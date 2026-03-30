// background.js — Extension service worker.
// Routes messages between the popup and Meet tab content scripts.
// Manages the whiteboard tab and TTS.

importScripts('tts.js');

let whiteboardTabId = null;
const tts = new TTSProvider();

// Load TTS config from storage on startup
chrome.storage.local.get(['ttsApiKey', 'ttsVoiceId'], (result) => {
  if (result.ttsApiKey) tts.updateConfig({ apiKey: result.ttsApiKey });
  if (result.ttsVoiceId) tts.updateConfig({ voiceId: result.ttsVoiceId });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // --- TTS: synthesize text and send audio to the Meet tab ---
  if (message.action === 'speak') {
    const text = message.text;
    if (!text) {
      sendResponse({ error: 'No text provided' });
      return;
    }

    console.log('[bots-in-calls] TTS request:', text.slice(0, 80));

    tts.synthesize(text)
      .then((audioBuffer) => {
        console.log('[bots-in-calls] TTS audio received:', audioBuffer.byteLength, 'bytes');
        // Forward audio to the Meet tab's page-inject.js for playback
        chrome.tabs.query({ url: 'https://meet.google.com/*' }, (tabs) => {
          if (tabs.length > 0) {
            chrome.tabs.sendMessage(tabs[0].id, {
              target: 'page',
              action: 'play-tts',
              payload: { audioData: audioBuffer },
            }, (response) => {
              sendResponse({ ok: true, bytes: audioBuffer.byteLength });
            });
          } else {
            sendResponse({ error: 'No Meet tab found' });
          }
        });
      })
      .catch((err) => {
        console.error('[bots-in-calls] TTS error:', err.message);
        sendResponse({ error: err.message });
      });
    return true; // async response
  }

  // --- TTS config update ---
  if (message.action === 'update-tts-config') {
    tts.updateConfig(message.config);
    // Persist to storage
    if (message.config.apiKey) {
      chrome.storage.local.set({ ttsApiKey: message.config.apiKey });
    }
    if (message.config.voiceId) {
      chrome.storage.local.set({ ttsVoiceId: message.config.voiceId });
    }
    console.log('[bots-in-calls] TTS config updated');
    sendResponse({ ok: true });
    return;
  }

  // --- Open the whiteboard tab ---
  if (message.action === 'open-whiteboard') {
    // IMPORTANT: chrome-extension:// URLs break Meet's screen sharing for the
    // entire session. Whiteboard must be hosted on a real domain.
    const url = message.url || 'https://vibeconferencing.vercel.app';

    if (whiteboardTabId !== null) {
      chrome.tabs.get(whiteboardTabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          chrome.tabs.create({ url, active: false }, (tab) => {
            whiteboardTabId = tab.id;
            sendResponse({ tabId: tab.id });
          });
        } else {
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

  // --- Update whiteboard content ---
  if (message.action === 'update-whiteboard' && whiteboardTabId !== null) {
    chrome.tabs.sendMessage(whiteboardTabId, message, (response) => {
      sendResponse(response || { ok: true });
    });
    return true;
  }

  // --- Forward messages from popup → content script in the Meet tab ---
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
