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

function isContentEditable(el) {
  if (!el) return false;
  if (el.isContentEditable === true) return true;
  return !!(el.getAttribute && el.getAttribute('contenteditable') === 'true');
}

function isInsideContentEditable(el) {
  let node = el;
  while (node) {
    if (isContentEditable(node)) return true;
    node = node.parentElement;
  }
  return false;
}

function isEditorCell(el) {
  return !!(el && el.matches && el.matches(
    'td.I5, .aO7, .Am.Al.editable, [g_editable="true"], .gmail_signature, .gmail_quote, [data-smartmail="gmail_signature"]'
  ));
}

function isTableChrome(el) {
  const tag = el && el.tagName;
  return tag === 'TABLE' || tag === 'TBODY' || tag === 'THEAD' || tag === 'TFOOT' || tag === 'TR' || tag === 'TD' || tag === 'TH';
}

function isForbiddenInsertionParent(el) {
  if (!el || el === document.body) return true;
  if (isContentEditable(el) || isInsideContentEditable(el)) return true;
  if (isEditorCell(el)) return true;
  if (el.matches && el.matches('.btC, .gU.Up, .gmail_signature, .gmail_quote, [data-smartmail="gmail_signature"]')) {
    return true;
  }
  return false;
}

function isUnsafeParent(el) {
  if (!el) return true;
  if (isTableChrome(el)) return true;
  if (el.matches && el.matches('td.I5, .aO7, .btC, .gU.Up, .msg-form__row, .msg-form__footer, .msg-form__msg-content-container')) {
    return true;
  }
  return looksLikeInputSendRow(el);
}

function childOfContaining(parent, descendant) {
  let node = descendant;
  while (node && node.parentElement !== parent) {
    node = node.parentElement;
  }
  return node && node.parentElement === parent ? node : null;
}

// Outermost compose/reply chrome. Inline Reply keeps Send in `.ip` while
// the editable lives in an inner `.aoI` — using the inner box as the root
// is what put the bar above the signature (PR #2 only exercised new Compose).
function findGmailFrame(bodyEl) {
  return bodyEl.closest('[role="dialog"], .nH.Hd, .ip') ||
    bodyEl.closest('.aoI, .AD, .nH.aHU, .aaZ');
}

// Popped-out / new-message windows. Inline thread Reply is NOT this.
function isGmailComposePopup(bodyEl) {
  return !!(bodyEl && bodyEl.closest && bodyEl.closest('[role="dialog"], .nH.Hd'));
}

// Any Gmail Message Body that is not the compose popup is an inline Reply.
// Real Reply often has none of `.ip` / `.aoI` / `.btC` — those were fixture guesses.
function isGmailReply(bodyEl) {
  if (!bodyEl) return false;
  const marked = bodyEl.getAttribute && bodyEl.getAttribute('data-renzo-platform');
  const platform = marked || currentPlatform();
  if (platform && platform !== 'gmail') return false;
  if (isGmailComposePopup(bodyEl)) return false;
  return platform === 'gmail' || !platform;
}

function findSendNearBody(bodyEl) {
  let node = bodyEl;
  while (node && node !== document.documentElement) {
    const send = findGmailSendChrome(node);
    if (send && !bodyEl.contains(send)) return send;
    node = node.parentElement;
  }
  return null;
}

function positionReplyOverlay(bar, bodyEl) {
  if (!bar || !bodyEl || !bodyEl.getBoundingClientRect) return;
  const send = findSendNearBody(bodyEl);
  const sendRect = send && send.getBoundingClientRect ? send.getBoundingClientRect() : null;
  const bodyRect = bodyEl.getBoundingClientRect();
  const width = Math.max(bodyRect.width || 0, (sendRect && sendRect.width) || 0, 200);
  const left = sendRect ? Math.min(bodyRect.left, sendRect.left) : bodyRect.left;
  const barH = bar.offsetHeight || 36;
  let top;
  if (sendRect && sendRect.top >= (bodyRect.top - 8)) {
    top = sendRect.top - barH - 6;
  } else {
    top = bodyRect.bottom + 6;
  }
  bar.style.position = 'fixed';
  bar.style.left = Math.max(8, left) + 'px';
  bar.style.top = Math.max(8, top) + 'px';
  bar.style.width = Math.max(160, width) + 'px';
  bar.style.zIndex = '2147483646';
}

function placeReplyOverlay(bar, bodyEl) {
  if (!bar || !bodyEl || !document.body) return false;
  bar.setAttribute('data-renzo-overlay', '1');
  bar.classList.add('renzo-compose-bar-overlay');
  const row = bar.closest && bar.closest('tr.' + BAR_CLASS + '-row');
  if (bar.parentElement !== document.body) {
    document.body.appendChild(bar);
  }
  if (row && row.parentElement && !row.contains(bar)) row.remove();
  positionReplyOverlay(bar, bodyEl);
  return true;
}

let overlayRaf = null;
function scheduleOverlayReposition() {
  if (overlayRaf) return;
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function (fn) { return setTimeout(fn, 16); };
  overlayRaf = raf(function () {
    overlayRaf = null;
    document.querySelectorAll('.' + BAR_CLASS + '[data-renzo-overlay]').forEach((bar) => {
      const id = bar.getAttribute('data-renzo-for');
      const body = id && document.querySelector('[data-renzo-id="' + id + '"]');
      if (!body || !body.isConnected) {
        bar.remove();
        return;
      }
      positionReplyOverlay(bar, body);
    });
  });
}

function findGmailSendChrome(root) {
  if (!root || !root.querySelectorAll) return null;
  const nodes = root.querySelectorAll(
    '.btC, .gU.Up, table.bs1, table.IU, .T-I.aoO, [role="button"][aria-label^="Send"], [data-tooltip^="Send"]'
  );
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    if (isInsideContentEditable(el)) continue;
    if (el.closest && el.closest('.gmail_quote, .gmail_signature, [data-smartmail="gmail_signature"]')) continue;
    if (el.matches('.T-I.aoO, [role="button"][aria-label^="Send"], [data-tooltip^="Send"]')) {
      return el.closest('.btC, .gU.Up, table.bs1, table.IU, .dC, tr') || el;
    }
    return el;
  }
  return null;
}

function findEditorSurface(bodyEl, frame) {
  let el = bodyEl;
  while (el.parentElement && el !== frame) {
    const parent = el.parentElement;
    const sendInParent = findGmailSendChrome(parent);
    if (sendInParent && !el.contains(sendInParent)) return el;
    if (parent === frame) return el;
    el = parent;
  }
  return el;
}

// Prefer a dedicated TR when the only chrome parent is a table, so we never
// drop a div into td.I5 (Gmail will reparent that into the contenteditable).
function hoistInsertion(fromEl, frame) {
  if (!fromEl) return null;
  let before = fromEl;
  let parent = fromEl.parentElement;
  while (parent && parent !== document.body) {
    if (isForbiddenInsertionParent(parent)) {
      before = parent;
      parent = parent.parentElement;
      continue;
    }
    if (parent.tagName === 'TR') {
      if (parent.querySelector && parent.querySelector('[contenteditable="true"]')) {
        before = parent;
        parent = parent.parentElement;
        continue;
      }
      before = parent;
      parent = parent.parentElement;
      if (parent && (parent.tagName === 'TABLE' || parent.tagName === 'TBODY')) {
        return { parent, before, asTableRow: true };
      }
      continue;
    }
    if (parent.tagName === 'TABLE' || parent.tagName === 'TBODY') {
      const rowBefore = before.tagName === 'TR' ? before : (before.closest && before.closest('tr'));
      // A TR above a row that already holds the editor looks like the button
      // is sitting on the signature. Put chrome after that mixed row instead.
      if (rowBefore && rowBefore.querySelector && rowBefore.querySelector('[contenteditable="true"]')) {
        return { parent, before: rowBefore.nextSibling, asTableRow: true };
      }
      return { parent, before: rowBefore, asTableRow: true };
    }
    if (before.parentElement !== parent) {
      before = childOfContaining(parent, before);
    }
    return { parent, before };
  }
  if (frame && !isForbiddenInsertionParent(frame) && frame !== fromEl) {
    return { parent: frame, before: childOfContaining(frame, fromEl) };
  }
  return null;
}

function placeBar(bar, insertion) {
  if (!insertion || !insertion.parent) return false;
  const parent = insertion.parent;
  if (isForbiddenInsertionParent(parent)) return false;
  let before = insertion.before;
  if (before && before.parentElement !== parent) {
    before = childOfContaining(parent, before);
  }
  if (insertion.asTableRow || parent.tagName === 'TABLE' || parent.tagName === 'TBODY') {
    const existingRow = bar.closest && bar.closest('tr.' + BAR_CLASS + '-row');
    const tr = existingRow || document.createElement('tr');
    tr.className = BAR_CLASS + '-row';
    tr.setAttribute('contenteditable', 'false');
    if (!existingRow) {
      const td = document.createElement('td');
      td.colSpan = 99;
      td.setAttribute('contenteditable', 'false');
      td.appendChild(bar);
      tr.appendChild(td);
    }
    const rowBefore = before && (before.tagName === 'TR' ? before : (before.closest && before.closest('tr')));
    parent.insertBefore(tr, rowBefore && rowBefore.parentElement === parent ? rowBefore : null);
    return true;
  }
  parent.insertBefore(bar, before || null);
  return true;
}

// Place the bar as its own chrome block — never inside the contenteditable,
// never inside td.I5 / the signature / quoted thread, never inside Gmail's
// Send/formatting row, never as a flex sibling of LinkedIn's Send control.
//
// Inline Reply: do NOT insert before the body table or the editable. That
// lands the button at the top of the white editor, above the signature.
// Insert before the Send/formatting chrome (found on the outer .ip frame).
function findSafeInsertion(bodyEl) {
  const gmailFrame = findGmailFrame(bodyEl);
  if (gmailFrame) {
    const send = findGmailSendChrome(gmailFrame);
    if (send) {
      const slot = hoistInsertion(send, gmailFrame);
      if (slot && slot.parent && !isForbiddenInsertionParent(slot.parent)) {
        return slot;
      }
    }
    const surface = findEditorSurface(bodyEl, gmailFrame);
    if (surface && surface.parentElement && !isForbiddenInsertionParent(surface.parentElement)) {
      let before = surface.nextSibling;
      while (before && before.nodeType !== 1) before = before.nextSibling;
      if (before && before.classList && before.classList.contains(BAR_CLASS)) {
        before = before.nextSibling;
      }
      return { parent: surface.parentElement, before: before || null };
    }
    if (!isForbiddenInsertionParent(gmailFrame) && gmailFrame !== bodyEl) {
      return { parent: gmailFrame, before: null };
    }
    return null;
  }

  const liRoot = bodyEl.closest('form.msg-form, .msg-form, .msg-overlay-conversation-bubble, .msg-convo-wrapper');
  if (liRoot) {
    const row = bodyEl.closest('.msg-form__row, .msg-form__msg-content-container, .msg-form__footer');
    if (row && row.parentElement && !isUnsafeParent(row.parentElement) && !isForbiddenInsertionParent(row.parentElement)) {
      return { parent: row.parentElement, before: row };
    }
    if (!isForbiddenInsertionParent(liRoot)) {
      return { parent: liRoot, before: liRoot.firstChild };
    }
    return null;
  }

  let before = bodyEl;
  let parent = bodyEl.parentElement;
  while (parent && parent !== document.body && (isUnsafeParent(parent) || isForbiddenInsertionParent(parent))) {
    before = parent;
    parent = parent.parentElement;
  }
  if (!parent || isForbiddenInsertionParent(parent)) return null;
  if (before === bodyEl) {
    return { parent, before: bodyEl.nextSibling };
  }
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

function firstKeepNode(bodyEl) {
  if (!bodyEl || !bodyEl.querySelector) return null;
  bodyEl.querySelectorAll('.' + BAR_CLASS + ', tr.' + BAR_CLASS + '-row').forEach((n) => n.remove());
  return bodyEl.querySelector(
    '.gmail_signature, [data-smartmail="gmail_signature"], .gmail_quote, blockquote.gmail_quote'
  );
}

function setComposeValue(bodyEl, text) {
  bodyEl.focus();

  const keep = firstKeepNode(bodyEl);
  try {
    const doc = bodyEl.ownerDocument;
    const sel = doc.getSelection && doc.getSelection();
    if (sel && doc.createRange && doc.execCommand) {
      const range = doc.createRange();
      if (keep) {
        range.setStart(bodyEl, 0);
        range.setEndBefore(keep);
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
  if (keep) {
    const tmp = bodyEl.ownerDocument.createElement('div');
    tmp.innerHTML = html;
    while (bodyEl.firstChild && bodyEl.firstChild !== keep) {
      bodyEl.removeChild(bodyEl.firstChild);
    }
    while (tmp.firstChild) bodyEl.insertBefore(tmp.firstChild, keep);
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
  const root = findGmailFrame(bodyEl) || bodyEl.closest('[role="dialog"], .nH.Hd, .ip, .aoI') || document;
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

function makeBar(bodyEl, rule) {
  const id = ensureBodyId(bodyEl);
  bodyEl.setAttribute('data-renzo-platform', rule.platform || currentPlatform() || '');
  const bar = document.createElement('div');
  bar.className = BAR_CLASS;
  bar.setAttribute('contenteditable', 'false');
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('data-renzo-for', id);
  bar.setAttribute('data-renzo-platform', rule.platform || '');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = BTN_CLASS;
  btn.setAttribute('contenteditable', 'false');
  btn.textContent = '✉ Generate with Renzo';
  bar.appendChild(btn);
  return bar;
}

function injectButton(matchedEl, rule) {
  const bodyEl = rule.mode === 'direct' ? matchedEl : findComposeBody(matchedEl);
  if (!bodyEl) return;
  if (isFeedOrComment(bodyEl)) return;
  if (isInsideContentEditable(bodyEl.parentElement)) return;

  const existing = liveBarFor(bodyEl);
  if (existing) {
    if (isGmailReply(bodyEl) && !existing.hasAttribute('data-renzo-overlay')) {
      placeReplyOverlay(existing, bodyEl);
    } else if (existing.hasAttribute('data-renzo-overlay')) {
      positionReplyOverlay(existing, bodyEl);
    }
    return;
  }

  const bar = makeBar(bodyEl, rule);

  // Inline Reply: host the bar on document.body. Gmail's editor reparents
  // siblings of the contenteditable into the letter (caret = above signature).
  // Compose popup keeps the in-tree chrome slot Dave already accepted.
  if (isGmailReply(bodyEl)) {
    if (!placeReplyOverlay(bar, bodyEl)) bar.remove();
    return;
  }

  const insertion = rule.mode === 'wrapper'
    ? { parent: matchedEl, before: matchedEl.firstChild }
    : findSafeInsertion(bodyEl);
  if (!insertion || !insertion.parent || isForbiddenInsertionParent(insertion.parent)) {
    bar.remove();
    return;
  }
  if (!placeBar(bar, insertion)) {
    bar.remove();
  }
}

function yankIfSwallowed(bar) {
  if (!bar || !bar.isConnected) return;
  const inLetter = isInsideContentEditable(bar) ||
    !!(bar.closest && bar.closest('.gmail_signature, .gmail_quote, [data-smartmail="gmail_signature"]')) ||
    !!(bar.closest && bar.closest('td.I5') && !bar.hasAttribute('data-renzo-overlay'));
  if (!inLetter) return;
  const id = bar.getAttribute('data-renzo-for');
  const body = (id && document.querySelector('[data-renzo-id="' + id + '"]')) ||
    (bar.closest && bar.closest('[contenteditable="true"]'));
  if (!body) {
    bar.remove();
    return;
  }
  if (isGmailReply(body) || inLetter) {
    placeReplyOverlay(bar, body);
  }
}

function rescueSwallowedBars() {
  document.querySelectorAll('.' + BAR_CLASS).forEach((bar) => {
    const id = bar.getAttribute('data-renzo-for');
    const body = id && document.querySelector('[data-renzo-id="' + id + '"]');
    if (body && isGmailReply(body) && !bar.hasAttribute('data-renzo-overlay')) {
      placeReplyOverlay(bar, body);
      return;
    }
    yankIfSwallowed(bar);
  });
}

function scanForComposeAreas(root) {
  if (!root || !root.querySelectorAll) return;
  rescueSwallowedBars();
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

const observer = new MutationObserver((mutations) => {
  for (let i = 0; i < mutations.length; i++) {
    const added = mutations[i].addedNodes;
    if (!added) continue;
    for (let j = 0; j < added.length; j++) {
      const n = added[j];
      if (!n || n.nodeType !== 1) continue;
      if (n.classList && n.classList.contains(BAR_CLASS)) yankIfSwallowed(n);
      const inner = n.querySelectorAll && n.querySelectorAll('.' + BAR_CLASS);
      if (inner) {
        for (let k = 0; k < inner.length; k++) yankIfSwallowed(inner[k]);
      }
    }
  }
  scheduleScan();
  scheduleOverlayReposition();
});

function start() {
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['contenteditable', 'aria-label', 'aria-placeholder', 'role', 'class']
  });
  window.addEventListener('scroll', scheduleOverlayReposition, true);
  window.addEventListener('resize', scheduleOverlayReposition);
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
