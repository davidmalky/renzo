// Renzo — injects an AI message generation button into the compose/message
// areas of Gmail, LinkedIn messaging, and Salesforce.

const RENZO_API_URL = 'https://meetrenzo.com/api/ai';
const injectedBodies = new WeakSet();
const buttonBodyMap = new WeakMap();

// Each rule matches a compose area on one of the three platforms.
// mode: 'direct' — `selector` matches the editable body itself (Gmail/LinkedIn).
//   The button is inserted as a sibling BEFORE `anchor` (a closest-ancestor
//   selector) if given, else BEFORE the editable element itself. It must
//   never be inserted inside the editable element, or it becomes part of
//   the actual message content.
// mode: 'wrapper' — `selector` matches a non-editable wrapper that CONTAINS
//   the editable body as a descendant (Salesforce). The button is prepended
//   as the wrapper's first child.
const COMPOSE_RULES = [
  // Gmail — matched directly on the editable body itself, with no anchor,
  // so the button lands immediately before the body. An earlier version
  // anchored on .compose-recipients-area, which put the button above the
  // sender name and confidentiality notice instead of the actual compose box.
  { mode: 'direct', selector: 'div[aria-label="Message Body"][contenteditable="true"]' },
  { mode: 'direct', selector: 'div.Am.Al.editable[contenteditable="true"]' },
  // LinkedIn messaging — several fallback selectors since LinkedIn's
  // messaging UI loads asynchronously and its markup varies.
  { mode: 'direct', selector: 'div[aria-label="Write a message..."]' },
  { mode: 'direct', selector: 'div.msg-form__contenteditable' },
  { mode: 'direct', selector: 'div.msg-form__contenteditable[contenteditable="true"]' },
  { mode: 'direct', selector: 'div[role="textbox"][aria-label*="message" i]' },
  // Salesforce email compose
  { mode: 'wrapper', selector: 'div[class*="emailBody"]' },
  { mode: 'wrapper', selector: 'div[class*="composeArea"]' },
  { mode: 'wrapper', selector: 'div[class*="email"]' }
];

function getApiKey() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['renzo_api_key'], (result) => {
      resolve(result.renzo_api_key || null);
    });
  });
}

function getContactName() {
  // Try common Salesforce Lightning record-title selectors first, then
  // fall back to the page's h1, then any breadcrumb link.
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
    const text = el?.textContent?.trim();
    if (text) return text;
  }
  const breadcrumb = document.querySelector('.slds-breadcrumb a, .breadcrumbs a');
  const breadcrumbText = breadcrumb?.textContent?.trim();
  if (breadcrumbText) return breadcrumbText;
  return '';
}

function findComposeBody(container) {
  return container.querySelector('textarea, [contenteditable="true"]');
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
  anchor.parentElement.appendChild(tip);
  setTimeout(() => tip.remove(), 3000);
}

function setComposeValue(bodyEl, text) {
  if (bodyEl.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(bodyEl, text);
    bodyEl.dispatchEvent(new Event('input', { bubbles: true }));
    bodyEl.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    bodyEl.focus();
    bodyEl.textContent = text;
    bodyEl.dispatchEvent(new Event('input', { bubbles: true }));
  }
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
    const contactName = getContactName();
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
        context: 'Email compose'
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

// Single delegated click listener instead of one listener per injected
// button. Gmail re-renders its compose chrome frequently enough that a
// listener attached directly to a button node can end up on a detached or
// orphaned element. Delegating to document sidesteps that entirely — we
// don't depend on any specific button node still being "live". Capture
// phase (the `true` third argument) means we see the click before the host
// page's own handlers get a chance to intercept/stop it further down the
// tree.
document.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest && e.target.closest('.renzo-generate-btn');
  if (!btn) return;
  const bodyEl = buttonBodyMap.get(btn);
  if (!bodyEl) return;
  e.stopPropagation();
  handleGenerateClick(btn, bodyEl);
}, true);

function injectButton(matchedEl, rule) {
  let bodyEl, parent, insertBeforeNode;

  if (rule.mode === 'direct') {
    bodyEl = matchedEl;
    const ancestor = rule.anchor ? matchedEl.closest(rule.anchor) : null;
    insertBeforeNode = ancestor || matchedEl;
    parent = insertBeforeNode.parentElement;
  } else {
    bodyEl = findComposeBody(matchedEl);
    if (!bodyEl) return;
    parent = matchedEl;
    insertBeforeNode = matchedEl.firstChild;
  }

  if (!parent || injectedBodies.has(bodyEl)) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'renzo-generate-btn';
  btn.textContent = '✉ Generate with Renzo';
  buttonBodyMap.set(btn, bodyEl);

  parent.insertBefore(btn, insertBeforeNode);
  injectedBodies.add(bodyEl);
  console.log('[Renzo] Generate button injected for compose area matching "' + rule.selector + '"', bodyEl);
  console.log('[Renzo] button injected on:', window.location.hostname);
}

// TEMPORARY DEBUG LOGGING — LinkedIn's messaging UI hasn't reliably matched
// our selectors. This logs every plausible compose-like candidate found in
// each newly-scanned subtree so we can see what's actually in the DOM and
// compare it against COMPOSE_RULES above. Remove once LinkedIn matching is
// confirmed stable.
function debugLogLinkedInCandidates(root) {
  if (!window.location.hostname.includes('linkedin.com')) return;
  if (!root.querySelectorAll) return;
  const CANDIDATE_SELECTOR = '[contenteditable="true"], [role="textbox"], [class*="msg-form"], [aria-label*="message" i]';
  const describe = (el) => ({
    tag: el.tagName,
    class: el.className,
    ariaLabel: el.getAttribute('aria-label'),
    role: el.getAttribute('role'),
    contentEditable: el.getAttribute('contenteditable'),
    el
  });
  root.querySelectorAll(CANDIDATE_SELECTOR).forEach((el) => {
    console.log('[Renzo][debug] LinkedIn candidate element:', describe(el));
  });
  if (root.matches && root.matches(CANDIDATE_SELECTOR)) {
    console.log('[Renzo][debug] LinkedIn candidate element (added node itself):', describe(root));
  }
}

function scanForComposeAreas(root) {
  if (!root.querySelectorAll) return;
  debugLogLinkedInCandidates(root);
  for (const rule of COMPOSE_RULES) {
    root.querySelectorAll(rule.selector).forEach((el) => injectButton(el, rule));
  }
  // A newly-added node can itself be the compose element, not just an
  // ancestor of it — check that case too.
  if (root.matches) {
    for (const rule of COMPOSE_RULES) {
      if (root.matches(rule.selector)) injectButton(root, rule);
    }
  }
}

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    mutation.addedNodes.forEach((node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      scanForComposeAreas(node);
    });
  }
});

function start() {
  observer.observe(document.body, { childList: true, subtree: true });
  scanForComposeAreas(document.body);
}

if (document.body) {
  start();
} else {
  document.addEventListener('DOMContentLoaded', start, { once: true });
}
