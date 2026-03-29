// background.js — Extension service worker.
// Routes messages between the popup and Meet tab content scripts.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Forward messages from popup → content script in the active Meet tab
  if (message.target === 'content' || message.target === 'page') {
    chrome.tabs.query({ url: 'https://meet.google.com/*' }, (tabs) => {
      if (tabs.length > 0) {
        chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
          sendResponse(response || { ok: true });
        });
      } else {
        sendResponse({ error: 'No Meet tab found' });
      }
    });
    return true; // keep channel open for async sendResponse
  }
});

console.log('[bots-in-calls] Service worker started');
