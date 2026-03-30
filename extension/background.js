// background.js — Extension service worker.
// Routes messages between the popup and Meet tab content scripts.
// Manages the whiteboard tab and TTS.

importScripts('tts.js', 'sync-client.js');

let whiteboardTabId = null;
const tts = new TTSProvider();
const sync = new SyncClient({
  onBotSpeech: (text) => {
    // When the backend posts a transcript for the bot, speak it via TTS
    console.log('[bots-in-calls] >>> onBotSpeech triggered, speaking:', text.slice(0, 80));
    speakText(text);
  },
});

// Log sync client config for debugging
console.log('[bots-in-calls] SyncClient created, botName:', sync.botName);

// Helper: synthesize and play text through the Meet tab
function speakText(text) {
  tts.synthesize(text)
    .then((audioBuffer) => {
      const bytes = new Uint8Array(audioBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const base64Audio = btoa(binary);

      chrome.tabs.query({ url: 'https://meet.google.com/*' }, (tabs) => {
        if (tabs.length > 0) {
          chrome.tabs.sendMessage(tabs[0].id, {
            target: 'page',
            action: 'play-tts',
            payload: { audioData: base64Audio },
          });
        }
      });
    })
    .catch((err) => {
      console.error('[bots-in-calls] TTS error:', err.message);
    });
}

// Load config from storage on startup
chrome.storage.local.get(['ttsApiKey', 'ttsVoiceId', 'botName', 'syncBaseUrl'], (result) => {
  if (result.ttsApiKey) tts.updateConfig({ apiKey: result.ttsApiKey });
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
        console.log('[bots-in-calls] Room creation failed, polling anyway (room may already exist)');
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

// ---------------------------------------------------------------------------
// Early media API injection — runs via chrome.scripting.executeScript which
// bypasses CSP (inline <script> injection gets blocked in signed-in profiles).
// Triggered on navigation to meet.google.com, before page scripts run.
// ---------------------------------------------------------------------------

function earlyMediaPatch() {
  if (window.__botsInCallsEarlyPatched) return;
  window.__botsInCallsEarlyPatched = true;

  var _getUserMedia = MediaDevices.prototype.getUserMedia;
  var _getDisplayMedia = MediaDevices.prototype.getDisplayMedia;
  var _enumerateDevices = MediaDevices.prototype.enumerateDevices;
  var _permissionsQuery = Permissions.prototype.query;

  window.__botsInCallsOriginalGUM = _getUserMedia;
  window.__botsInCallsOriginalGDM = _getDisplayMedia;
  window.__botsInCallsPendingGUM = [];

  MediaDevices.prototype.getUserMedia = function() {
    if (window.__botsInCallsGetUserMedia) {
      return window.__botsInCallsGetUserMedia.apply(this, arguments);
    }
    var args = arguments, ctx = this;
    return new Promise(function(resolve, reject) {
      window.__botsInCallsPendingGUM.push({ args: args, context: ctx, resolve: resolve, reject: reject });
      console.log('[bots-in-calls] Early: getUserMedia queued');
    });
  };

  MediaDevices.prototype.getDisplayMedia = function() {
    if (window.__botsInCallsGetDisplayMedia) {
      return window.__botsInCallsGetDisplayMedia.apply(this, arguments);
    }
    return _getDisplayMedia.call(this, arguments[0]);
  };

  MediaDevices.prototype.enumerateDevices = async function() {
    var devices = await _enumerateDevices.call(navigator.mediaDevices);
    var hasAudio = devices.some(function(d) { return d.kind === 'audioinput'; });
    var hasVideo = devices.some(function(d) { return d.kind === 'videoinput'; });
    var extras = [];
    if (!hasAudio) extras.push({ deviceId: 'virtual-mic', kind: 'audioinput', label: 'Virtual Microphone', groupId: 'bots-in-calls', toJSON: function() { return this; } });
    if (!hasVideo) extras.push({ deviceId: 'virtual-camera', kind: 'videoinput', label: 'Virtual Camera', groupId: 'bots-in-calls', toJSON: function() { return this; } });
    if (extras.length > 0) console.log('[bots-in-calls] Early: added', extras.length, 'virtual device(s)');
    return devices.concat(extras);
  };

  Permissions.prototype.query = async function(desc) {
    if (desc.name === 'microphone' || desc.name === 'camera') {
      var s = new EventTarget(); s.state = 'granted'; s.onchange = null;
      return s;
    }
    return _permissionsQuery.call(this, desc);
  };

  console.log('[bots-in-calls] Early: all media APIs patched via scripting.executeScript');
}

// Inject early patches when navigating to Meet
chrome.webNavigation.onCommitted.addListener(
  (details) => {
    if (details.frameId !== 0) return; // main frame only
    console.log('[bots-in-calls] Meet navigation detected, injecting early patches');
    chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      func: earlyMediaPatch,
      world: 'MAIN',
      injectImmediately: true,
    }).catch(err => console.error('[bots-in-calls] Early inject failed:', err));
  },
  { url: [{ hostEquals: 'meet.google.com' }] }
);

// Open side panel when clicking the extension icon (instead of popup)
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })
  .then(() => console.log('[bots-in-calls] Side panel enabled'))
  .catch(() => console.log('[bots-in-calls] Side panel not available, using popup'));

console.log('[bots-in-calls] Service worker started');
