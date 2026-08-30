// Renzo — injects an AI message generation button into the compose/message
// areas of Gmail, LinkedIn messaging, and Salesforce.

// Must be the exact final destination, not a domain that redirects — a
// redirect on this URL (meetrenzo.com -> www.meetrenzo.com) fails the CORS
// preflight outright, since browsers refuse to follow redirects for
// preflight OPTIONS requests. That silently killed every request from
// third-party pages like linkedin.com and mail.google.com.
const RENZO_API_URL = 'https://www.meetrenzo.com/api/ai';
const BAR_CLASS = 'renzo-compose-bar';
const BTN_CLASS = 'renzo-generate-btn';

let bodySeq = 0;
let scanTimer = null;

// Each rule matches a compose area on one of the three platforms.
// mode: 'direct' — `selector` matches the editable body itself (Gmail/LinkedIn).
// mode: 'wrapper' — `selector` matches a non-editable wrapper that CONTAINS
//   the editable body as a descendant (Salesforce).
const COMPOSE_RULES = [
  { mode: 'direct', selector: 'div[aria-label="Message Body"][contenteditable="true"]', platform: 'gmail' },
  { mode: 'direct', selector: 'div.Am.Al.editable[contenteditable="true"]', platform: 'gmail' },
  { mode: 'direct', selector: 'div[g_editable="true"][contenteditable="true"]', platform: 'gmail' },
  // LinkedIn uses an ellipsis (U+2026) in "Write a message…", not three dots.
  { mode: 'direct', selector: 'div.msg-form__contenteditable', platform: 'linkedin' },
  { mode: 'direct', selector: 'div.msg-form__contenteditable[contenteditable="true"]', platform: 'linkedin' },
  { mode: 'direct', selector: 'div[aria-label="Write a message…"]', platform: 'linkedin' },
  { mode: 'direct', selector: 'div[aria-label="Write a message..."]', platform: 'linkedin' },
  { mode: 'direct', selector: 'div[role="textbox"][aria-label*="message" i]', platform: 'linkedin' },
  { mode: 'direct', selector: 'div[role="textbox"][aria-placeholder*="message" i]', platform: 'linkedin' },
  { mode: 'direct', selector: 'div[contenteditable="true"][aria-label*="message" i]', platform: 'linkedin' },
  { mode: 'wrapper', selector: 'div[class*="emailBody"]', platform: 'salesforce' },
  { mode: 'wrapper', selector: 'div[class*="composeArea"]', platform: 'salesforce' },
  { mode: 'wrapper', selector: 'div[class*="email"]', platform: 'salesforce' }
];

function currentPlatform() {
  const h = (window.location && window.location.hostname) || '';
  if (h === 'mail.google.com' || h.endsWith('.mail.google.com')) return 'gmail';
  if (h === 'linkedin.com' || h.endsWith('.linkedin.com')) return 'linkedin';
  if (h.endsWith('salesforce.com') || h.endsWith('force.com')) return 'salesforce';
  return null;
}

function shouldApplyRule(rule) {
  const platform = currentPlatform();
  if (!platform) return true;
  return !rule.platform || rule.platform === platform;
}

function getApiKey() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['renzo_api_key'], (result) => {
      resolve(result.renzo_api_key || null);
    });
  });
}

function findComposeBody(container) {
  return container.querySelector('textarea, [contenteditable="true"], [role="textbox"][contenteditable="true"]');
}

function isFeedOrComment(el) {
  return !!(el && el.closest && el.closest(
    '.comments-comment-box, .comments-comment-texteditor, .feed-shared-update-v2, .share-creation-state'
  ));
}

function looksLikeInputSendRow(el) {
  if (!el || el === document.body) return false;
  if (el.matches && el.matches('.msg-form__row, .msg-form__footer, .msg-form__right-actions, .btC, .gU.Up')) {
    return true;
  }
  const send = el.querySelector && el.querySelector(
    '.msg-form__send-button, .T-I.aoO, [aria-label^="Send"], [aria-label*="Send" i]'
  );
  const box = el.querySelector && el.querySelector('[contenteditable="true"], [role="textbox"]');
  return !!(send && box);
}

function isUnsafeParent(el) {
  if (!el) return true;
  const tag = el.tagName;
  if (tag === 'TABLE' || tag === 'TBODY' || tag === 'THEAD' || tag === 'TFOOT' || tag === 'TR' || tag === 'TD' || tag === 'TH') {
    return true;
  }
  if (el.matches && el.matches('td.I5, .aO7, .btC, .gU.Up, .msg-form__row, .msg-form__footer, .msg-form__msg-content-container')) {
    return true;
  }
  return looksLikeInputSendRow(el);
}

// Place the bar as its own block in compose chrome — never inside the
// contenteditable, never inside Gmail's send row (.btC), never as a flex
// sibling of LinkedIn's Send control.
function findSafeInsertion(bodyEl) {
  const gmailRoot = bodyEl.closest('[role="dialog"], .nH.Hd, .ip, .aoI');
  if (gmailRoot) {
    const bodyTable = bodyEl.closest('table.aoP, table.iN, table.aoC');
    if (bodyTable && bodyTable.parentElement && !isUnsafeParent(bodyTable.parentElement)) {
      return { parent: bodyTable.parentElement, before: bodyTable };
    }
    const send = gmailRoot.querySelector('.btC, .gU.Up');
    if (send && send.parentElement) {
      return { parent: send.parentElement, before: send };
    }
    return { parent: gmailRoot, before: bodyEl };
  }

  const liRoot = bodyEl.closest('form.msg-form, .msg-form, .msg-overlay-conversation-bubble, .msg-convo-wrapper');
  if (liRoot) {
    const row = bodyEl.closest('.msg-form__row, .msg-form__msg-content-container, .msg-form__footer');
    if (row && row.parentElement && !isUnsafeParent(row.parentElement)) {
      return { parent: row.parentElement, before: row };
    }
    return { parent: liRoot, before: liRoot.firstChild };
  }

  let before = bodyEl;
  let parent = bodyEl.parentElement;
  while (parent && parent !== document.body && isUnsafeParent(parent)) {
    before = parent;
    parent = parent.parentElement;
  }
  if (!parent) return null;
  return { parent, before };
}

function ensureBodyId(bodyEl) {
  if (!bodyEl.getAttribute('data-renzo-id')) {
    bodySeq += 1;
    bodyEl.setAttribute('data-renzo-id', 'renzo-body-' + bodySeq);
  }
  return bodyEl.getAttribute('data-renzo-id');
}

function liveBarFor(bodyEl) {
  const id = bodyEl.getAttribute('data-renzo-id');
  if (!id) return null;
  const bar = document.querySelector('.' + BAR_CLASS + '[data-renzo-for="' + id + '"]');
  return bar && bar.isConnected ? bar : null;
}

function showToast(message) {
  const existing = document.querySelector('.renzo-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'renzo-toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('renzo-toast-visible'));
  setTimeout(() => {
    toast.classList.remove('renzo-toast-visible');
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

function showTooltip(anchor, message) {
  const existing = document.querySelector('.renzo-tooltip');
  if (existing) existing.remove();
  const tip = document.createElement('div');
  tip.className = 'renzo-tooltip';
  tip.textContent = message;
  (anchor.parentElement || document.body).appendChild(tip);
  setTimeout(() => tip.remove(), 3000);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function setComposeValue(bodyEl, text) {
  bodyEl.focus();

  const signature = bodyEl.querySelector('.gmail_signature, [data-smartmail="gmail_signature"]');
  try {
    const doc = bodyEl.ownerDocument;
    const sel = doc.getSelection && doc.getSelection();
    if (sel && doc.createRange && doc.execCommand) {
      const range = doc.createRange();
      if (signature) {
        range.setStart(bodyEl, 0);
        range.setEndBefore(signature);
      } else {
        range.selectNodeContents(bodyEl);
      }
      sel.removeAllRanges();
      sel.addRange(range);
      const ok = doc.execCommand('insertText', false, text);
      if (ok) {
        bodyEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        return;
      }
    }
  } catch (e) {
    // fall through to the DOM write below
  }

  if (bodyEl.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(bodyEl, text);
    bodyEl.dispatchEvent(new Event('input', { bubbles: true }));
    bodyEl.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  const html = escapeHtml(text).split('\n').map((line) => '<p>' + (line || '<br>') + '</p>').join('');
  if (signature) {
    const tmp = bodyEl.ownerDocument.createElement('div');
    tmp.innerHTML = html;
    while (bodyEl.firstChild && bodyEl.firstChild !== signature) {
      bodyEl.removeChild(bodyEl.firstChild);
    }
    while (tmp.firstChild) bodyEl.insertBefore(tmp.firstChild, signature);
  } else {
    bodyEl.innerHTML = html;
  }
  try {
    bodyEl.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
  } catch (e) {
    bodyEl.dispatchEvent(new Event('input', { bubbles: true }));
  }
  bodyEl.dispatchEvent(new Event('change', { bubbles: true }));
}

function textFrom(el) {
  return (el && (el.getAttribute('data-name') || el.getAttribute('email') || el.textContent) || '').trim();
}

function getGmailRecipient(bodyEl) {
  const root = bodyEl.closest('[role="dialog"], .nH.Hd, .ip, .aoI') || document;
  const chip = root.querySelector('[data-name], span[email], [data-hovercard-id]');
  const fromChip = textFrom(chip);
  if (fromChip) return fromChip.split(/\s+</)[0].replace(/"/g, '').trim();
  const toField = root.querySelector('textarea[name="to"], input[aria-label^="To"], input[aria-label*="Recipients"]');
  if (toField && toField.value) return toField.value.trim();
  return '';
}

function getLinkedInRecipient(bodyEl) {
  const thread = bodyEl.closest(
    'form.msg-form, .msg-form, .msg-overlay-conversation-bubble, .msg-convo-wrapper, .msg-thread'
  );
  const searchRoots = [];
  if (thread) searchRoots.push(thread);
  if (thread && thread.parentElement) searchRoots.push(thread.parentElement);
  const selectors = [
    '.msg-overlay-bubble-header__title',
    '.msg-entity-lockup__entity-title',
    '.msg-thread__link-to-profile',
    '.profile-card-one-to-one__profile-link',
    'header h2'
  ];
  for (const root of searchRoots) {
    for (const sel of selectors) {
      const name = textFrom(root.querySelector(sel));
      if (name && !/^(messaging|linkedin)$/i.test(name)) return name;
    }
  }
  return '';
}

function getSalesforceContactName() {
  const selectors = [
    '.slds-page-header__title',
    '.slds-page-header__name-title lightning-formatted-text',
    '.slds-page-header__name-title',
    'records-highlights-details-item lightning-formatted-text',
    '[data-aura-class="forceHighlightsDetails"] lightning-formatted-text',
    'h1'
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    const text = el && el.textContent && el.textContent.trim();
    if (text) return text;
  }
  const breadcrumb = document.querySelector('.slds-breadcrumb a, .breadcrumbs a');
  const breadcrumbText = breadcrumb && breadcrumb.textContent && breadcrumb.textContent.trim();
  return breadcrumbText || '';
}

function getContactName(bodyEl, platform) {
  if (platform === 'gmail') return getGmailRecipient(bodyEl) || 'there';
  if (platform === 'linkedin') return getLinkedInRecipient(bodyEl) || 'there';
  return getSalesforceContactName() || 'there';
}

function contextFor(platform) {
  if (platform === 'linkedin') return 'LinkedIn message';
  if (platform === 'gmail') return 'Gmail compose';
  return 'Email compose';
}

function platformOf(bodyEl) {
  const marked = bodyEl.getAttribute('data-renzo-platform');
  if (marked) return marked;
  return currentPlatform() || 'gmail';
}

function resolveBodyFromButton(btn) {
  const bar = btn.closest('.' + BAR_CLASS);
  const id = bar && bar.getAttribute('data-renzo-for');
  if (id) {
    const el = document.querySelector('[data-renzo-id="' + id + '"]');
    if (el && el.isConnected) return el;
  }
  const root = (bar && bar.parentElement) || btn.parentElement;
  if (!root) return null;
  return root.querySelector('[data-renzo-id]') ||
    root.querySelector('[contenteditable="true"], textarea, [role="textbox"]');
}

async function handleGenerateClick(btn, bodyEl) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    showTooltip(btn, 'Add your Renzo API key in the extension settings');
    return;
  }

  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Generating…';

  try {
    const platform = platformOf(bodyEl);
    const contactName = getContactName(bodyEl, platform);
    const res = await fetch(RENZO_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'X-API-Key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        action: 'generate_simple',
        contactName,
        context: contextFor(platform)
      })
    });
    const data = await res.json();
    if (!res.ok || !data.message) {
      showToast('Renzo: ' + (data.error || 'Could not generate message'));
      return;
    }
    setComposeValue(bodyEl, data.message);
    showToast('✓ Message generated by Renzo');
  } catch (e) {
    showToast('Renzo: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

// Delegated capture-phase click. Gmail re-renders compose chrome and will
// clone or replace our button node; resolving the body from the bar's
// data-renzo-for attribute (not a WeakMap keyed on a specific node) is
// what keeps the click working after that.
document.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest && e.target.closest('.' + BTN_CLASS);
  if (!btn) return;
  const bodyEl = resolveBodyFromButton(btn);
  if (!bodyEl) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  handleGenerateClick(btn, bodyEl);
}, true);

function injectButton(matchedEl, rule) {
  const bodyEl = rule.mode === 'direct' ? matchedEl : findComposeBody(matchedEl);
  if (!bodyEl) return;
  if (isFeedOrComment(bodyEl)) return;
  if (liveBarFor(bodyEl)) return;

  const insertion = rule.mode === 'wrapper'
    ? { parent: matchedEl, before: matchedEl.firstChild }
    : findSafeInsertion(bodyEl);
  if (!insertion || !insertion.parent) return;

  const id = ensureBodyId(bodyEl);
  bodyEl.setAttribute('data-renzo-platform', rule.platform || currentPlatform() || '');

  const bar = document.createElement('div');
  bar.className = BAR_CLASS;
  bar.setAttribute('data-renzo-for', id);
  bar.setAttribute('data-renzo-platform', rule.platform || '');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = BTN_CLASS;
  btn.textContent = '✉ Generate with Renzo';
  bar.appendChild(btn);

  insertion.parent.insertBefore(bar, insertion.before);
}

function scanForComposeAreas(root) {
  if (!root || !root.querySelectorAll) return;
  for (const rule of COMPOSE_RULES) {
    if (!shouldApplyRule(rule)) continue;
    root.querySelectorAll(rule.selector).forEach((el) => injectButton(el, rule));
  }
  if (root.matches) {
    for (const rule of COMPOSE_RULES) {
      if (!shouldApplyRule(rule)) continue;
      if (root.matches(rule.selector)) injectButton(root, rule);
    }
  }
}

function scheduleScan() {
  if (scanTimer) return;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    if (document.body) scanForComposeAreas(document.body);
  }, 80);
}

const observer = new MutationObserver(() => {
  scheduleScan();
});

function start() {
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['contenteditable', 'aria-label', 'aria-placeholder', 'role', 'class']
  });
  scanForComposeAreas(document.body);
  setInterval(() => {
    if (document.body) scanForComposeAreas(document.body);
  }, 2000);
}

if (document.body) {
  start();
} else {
  document.addEventListener('DOMContentLoaded', start, { once: true });
}

window.RenzoExtension = {
  scan: scanForComposeAreas,
  start
};
