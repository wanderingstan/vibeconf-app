// main.js — Electron main process
// Manages Meet BrowserView + panel sidebar in a single window,
// IPC routing, TTS, and sync.

const { app, BrowserWindow, BrowserView, ipcMain, session, shell, nativeImage, desktopCapturer, systemPreferences, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const Store = require('./store.js');
const { resolveSvg } = require('./svg-resolver.js');

// Short HH:MM:SS.mmm prefix for emoji diagnostic logs.
function ts() {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

// Round-trip request to the Meet preload (read/send chat). Sends on `channel`
// with a unique requestId and resolves with the matching 'chat-result' reply,
// or a timeout error. preload-meet.js handles 'read-chat'/'send-chat'.
function chatRequest(channel, payload) {
  return new Promise((resolve) => {
    if (!meetView || meetView.webContents.isDestroyed()) {
      resolve({ ok: false, error: 'No active Meet view' });
      return;
    }
    const requestId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const timer = setTimeout(() => {
      ipcMain.removeListener('chat-result', handler);
      resolve({ ok: false, error: 'Chat operation timed out' });
    }, 15000);
    const handler = (_event, data) => {
      if (data?.requestId !== requestId) return;
      clearTimeout(timer);
      ipcMain.removeListener('chat-result', handler);
      resolve(data);
    };
    ipcMain.on('chat-result', handler);
    meetView.webContents.send(channel, { requestId, ...payload });
  });
}

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

// Catch-all error handlers — surface unexpected failures via broadcastError
// (which routes to a push notification if the app isn't focused). Defined
// near the top so they're active before any setup code runs.
process.on('uncaughtException', (err) => {
  console.error('[electron] uncaughtException:', err);
  try { broadcastError('Unexpected error: ' + (err?.message || String(err)).slice(0, 200)); } catch {}
});
process.on('unhandledRejection', (reason) => {
  console.error('[electron] unhandledRejection:', reason);
  const msg = reason?.message || (typeof reason === 'string' ? reason : JSON.stringify(reason));
  try { broadcastError('Unhandled promise rejection: ' + String(msg).slice(0, 200)); } catch {}
});

const tts = new globalThis.TTSProvider();
const stt = new globalThis.STTProvider();
const sync = new globalThis.SyncClient({
  onBotSpeech: (text, voice) => {
    console.log('[electron] Bot speech from sync:', text.slice(0, 80), voice ? `(voice: ${voice})` : '');
    ackTtsPending = false;
    speakText(text, voice);
  },
  getAuthCookie: async () => {
    try {
      // The vc_session cookie is stored against the website URL (where auth
      // ran), not the local server — read it from the same place.
      const baseUrl = getWebsiteUrl();
      const cookies = await session.defaultSession.cookies.get({ url: baseUrl, name: 'vc_session' });
      return cookies.length > 0 ? cookies[0].value : null;
    } catch {
      return null;
    }
  },
});

// True when the TTS queue only contains the "Mm-hmm/Okay" acknowledgment that
// fires as the bot enters 'thinking'. When its tts-ended fires we should stay
// in 'thinking' (the agent is still processing) rather than drop to 'idle'.
// Any real bot speech clears this flag so the next tts-ended transitions normally.
let ackTtsPending = false;

// Local HTTP server for agent communication (replaces remote sync for MCP)
const localServer = new globalThis.LocalServer({
  onBotSpeech: (text, voice, emoji) => {
    console.log('[local-server] Bot speech:', text.slice(0, 80), emoji ? `(emoji: ${emoji})` : '');
    ackTtsPending = false;
    speakText(text, voice, emoji);
  },
  onWhiteboardUpdate: (content, sender) => {
    console.log('[local-server] Whiteboard update from', sender, ':', content.slice(0, 80));
    const roomId = localServer.roomId;
    if (roomId) {
      const baseUrl = (store && store.get('syncBaseUrl')) || 'http://127.0.0.1:7865';
      const roomUrl = `${baseUrl}/room/${roomId}`;

      // If the whiteboard window was navigated to an external URL (via load-url),
      // navigate it back to the room page so it can receive SSE updates
      if (whiteboardWindow && !whiteboardWindow.isDestroyed()) {
        const currentUrl = whiteboardWindow.webContents.getURL();
        if (!currentUrl.includes('/room/')) {
          console.log('[local-server] Whiteboard showing external URL, navigating back to room');
          whiteboardWindow.loadURL(roomUrl);
        }
      }

      // Forward to remote sync server so the whiteboard window picks it up
      fetch(`${baseUrl}/api/sync/${roomId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender,
          role: 'bot',
          ownerName: sender,
          whiteboard: { content },
        }),
      }).catch(err => {
        console.error('[local-server] Failed to forward whiteboard update:', err.message);
      });
    }
  },
  onJoinCall: (meetCode, botName) => {
    console.log('[local-server] Join call requested by agent:', meetCode, botName);
    if (botName) {
      // Persist so preload-meet.js's get-config read picks up THIS name when
      // typing into Meet's pre-join name input. Without this, the agent can
      // pass bot_name='Coltrane' but preload would still type the previously
      // stored botName into Meet.
      if (store) store.set('botName', botName);
      sync.updateConfig?.({ botName });
      if (panelView && !panelView.webContents.isDestroyed()) {
        panelView.webContents.send('set-bot-name', botName);
      }
    }
    const meetUrl = `https://meet.google.com/${meetCode}`;
    loadMeetURL(meetUrl);
  },
  onLeaveCall: () => {
    console.log('[local-server] Leave call requested by agent');

    // Wait for any in-flight TTS to finish so goodbye speech actually plays.
    // botState leaves 'speaking' when the `tts-ended` IPC fires (page-inject
    // posts it when its playback queue drains). Cap the wait so a stuck
    // synthesis can't block leave forever.
    const MAX_WAIT_MS = 8000;
    const POLL_MS = 150;
    const TAIL_MS = 400; // let the last audio buffer flush into the mic stream
    const deadline = Date.now() + MAX_WAIT_MS;

    const performLeave = () => {
      if (panelView && !panelView.webContents.isDestroyed()) {
        panelView.webContents.send('leave-requested');
      }
    };

    const checkAndLeave = () => {
      const stillSpeaking = localServer.botState === 'speaking';
      if (!stillSpeaking) {
        console.log('[local-server] TTS idle — leaving call');
        setTimeout(performLeave, TAIL_MS);
      } else if (Date.now() >= deadline) {
        console.log('[local-server] TTS still playing after', MAX_WAIT_MS, 'ms — leaving anyway');
        performLeave();
      } else {
        setTimeout(checkAndLeave, POLL_MS);
      }
    };
    checkAndLeave();
  },
  onShareWhiteboard: (shareType) => {
    console.log('[local-server] Share requested by agent, type:', shareType);
    const meetCode = localServer.roomId;
    if (meetCode) {
      localServer.setSharing(true);
      if (shareType === 'screen') {
        // Full screen share — no whiteboard window needed
        fullScreenShareRequested = true;
        if (meetView && !meetView.webContents.isDestroyed()) {
          meetView.webContents.send('trigger-screen-share', { shareType: 'screen' });
        }
      } else {
        // Whiteboard share — open whiteboard window first
        fullScreenShareRequested = false;
        ipcMain.emit('start-whiteboard-share', {}, { meetCode });
        setTimeout(() => {
          if (meetView && !meetView.webContents.isDestroyed()) {
            meetView.webContents.send('trigger-screen-share', { shareType: 'window' });
          }
        }, 2000);
      }
    }
  },
  onStopSharing: () => {
    console.log('[local-server] Stop sharing requested by agent');
    fullScreenShareRequested = false;
    localServer.setSharing(false);
    // Close the whiteboard window — this ends the display media stream for whiteboard shares
    if (whiteboardWindow && !whiteboardWindow.isDestroyed()) {
      whiteboardWindow.close();
      whiteboardWindow = null;
    }
    // Click Meet's "Stop presenting" button — works for both whiteboard and full-screen shares
    if (meetView && !meetView.webContents.isDestroyed()) {
      meetView.webContents.send('trigger-stop-sharing');
    }
  },
  onLoadUrl: (url) => {
    console.log('[local-server] Load URL in whiteboard:', url);
    if (whiteboardWindow && !whiteboardWindow.isDestroyed()) {
      whiteboardWindow.loadURL(url);
    } else {
      whiteboardWindow = createWhiteboardWindow(url);
    }
  },
  onBotStateChange: (state, extra) => {
    console.log('[local-server] Bot state:', state, extra || '');
    // Forward state to page-inject.js to update avatar emoji
    if (meetView && !meetView.webContents.isDestroyed()) {
      meetView.webContents.send('extension-message', {
        action: 'set-bot-state',
        payload: { state },
      });
    }

    // Play acknowledgment sounds when entering 'thinking' state.
    // Only in active mode — passive/silent shouldn't blurt "mm-hmm" unprompted.
    if (state === 'thinking' && localServer.mode === 'active') {
      const wordCount = extra?.wordCount || 0;

      // Three tiers driven by user prefs (defaults 20 / 50):
      //   wordCount < ackShortMin    → no ack (short prompt — agent can answer fast)
      //   ackShortMin..ackLongMin    → short ack ("Mm-hmm.")
      //   ≥ ackLongMin               → long ack ("Let me think about that.")
      const prefsSchema = require('./preferences-schema.js');
      const ackShortMin = Number(store?.get('ackShortMin')) || prefsSchema.PREFERENCES.ackShortMin.default;
      const ackLongMin = Number(store?.get('ackLongMin')) || prefsSchema.PREFERENCES.ackLongMin.default;
      const shortPhrases = store?.get('ackShortPhrases') || prefsSchema.PREFERENCES.ackShortPhrases.default;
      const longPhrases = store?.get('ackLongPhrases') || prefsSchema.PREFERENCES.ackLongPhrases.default;

      let ack = null;
      if (wordCount >= ackLongMin) {
        ack = longPhrases[Math.floor(Math.random() * longPhrases.length)];
      } else if (wordCount >= ackShortMin) {
        ack = shortPhrases[Math.floor(Math.random() * shortPhrases.length)];
      }

      if (!ack) {
        console.log(ts(), '🤐 [ack] Skipping (wordCount=' + wordCount + ' < ' + ackShortMin + ')');
        // Short prompt — skip the ack entirely. The thinking emoji is already
        // showing, so the user has visual feedback while the agent responds.
        return;
      }

      console.log(ts(), '👂 [ack] Playing acknowledgement:', JSON.stringify(ack), '(wordCount=' + wordCount + ')');
      // Speak the acknowledgment immediately (before the agent responds).
      // Mark the ack so its tts-ended doesn't drop us out of 'thinking' while
      // the agent is still generating the real response.
      ackTtsPending = true;
      speakText(ack);
    }
  },
  onModeChange: (mode) => {
    console.log('[local-server] Mode:', mode);
    if (meetView && !meetView.webContents.isDestroyed()) {
      meetView.webContents.send('extension-message', {
        action: 'set-mode',
        payload: { mode },
      });
      // Keep Meet's mute UI in sync with mode so the user always sees one
      // canonical indicator. Active = unmuted, passive/silent = muted.
      meetView.webContents.send('extension-message', {
        action: mode === 'active' ? 'unmute-mic' : 'mute-mic',
      });
    }
  },

  onCallStatusChange: (status) => {
    // Forward to page-inject so the avatar can show 🫥 while joining/waiting.
    if (meetView && !meetView.webContents.isDestroyed()) {
      meetView.webContents.send('extension-message', {
        action: 'set-call-status',
        payload: { status },
      });
    }
    // Also let the panel reflect real call state. Showing "Leave Call" between
    // "URL navigated" and "actually admitted" is misleading — especially when
    // entry is denied, since that 15s grace window leaves the button visible
    // while we wait for the denial page to be detected.
    if (panelView && !panelView.webContents.isDestroyed()) {
      panelView.webContents.send('call-status-changed', { status });
    }
  },

  onAnyoneSpeakingChange: (anyoneSpeaking) => {
    // Forward to page-inject so the avatar can flash 😐 while someone speaks
    // (signals "I noticed you"). Page-inject suppresses this in silent mode.
    if (meetView && !meetView.webContents.isDestroyed()) {
      meetView.webContents.send('extension-message', {
        action: 'set-anyone-speaking',
        payload: { anyoneSpeaking },
      });
    }
  },

  onParticipantsFirstSeen: () => {
    // Used to be the avatar engagement trigger, but the captions-ready
    // signal is more honest: people pane fills before captions are usable,
    // so the avatar would flip to 🙂 several seconds before the bot could
    // actually hear. Keep this hook for logging/observability only —
    // engagement is fired from the captions-ready IPC handler.
    console.log('[local-server] First participants seen (avatar engagement still pending captions-ready)');
  },

  onAvatarEmojiOverride: (overrides) => {
    console.log('[local-server] Avatar emoji override:', overrides);
    if (meetView && !meetView.webContents.isDestroyed()) {
      meetView.webContents.send('extension-message', {
        action: 'set-avatar-emoji-override',
        payload: overrides,
      });
    }
  },

  onSetCamera: (on) => {
    console.log('[local-server] Set camera:', on ? 'on' : 'off');
    if (meetView && !meetView.webContents.isDestroyed()) {
      meetView.webContents.send('extension-message', {
        action: on ? 'camera-on' : 'camera-off',
      });
    }
  },

  onCaptureScreenshot: async ({ roomId }) => {
    if (!meetView || meetView.webContents.isDestroyed()) {
      return { error: 'No active Meet view to capture' };
    }
    try {
      const image = await meetView.webContents.capturePage();
      const buf = image.toPNG();
      const dir = path.join(app.getPath('temp'), 'vibeconf-screenshots');
      await fs.promises.mkdir(dir, { recursive: true });

      // Keep the most recent N per room; older ones are noise on disk.
      const KEEP_PER_ROOM = 10;
      const prefix = (roomId || 'no-room') + '-';
      try {
        const existing = (await fs.promises.readdir(dir))
          .filter(f => f.startsWith(prefix) && f.endsWith('.png'))
          .sort();
        const toDelete = existing.slice(0, Math.max(0, existing.length - (KEEP_PER_ROOM - 1)));
        await Promise.all(toDelete.map(f => fs.promises.unlink(path.join(dir, f)).catch(() => {})));
      } catch { /* dir was just created or unreadable — fine */ }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filePath = path.join(dir, `${prefix}${stamp}.png`);
      await fs.promises.writeFile(filePath, buf);
      console.log('[electron] Screenshot saved:', filePath, '(' + buf.length + ' bytes)');
      return { path: filePath };
    } catch (err) {
      console.error('[electron] Screenshot capture failed:', err);
      return { error: err.message };
    }
  },

  onReadChat: async () => chatRequest('read-chat', {}),
  onSendChat: async (text) => chatRequest('send-chat', { text }),
  getWebsiteUrl: () => getWebsiteUrl(),

  // Preference plumbing for the agent-visible whitelist (preferences-schema.js).
  // get/set go to the same Store the panel uses, so changes from the agent and
  // changes from Settings → UI converge on one config.json.
  getPref: (key) => store?.get(key),
  setPref: (key, value) => store?.set(key, value),
  applyPref: (key, value) => {
    // Live-apply hooks per-key. Anything we leave out is read on next use
    // (the ack thresholds, for example, are read every time a thinking state
    // fires — no live-apply needed).
    if (key === 'ttsVoiceId') {
      tts.updateConfig?.({ voiceId: value });
    } else if (key === 'botName' && panelView && !panelView.webContents.isDestroyed()) {
      // Surface the change in the panel so the input reflects reality.
      panelView.webContents.send('extension-message', {
        action: 'config-updated',
        payload: { key, value },
      });
    } else if (key === 'avatarBackgroundSvg') {
      pushAvatarBackground(value);
    }
  },
});

// Resolve external refs in the SVG and broadcast the result to the meet view.
// Empty/missing value clears the background back to the default gradient.
async function pushAvatarBackground(svgSource) {
  if (!meetView || meetView.webContents.isDestroyed()) return;
  try {
    const resolved = (typeof svgSource === 'string' && svgSource.trim())
      ? await resolveSvg(svgSource)
      : '';
    meetView.webContents.send('extension-message', {
      action: 'set-avatar-background',
      payload: { svg: resolved },
    });
  } catch (err) {
    console.warn('[electron] Failed to resolve avatar background SVG:', err.message);
    // Fall back to clearing — renderer goes back to default gradient.
    meetView.webContents.send('extension-message', {
      action: 'set-avatar-background',
      payload: { svg: '' },
    });
  }
}

// ---------------------------------------------------------------------------
// Config store & window refs
// ---------------------------------------------------------------------------

let store;
let mainWindow = null;   // single window that holds both views
let panelView = null;     // left sidebar BrowserView
let meetView = null;      // right Meet BrowserView
let whiteboardWindow = null;
let fullScreenShareRequested = false;

function createWhiteboardWindow(roomUrl) {
  // Position off the bottom-right of the screen so macOS doesn't clamp to (0,0)
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = display.workArea;

  const win = new BrowserWindow({
    width: 800,
    height: 450,
    x: sw + 100,
    y: sh + 100,
    title: 'Vibeconferencing Whiteboard',
    skipTaskbar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(roomUrl);
  win.on('closed', () => { whiteboardWindow = null; });
  return win;
}

const PANEL_WIDTH = 380;

// Check if already logged in
// The public website hosts auth (/api/auth/*) and the whiteboard web-rooms.
// The local MCP server (127.0.0.1:7865) does NOT — so auth must never target
// it (fixes #147 where a fresh install sent the login button to the local
// server). Resolution order, so testers can point auth at a Vercel preview:
//   1. VIBECONF_WEBSITE_URL env var          (per-launch override)
//   2. `websiteUrl` preference               (persisted override)
//   3. `syncBaseUrl` if it's an https URL    (back-compat with existing setups)
//   4. production default
const DEFAULT_WEBSITE = 'https://vibeconferencing.com';
function getWebsiteUrl() {
  const envUrl = process.env.VIBECONF_WEBSITE_URL;
  if (envUrl && /^https?:\/\//i.test(envUrl)) return envUrl;

  const prefUrl = store.get('websiteUrl');
  if (prefUrl && /^https?:\/\//i.test(prefUrl)) return prefUrl;

  const syncUrl = store.get('syncBaseUrl');
  if (syncUrl && /^https:\/\//i.test(syncUrl)) return syncUrl;

  return DEFAULT_WEBSITE;
}

async function checkAuth() {
  const baseUrl = getWebsiteUrl();
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
  const baseUrl = getWebsiteUrl();
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

function speakText(text, voice, emoji) {
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
            payload: { audioData: base64Audio, emoji },
          });
          console.log('[electron] Sent play-tts to Meet view', emoji ? `(emoji: ${emoji})` : '');
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

// Track recent error notifications so a flapping condition doesn't spam the
// notification center. Same message within this window is suppressed.
const ERROR_NOTIFY_DEDUPE_MS = 30_000;
const recentErrorNotifications = new Map(); // message -> timestamp

function broadcastError(message) {
  if (panelView && !panelView.webContents.isDestroyed()) {
    panelView.webContents.send('extension-message', { action: 'error', message });
  }

  // If the app isn't in the foreground, surface the error as a system
  // notification so the user finds out without checking the app. We treat
  // "not in foreground" as: window doesn't exist, isn't visible, is minimized,
  // or doesn't have focus. Visible-but-unfocused (e.g. user switched apps)
  // still counts — that's the whole point of this feature.
  const inForeground =
    mainWindow &&
    !mainWindow.isDestroyed() &&
    mainWindow.isVisible() &&
    !mainWindow.isMinimized() &&
    mainWindow.isFocused();

  if (inForeground) return;

  const now = Date.now();
  const lastShown = recentErrorNotifications.get(message);
  if (lastShown && now - lastShown < ERROR_NOTIFY_DEDUPE_MS) return;
  recentErrorNotifications.set(message, now);
  // Best-effort cleanup so the map doesn't grow unbounded.
  if (recentErrorNotifications.size > 50) {
    for (const [k, t] of recentErrorNotifications) {
      if (now - t > ERROR_NOTIFY_DEDUPE_MS) recentErrorNotifications.delete(k);
    }
  }

  try {
    const { Notification } = require('electron');
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: 'Vibeconferencing Error',
      body: message.slice(0, 240),
      silent: false,
    });
    notification.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
    notification.show();
  } catch (err) {
    console.error('[electron] Failed to show error notification:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Terminal management — launch Claude and track the window for cleanup
// ---------------------------------------------------------------------------

let claudeTerminalWindowId = null;

function launchClaudeTerminal(meetCode) {
  const { execFile } = require('child_process');
  const claudeDir = store.get('claudeWorkDir') || '/tmp';
  const botName = store.get('botName') || 'Jimmy';

  // Position terminal below the Electron window, matching its width
  let termBounds = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const bounds = mainWindow.getBounds();
    const termHeight = 220;
    const termY = bounds.y + bounds.height + 10;
    termBounds = `${bounds.x}, ${termY}, ${bounds.x + bounds.width}, ${termY + termHeight}`;
  }

  // Build the claude command with optional --dangerously-skip-permissions
  const dangerousMode = store.get('dangerousMode');
  const dangerousFlag = dangerousMode ? ' --dangerously-skip-permissions' : '';
  const claudeCmd = `claude${dangerousFlag} \\"/join-call ${meetCode} ${botName.replace(/"/g, '')}\\"`;

  // AppleScript that opens a new Terminal window and returns its ID
  const script = `tell application "Terminal"
  do script "cd ${claudeDir.replace(/"/g, '\\"')} && ${claudeCmd}"
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

    const baseUrl = sync.baseUrl || 'http://127.0.0.1:7865';
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
  const configuredBotName = store.get('botName') || 'Jimmy';
  const currentMcp = claudeJson.mcpServers.vibeconferencing;
  const needsUpdate = !currentMcp ||
    currentMcp.env?.VIBECONF_BASE_URL !== localBaseUrl ||
    currentMcp.env?.VIBECONF_BOT_NAME !== configuredBotName ||
    currentMcp.args?.[0] !== mcpServerPath;

  if (needsUpdate) {
    claudeJson.mcpServers.vibeconferencing = {
      command: 'node',
      args: [mcpServerPath],
      env: {
        VIBECONF_ROOM_ID: '',
        VIBECONF_BOT_NAME: configuredBotName,
        VIBECONF_BASE_URL: localBaseUrl,
      },
    };
    fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2) + '\n');
    console.log('[electron] Updated MCP config → local server at', localBaseUrl, 'botName:', configuredBotName);
    changed = true;
  } else {
    console.log('[electron] MCP config already pointing to local server');
  }

  // --- Ensure global skill in ~/.claude/skills/join-call/ ---
  // Version-tracked: updates when app version changes
  const SKILL_VERSION = '13';  // Bump this when updating the skill content below
  const versionFile = path.join(skillDir, '.version');
  let installedVersion = '';
  try { installedVersion = fs.readFileSync(versionFile, 'utf-8').trim(); } catch {}

  if (installedVersion !== SKILL_VERSION) {
    fs.mkdirSync(skillDir, { recursive: true });
    const skillContent = fs.readFileSync(
      isPackaged
        ? path.join(process.resourcesPath, 'mcp-server', 'join-call-skill.md')
        : path.join(__dirname, '..', 'mcp-server', 'join-call-skill.md'),
      'utf-8'
    );
    fs.writeFileSync(skillPath, skillContent);
    fs.writeFileSync(versionFile, SKILL_VERSION);
    console.log('[electron] Installed/updated skill v%s at %s', SKILL_VERSION, skillPath);
    changed = true;
  } else {
    console.log('[electron] Skill v%s already installed', SKILL_VERSION);
  }

  if (changed) {
    console.log('[electron] Claude integration installed. Restart Claude Code to pick up MCP changes.');
  }

  return changed;
}

// ---------------------------------------------------------------------------
// Uninstall Claude integration (MCP config + skill)
// ---------------------------------------------------------------------------

function uninstallClaudeIntegration() {
  const home = process.env.HOME || process.env.USERPROFILE;
  const claudeJsonPath = path.join(home, '.claude.json');
  const skillDir = path.join(home, '.claude', 'skills', 'join-call');

  // Remove MCP server from ~/.claude.json
  try {
    const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
    if (claudeJson.mcpServers?.vibeconferencing) {
      delete claudeJson.mcpServers.vibeconferencing;
      fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2) + '\n');
      console.log('[electron] Removed MCP config from ~/.claude.json');
    }
  } catch {}

  // Remove skill directory
  try {
    fs.rmSync(skillDir, { recursive: true, force: true });
    console.log('[electron] Removed skill at', skillDir);
  } catch {}

  console.log('[electron] Claude integration uninstalled.');
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
    console.log('[electron] Screen recording permission at launch:', screenAccess);
    localServer.setPermission('screenRecording', screenAccess);

    if (screenAccess === 'not-determined') {
      // First-time request — getSources will trigger the OS prompt.
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
        .then(() => {
          const newStatus = systemPreferences.getMediaAccessStatus('screen');
          console.log('[electron] Screen recording permission after prompt:', newStatus);
          localServer.setPermission('screenRecording', newStatus);
        })
        .catch(() => {});
    } else if (screenAccess === 'denied' || screenAccess === 'restricted') {
      // macOS won't re-prompt once denied — guide the user to System Settings.
      // BUT first attempt a capture: an app only appears in the Screen Recording
      // list once it has tried to record. Without this, Vibeconferencing is
      // absent from the System Settings pane (nothing to toggle) — common after
      // `tccutil reset` wipes the prior TCC entry. The getSources call registers
      // the app so it shows up with a toggle when we open Settings.
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
        .catch(() => {})
        .finally(() => {
          const choice = dialog.showMessageBoxSync({
            type: 'warning',
            title: 'Screen Recording Permission',
            message: 'Whiteboard sharing is disabled',
            detail: 'Vibeconferencing needs Screen Recording permission to share the whiteboard in your Meet calls. The app will still work without it — the bot just can\'t share visuals.\n\nIn System Settings > Privacy & Security > Screen & System Audio Recording, enable the toggle next to Vibeconferencing, then restart the app.',
            buttons: ['Open System Settings', 'Continue Without'],
            defaultId: 0,
            cancelId: 1,
          });
          if (choice === 0) {
            shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
          }
        });
    }
  } else {
    localServer.setPermission('screenRecording', 'granted');
  }

  // Re-check screen recording perm whenever the app regains focus. Users
  // typically grant it via System Settings, then return to the app — this
  // picks up the change without requiring a restart.
  if (process.platform === 'darwin') {
    app.on('browser-window-focus', () => {
      const current = systemPreferences.getMediaAccessStatus('screen');
      localServer.setPermission('screenRecording', current);
    });
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

  // Handle getDisplayMedia — provide the appropriate source based on share mode
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    // Full screen share mode
    if (fullScreenShareRequested) {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 },
        });
        if (sources.length > 0) {
          console.log('[electron] Full screen share source:', sources[0].id, sources[0].name);
          callback({ video: sources[0] });
        } else {
          console.error('[electron] No screen sources found');
          callback({});
        }
      } catch (err) {
        console.error('[electron] Full screen share error:', err);
        callback({});
      }
      return;
    }

    // Whiteboard window share mode
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
  if (cliArgs['website-url']) {
    // Override the auth/web-room host (e.g. a Vercel preview) for testing.
    store.set('websiteUrl', cliArgs['website-url']);
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
  let automationPromptShown = false; // only nag about Automation permission once

  function startMeetDetection() {
    if (meetDetectionInterval) return;
    const { execFile } = require('child_process');
    let pollInFlight = false;

    // Note: Firefox is not supported — it has no AppleScript tab API
    const appleScript = `
set allURLs to ""
tell application "System Events"
  set chromeRunning to exists process "Google Chrome"
  set safariRunning to exists process "Safari"
  set braveRunning to exists process "Brave Browser"
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
if braveRunning then
  tell application "Brave Browser"
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
          const stderrMsg = stderr?.trim() || '';
          console.log(`[electron] Meet poll failed (${elapsed}s):`, stderrMsg || (err.killed ? 'timeout' : err.message?.slice(0, 80)));
          // -1743 = errAEEventNotPermitted: the user hasn't granted Automation
          // permission to control the browser. macOS won't re-prompt once it's
          // been denied/dismissed, so the poll fails silently forever and Meet
          // detection just never works (Seth's case). Surface it once with a
          // path to fix it.
          const notAuthorized = stderrMsg.includes('-1743') || /not authorized to send apple events/i.test(stderrMsg);
          if (notAuthorized && !automationPromptShown) {
            automationPromptShown = true;
            dialog.showMessageBox({
              type: 'warning',
              title: 'Permission needed to detect Google Meet',
              message: 'Vibeconferencing needs Automation permission to find your active Google Meet call.',
              detail: 'Open System Settings → Privacy & Security → Automation, then enable the checkbox under Vibeconferencing for your browser (Google Chrome / Brave / Safari).\n\nYou can also just paste the Meet link into the app to join without this permission.',
              buttons: ['Open System Settings', 'Later'],
              defaultId: 0,
              cancelId: 1,
            }).then(({ response }) => {
              if (response === 0) {
                shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation');
              }
            }).catch(() => {});
          }
          return;
        }
        console.log(`[electron] Meet poll ok (${elapsed}s)`);

        const result = (stdout || '').trim();
        const urls = result.split('\n').filter(u => /meet\.google\.com\/[a-z]+-[a-z]+-[a-z]+/.test(u));
        const meetUrl = urls[0] || null;

        // Forward all detected Meet URLs to local server for MCP access
        localServer.setDetectedMeetUrls(urls);

        if (meetUrl && meetUrl !== detectedMeetUrl) {
          detectedMeetUrl = meetUrl;
          const meetCode = meetUrl.match(/meet\.google\.com\/([a-z]+-[a-z]+-[a-z]+)/)?.[1] || '';
          console.log('[electron] Meet detected:', meetCode);
          if (panelView && !panelView.webContents.isDestroyed()) {
            panelView.webContents.send('meet-detected', { url: meetUrl, meetCode });
          }
          // Show macOS notification
          const { Notification } = require('electron');
          if (Notification.isSupported()) {
            const notification = new Notification({
              title: 'Google Meet Detected',
              body: `Found call: ${meetCode}. Click Join in Vibeconferencing to connect your bot.`,
              silent: false,
            });
            notification.on('click', () => {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.show();
                mainWindow.focus();
              }
            });
            notification.show();
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
    const baseUrl = getWebsiteUrl();
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
    width: 800 + PANEL_WIDTH,
    height: 550,
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
        {
          label: 'Uninstall Claude Integration...',
          click: () => {
            const { dialog } = require('electron');
            dialog.showMessageBox(mainWindow, {
              type: 'question',
              buttons: ['Cancel', 'Uninstall'],
              defaultId: 0,
              title: 'Uninstall Claude Integration',
              message: 'Remove the /join-call skill and MCP server config from Claude Code?',
              detail: 'This removes the vibeconferencing MCP server from ~/.claude.json and the join-call skill from ~/.claude/skills/. The app itself is not affected.',
            }).then(({ response }) => {
              if (response === 1) {
                uninstallClaudeIntegration();
                dialog.showMessageBox(mainWindow, {
                  type: 'info',
                  message: 'Claude integration removed. Restart Claude Code to apply.',
                });
              }
            });
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

  // Forward preload-meet's console output to main stdout so [electron-meet]
  // and [CC] log lines show up alongside [local-server] / [electron] in the
  // terminal we tail with cmux read-screen. Errors → console.error.
  meetView.webContents.on('console-message', (_e, level, message) => {
    // Only forward our prefixed lines — Meet's own console is noisy.
    if (typeof message === 'string' && (message.startsWith('[electron-meet]') ||
        message.startsWith('[bots-in-calls]') || message.startsWith('[captions]') ||
        message.startsWith('[chat]') || message.startsWith('[speaker-tracker]'))) {
      if (level === 2) console.warn(message);
      else if (level === 3) console.error(message);
      else console.log(message);
    }
  });

  meetView.webContents.on('did-finish-load', () => {
    const url = meetView.webContents.getURL();
    if (url.includes('meet.google.com')) {
      // Notify panel that Meet is loaded
      if (panelView && !panelView.webContents.isDestroyed()) {
        panelView.webContents.send('meet-status', { url, ready: true });
      }
      // Push current state to page-inject — first-call timing race fix.
      // Without this, the initial 'joining' callStatus may have fired before
      // the avatar was alive to receive it, leaving 🙂‍↕️ stuck on screen.
      meetView.webContents.send('extension-message', {
        action: 'set-call-status',
        payload: { status: localServer.callStatus },
      });
      meetView.webContents.send('extension-message', {
        action: 'set-mode',
        payload: { mode: localServer.mode },
      });
      meetView.webContents.send('extension-message', {
        action: 'set-bot-state',
        payload: { state: localServer.botState },
      });
      // Push the stored avatar background (if any) so it persists across
      // app restarts and survives a Meet reload.
      const savedSvg = store?.get('avatarBackgroundSvg');
      if (savedSvg) pushAvatarBackground(savedSvg);
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

  ipcMain.handle('get-app-version', () => app.getVersion());

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
      const baseUrl = getWebsiteUrl();
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
    const baseUrl = getWebsiteUrl();
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

  // --- Bot joined call: play a soft join chime ---
  // Previously this fired a canned "Hello I am X" speech. That pre-empted the
  // user and was visually inconsistent (avatar still 🫥 during the welcome).
  // The chime gives a clear "bot is in the room" signal and lets the human
  // start the conversation. The first real speak() flips hasEngaged so the
  // avatar transitions naturally.
  ipcMain.on('bot-joined-call', (_event, { meetCode, botName }) => {
    console.log('[electron] Bot joined call, playing join chime');
    if (meetView && !meetView.webContents.isDestroyed()) {
      meetView.webContents.send('extension-message', { action: 'play-join-chime' });
    }
  });

  // --- Meet status updates (logged, DOM updated by preload) ---
  ipcMain.on('meet-status-update', (_event, status) => {
    console.log('[electron] Meet status:', status);
    // Map Meet status to call status for the local server
    if (typeof status === 'string') {
      if (status.startsWith('Error')) {
        // Surface join-flow errors as a push notification when backgrounded.
        broadcastError(status);
        // Decisively reset call state — without this, callStatus would stick at
        // 'waiting-to-be-admitted' forever and the agent's wait_for_speech loop
        // would never exit. Failing-to-admit means we're not in the call at all,
        // so any active waiters should also be told the call is over.
        for (const waiter of [...localServer.waiters]) {
          if (waiter.resolved) continue;
          waiter.resolved = true;
          clearTimeout(waiter.timer);
          clearTimeout(waiter.silenceTimer);
          waiter.resolve({
            success: true,
            displaced: true,  // reuse the displaced flag so the skill exits cleanly
            asOf: new Date().toISOString(),
            transcript: { entries: [] },
            callFailed: true,
          });
        }
        localServer.waiters = [];
        localServer.clearRoom();
        // Reset the panel UI — without this it keeps showing "leave call"
        // even though we never made it into the meeting.
        if (panelView && !panelView.webContents.isDestroyed()) {
          panelView.webContents.send('call-failed', { message: status });
        }
      } else if (status.includes('Waiting') || status.includes('Ask to join')) {
        localServer.setCallStatus('waiting-to-be-admitted');
      } else if (status.includes('Participating') || status.includes('In call')) {
        localServer.setCallStatus('in-call');
      } else if (status.includes('Joining')) {
        localServer.setCallStatus('joining');
      }
    }
  });

  ipcMain.on('stop-sync', () => {
    sync.stopPolling();
  });

  // --- Screen share status ---
  ipcMain.on('screen-share-error', (_event, errorMessage) => {
    console.error('[electron] Screen share error:', errorMessage);
    localServer.setSharing(false);
    localServer.addError('Screen share: ' + errorMessage);
    broadcastError('Screen share: ' + errorMessage);
  });

  ipcMain.on('screen-share-stopped', () => {
    console.log('[electron] Screen share stopped');
    localServer.setSharing(false);
  });

  // Forwarded log lines from page-inject.js (via preload-meet). These are
  // emoji-change announcements right now but the channel is generic.
  ipcMain.on('page-inject-log', (_event, line) => {
    console.log('[page-inject]', line);
  });

  // Captions confirmed on (toolbar shows "Turn off captions"). This is
  // the canonical "the bot can actually hear what's said" signal. We use
  // it to BOTH flush deferred bot speech AND engage the avatar — anything
  // earlier means the avatar shows 🙂 before the bot is really listening.
  ipcMain.on('captions-ready', () => {
    console.log('[electron] Captions ready — flushing pending bot speech and engaging avatar');
    localServer._flushPendingBotSpeech();
    if (meetView && !meetView.webContents.isDestroyed()) {
      meetView.webContents.send('extension-message', { action: 'set-engaged' });
    }
  });

  ipcMain.on('tts-ended', () => {
    // If only the ack just finished, stay in 'thinking' — the agent is still
    // generating the real response and will clear the flag when it speaks.
    if (ackTtsPending) {
      ackTtsPending = false;
      return;
    }
    // After real bot speech: restore mic to mode-appropriate state. Passive/silent
    // want the mic muted (matches user's mute toggle); active wants it open.
    if (meetView && !meetView.webContents.isDestroyed()) {
      const shouldMute = localServer.mode === 'passive' || localServer.mode === 'silent';
      meetView.webContents.send('extension-message', {
        action: shouldMute ? 'mute-mic' : 'unmute-mic',
      });
    }
    // TTS playback finished — return to idle (or listening if a waiter is
    // active). force=true so the speaking-→-listening guard in _setBotState
    // (which prevents premature transitions when speak/wait_for_speech are
    // called back-to-back) doesn't block this legitimate end-of-speech.
    localServer._setBotState(
      localServer.waiters.length > 0 ? 'listening' : 'idle',
      undefined,
      { force: true }
    );
  });

  // User toggled the mic in Meet's UI — map to listening mode.
  // Muted = passive (only respond when name mentioned).
  // Unmuted = active (respond on every pause).
  // The MCP set_mode tool can still set 'silent' separately.
  ipcMain.on('mic-mute-changed', (_event, { muted }) => {
    const newMode = muted ? 'passive' : 'active';
    if (localServer.mode === newMode) return;
    // Don't downgrade silent → passive on a mute click; user is already silenced.
    if (muted && localServer.mode === 'silent') return;
    console.log('[electron] Mic toggle → mode:', newMode);
    localServer.setMode(newMode);
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

  // --- Participant list + presenting state from preload-meet.js ---
  ipcMain.on('participants-updated', (_event, participants) => {
    localServer.setParticipants(participants || []);
  });

  ipcMain.on('chat-unread', (_event, { unread }) => {
    localServer.setChatUnread(!!unread);
  });

  ipcMain.on('someone-presenting', (_event, { presenting, presenterName }) => {
    localServer.setSomeoneElsePresenting(presenting, presenterName);
  });

  // Track our own presenting state from Meet UI (Stop presenting button visible)
  ipcMain.on('self-presenting', (_event, { presenting }) => {
    const wasSharing = localServer.sharing;
    localServer.setSharing(presenting);
    if (!presenting) {
      // Distinguish an agent-initiated stop (onStopSharing already cleared
      // fullScreenShareRequested and pushed a screen-share-stopped event)
      // from an unexpected drop (browser killed the stream, user clicked
      // Chrome's floating Stop pill, codec stall, perm flip mid-call).
      // When the agent asked to share and we transition from sharing→not
      // sharing without anyone having cleared the request, that's a drop.
      if (wasSharing && fullScreenShareRequested) {
        console.warn('[electron] Screen share ended unexpectedly');
        localServer.addError('Screen share ended unexpectedly');
      }
      fullScreenShareRequested = false;
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
    // A blank Server URL means "use the default" — delete the override rather
    // than storing an empty string. Previously the falsy guard left the old
    // value in place, so clearing the field did nothing.
    if (Object.prototype.hasOwnProperty.call(config, 'baseUrl')) {
      const trimmed = (config.baseUrl || '').trim();
      if (trimmed) {
        store.set('syncBaseUrl', trimmed);
        sync.updateConfig({ baseUrl: trimmed });
      } else {
        store.delete('syncBaseUrl');
        sync.updateConfig({ baseUrl: DEFAULT_WEBSITE });
      }
    }
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
    const baseUrl = getWebsiteUrl();
    const roomUrl = `${baseUrl}/room/${meetCode}?mode=whiteboard`;

    if (!whiteboardWindow || whiteboardWindow.isDestroyed()) {
      whiteboardWindow = createWhiteboardWindow(roomUrl);
    }

    console.log('[electron] Whiteboard window opened:', roomUrl);
  });

  // Combined: open whiteboard + trigger screen share in Meet
  ipcMain.handle('share-whiteboard', async (_event, { meetCode }) => {
    const baseUrl = getWebsiteUrl();
    const roomUrl = `${baseUrl}/room/${meetCode}?mode=whiteboard`;

    // Open whiteboard window if not already open
    if (!whiteboardWindow || whiteboardWindow.isDestroyed()) {
      whiteboardWindow = createWhiteboardWindow(roomUrl);
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
    // Full screen share mode — return the primary display
    if (fullScreenShareRequested) {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 },
        });
        if (sources.length > 0) {
          console.log('[electron] Full screen share source:', sources[0].id);
          return { sourceId: sources[0].id };
        }
        return { error: 'No screen source found' };
      } catch (err) {
        return { error: err.message };
      }
    }

    // Whiteboard window share mode
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
