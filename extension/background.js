// background.js — Extension service worker.
// Routes messages between the popup and Meet tab content scripts.
// Manages the whiteboard tab.

let whiteboardTabId = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Open the whiteboard tab
  if (message.action === 'open-whiteboard') {
    // IMPORTANT: chrome-extension:// URLs break Meet's screen sharing for the
    // entire session. Whiteboard must be hosted on a real domain.
    // TODO: Host on vibeconferencing.vercel.app/whiteboard
    const url = message.url || 'https://vibeconferencing.vercel.app';

    // Reuse existing whiteboard tab if it's still open
    if (whiteboardTabId !== null) {
      chrome.tabs.get(whiteboardTabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          // Tab was closed, open a new one
          chrome.tabs.create({ url, active: false }, (tab) => {
            whiteboardTabId = tab.id;
            sendResponse({ tabId: tab.id });
          });
        } else {
          // Tab exists, just make sure it's the right URL
          chrome.tabs.update(whiteboardTabId, { url });
          sendResponse({ tabId: whiteboardTabId });
        }
      });
    } else {
      chrome.tabs.create({ url, active: false }, (tab) => {
        whiteboardTabId = tab.id;
        sendResponse({ tabId: tab.id });
      });
    }
    return true;
  }

  // Update whiteboard content
  if (message.action === 'update-whiteboard' && whiteboardTabId !== null) {
    chrome.tabs.sendMessage(whiteboardTabId, message, (response) => {
      sendResponse(response || { ok: true });
    });
    return true;
  }

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
    return true;
  }
});

// Clean up whiteboard tab reference when it's closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === whiteboardTabId) {
    whiteboardTabId = null;
  }
});

console.log('[bots-in-calls] Service worker started');
