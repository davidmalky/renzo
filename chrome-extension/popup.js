const apiKeyInput = document.getElementById('apiKeyInput');
const saveBtn = document.getElementById('saveBtn');
const status = document.getElementById('status');

let savedKey = '';
let showingMasked = false;

function maskKey(key) {
  const prefix = key.startsWith('renzo_') ? 'renzo_' : key.slice(0, Math.min(6, key.length));
  return prefix + '••••••••';
}

function showMasked() {
  if (!savedKey) return;
  apiKeyInput.value = maskKey(savedKey);
  showingMasked = true;
}

chrome.storage.local.get(['renzo_api_key'], (result) => {
  if (result.renzo_api_key) {
    savedKey = result.renzo_api_key;
    showMasked();
  }
});

apiKeyInput.addEventListener('focus', () => {
  if (showingMasked) {
    apiKeyInput.value = '';
    showingMasked = false;
  }
});

apiKeyInput.addEventListener('blur', () => {
  if (!apiKeyInput.value.trim() && savedKey) showMasked();
});

saveBtn.addEventListener('click', () => {
  const value = apiKeyInput.value.trim();
  if (!value || showingMasked) {
    status.textContent = savedKey ? 'No changes to save' : 'Enter an API key first';
    setTimeout(() => { status.textContent = ''; }, 2000);
    return;
  }
  chrome.storage.local.set({ renzo_api_key: value }, () => {
    savedKey = value;
    showMasked();
    status.textContent = 'Saved!';
    setTimeout(() => { status.textContent = ''; }, 2000);
  });
});
