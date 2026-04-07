// main.js — Electron main process
// Manages Meet BrowserWindow, control panel, IPC routing, TTS, and sync.

const { app, BrowserWindow, ipcMain, session, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const Store = require('./store.js');

// ---------------------------------------------------------------------------
// Load extension modules (they export on globalThis)
// The extension files live under the root package.json which has "type": "module",
// so require() fails. We load them as text and run in the current context.
// ---------------------------------------------------------------------------

const EXT_DIR = path.join(__dirname, '..', 'extension');

function loadExtensionScript(filename) {
  const code = fs.readFileSync(path.join(EXT_DIR, filename), 'utf-8');
  vm.runInThisContext(code, { filename });
}

loadExtensionScript('tts.js');
loadExtensionScript('stt.js');
loadExtensionScript('sync-client.js');

const tts = new globalThis.TTSProvider();
const stt = new globalThis.STTProvider();
const sync = new globalThis.SyncClient({
  onBotSpeech: (text) => {
    console.log('[electron] Bot speech from sync:', text.slice(0, 80));
    speakText(text);
  },
});

// ---------------------------------------------------------------------------
// Config store
// ---------------------------------------------------------------------------

let store;
let meetWindow = null;
let panelWindow = null;
let whiteboardWindow = null;

// Read page-inject.js source once at startup
const pageInjectCode = fs.readFileSync(path.join(EXT_DIR, 'page-inject.js'), 'utf-8');
const testSpeechPath = path.join(EXT_DIR, 'test-speech.mp3');

// Chrome-like user agent to avoid Google blocking
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Helper: speak text via TTS → send audio to Meet window
// ---------------------------------------------------------------------------

function speakText(text) {
  tts.synthesize(text)
    .then((audioBuffer) => {
      const base64Audio = Buffer.from(audioBuffer).toString('base64');
      // Unmute mic before speaking
      if (meetWindow && !meetWindow.isDestroyed()) {
        meetWindow.webContents.send('extension-message', { action: 'unmute-mic' });
        setTimeout(() => {
          meetWindow.webContents.send('extension-message', {
            action: 'play-tts',
            payload: { audioData: base64Audio },
          });
        }, 300);
      }
    })
    .catch((err) => {
      console.error('[electron] TTS error:', err.message);
      broadcastError('TTS: ' + err.message.slice(0, 120));
    });
}

function broadcastError(message) {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send('extension-message', { action: 'error', message });
  }
}

// ---------------------------------------------------------------------------
// Speaking state — debounced presence updates
// ---------------------------------------------------------------------------

const speakingState = new Map();

function updateSpeakingState(name, speaking) {
  const existing = speakingState.get(name);
  if (existing && existing.speaking === speaking && existing.sent) return;

  speakingState.set(name, { speaking, sent: false, timer: existing?.timer });

  if (existing?.timer) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    const state = speakingState.get(name);
    if (!state || state.sent) return;
    state.sent = true;

    const baseUrl = sync.baseUrl || 'https://vibeconferencing.com';
    fetch(`${baseUrl}/api/room/${sync.roomId}/presence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, speaking }),
    }).catch(err => {
      console.debug('[electron] Speaking state update failed:', err.message);
    });
  }, 1000);
  speakingState.get(name).timer = timer;
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Single instance — quit if another instance is already running
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('[electron] Another instance is running, quitting.');
  app.quit();
}
app.on('second-instance', () => {
  // Focus existing windows when a second instance tries to launch
  if (panelWindow && !panelWindow.isDestroyed()) {
    if (panelWindow.isMinimized()) panelWindow.restore();
    panelWindow.focus();
  }
});

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));

  // Load saved config
  const savedConfig = store.getMultiple(['ttsApiKey', 'ttsVoiceId', 'botName', 'syncBaseUrl']);
  if (savedConfig.ttsApiKey) {
    tts.updateConfig({ apiKey: savedConfig.ttsApiKey });
    stt.updateConfig({ apiKey: savedConfig.ttsApiKey });
  }
  if (savedConfig.ttsVoiceId) tts.updateConfig({ voiceId: savedConfig.ttsVoiceId });
  if (savedConfig.botName) sync.updateConfig({ botName: savedConfig.botName });
  if (savedConfig.syncBaseUrl) sync.updateConfig({ baseUrl: savedConfig.syncBaseUrl });

  // Strip Content-Security-Policy headers from Meet responses.
  // Meet's Trusted Types CSP blocks our page-inject.js eval() in the preload.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    delete headers['content-security-policy'];
    delete headers['Content-Security-Policy'];
    delete headers['content-security-policy-report-only'];
    delete headers['Content-Security-Policy-Report-Only'];
    callback({ responseHeaders: headers });
  });

  // Auto-grant media permissions
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (['media', 'microphone', 'camera', 'display-capture'].includes(permission)) {
      callback(true);
    } else {
      callback(false);
    }
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    if (['media', 'microphone', 'camera', 'display-capture'].includes(permission)) {
      return true;
    }
    return false;
  });

  // Set Chrome-like user agent
  session.defaultSession.setUserAgent(CHROME_UA);

  createPanelWindow();
  setupIPC();
});

app.on('window-all-closed', () => {
  app.quit();
});

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

function createMeetWindow(meetUrl) {
  if (meetWindow && !meetWindow.isDestroyed()) {
    meetWindow.loadURL(meetUrl);
    meetWindow.focus();
    return;
  }

  meetWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Vibeconferencing Agent — Meet',
    webPreferences: {
      preload: path.join(__dirname, 'preload-meet.js'),
      contextIsolation: false, // allows preload to run in page's world (needed to patch getUserMedia before Meet's scripts)
      sandbox: false,
    },
  });

  // Open DevTools for debugging (remove once stable)
  meetWindow.webContents.openDevTools({ mode: 'detach' });

  meetWindow.webContents.on('did-finish-load', () => {
    const url = meetWindow.webContents.getURL();
    if (url.includes('meet.google.com')) {
      // Notify panel that Meet is loaded
      if (panelWindow && !panelWindow.isDestroyed()) {
        panelWindow.webContents.send('meet-status', { url, ready: true });
      }
    }
  });

  meetWindow.on('closed', () => {
    meetWindow = null;
    sync.stopPolling();
  });

  meetWindow.loadURL(meetUrl);
}

function createPanelWindow() {
  panelWindow = new BrowserWindow({
    width: 380,
    height: 700,
    title: 'Vibeconferencing Agent',
    webPreferences: {
      preload: path.join(__dirname, 'preload-panel.js'),
      contextIsolation: true,
    },
  });

  panelWindow.loadFile(path.join(__dirname, 'renderer', 'panel.html'));

  panelWindow.on('closed', () => {
    panelWindow = null;
  });
}

// ---------------------------------------------------------------------------
// IPC routing — replaces chrome.runtime.onMessage
// ---------------------------------------------------------------------------

function setupIPC() {
  // --- Config ---
  ipcMain.handle('get-config', (_event, keys) => {
    return store.getMultiple(keys);
  });

  ipcMain.handle('set-config', (_event, key, value) => {
    store.set(key, value);
  });

  // --- Meet window management ---
  ipcMain.on('join-meet', (_event, meetUrl) => {
    createMeetWindow(meetUrl);
  });

  ipcMain.on('get-meet-status', (event) => {
    if (meetWindow && !meetWindow.isDestroyed()) {
      event.returnValue = { url: meetWindow.webContents.getURL(), ready: true };
    } else {
      event.returnValue = { url: null, ready: false };
    }
  });

  // --- TTS ---
  ipcMain.on('speak', (_event, text) => {
    if (!text) return;
    console.log('[electron] TTS request:', text.slice(0, 80));
    speakText(text);
  });

  ipcMain.on('play-speech-test', () => {
    if (!meetWindow || meetWindow.isDestroyed()) return;
    const audioBuffer = fs.readFileSync(testSpeechPath);
    const base64Audio = Buffer.from(audioBuffer).toString('base64');
    meetWindow.webContents.send('extension-message', { action: 'unmute-mic' });
    setTimeout(() => {
      meetWindow.webContents.send('extension-message', {
        action: 'play-tts',
        payload: { audioData: base64Audio },
      });
    }, 300);
  });

  // --- Sync ---
  ipcMain.on('start-sync', (_event, { meetCode, botName }) => {
    sync.updateConfig({ roomId: meetCode });
    if (botName) sync.updateConfig({ botName });
    sync.ensureRoom().then(() => {
      sync.startPolling();
      console.log('[electron] Sync started for room:', meetCode);
    });
  });

  ipcMain.on('stop-sync', () => {
    sync.stopPolling();
  });

  ipcMain.on('post-transcripts', (_event, transcripts) => {
    sync.postTranscripts(transcripts || []);
  });

  // --- Speaking state ---
  ipcMain.on('update-speaking', (_event, { name, speaking }) => {
    if (name && sync.roomId) {
      updateSpeakingState(name, speaking);
    }
  });

  // --- TTS config ---
  ipcMain.on('update-tts-config', (_event, config) => {
    tts.updateConfig(config);
    if (config.apiKey) {
      stt.updateConfig({ apiKey: config.apiKey });
      store.set('ttsApiKey', config.apiKey);
    }
    if (config.voiceId) {
      store.set('ttsVoiceId', config.voiceId);
    }
  });

  // --- Sync config ---
  ipcMain.on('update-sync-config', (_event, config) => {
    sync.updateConfig(config);
    if (config.baseUrl) store.set('syncBaseUrl', config.baseUrl);
  });

  // --- Forward messages from Meet content script to panel ---
  ipcMain.on('to-panel', (_event, message) => {
    if (panelWindow && !panelWindow.isDestroyed()) {
      panelWindow.webContents.send('extension-message', message);
    }
  });

  // --- Forward messages from panel to Meet content script ---
  ipcMain.on('to-meet', (_event, message) => {
    if (meetWindow && !meetWindow.isDestroyed()) {
      meetWindow.webContents.send('extension-message', message);
    }
  });

  // --- Whiteboard ---
  ipcMain.on('open-whiteboard', () => {
    if (whiteboardWindow && !whiteboardWindow.isDestroyed()) {
      whiteboardWindow.focus();
      return;
    }
    const baseUrl = store.get('syncBaseUrl') || 'https://vibeconferencing.com';
    whiteboardWindow = new BrowserWindow({ width: 1024, height: 768, title: 'Whiteboard' });
    whiteboardWindow.loadURL(baseUrl);
    whiteboardWindow.on('closed', () => { whiteboardWindow = null; });
  });
}
