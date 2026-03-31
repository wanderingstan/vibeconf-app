// background.js — Extension service worker.
// Routes messages between the popup and Meet tab content scripts.
// Manages the whiteboard tab and TTS.

importScripts('tts.js', 'stt.js', 'sync-client.js');

let whiteboardTabId = null;
const tts = new TTSProvider();
const stt = new STTProvider();
const sync = new SyncClient({
  onBotSpeech: (text) => {
    // When the backend posts a transcript for the bot, speak it via TTS
    console.log('[bots-in-calls] >>> onBotSpeech triggered, speaking:', text.slice(0, 80));
    speakText(text);
  },
});

// Log sync client config for debugging
console.debug('[bots-in-calls] SyncClient created, botName:', sync.botName);

// Broadcast errors to the side panel / popup
function broadcastError(message) {
  chrome.runtime.sendMessage({ action: 'error', message }).catch(() => {});
}

// Helper: synthesize and play text through the Meet tab
// Unmutes mic before speaking, mutes after.
function speakText(text) {
  tts.synthesize(text)
    .then((audioBuffer) => {
      const bytes = new Uint8Array(audioBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const base64Audio = btoa(binary);

      chrome.tabs.query({ url: 'https://meet.google.com/*' }, (tabs) => {
        if (tabs.length > 0) {
          const tabId = tabs[0].id;
          // Unmute before speaking
          chrome.tabs.sendMessage(tabId, { action: 'unmute-mic' });

          chrome.tabs.sendMessage(tabId, {
            target: 'page',
            action: 'play-tts',
            payload: { audioData: base64Audio },
          });
          // Mic will be muted by content script when tts-ended event fires
        }
      });
    })
    .catch((err) => {
      console.error('[bots-in-calls] TTS error:', err.message);
      broadcastError('TTS: ' + err.message.slice(0, 120));
    });
}

// Load config from storage on startup
chrome.storage.local.get(['ttsApiKey', 'ttsVoiceId', 'botName', 'syncBaseUrl'], (result) => {
  if (result.ttsApiKey) {
    tts.updateConfig({ apiKey: result.ttsApiKey });
    stt.updateConfig({ apiKey: result.ttsApiKey }); // same key for STT
  }
  if (result.ttsVoiceId) tts.updateConfig({ voiceId: result.ttsVoiceId });
  if (result.botName) sync.updateConfig({ botName: result.botName });
  if (result.syncBaseUrl) sync.updateConfig({ baseUrl: result.syncBaseUrl });
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
    speakText(text);
    sendResponse({ ok: true });
    return;
  }

  // --- STT: transcribe audio blob ---
  if (message.action === 'transcribe') {
    const { audioBase64 } = message;
    if (!audioBase64) {
      sendResponse({ error: 'No audio data' });
      return;
    }
    // Decode base64 to blob
    const binary = atob(audioBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'audio/webm;codecs=opus' });

    console.log('[bots-in-calls] STT request:', (blob.size / 1024).toFixed(1), 'KB');

    stt.transcribe(blob)
      .then((result) => {
        if (result?.text?.trim()) {
          console.log('[bots-in-calls] STT result:', result.text.slice(0, 80));

          // If from tabCapture, forward the transcript to the Meet tab
          if (message.source === 'tabCapture') {
            chrome.tabs.query({ url: 'https://meet.google.com/*' }, (tabs) => {
              if (tabs.length > 0) {
                chrome.tabs.sendMessage(tabs[0].id, {
                  action: 'stt-result',
                  text: result.text.trim(),
                });
              }
            });
          }
        }
        sendResponse({ ok: true, ...result });
      })
      .catch((err) => {
        console.error('[bots-in-calls] STT error:', err.message);
        broadcastError('STT: ' + err.message.slice(0, 120));
        sendResponse({ error: err.message });
      });
    return true; // async
  }

  // --- Sync: post transcripts to vibeconferencing backend ---
  if (message.action === 'post-transcripts') {
    sync.postTranscripts(message.transcripts || []);
    sendResponse({ ok: true });
    return;
  }

  // --- Sync: start syncing with a Meet room ---
  if (message.action === 'start-sync') {
    const meetCode = message.meetCode;
    if (!meetCode) {
      sendResponse({ error: 'No Meet code provided' });
      return;
    }
    sync.updateConfig({ roomId: meetCode });
    if (message.botName) sync.updateConfig({ botName: message.botName });

    sync.ensureRoom().then((ok) => {
      if (!ok) {
        console.debug('[bots-in-calls] Room creation failed, polling anyway (room may already exist)');
      }
      // Always start polling — room might already exist even if create failed
      sync.startPolling();
      sendResponse({ ok: true, roomId: meetCode });
    });
    return true; // async response
  }

  // --- Sync: stop syncing ---
  if (message.action === 'stop-sync') {
    sync.stopPolling();
    sendResponse({ ok: true });
    return;
  }

  // --- TTS config update ---
  if (message.action === 'update-tts-config') {
    tts.updateConfig(message.config);
    if (message.config.apiKey) {
      stt.updateConfig({ apiKey: message.config.apiKey }); // share key with STT
      chrome.storage.local.set({ ttsApiKey: message.config.apiKey });
    }
    if (message.config.voiceId) {
      chrome.storage.local.set({ ttsVoiceId: message.config.voiceId });
    }
    console.debug('[bots-in-calls] TTS config updated');
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

// ---------------------------------------------------------------------------
// Tab audio capture via offscreen document for ElevenLabs STT
// ---------------------------------------------------------------------------

let captureActive = false;

async function ensureOffscreenAndCapture(streamId) {
  if (captureActive) return;

  try {
    // Create offscreen document if it doesn't exist
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA'],
        justification: 'Capture tab audio for speech-to-text transcription',
      });
      console.log('[bots-in-calls] Offscreen document created');
    }

    // Tell the offscreen document to start capturing
    chrome.runtime.sendMessage({
      action: 'start-capture',
      streamId,
    });

    captureActive = true;
    console.log('[bots-in-calls] Tab audio capture started');
  } catch (err) {
    console.error('[bots-in-calls] Offscreen/capture setup failed:', err.message);
    broadcastError('Audio capture: ' + err.message.slice(0, 100));
  }
}

// Toolbar icon click: open side panel AND start tab capture.
// Using action.onClicked (not openPanelOnActionClick) because it
// properly grants activeTab permission needed for chrome.tabCapture.
// Set side panel path (must be done before opening)
chrome.sidePanel.setOptions({ path: 'popup.html' }).catch(() => {});

chrome.action.onClicked.addListener((tab) => {
  console.log('[bots-in-calls] Action clicked, tab:', tab.id, tab.url?.slice(0, 40));

  // Start tab capture FIRST (synchronously in user gesture context)
  if (tab.url?.startsWith('https://meet.google.com/')) {
    chrome.tabCapture.getMediaStreamId({}, (streamId) => {
      if (chrome.runtime.lastError) {
        console.error('[bots-in-calls] tabCapture error:', chrome.runtime.lastError.message);
        broadcastError('Audio capture: ' + chrome.runtime.lastError.message);
      } else {
        console.log('[bots-in-calls] Got tab capture stream ID:', streamId?.slice(0, 20));
        ensureOffscreenAndCapture(streamId);
      }
    });
  }

  // Open side panel
  chrome.sidePanel.open({ tabId: tab.id }).catch((e) => {
    console.debug('[bots-in-calls] Side panel open error:', e.message);
  });
});

console.log('[bots-in-calls] Service worker started');
