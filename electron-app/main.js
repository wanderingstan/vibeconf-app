// main.js — Electron main process
// Manages Meet BrowserView + panel sidebar in a single window,
// IPC routing, TTS, and sync.

const { app, BrowserWindow, BrowserView, ipcMain, session, nativeImage, desktopCapturer, systemPreferences, dialog, Menu } = require('electron');
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
require('./local-server.js');

const tts = new globalThis.TTSProvider();
const stt = new globalThis.STTProvider();
const sync = new globalThis.SyncClient({
  onBotSpeech: (text, voice) => {
    console.log('[electron] Bot speech from sync:', text.slice(0, 80), voice ? `(voice: ${voice})` : '');
    speakText(text, voice);
  },
  getAuthCookie: async () => {
    try {
      const baseUrl = (store && store.get('syncBaseUrl')) || 'https://vibeconferencing.com';
      const cookies = await session.defaultSession.cookies.get({ url: baseUrl, name: 'vc_session' });
      return cookies.length > 0 ? cookies[0].value : null;
    } catch {
      return null;
    }
  },
});

// Local HTTP server for agent communication (replaces remote sync for MCP)
const localServer = new globalThis.LocalServer({
  onBotSpeech: (text, voice) => {
    console.log('[local-server] Bot speech:', text.slice(0, 80));
    speakText(text, voice);
  },
  onWhiteboardUpdate: (content, sender) => {
    console.log('[local-server] Whiteboard update from', sender, ':', content.slice(0, 80));
    // Forward to remote server if needed
  },
  onLeaveCall: () => {
    console.log('[local-server] Leave call requested by agent');
    // Trigger leave via the panel
    if (panelView && !panelView.webContents.isDestroyed()) {
      panelView.webContents.send('leave-requested');
    }
  },
  onShareWhiteboard: () => {
    console.log('[local-server] Share whiteboard requested by agent');
    const meetCode = localServer.roomId;
    if (meetCode) {
      // Reuse the existing share-whiteboard IPC logic
      ipcMain.emit('start-whiteboard-share', {}, { meetCode });
      // Wait for whiteboard to load, then trigger screen share in Meet
      setTimeout(() => {
        if (meetView && !meetView.webContents.isDestroyed()) {
          meetView.webContents.send('trigger-screen-share');
        }
      }, 2000);
    }
  },
  onStopSharing: () => {
    console.log('[local-server] Stop sharing requested by agent');
    // Close the whiteboard window — this ends the display media stream
    if (whiteboardWindow && !whiteboardWindow.isDestroyed()) {
      whiteboardWindow.close();
      whiteboardWindow = null;
    }
    // Also click Meet's stop-presenting button if visible
    if (meetView && !meetView.webContents.isDestroyed()) {
      meetView.webContents.send('trigger-stop-sharing');
    }
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

// Check if already logged in
async function checkAuth() {
  const baseUrl = store.get('syncBaseUrl') || 'https://vibeconferencing.com';
  const { net } = require('electron');

  // Get the session cookie manually to include it
  const cookies = await session.defaultSession.cookies.get({ url: baseUrl, name: 'vc_session' });
  const cookieHeader = cookies.length > 0 ? `vc_session=${cookies[0].value}` : '';

  return new Promise((resolve) => {
    const request = net.request(`${baseUrl}/api/auth/me`);
    if (cookieHeader) {
      request.setHeader('Cookie', cookieHeader);
    }
    let body = '';
    request.on('response', (response) => {
      response.on('data', (chunk) => { body += chunk.toString(); });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve({ authenticated: false }); }
      });
    });
    request.on('error', () => resolve({ authenticated: false }));
    request.end();
  });
}

// Open Google OAuth in the system browser
// Google blocks embedded webviews, so we must use the real browser.
// We start a local HTTP server to catch the session cookie after login.
function openGoogleLogin() {
  const baseUrl = store.get('syncBaseUrl') || 'https://vibeconferencing.com';
  const http = require('http');
  const { shell } = require('electron');
  const { net } = require('electron');

  // Create a temporary local server to receive the auth callback
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/auth-complete') {
      // Extract session token from query param
      const token = url.searchParams.get('token');
      if (token) {
        console.log('[electron] Received auth token, length:', token.length);
        // Set the cookie in Electron's session for the server URL
        session.defaultSession.cookies.set({
          url: baseUrl,
          name: 'vc_session',
          value: token,
          path: '/',
          httpOnly: true,
          secure: baseUrl.startsWith('https'),
          sameSite: 'lax',
          expirationDate: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        }).then(() => {
          console.log('[electron] Session cookie set successfully for', baseUrl);
          // Verify the cookie was set
          return session.defaultSession.cookies.get({ url: baseUrl, name: 'vc_session' });
        }).then(cookies => {
          console.log('[electron] Cookie verification:', cookies.length > 0 ? 'found' : 'NOT FOUND');
          // Now verify with the server
          return checkAuth();
        }).then(data => {
          console.log('[electron] Auth check after login:', data?.authenticated ? `logged in as ${data.user.name}` : 'NOT authenticated');
          if (panelView && !panelView.webContents.isDestroyed()) {
            panelView.webContents.send('auth-changed');
          }
        }).catch(err => {
          console.error('[electron] Login cookie error:', err);
        });
      } else {
        console.warn('[electron] No token in auth callback');
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>Signed in! You can close this tab.</h2><script>window.close()</script></body></html>');
      server.close();
      return;
    }

    res.writeHead(404);
    res.end();
  });

  // Find a free port and start
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const callbackUrl = `http://127.0.0.1:${port}/auth-complete`;
    const loginUrl = `${baseUrl}/api/auth/google?electron_callback=${encodeURIComponent(callbackUrl)}`;
    console.log('[electron] Opening Google login in system browser:', loginUrl);
    shell.openExternal(loginUrl);

    // Auto-close server after 5 minutes if no callback
    setTimeout(() => {
      server.close();
    }, 5 * 60 * 1000);
  });
}

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
      if (!audioBuffer) {
        console.error('[electron] TTS returned null/empty buffer');
        return;
      }
      const base64Audio = Buffer.from(audioBuffer).toString('base64');
      console.log('[electron] TTS synthesized:', text.slice(0, 40), '→', base64Audio.length, 'bytes base64');
      // Unmute mic before speaking
      if (meetView && !meetView.webContents.isDestroyed()) {
        meetView.webContents.send('extension-message', { action: 'unmute-mic' });
        setTimeout(() => {
          meetView.webContents.send('extension-message', {
            action: 'play-tts',
            payload: { audioData: base64Audio },
          });
          console.log('[electron] Sent play-tts to Meet view');
        }, 300);
      } else {
        console.error('[electron] Meet view not available for TTS playback');
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
// Terminal management — launch Claude and track the window for cleanup
// ---------------------------------------------------------------------------

let claudeTerminalWindowId = null;

function launchClaudeTerminal(meetCode) {
  const { execFile } = require('child_process');
  const claudeDir = store.get('claudeWorkDir') || '/tmp';
  const botName = store.get('botName') || 'AI Assistant';

  // Split screen: Terminal on left half, Electron on right half
  let termBounds = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const { screen } = require('electron');
    const display = screen.getDisplayMatching(mainWindow.getBounds());
    const { x: sx, y: sy, width: sw, height: sh } = display.workArea;
    const half = Math.floor(sw / 2);

    // Terminal takes left half
    termBounds = `${sx}, ${sy}, ${sx + half - 5}, ${sy + sh}`;

    // Move Electron window to right half
    mainWindow.setBounds({ x: sx + half + 5, y: sy, width: half - 5, height: sh });
    console.log('[electron] Split screen: terminal left, electron right (screen: %dx%d)', sw, sh);
  }

  // AppleScript that opens a new Terminal window and returns its ID
  const script = `tell application "Terminal"
  do script "cd ${claudeDir.replace(/"/g, '\\"')} && claude \\"/join-call ${meetCode} ${botName.replace(/"/g, '')}\\""
  activate
  return id of window 1
end tell`;

  execFile('osascript', ['-e', script], (err, stdout, stderr) => {
    if (err) {
      console.error('[electron] Failed to launch Claude:', err.message, stderr);
    } else {
      claudeTerminalWindowId = (stdout || '').trim();
      console.log('[electron] Launched Claude session, terminal window ID:', claudeTerminalWindowId);

      // Position the terminal window after a short delay to ensure it's fully created
      if (termBounds) {
        setTimeout(() => {
          const posScript = `tell application "Terminal"
  repeat with w in windows
    if id of w is ${claudeTerminalWindowId} then
      set bounds of w to {${termBounds}}
      return "positioned"
    end if
  end repeat
  return "window not found"
end tell`;
          execFile('osascript', ['-e', posScript], (posErr, posOut) => {
            if (posErr) console.error('[electron] Terminal positioning failed:', posErr.message);
            else console.log('[electron] Terminal positioning:', (posOut || '').trim());
          });
        }, 500);
      }
    }
  });
}

function closeClaudeTerminal() {
  if (!claudeTerminalWindowId) return;
  const { execFile } = require('child_process');
  const windowId = claudeTerminalWindowId;
  claudeTerminalWindowId = null;

  // First send Ctrl-C to interrupt Claude, wait for it to exit, then close
  const script = `tell application "Terminal"
  repeat with w in windows
    if id of w is ${windowId} then
      -- Send Ctrl-C to interrupt Claude, then exit the shell
      do script "exit" in w
      return "closing"
    end if
  end repeat
  return "not found"
end tell`;

  execFile('osascript', ['-e', script], (err, stdout) => {
    if (err) {
      console.error('[electron] Failed to signal Claude terminal:', err.message);
      return;
    }
    console.log('[electron] Claude terminal signal:', (stdout || '').trim());

    // Wait for Claude to exit, then close the window
    setTimeout(() => {
      const closeScript = `tell application "Terminal"
  repeat with w in windows
    if id of w is ${windowId} then
      close w
      return "closed"
    end if
  end repeat
  return "already gone"
end tell`;
      execFile('osascript', ['-e', closeScript], (err2, stdout2) => {
        if (err2) console.error('[electron] Failed to close Claude terminal:', err2.message);
        else console.log('[electron] Claude terminal:', (stdout2 || '').trim());
      });
    }, 3000);
  });
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

function ensureClaudeIntegration(localPort) {
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

  const localBaseUrl = `http://127.0.0.1:${localPort || 7865}`;
  const currentMcp = claudeJson.mcpServers.vibeconferencing;
  const needsUpdate = !currentMcp ||
    currentMcp.env?.VIBECONF_BASE_URL !== localBaseUrl ||
    currentMcp.args?.[0] !== mcpServerPath;

  if (needsUpdate) {
    claudeJson.mcpServers.vibeconferencing = {
      command: 'node',
      args: [mcpServerPath],
      env: {
        VIBECONF_ROOM_ID: '',
        VIBECONF_BOT_NAME: 'AI Assistant',
        VIBECONF_BASE_URL: localBaseUrl,
      },
    };
    fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2) + '\n');
    console.log('[electron] Updated MCP config → local server at', localBaseUrl);
    changed = true;
  } else {
    console.log('[electron] MCP config already pointing to local server');
  }

  // --- Ensure global skill in ~/.claude/skills/join-call/ ---
  // The skill is managed at ~/.claude/skills/join-call/SKILL.md
  // Only install a default if it doesn't exist yet
  if (!fs.existsSync(skillPath)) {
    fs.mkdirSync(skillDir, { recursive: true });
    const skillContent = `---
name: join-call
description: Join the user's current Google Meet call as an AI bot participant
argument-hint: "[room_code] [BotName]  — or just [BotName] to auto-detect"
disable-model-invocation: true
allowed-tools: Bash mcp__vibeconferencing__get_room_info mcp__vibeconferencing__wait_for_speech mcp__vibeconferencing__speak mcp__vibeconferencing__update_whiteboard mcp__vibeconferencing__read_transcripts mcp__vibeconferencing__list_voices mcp__vibeconferencing__set_voice mcp__vibeconferencing__leave_call
---

Join the user's current Google Meet call as an AI bot participant.

## Step 1: Determine the room code

Parse \`$ARGUMENTS\` for a meet code (pattern: \`xxx-xxxx-xxx\`). If found, use it directly. Any non-code argument is the bot name.

**If no room code in arguments**, detect from Chrome:
\`\`\`
osascript -e 'tell application "Google Chrome" to repeat with w in windows
  repeat with t in tabs of w
    if URL of t starts with "https://meet.google.com/" then return URL of t
  end repeat
end repeat'
\`\`\`

## Step 2: Launch the Electron app (if needed)

\`\`\`
pgrep -f "Vibeconferencing" >/dev/null 2>&1 && echo "RUNNING" || echo "NOT_RUNNING"
\`\`\`

If **NOT_RUNNING**, launch it:
\`\`\`
open -a Vibeconferencing --meet-url=https://meet.google.com/<ROOM_CODE> --bot-name="<BOT_NAME>" &
disown
\`\`\`

## Step 3: Start the conversation loop immediately

1. Call \`wait_for_speech\` to listen (blocks until someone speaks and pauses)
2. Respond naturally using \`speak\` — keep it to 1-2 sentences
3. If visual content is relevant, call \`update_whiteboard\` with markdown or Mermaid
4. Go back to step 1

Guidelines:
- Be a helpful, natural conversational participant
- Keep spoken responses short — people can ask you to elaborate
- Use the whiteboard for anything visual (code, diagrams, structured info)
- If someone says goodbye or asks you to leave, say goodbye via \`speak\`, then call \`leave_call\` to hang up. Then stop the loop.
- If \`wait_for_speech\` times out with no speech, call it again — people may just be quiet
- If someone asks you to change your voice, use \`list_voices\` then \`set_voice\`
- NEVER kill or relaunch the Vibeconferencing app during the conversation loop
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

app.whenReady().then(async () => {
  store = new Store(app.getPath('userData'));

  // Start local HTTP server for agent communication
  const localPort = await localServer.start();

  // Check/install Claude integration
  ensureClaudeIntegration(localPort);

  // Request microphone permission (needed for audio pipeline even with virtual mic)
  if (process.platform === 'darwin') {
    try {
      const micAccess = systemPreferences.getMediaAccessStatus('microphone');
      console.log('[electron] Microphone permission:', micAccess);
      if (micAccess !== 'granted') {
        systemPreferences.askForMediaAccess('microphone').then((granted) => {
          console.log('[electron] Microphone permission after prompt:', granted ? 'granted' : 'denied');
        }).catch(err => {
          console.error('[electron] Microphone permission prompt failed:', err.message);
        });
      }
    } catch (err) {
      console.error('[electron] Microphone permission check failed:', err.message);
    }
  }

  // Check screen recording permission (needed for whiteboard share)
  if (process.platform === 'darwin') {
    const screenAccess = systemPreferences.getMediaAccessStatus('screen');
    if (screenAccess !== 'granted') {
      console.warn('[electron] Screen recording permission not granted:', screenAccess);
      // Trigger a desktopCapturer call to prompt the OS permission dialog
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
        .then(() => {
          const newStatus = systemPreferences.getMediaAccessStatus('screen');
          if (newStatus !== 'granted') {
            dialog.showMessageBoxSync({
              type: 'warning',
              title: 'Screen Recording Permission',
              message: 'Vibeconferencing needs screen recording permission to share the whiteboard.\n\nPlease grant access in System Settings > Privacy & Security > Screen Recording, then restart the app.',
              buttons: ['OK'],
            });
          }
        })
        .catch(() => {});
    }
  }

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

  // Handle getDisplayMedia — share the whiteboard window if open, otherwise deny
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (whiteboardWindow && !whiteboardWindow.isDestroyed()) {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['window'],
          thumbnailSize: { width: 0, height: 0 },
        });
        const mediaSourceId = whiteboardWindow.getMediaSourceId();
        console.log('[electron] Display media request — looking for source:', mediaSourceId);
        console.log('[electron] Available sources:', sources.map(s => `${s.id} "${s.name}"`));

        const source = sources.find(s => s.id === mediaSourceId);
        if (source) {
          console.log('[electron] Matched whiteboard source:', source.id, source.name);
          callback({ video: source });
          return;
        }

        // Fallback: match by title
        const wbTitle = whiteboardWindow.getTitle();
        const fallback = sources.find(s => s.name.includes(wbTitle) || s.name.includes('Vibeconferencing'));
        if (fallback) {
          console.log('[electron] Matched whiteboard by title:', fallback.id, fallback.name);
          callback({ video: fallback });
          return;
        }

        console.warn('[electron] Could not find whiteboard in sources, trying webContents');
        callback({ video: whiteboardWindow.webContents });
      } catch (err) {
        console.error('[electron] Display media error:', err);
        callback({});
      }
    } else {
      console.log('[electron] Display media request → no whiteboard window, denying');
      callback({});
    }
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

  // Process CLI args FIRST so syncBaseUrl/botName are set before auto-login
  if (cliArgs['bot-name']) {
    sync.updateConfig({ botName: cliArgs['bot-name'] });
    store.set('botName', cliArgs['bot-name']);
  }
  if (cliArgs['sync-url']) {
    sync.updateConfig({ baseUrl: cliArgs['sync-url'] });
    store.set('syncBaseUrl', cliArgs['sync-url']);
  }

  // Check auth status on startup
  checkAuth().then(data => {
    if (data.authenticated) {
      console.log('[electron] Already logged in as', data.user.name);
    } else {
      console.log('[electron] Not logged in — user can click Log in button');
    }
  });

  // --- Meet detection: poll Chrome tabs for active Meet calls ---
  let detectedMeetUrl = null;
  let meetDetectionInterval = null;
  let currentMeetUrl = null; // Track what we've joined

  function startMeetDetection() {
    if (meetDetectionInterval) return;
    const { execFile } = require('child_process');
    let pollInFlight = false;

    const appleScript = `
set allURLs to ""
tell application "System Events"
  set chromeRunning to exists process "Google Chrome"
  set safariRunning to exists process "Safari"
end tell
if chromeRunning then
  tell application "Google Chrome"
    repeat with w in windows
      repeat with t in tabs of w
        set tabURL to URL of t
        if tabURL starts with "https://meet.google.com/" then
          set allURLs to allURLs & tabURL & linefeed
        end if
      end repeat
    end repeat
  end tell
end if
if safariRunning then
  tell application "Safari"
    repeat with w in windows
      repeat with t in tabs of w
        set tabURL to URL of t
        if tabURL starts with "https://meet.google.com/" then
          set allURLs to allURLs & tabURL & linefeed
        end if
      end repeat
    end repeat
  end tell
end if
allURLs`;

    console.log('[electron] Meet detection started');

    function pollForMeet() {
      if (currentMeetUrl || pollInFlight) return;
      pollInFlight = true;

      const pollStart = Date.now();
      execFile('osascript', ['-e', appleScript], { timeout: 8000 }, (err, stdout, stderr) => {
        pollInFlight = false;
        const elapsed = ((Date.now() - pollStart) / 1000).toFixed(1);
        if (err) {
          const stderrMsg = stderr?.trim();
          console.log(`[electron] Meet poll failed (${elapsed}s):`, stderrMsg || err.killed ? 'timeout' : err.message?.slice(0, 80));
          return;
        }
        console.log(`[electron] Meet poll ok (${elapsed}s)`);

        const result = (stdout || '').trim();
        const urls = result.split('\n').filter(u => /meet\.google\.com\/[a-z]+-[a-z]+-[a-z]+/.test(u));
        const meetUrl = urls[0] || null;

        if (meetUrl && meetUrl !== detectedMeetUrl) {
          detectedMeetUrl = meetUrl;
          const meetCode = meetUrl.match(/meet\.google\.com\/([a-z]+-[a-z]+-[a-z]+)/)?.[1] || '';
          console.log('[electron] Meet detected:', meetCode);
          if (panelView && !panelView.webContents.isDestroyed()) {
            panelView.webContents.send('meet-detected', { url: meetUrl, meetCode });
          }
        } else if (!meetUrl && detectedMeetUrl) {
          detectedMeetUrl = null;
          if (panelView && !panelView.webContents.isDestroyed()) {
            panelView.webContents.send('meet-detected', null);
          }
        }
      });
    }

    // Poll immediately, then every 5 seconds
    pollForMeet();
    meetDetectionInterval = setInterval(pollForMeet, 5000);
  }

  startMeetDetection();

  // IPC: join detected meet and launch Claude
  ipcMain.on('join-detected-meet', (_event, { url, meetCode }) => {
    currentMeetUrl = url;
    loadMeetURL(url);
    localServer.setRoom(meetCode);

    // Start sync
    const baseUrl = store.get('syncBaseUrl') || 'https://vibeconferencing.com';
    sync.updateConfig({ roomId: meetCode, baseUrl });
    sync.ensureRoom().then(() => {
      sync.startPolling();
      console.log('[electron] Sync started for detected room:', meetCode);
    });

    // Launch Claude Code in Terminal — MCP tools are globally installed
    launchClaudeTerminal(meetCode);
  });

  // Auto-join if launched with --meet-url
  if (cliArgs['meet-url']) {
    const meetUrl = cliArgs['meet-url'];
    currentMeetUrl = meetUrl;
    console.log('[electron] Auto-joining:', meetUrl);
    loadMeetURL(meetUrl);

    // Extract meet code and start sync
    const meetCode = meetUrl.replace(/.*meet\.google\.com\//, '').replace(/\?.*/, '');
    if (meetCode) {
      localServer.setRoom(meetCode);
      sync.updateConfig({ roomId: meetCode });
      sync.ensureRoom().then(() => {
        sync.startPolling();
        console.log('[electron] Sync started for room:', meetCode);
      });
    }
  }
});

app.on('window-all-closed', () => {
  closeClaudeTerminal();
  localServer.stop();
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

  // --- macOS menu bar ---
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings...',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            if (panelView && !panelView.webContents.isDestroyed()) {
              panelView.webContents.send('show-settings');
            }
          },
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

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

  // Open DevTools on demand from panel
  ipcMain.on('open-devtools', () => {
    if (meetView && meetView.webContents) {
      meetView.webContents.openDevTools({ mode: 'detach' });
    }
  });

  // Layout views on resize
  function layoutViews() {
    if (mainWindow.isDestroyed()) return;
    const [width, height] = mainWindow.getContentSize();
    panelView.setBounds({ x: 0, y: 0, width: PANEL_WIDTH, height });
    meetView.setBounds({ x: PANEL_WIDTH, y: 0, width: width - PANEL_WIDTH, height });
  }
  layoutViews();
  mainWindow.on('resize', layoutViews);

  // Load idle placeholder in the Meet view
  meetView.webContents.loadFile(path.join(__dirname, 'renderer', 'idle.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
    panelView = null;
    meetView = null;
    sync.stopPolling();
  });
}

function showIdle() {
  if (!meetView || meetView.webContents.isDestroyed()) return;
  meetView.webContents.loadFile(path.join(__dirname, 'renderer', 'idle.html'));
  sync.stopPolling();
  // Close whiteboard window if open
  if (whiteboardWindow && !whiteboardWindow.isDestroyed()) {
    whiteboardWindow.close();
  }
  console.log('[electron] Returned to idle state');
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

  // --- Auth check ---
  ipcMain.handle('check-auth', () => {
    return checkAuth();
  });

  // --- Meet window management ---
  ipcMain.on('join-meet', (_event, meetUrl) => {
    currentMeetUrl = meetUrl;
    loadMeetURL(meetUrl);

    // Extract meet code and start sync + Claude
    const match = meetUrl.match(/meet\.google\.com\/([a-z]+-[a-z]+-[a-z]+)/);
    if (match) {
      const meetCode = match[1];
      localServer.setRoom(meetCode);
      const baseUrl = store.get('syncBaseUrl') || 'https://vibeconferencing.com';
      sync.updateConfig({ roomId: meetCode, baseUrl });
      sync.ensureRoom().then(() => {
        sync.startPolling();
        console.log('[electron] Sync started for room:', meetCode);
      });

      // Launch Claude Code in Terminal
      launchClaudeTerminal(meetCode);
    }
  });

  ipcMain.on('leave-meet', () => {
    currentMeetUrl = null;
    detectedMeetUrl = null; // Reset so detection will re-notify about the same Meet
    localServer.clearRoom();
    closeClaudeTerminal();
    showIdle();
  });

  ipcMain.on('get-meet-status', (event) => {
    if (meetView && !meetView.webContents.isDestroyed()) {
      event.returnValue = { url: meetView.webContents.getURL(), ready: true };
    } else {
      event.returnValue = { url: null, ready: false };
    }
  });

  // --- Login ---
  ipcMain.handle('login', () => {
    openGoogleLogin();
    return { opening: true };
  });

  ipcMain.handle('logout', async () => {
    const baseUrl = store.get('syncBaseUrl') || 'https://vibeconferencing.com';
    await session.defaultSession.cookies.remove(baseUrl, 'vc_session');
    if (panelView && !panelView.webContents.isDestroyed()) {
      panelView.webContents.send('auth-changed');
    }
    return { loggedOut: true };
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
    // Also feed local server for agent communication
    for (const t of (transcripts || [])) {
      localServer.addTranscript(t.speaker, t.text, 'member');
    }
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

  // --- Whiteboard + screen share ---
  ipcMain.on('start-whiteboard-share', (_event, { meetCode }) => {
    const baseUrl = store.get('syncBaseUrl') || 'https://vibeconferencing.com';
    const roomUrl = `${baseUrl}/room/${meetCode}?mode=whiteboard`;

    if (whiteboardWindow && !whiteboardWindow.isDestroyed()) {
      whiteboardWindow.focus();
    } else {
      whiteboardWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        title: 'Vibeconferencing Whiteboard',
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      });
      whiteboardWindow.loadURL(roomUrl);
      whiteboardWindow.on('closed', () => { whiteboardWindow = null; });
    }

    console.log('[electron] Whiteboard window opened:', roomUrl);
  });

  // Combined: open whiteboard + trigger screen share in Meet
  ipcMain.handle('share-whiteboard', async (_event, { meetCode }) => {
    const baseUrl = store.get('syncBaseUrl') || 'https://vibeconferencing.com';
    const roomUrl = `${baseUrl}/room/${meetCode}?mode=whiteboard`;

    // Open whiteboard window if not already open
    if (!whiteboardWindow || whiteboardWindow.isDestroyed()) {
      whiteboardWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        title: 'Vibeconferencing Whiteboard',
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      });
      whiteboardWindow.loadURL(roomUrl);
      whiteboardWindow.on('closed', () => { whiteboardWindow = null; });
    }

    // Wait for the whiteboard to load, then trigger screen share
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Trigger screen share in Meet
    if (meetView && meetView.webContents) {
      meetView.webContents.send('trigger-screen-share');
    }

    return { success: true, url: roomUrl };
  });

  // Provide desktopCapturer source for screen share
  ipcMain.handle('get-screen-share-source', async () => {
    if (!whiteboardWindow || whiteboardWindow.isDestroyed()) {
      return { error: 'No whiteboard window open' };
    }

    try {
      // Use the window's native media source ID for reliable matching
      const mediaSourceId = whiteboardWindow.getMediaSourceId();
      console.log('[electron] Whiteboard media source ID:', mediaSourceId);

      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 0, height: 0 },
      });

      console.log('[electron] Available sources:', sources.map(s => `${s.id} "${s.name}"`).join(', '));

      // Match by media source ID (most reliable)
      const wbSource = sources.find(s => s.id === mediaSourceId);
      if (wbSource) {
        console.log('[electron] Matched whiteboard by media source ID:', wbSource.id);
        return { sourceId: wbSource.id };
      }

      // Fallback: match by window title
      const wbTitle = whiteboardWindow.getTitle();
      console.log('[electron] Whiteboard title:', wbTitle);
      const fallback = sources.find(s => s.name.includes(wbTitle) || s.name.includes('Vibeconferencing'));
      if (fallback) {
        console.log('[electron] Matched whiteboard by title:', fallback.id, fallback.name);
        return { sourceId: fallback.id };
      }

      return { error: `Could not find whiteboard window. Title: "${wbTitle}", sources: ${sources.length}` };
    } catch (err) {
      return { error: err.message };
    }
  });
}
