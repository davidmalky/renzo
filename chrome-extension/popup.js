const apiKeyInput = document.getElementById('apiKeyInput');
const saveBtn = document.getElementById('saveBtn');
const status = document.getElementById('status');

chrome.storage.local.get(['renzo_api_key'], (result) => {
  if (result.renzo_api_key) apiKeyInput.value = result.renzo_api_key;
});

saveBtn.addEventListener('click', () => {
  const value = apiKeyInput.value.trim();
  chrome.storage.local.set({ renzo_api_key: value }, () => {
    status.textContent = 'Saved!';
    setTimeout(() => { status.textContent = ''; }, 2000);
  });
});
