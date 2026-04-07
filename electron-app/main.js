// main.js — Electron main process
// Manages Meet BrowserView + panel sidebar in a single window,
// IPC routing, TTS, and sync.

const { app, BrowserWindow, BrowserView, ipcMain, session, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const Store = require('./store.js');

// ---------------------------------------------------------------------------
// Load extension modules (they export on globalThis)
// The extension files live under the root package.json which has "type": "module",
// so require() fails. We load them as text and run in the current context.
// ---------------------------------------------------------------------------

// In packaged app, extension files are in Resources/extension; in dev, they're in ../extension
const EXT_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'extension')
  : path.join(__dirname, '..', 'extension');

// Expose Node modules on globalThis so vm-loaded scripts can use them
globalThis.require = require;

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
  onBotSpeech: (text, voice) => {
    console.log('[electron] Bot speech from sync:', text.slice(0, 80), voice ? `(voice: ${voice})` : '');
    speakText(text, voice);
  },
});

// ---------------------------------------------------------------------------
// Config store & window refs
// ---------------------------------------------------------------------------

let store;
let mainWindow = null;   // single window that holds both views
let panelView = null;     // left sidebar BrowserView
let meetView = null;      // right Meet BrowserView
let whiteboardWindow = null;

const PANEL_WIDTH = 380;

// Read page-inject.js source once at startup
const pageInjectCode = fs.readFileSync(path.join(EXT_DIR, 'page-inject.js'), 'utf-8');
const testSpeechPath = path.join(EXT_DIR, 'test-speech.mp3');

// Chrome-like user agent to avoid Google blocking
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// CLI argument parsing — supports --meet-url, --bot-name, --sync-url, --devtools
// ---------------------------------------------------------------------------

function parseCLIArgs() {
  const args = process.argv.slice(1); // skip electron binary
  const result = {};
  for (const arg of args) {
    const match = arg.match(/^--(\w[\w-]*)=(.+)$/);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

const cliArgs = parseCLIArgs();

// ---------------------------------------------------------------------------
// Helper: speak text via TTS → send audio to Meet view
// ---------------------------------------------------------------------------

function speakText(text, voice) {
  // Temporarily override voice if specified (works for both macOS and ElevenLabs)
  const originalMacVoice = tts.macosVoice;
  const originalELVoice = tts.voiceId;
  if (voice) {
    tts.updateConfig({ macosVoice: voice });
    // If it looks like an ElevenLabs voice ID, also set voiceId
    if (voice.length > 15) tts.updateConfig({ voiceId: voice });
  }

  tts.synthesize(text)
    .then((audioBuffer) => {
      const base64Audio = Buffer.from(audioBuffer).toString('base64');
      // Unmute mic before speaking
      if (meetView && !meetView.webContents.isDestroyed()) {
        meetView.webContents.send('extension-message', { action: 'unmute-mic' });
        setTimeout(() => {
          meetView.webContents.send('extension-message', {
            action: 'play-tts',
            payload: { audioData: base64Audio },
          });
        }, 300);
      }
    })
    .catch((err) => {
      console.error('[electron] TTS error:', err.message);
      broadcastError('TTS: ' + err.message.slice(0, 120));
    })
    .finally(() => {
      // Restore original voices after one-off override
      if (voice) {
        tts.updateConfig({ macosVoice: originalMacVoice });
        tts.voiceId = originalELVoice;
      }
    });
}

function broadcastError(message) {
  if (panelView && !panelView.webContents.isDestroyed()) {
    panelView.webContents.send('extension-message', { action: 'error', message });
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
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ---------------------------------------------------------------------------
// Auto-install MCP config + Claude skill on first launch
// ---------------------------------------------------------------------------

function ensureClaudeIntegration() {
  const home = process.env.HOME || process.env.USERPROFILE;
  const claudeDir = path.join(home, '.claude');
  const claudeJsonPath = path.join(home, '.claude.json');
  const skillDir = path.join(claudeDir, 'skills', 'join-call');
  const skillPath = path.join(skillDir, 'SKILL.md');

  // Determine paths based on whether we're packaged or in dev
  const isPackaged = app.isPackaged;
  const mcpServerPath = isPackaged
    ? path.join(process.resourcesPath, 'mcp-server', 'server.js')
    : path.join(__dirname, '..', 'mcp-server', 'server.js');
  const appLaunchCmd = isPackaged
    ? 'open -a Vibeconferencing'
    : `cd ${__dirname} && npx electron .`;

  let changed = false;

  // --- Ensure global MCP config in ~/.claude.json ---
  let claudeJson = {};
  try {
    claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
  } catch {}

  if (!claudeJson.mcpServers) claudeJson.mcpServers = {};

  const currentMcp = claudeJson.mcpServers.vibeconferencing;
  if (!currentMcp) {
    claudeJson.mcpServers.vibeconferencing = {
      command: 'node',
      args: [mcpServerPath],
      env: {
        VIBECONF_ROOM_ID: '',
        VIBECONF_BOT_NAME: 'AI Assistant',
        VIBECONF_BASE_URL: 'https://vibeconferencing-git-staging-lets-vibe.vercel.app',
      },
    };
    fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2) + '\n');
    console.log('[electron] Installed global MCP config at', claudeJsonPath);
    changed = true;
  } else {
    console.log('[electron] Global MCP config already present');
  }

  // --- Ensure global skill in ~/.claude/skills/join-call/ ---
  if (!fs.existsSync(skillPath)) {
    fs.mkdirSync(skillDir, { recursive: true });
    const skillContent = `---
name: join-call
description: Join the user's current Google Meet call as an AI bot participant
disable-model-invocation: true
allowed-tools: Bash mcp__vibeconferencing__get_room_info mcp__vibeconferencing__wait_for_speech mcp__vibeconferencing__speak mcp__vibeconferencing__update_whiteboard mcp__vibeconferencing__read_transcripts
---

Join the user's current Google Meet call as an AI bot participant.

## Step 1: Find the Meet URL and launch

Run this AppleScript to find a Google Meet URL in Chrome:

\`\`\`
osascript -e '
tell application "Google Chrome"
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t starts with "https://meet.google.com/" then
        return URL of t
      end if
    end repeat
  end repeat
end tell
'
\`\`\`

If no Meet URL is found, ask the user for the Meet URL.

Extract the meet code from the URL (the \`xxx-xxxx-xxx\` part after \`meet.google.com/\`).

Kill any existing instance and launch the Electron app:

\`\`\`
pkill -f "Vibeconferencing" 2>/dev/null; sleep 1
${appLaunchCmd} \\
  --meet-url=<MEET_URL> \\
  --bot-name="AI Assistant" \\
  --sync-url=https://vibeconferencing-git-staging-lets-vibe.vercel.app &
disown
\`\`\`

Use "AI Assistant" as the default bot name, or $ARGUMENTS if provided.

## Step 2: Start the conversation loop immediately

Don't wait for admission — the long-poll will block until speech arrives. Use the meet code as \`room_id\` for all MCP tool calls.

1. Call \`wait_for_speech\` to listen (blocks until someone speaks and pauses)
2. Respond naturally using \`speak\` — keep it to 1-2 sentences since it's spoken aloud
3. If the conversation involves visual content (code, diagrams, lists), also call \`update_whiteboard\` with markdown or Mermaid
4. Go back to step 1

Guidelines:
- Be a helpful, natural conversational participant
- Keep spoken responses short — people can ask you to elaborate
- Use the whiteboard for anything visual (code, diagrams, structured info)
- If someone says goodbye or asks you to leave, stop the loop
- If \`wait_for_speech\` times out with no speech, call it again — people may just be quiet
`;
    fs.writeFileSync(skillPath, skillContent);
    console.log('[electron] Installed global skill at', skillPath);
    changed = true;
  } else {
    console.log('[electron] Global skill already present');
  }

  if (changed) {
    console.log('[electron] Claude integration installed. Restart Claude Code to pick up MCP changes.');
  }
}

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));

  // Check/install Claude integration
  ensureClaudeIntegration();

  // Load saved config
  const savedConfig = store.getMultiple(['ttsApiKey', 'ttsVoiceId', 'botName', 'syncBaseUrl', 'macosVoice']);
  if (savedConfig.ttsApiKey) {
    tts.updateConfig({ apiKey: savedConfig.ttsApiKey });
    stt.updateConfig({ apiKey: savedConfig.ttsApiKey });
  }
  if (savedConfig.ttsVoiceId) tts.updateConfig({ voiceId: savedConfig.ttsVoiceId });
  if (savedConfig.macosVoice) tts.updateConfig({ macosVoice: savedConfig.macosVoice });
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

  // Set dock icon on macOS
  if (process.platform === 'darwin' && app.dock) {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
    app.dock.setIcon(icon);
  }

  createMainWindow();
  setupIPC();

  // Auto-join if launched with --meet-url
  if (cliArgs['meet-url']) {
    const meetUrl = cliArgs['meet-url'];
    const botName = cliArgs['bot-name'];
    const syncUrl = cliArgs['sync-url'];
    if (botName) {
      sync.updateConfig({ botName });
      store.set('botName', botName);
    }
    if (syncUrl) {
      sync.updateConfig({ baseUrl: syncUrl });
      store.set('syncBaseUrl', syncUrl);
    }
    console.log('[electron] Auto-joining:', meetUrl);
    loadMeetURL(meetUrl);

    // Extract meet code and start sync
    const meetCode = meetUrl.replace(/.*meet\.google\.com\//, '').replace(/\?.*/, '');
    if (meetCode) {
      sync.updateConfig({ roomId: meetCode });
      sync.ensureRoom().then(() => {
        sync.startPolling();
        console.log('[electron] Sync started for room:', meetCode);
      });
    }
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

// ---------------------------------------------------------------------------
// Window creation — single window with panel sidebar + Meet view
// ---------------------------------------------------------------------------

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 960 + PANEL_WIDTH,
    height: 600,
    title: 'Vibeconferencing',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      // Main window itself doesn't load content — views do
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // --- Panel sidebar (left) ---
  panelView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-panel.js'),
      contextIsolation: true,
    },
  });
  mainWindow.addBrowserView(panelView);
  panelView.webContents.loadFile(path.join(__dirname, 'renderer', 'panel.html'));

  // --- Meet view (right) ---
  meetView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-meet.js'),
      contextIsolation: false,
      sandbox: false,
    },
  });
  mainWindow.addBrowserView(meetView);

  // Mute audio output so the user doesn't hear themselves echoed back
  meetView.webContents.setAudioMuted(true);

  // Zoom out the Meet view
  meetView.webContents.on('dom-ready', () => {
    meetView.webContents.setZoomFactor(0.75);
  });

  // Open DevTools only if --devtools flag is passed
  if (cliArgs['devtools']) {
    meetView.webContents.openDevTools({ mode: 'detach' });
  }

  // Layout views on resize
  function layoutViews() {
    if (mainWindow.isDestroyed()) return;
    const [width, height] = mainWindow.getContentSize();
    panelView.setBounds({ x: 0, y: 0, width: PANEL_WIDTH, height });
    meetView.setBounds({ x: PANEL_WIDTH, y: 0, width: width - PANEL_WIDTH, height });
  }
  layoutViews();
  mainWindow.on('resize', layoutViews);

  // Load a placeholder in the Meet view
  meetView.webContents.loadURL('about:blank');

  mainWindow.on('closed', () => {
    mainWindow = null;
    panelView = null;
    meetView = null;
    sync.stopPolling();
  });
}

function loadMeetURL(meetUrl) {
  if (!meetView || meetView.webContents.isDestroyed()) return;

  meetView.webContents.loadURL(meetUrl);

  meetView.webContents.on('did-finish-load', () => {
    const url = meetView.webContents.getURL();
    if (url.includes('meet.google.com')) {
      // Notify panel that Meet is loaded
      if (panelView && !panelView.webContents.isDestroyed()) {
        panelView.webContents.send('meet-status', { url, ready: true });
      }
    }
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
    loadMeetURL(meetUrl);
  });

  ipcMain.on('get-meet-status', (event) => {
    if (meetView && !meetView.webContents.isDestroyed()) {
      event.returnValue = { url: meetView.webContents.getURL(), ready: true };
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
    if (!meetView || meetView.webContents.isDestroyed()) return;
    const audioBuffer = fs.readFileSync(testSpeechPath);
    const base64Audio = Buffer.from(audioBuffer).toString('base64');
    meetView.webContents.send('extension-message', { action: 'unmute-mic' });
    setTimeout(() => {
      meetView.webContents.send('extension-message', {
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

  // --- Bot joined call: speak introduction via TTS ---
  ipcMain.on('bot-joined-call', (_event, { meetCode, botName }) => {
    console.log('[electron] Bot joined call, speaking introduction');
    speakText(`Hello. I am ${botName}, an AI agent.`);
  });

  // --- Meet status updates (logged, DOM updated by preload) ---
  ipcMain.on('meet-status-update', (_event, status) => {
    console.log('[electron] Meet status:', status);
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
    if ('apiKey' in config) {
      stt.updateConfig({ apiKey: config.apiKey });
      if (config.apiKey) {
        store.set('ttsApiKey', config.apiKey);
      } else {
        store.delete('ttsApiKey');
      }
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
    if (panelView && !panelView.webContents.isDestroyed()) {
      panelView.webContents.send('extension-message', message);
    }
  });

  // --- Forward messages from panel to Meet content script ---
  ipcMain.on('to-meet', (_event, message) => {
    if (meetView && !meetView.webContents.isDestroyed()) {
      meetView.webContents.send('extension-message', message);
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
