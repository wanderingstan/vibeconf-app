// main.js — Electron main process
// Manages Meet BrowserView + panel sidebar in a single window,
// IPC routing, TTS, and sync.

const { app, BrowserWindow, BrowserView, ipcMain, session, shell, nativeImage, desktopCapturer, systemPreferences, dialog, Menu, net } = require('electron');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const Store = require('./store.js');
const profileManager = require('./profile-manager.js');
const { resolveSvg } = require('./svg-resolver.js');
const { initSessionLog, logSessionHeaderUpdate, getRecentSessionLog, getSessionLogPath } = require('./session-log.js');
// The call-provider contract. main.js is the consumer side: it subscribes to
// CALL_EVENTS (provider → app) and issues CALL_COMMANDS (app → provider) by
// constant rather than raw channel string, so the contract is shared on both
// sides of the IPC wire (provider impl in google-meet-provider.js). Values are
// byte-identical to the prior literals — same wire.
const { CALL_EVENTS, CALL_COMMANDS } = require('./call-provider.js');

// Short HH:MM:SS.mmm prefix for emoji diagnostic logs.
function ts() {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

// Auto-stamp every console line with HH:MM:SS.mmm so the session log is a
// timeline by default. Skip stamping when the caller already prefixed with
// ts() to avoid double-timestamps. Catches main + everything else that
// console.log()s into stdout (preload-meet and page-inject lines come in
// already-stamped via their own monkey-patch, so this skip path matters).
(function installTimestampedConsole() {
  const TS_RE = /^\d{2}:\d{2}:\d{2}\.\d{3}$/;
  const wrap = (fn) => (...args) => {
    if (args.length && typeof args[0] === 'string' && TS_RE.test(args[0])) {
      fn(...args);
    } else {
      fn(ts(), ...args);
    }
  };
  console.log = wrap(console.log.bind(console));
  console.warn = wrap(console.warn.bind(console));
  console.error = wrap(console.error.bind(console));
})();

// --- Provider-aware command routing (#264) -------------------------------
// Meet drives the whole call through one surface (meetView). Slack splits it:
// DOM commands (mic/camera/chat/share/captions) target the huddle POPUP where
// SlackProvider runs, while audio-out (play-tts/play-speech-test/play-join-chime)
// targets the MAIN app.slack.com window (the VirtualMic that Chime captures).
// Set in createMainWindow when --provider=slack.
let slackProviderMode = false;
let slackSurface = null;
// In Slack mode, ONLY these commands target the huddle POPUP (huddle-UI / DOM
// ops handled by SlackProvider). Everything else — TTS/play-* (VirtualMic),
// avatar/engagement (VirtualCamera), etc. — is a page-inject op on the MAIN
// app.slack.com window, so it stays on meetView (same as Meet).
const SLACK_POPUP_CMDS = new Set([
  CALL_COMMANDS.ACTIONS.unmuteMic, CALL_COMMANDS.ACTIONS.muteMic,
  CALL_COMMANDS.ACTIONS.cameraOn, CALL_COMMANDS.ACTIONS.cameraOff,
  CALL_COMMANDS.triggerScreenShare, CALL_COMMANDS.triggerStopSharing,
  CALL_COMMANDS.setStudioSound, CALL_COMMANDS.recoverCaptions,
  CALL_COMMANDS.readChat, CALL_COMMANDS.sendChat,
]);

// The webContents a call command should target, given its action/channel name.
function callCmdWC(name) {
  if (slackProviderMode && slackSurface && SLACK_POPUP_CMDS.has(name)) {
    // These commands (chat, mic, camera, captions, share) are handled ONLY by
    // the huddle popup. If it isn't up yet (e.g. a chat fired before auto-join
    // completed), return null — do NOT fall back to meetView (the main
    // app.slack.com window). That window has no popup-command handlers, so a
    // misrouted send is silently dropped and chatRequest hangs to its 15s
    // timeout. null makes the caller fail fast ("No active call view") instead.
    return (slackSurface.getHuddleWebContents && slackSurface.getHuddleWebContents()) || null;
  }
  return (meetView && !meetView.webContents.isDestroyed()) ? meetView.webContents : null;
}
// Send a dedicated call-command channel (trigger-screen-share, set-studio-sound,
// recover-captions, …) to the right surface.
function sendCallCmd(channel, payload) {
  const wc = callCmdWC(channel);
  if (!wc) {
    // Previously a silent return — which hid #269: the whiteboard Present-now
    // trigger was dropped whenever meetView was momentarily null/destroyed, with
    // no trace. Make every dropped command visible.
    console.warn('[electron] sendCallCmd: no target webContents for "' + channel + '" — command DROPPED (call view null/destroyed?)');
    return;
  }
  if (payload === undefined) wc.send(channel); else wc.send(channel, payload);
}
// Send an extension-message {action, …} to the right surface (routed by action).
function sendExtMsg(message) {
  const wc = callCmdWC(message && message.action);
  if (wc) wc.send(CALL_COMMANDS.extensionMessage, message);
}

// The bot's name on the ACTIVE platform, for addressivity (recognizing when the
// bot is addressed) in the conversation loop. On Slack the bot joins as its
// signed-in Slack ACCOUNT, so use the separate slackBotName; on Meet it's the
// Meet botName (guest name / Google account name). Distinct because the bot's
// display name commonly differs between the two.
function getActiveBotName() {
  if (slackProviderMode) return store?.get('slackBotName') || store?.get('botName') || '';
  return store?.get('botName') || '';
}

// Round-trip request to the call preload (read/send chat). Sends on `channel`
// with a unique requestId and resolves with the matching 'chat-result' reply,
// or a timeout error. Handled by preload-meet.js (Meet) / preload-slack-huddle.js
// (Slack), routed to the right surface via callCmdWC.
function chatRequest(channel, payload) {
  return new Promise((resolve) => {
    const wc = callCmdWC(channel);
    if (!wc) {
      resolve({ ok: false, error: 'No active call view' });
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
    ipcMain.on(CALL_EVENTS.chatResult, handler);
    wc.send(channel, { requestId, ...payload });
  });
}

// ---------------------------------------------------------------------------
// Load extension modules (they export on globalThis)
// The extension files live under the root package.json which has "type": "module",
// so require() fails. We load them as text and run in the current context.
// ---------------------------------------------------------------------------

// The formerly-separate scripts (page-inject, sync-client, tts, stt) and
// test-speech.mp3 now live alongside main.js in electron-app/ (bundled via the
// build's files glob), so __dirname resolves in both dev and packaged builds.
const EXT_DIR = __dirname;

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

// Two-tier triage EVAL pairing: the most recent fast-model turn-taking verdict
// from a floor-open, held until the slow session actually speaks so we can log
// whether triage correctly predicted a response was expected. { ack, category,
// ms, at }. Null when none pending.
let pendingTriage = null;

// Local HTTP server for agent communication (replaces remote sync for MCP)
const localServer = new globalThis.LocalServer({
  appVersion: app.getVersion(),
  getWhiteboardLoadedUrl: () => {
    try {
      if (whiteboardWindow && !whiteboardWindow.isDestroyed() && !whiteboardWindow.webContents.isDestroyed()) {
        return whiteboardWindow.webContents.getURL() || null;
      }
    } catch { /* ignore */ }
    return null;
  },
  // The user's persistent panel preference, read live (#212). Lets the MCP
  // resolve an omitted bot_name to this instead of a frozen env default, and
  // keeps join_call from ever overwriting it.
  getConfiguredBotName: () => (store?.get('botName') || 'Jimmy'),
  onBotSpeech: (text, voice, emoji) => {
    console.log('[local-server] Bot speech:', text.slice(0, 80), emoji ? `(emoji: ${emoji})` : '');
    // Triage EVAL: pair the fast model's turn-taking verdict with the fact that
    // the slow session DID speak this turn — the ground truth for "was a response
    // expected?". triage said ack=true → correct (it predicted the response).
    // triage said ack=false but slow spoke → a MISS (it should have acked; the
    // slow model came in late, exactly Stan's recoverable case). gap = floor-open
    // verdict → this utterance (≈ how long the ack would have covered).
    if (pendingTriage) {
      const t = pendingTriage;
      pendingTriage = null;
      const gap = ((Date.now() - t.at) / 1000).toFixed(1);
      const hit = t.ack ? 'ACK✓ (predicted response)' : 'NO-ACK✗ (missed — slow came in late)';
      console.log(ts(), `🚦 [triage-eval] gap=${gap}s | triage=${t.ack ? 'ACK' : 'no-ack'}[${t.category},${t.ms}ms] → SLOW SPOKE → ${hit}`);
    }
    ackTtsPending = false;
    speakText(text, voice, emoji);
  },
  // Stop any in-flight TTS playback in the Meet view (back-off, #154). The
  // page-inject side clears its queue too. Best-effort: silent no-op if the
  // meet view is gone.
  onStopTts: (reason) => {
    console.log('[local-server] stop-tts:', reason || 'unspecified');
    if (meetView && !meetView.webContents.isDestroyed()) {
      meetView.webContents.send('extension-message', {
        action: 'stop-tts',
        payload: { reason: reason || 'back-off' },
      });
    }
  },
  onWhiteboardUpdate: (content, sender) => {
    console.log('[local-server] Whiteboard update from', sender, ':', content.slice(0, 80));
    const roomId = localServer.roomId;
    if (roomId) {
      const baseUrl = getWebsiteUrl();
      const roomUrl = `${baseUrl}/room/${roomId}?mode=whiteboard`;

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
    logSessionHeaderUpdate('roomId', meetCode);
    if (botName) {
      // #212: do NOT persist to the store — that's the user's panel preference
      // and a per-call name must not silently overwrite it. The per-call name
      // lives in localServer.currentCallBotName (set in the join handler);
      // preload-meet types localServer.getEffectiveBotName() into Meet via the
      // get-meet-bot-name IPC. We still update the sync-client config so the
      // bot registers in the room under this call's name.
      sync.updateConfig?.({ botName });
      logSessionHeaderUpdate('botName', botName);
    }
    // Slack: the bot is ALREADY in the huddle (the surface auto-joined on the
    // provider switch) and the room/sync are already set up. There's no Meet URL
    // to navigate to — synthesizing meet.google.com/<slack-code> would load a
    // broken page into the Slack surface. So skip navigation; /join-call becomes
    // "confirm in-call + start the loop". For Meet, navigate as before.
    if (slackProviderMode || /^slack-/.test(meetCode || '')) {
      console.log('[local-server] Slack join — bot already in huddle, skipping Meet navigation');
    } else {
      const meetUrl = `https://meet.google.com/${meetCode}`;
      // Track what we've joined for EVERY join path — the panel paths set this,
      // but the MCP /join-call path didn't, which left browser Meet-detection
      // (and its push notifications) running mid-call. Mirror the other paths.
      currentMeetUrl = meetUrl;
      loadMeetURL(meetUrl);
    }

    // Pre-warm the LLM ack engine so the first real ack of the call
    // doesn't pay the multi-second cold-prefill cost. Fire-and-forget;
    // the ~5-10s bot-navigating-to-Meet window absorbs the warmup
    // latency invisibly. Noop when ackProvider is 'builtin'.
    const ackModule = require('./ack');
    ackModule.warmup({
      store,
      log: (msg) => console.log(ts(), '[ack]', msg),
    }).catch(() => {});

    // Also warm the LOCAL model used by triage / comprehend (independent of
    // ackProvider) — without this the first few triage requests cold-start-timed
    // out while LM Studio loaded the model. Only when those features are on.
    if (store?.get('triageAck') || (Number(store?.get('comprehendCharThreshold')) || 0) > 0) {
      ackModule.warmupLocalModel({
        store,
        log: (msg) => console.log(ts(), '[triage-warmup]', msg),
      }).catch(() => {});
    }
  },
  onLeaveCall: () => {
    console.log('[local-server] Leave call requested by agent');
    shareGeneration++; // cancel any in-flight Present-now retry loop before the view tears down

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
  // Play an arbitrary audio file into the call (#audio). Resolve the source to
  // base64 (inline data / local file via fs / remote URL via fetch), then route
  // it through the SAME virtual-mic playback TTS uses (unmute-mic → play-tts).
  // decodeAudioData (renderer side) handles mp3/wav/ogg, so no format flag.
  onPlayAudio: ({ url, path: filePath, audioData, emoji }) => {
    // Funnel through the same serial audio chain as speakText so a preceding
    // spoken ack always plays BEFORE this sound, regardless of fetch vs synth
    // timing (#audio).
    enqueueAudio(async () => {
      try {
        let base64 = audioData || null;
        if (!base64 && filePath) base64 = fs.readFileSync(filePath).toString('base64');
        if (!base64 && url) {
          const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
          if (!res.ok) throw new Error(`fetch ${res.status}`);
          base64 = Buffer.from(await res.arrayBuffer()).toString('base64');
        }
        if (!base64) { console.error('[local-server] play-audio: no source provided'); return; }
        console.log('[local-server] play-audio:', url || filePath || '(inline)', '→', base64.length, 'b64');
        await sendPlayTts(base64, emoji);
      } catch (err) {
        console.error('[local-server] play-audio failed:', err.message);
        // Don't strand 'speaking' if resolving the audio failed.
        if (localServer.botState === 'speaking') localServer._setBotState(localServer.waiters.length ? 'listening' : 'idle', undefined, { force: true });
      }
    });
  },
  onShareWhiteboard: (shareType) => {
    console.log('[local-server] Share requested by agent, type:', shareType);
    const meetCode = localServer.roomId;
    if (meetCode) {
      // Meet sets sharing optimistically (the present-flow is reliable). On Slack
      // the share engages ~2s later (whiteboard window opens, then the popup
      // clicks the share button → getDisplayMedia), and the popup reports the
      // REAL toggle state via selfPresenting → setSharing. So DON'T pre-set true
      // on Slack: let the actual share drive `sharing`, so the flag can't claim a
      // share that silently failed (and a too-early stop can't get masked).
      if (!slackProviderMode) localServer.setSharing(true);
      if (shareType === 'screen') {
        // Full screen share — no whiteboard window needed
        fullScreenShareRequested = true;
        if (meetView && !meetView.webContents.isDestroyed()) {
          sendCallCmd(CALL_COMMANDS.triggerScreenShare, { shareType: 'screen' });
        }
      } else {
        // Whiteboard share — open whiteboard window first. Keep the flag
        // false so setDisplayMediaRequestHandler routes through the
        // whiteboard-window picker (with main-window exclusion to avoid
        // #158's infinity-mirror), not the full-screen-grab branch.
        fullScreenShareRequested = false;
        ipcMain.emit('start-whiteboard-share', {}, { meetCode });
        // Trigger Meet's "Present now" once the whiteboard window is up. A single
        // 2s setTimeout silently dropped the trigger whenever meetView was
        // null/destroyed at that instant (mid-rejoin / view swap), so startShare
        // never ran, the bot never presented, and the failure was invisible
        // (#269). Retry a few times, re-resolving meetView each attempt.
        //
        // But the loop must STOP firing once the share lands or the call moves
        // on — otherwise a stray retry re-triggers after the share already
        // engaged or after a stop/leave tore down the whiteboard window. On Meet
        // that's a harmless no-op (idempotent Present-now guard); on Slack the
        // control is a single TOGGLE, so a late re-click flips sharing OFF and
        // then getDisplayMedia crashes ("Video was requested, but no video stream
        // was provided") on the gone window. Guard with a generation token
        // (cancel on stop/leave) and, on Slack, stop as soon as `sharing` (the
        // real selfPresenting toggle) reports engaged.
        const myGen = ++shareGeneration;
        (async () => {
          for (let attempt = 1; attempt <= 5; attempt++) {
            await new Promise((r) => setTimeout(r, attempt === 1 ? 1800 : 2000));
            if (myGen !== shareGeneration) {
              console.log('[electron] Whiteboard share: Present trigger loop cancelled (superseded by stop/leave/new share)');
              return;
            }
            // On Slack `sharing` tracks the REAL toggle (selfPresenting), so once
            // it's engaged, re-triggering would turn it back OFF — stop. On Meet
            // `sharing` is set optimistically up front, so it isn't a reliable
            // "engaged" signal there; keep the belt-and-suspenders retries.
            if (slackProviderMode && localServer.sharing) {
              console.log('[electron] Whiteboard share: engaged on Slack (attempt ' + attempt + ') — stopping retries');
              return;
            }
            if (meetView && !meetView.webContents.isDestroyed()) {
              console.log('[electron] Whiteboard share: Present-now trigger attempt ' + attempt + '/5');
              sendCallCmd(CALL_COMMANDS.triggerScreenShare, { shareType: 'window' });
            } else {
              console.warn('[electron] Whiteboard share: meetView unavailable on Present trigger attempt ' + attempt + '/5 (#269)');
            }
          }
        })();
        // #189: drop the board-only URL into Meet chat the first time the
        // whiteboard is shared this call, so participants can open it in
        // their own browser instead of squinting at the shared tile.
        // Delayed past the share trigger because sending chat briefly
        // steals the side pane from speaker detection.
        if (!whiteboardLinkPostedForCall) {
          whiteboardLinkPostedForCall = true; // set now to prevent double-scheduling this call; reset below on any failure
          setTimeout(async () => {
            const base = (getWebsiteUrl() || '').replace(/\/$/, '');
            if (!base || !meetCode) {
              // #241: don't silently early-return — log it and allow a retry.
              whiteboardLinkPostedForCall = false;
              console.warn('[main] #189 whiteboard auto-post skipped — empty base/room (base=' +
                JSON.stringify(base) + ', room=' + JSON.stringify(meetCode) + ')');
              return;
            }
            const url = `${base}/room/${meetCode}?mode=whiteboard`;
            // #241: the chat pane can be slow/flaky to open right after a share,
            // so retry a few times rather than failing on one bad attempt (the
            // user may only share once, so "retry on next share" wasn't enough).
            let posted = false;
            for (let i = 1; i <= 3 && !posted; i++) {
              const result = await chatRequest(CALL_COMMANDS.sendChat, { text: `Whiteboard (live): ${url}` });
              if (result?.ok) {
                posted = true;
                console.log('[main] #189 posted whiteboard link to chat:', url);
              } else {
                console.warn('[main] #189 whiteboard link post attempt', i, 'failed:', result?.error || '(no result)');
                if (i < 3) await new Promise((r) => setTimeout(r, 2000));
              }
            }
            if (!posted) {
              whiteboardLinkPostedForCall = false; // allow another try on the next share
              console.warn('[main] #189 gave up auto-posting whiteboard link after 3 attempts');
            }
          }, 5000);
        }
      }
    }
  },
  onStopSharing: () => {
    console.log('[local-server] Stop sharing requested by agent');
    fullScreenShareRequested = false;
    shareGeneration++; // cancel any in-flight Present-now retry loop (it would re-toggle Slack)
    // Close the whiteboard window — this ends the display media stream for whiteboard shares
    if (whiteboardWindow && !whiteboardWindow.isDestroyed()) {
      whiteboardWindow.close();
      whiteboardWindow = null;
    }
    // Click Meet's "Stop presenting" button — works for both whiteboard and full-screen shares
    if (meetView && !meetView.webContents.isDestroyed()) {
      sendCallCmd(CALL_COMMANDS.triggerStopSharing);
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
  // Profile switcher (#282): a sibling instance asked us to come forward.
  onFocusRequest: () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    if (app.dock) app.dock.show();
    app.focus({ steal: true });
  },
  onScrollShare: async ({ direction, amount } = {}) => {
    if (!whiteboardWindow || whiteboardWindow.isDestroyed()) {
      return { ok: false, error: 'Nothing is being shared to scroll' };
    }
    // Default to ~85% of the viewport per scroll so content overlaps slightly.
    const dir = (direction || 'down').toLowerCase();
    const px = Number(amount) > 0 ? Number(amount) : null;
    const js = `(() => {
      const vh = window.innerHeight || 800;
      const step = ${px === null ? 'Math.round(vh * 0.85)' : px};
      // Find what actually scrolls. A loaded URL is the document itself, so the
      // document scrolls. Markdown is rendered into a nested container (.wb-slide,
      // overflow-y:auto) while html/body are overflow:hidden — so the document
      // doesn't move and we must scroll the inner container instead (issue #234).
      const doc = document.scrollingElement || document.documentElement;
      let target = doc;
      if (doc.scrollHeight - doc.clientHeight <= 4) {
        let mostHidden = 0;
        for (const el of document.querySelectorAll('*')) {
          const oy = getComputedStyle(el).overflowY;
          if (oy !== 'auto' && oy !== 'scroll') continue;
          const hidden = el.scrollHeight - el.clientHeight;
          if (hidden > mostHidden + 4) { target = el; mostHidden = hidden; }
        }
      }
      if ('${dir}' === 'top') { target.scrollTo({ top: 0, behavior: 'smooth' }); return 'top'; }
      if ('${dir}' === 'bottom') { target.scrollTo({ top: target.scrollHeight, behavior: 'smooth' }); return 'bottom'; }
      target.scrollBy({ top: '${dir}' === 'up' ? -step : step, left: 0, behavior: 'smooth' });
      return '${dir}';
    })()`;
    try {
      await whiteboardWindow.webContents.executeJavaScript(js, true);
      console.log('[local-server] Scrolled shared window:', dir, px || '(page)');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
  // Read-only DOM extraction: run querySelectorAll in the Meet view
  // or the shared whiteboard window and return the matched elements' outerHTML.
  // Lets the bot inspect what it (or a participant) is actually looking at —
  // e.g. locate a modal's dismiss button, debug a blank whiteboard render.
  onInspectDom: async ({ target, selector, maxElements, maxChars } = {}) => {
    const which = (target || 'meet').toLowerCase();
    let wc = null;
    if (which === 'meet' || which === 'call') {
      wc = meetView && !meetView.webContents.isDestroyed() ? meetView.webContents : null;
      if (!wc) return { ok: false, error: 'No active Meet view (the bot is not in a call).' };
    } else if (which === 'share' || which === 'screen' || which === 'whiteboard') {
      // 'share' is the canonical term — the window being screen-shared into Meet,
      // whatever it shows (the whiteboard, or any URL loaded into it). 'whiteboard'
      // is accepted as a back-compat alias.
      wc = whiteboardWindow && !whiteboardWindow.isDestroyed() && !whiteboardWindow.webContents.isDestroyed()
        ? whiteboardWindow.webContents : null;
      if (!wc) return { ok: false, error: 'No screen-share window is open (nothing is being shared into the call).' };
    } else {
      return { ok: false, error: `Unknown target '${target}'. Use 'meet' or 'share'.` };
    }
    const sel = String(selector || 'body');
    const maxEls = Math.max(1, Math.min(20, Number(maxElements) || 5));
    const perElCap = Math.max(200, Math.min(20000, Number(maxChars) || 4000));
    const js = `(() => {
      try {
        const els = Array.from(document.querySelectorAll(${JSON.stringify(sel)}));
        const cap = ${perElCap};
        const html = els.slice(0, ${maxEls}).map((el) => {
          const h = el.outerHTML || '';
          return h.length > cap ? h.slice(0, cap) + '\\n…[truncated ' + (h.length - cap) + ' chars]' : h;
        });
        return { ok: true, total: els.length, returned: html.length, html };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    })()`;
    try {
      const result = await wc.executeJavaScript(js, true);
      console.log('[local-server] inspect-dom', which, JSON.stringify(sel), '→',
        result?.ok ? `${result.returned}/${result.total} els` : `error: ${result?.error}`);
      return result || { ok: false, error: 'no result' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
  onBotStateChange: async (state, extra) => {
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
    // When triage is enabled (triageAck), the ack is gated by the smart
    // triage verdict in onTriageAck instead of this regex-addressivity path —
    // skip here to avoid a double ack.
    // A background_tick is a silent "think, don't speak" wake (#245) — never
    // fire a spoken ack there, or the bot interrupts whoever still has the floor.
    if (state === 'thinking' && localServer.mode === 'active' && !store?.get('triageAck') && !extra?.backgroundTick) {
      const wordCount = extra?.wordCount || 0;
      const text = (extra?.text || '').toLowerCase();

      // Working-state thinking (agent doing tool work between turns or
      // post-speak) has no user-speech context — wordCount=0, text=''.
      // Without this gate the ack-llm fires with an empty "User said: \"\""
      // prompt and the model hallucinates a phrase ("Hmm, let me think.")
      // that plays out of nowhere mid-tool-call. Real user-speech thinking
      // always passes wordCount, so this only suppresses the working path.
      if (wordCount <= 0) return;

      // Addressivity (#155). Three regimes:
      //   - 1:1 (one human + this bot)  → always ack, no ambiguity
      //   - multi-participant, my name  → always ack (forced)
      //   - multi-participant, OTHER's name → never ack (suppress)
      //   - multi-participant, no name  → default by wordCount
      // Names are matched as whole words, case-insensitive.
      const snap = localServer.getCallStateSnapshot();
      const myName = getActiveBotName().toLowerCase();
      const otherNames = new Set(
        (snap.participants || [])
          .filter((p) => !p.isSelf && p.name && p.name !== 'You')
          .map((p) => p.name.toLowerCase())
          .filter((n) => n && n !== myName)
      );
      // Members may include bots that haven't shown up in the DOM yet.
      for (const m of (localServer.members || [])) {
        const n = (m.name || '').toLowerCase();
        if (n && n !== myName) otherNames.add(n);
      }
      // People address each other by FIRST name ("hey jimmy"), but the Meet
      // roster carries full account names ("jimmy bot", "Stan James" — a
      // signed-in bot shows its Google name). Match the full name OR its first
      // token, so "jimmy" recognizes the "jimmy bot" participant. (Without this,
      // a bot misreads a turn addressed to another bot as "unspecified" and acks
      // into it.)
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const nameMatches = (full) => {
        const clean = (full || '').trim();
        if (!clean) return false;
        const toks = clean.split(/\s+/);
        const cands = toks.length > 1 ? [clean, toks[0]] : [clean];
        return cands.some((c) => c.length >= 2 && new RegExp(`\\b${esc(c)}\\b`, 'i').test(text));
      };
      const addressedToMe = myName ? nameMatches(myName) : false;
      const addressedToOther = [...otherNames].some((n) => nameMatches(n));
      // 1:1 = exactly one non-self, non-bot participant in the call. Use the
      // already-tagged isBot from the snapshot so the count is correct even
      // when the bot list is populating slowly.
      const humansInCall = (snap.participants || []).filter(
        (p) => !p.isSelf && !p.isBot && p.name && p.name !== 'You'
      );
      const isOneOnOne = humansInCall.length === 1;

      let addressivity;
      if (isOneOnOne) addressivity = 'me-1on1';
      else if (addressedToMe) addressivity = 'me';
      else if (addressedToOther) addressivity = 'other';
      else addressivity = 'unspecified';

      // Only ack when we're actually being addressed: named ('me') or a true
      // 1:1 ('me-1on1'). In a multi-party call, 'other' (someone else named) and
      // 'unspecified' (no name at all) must NOT ack — otherwise the bot blurts a
      // filler into a long utterance it wasn't part of and interrupts the speaker
      // (live: Samantha acked "hey jimmy, …" because she misread it as unspecified
      // and jumped into a mid-sentence pause).
      if (addressivity === 'other' || addressivity === 'unspecified') {
        console.log(ts(), '🤐 [ack] Suppressing — not addressed to me (' + addressivity + ')');
        return;
      }

      // The exact transcript text the bot received — same string passed to
      // the agent's wait_for_speech return and to the ack decider below.
      // Surfaces "did Meet's captions catch what I actually said" without
      // needing to dig elsewhere in the log.
      console.log(ts(), '[ack] trigger:', JSON.stringify(text.slice(0, 300)),
        '(wordCount=' + wordCount + ', addressivity=' + addressivity + ')');

      // Ack decider — dispatched through ack/index.js. Defaults to the same
      // wordcount-and-pick logic as before; setting ackProvider='openai-compat'
      // swaps in an HTTP call to any OpenAI-Chat-Completions endpoint
      // (LM Studio, Ollama, OpenAI, OpenRouter, etc.). Endpoint failures fall
      // back to builtin so the bot is never worse than baseline.
      const ackModule = require('./ack');
      const ackResult = await ackModule.decide({
        text,
        wordCount,
        addressivity,
        mode: localServer.mode,
        recentTranscript: localServer.transcripts.slice(-5),
        store,
        log: (msg) => console.log(ts(), '[ack]', msg),
      });
      const ack = ackResult.phrase;

      // Record health/status for the troubleshooting panel — visible at-a-
      // glance whether the LLM path is hitting, falling back, or skipped.
      localServer.setLastAckEvent({
        phrase: ack,
        source: ackResult.source,
        latencyMs: ackResult.latencyMs,
        error: ackResult.error,
        wordCount,
        addressivity,
        at: Date.now(),
      });

      if (!ack) {
        console.log(ts(), '🤐 [ack] Skipping (wordCount=' + wordCount + ', addressivity=' + addressivity + ')');
        return;
      }

      console.log(ts(), '👂 [ack] Playing acknowledgement:', JSON.stringify(ack), '(wordCount=' + wordCount + ', addressivity=' + addressivity + ')');
      // Speak the acknowledgment immediately (before the agent responds).
      // Mark the ack so its tts-ended doesn't drop us out of 'thinking' while
      // the agent is still generating the real response.
      ackTtsPending = true;
      speakText(ack);
      // Surface the phrase to the slow model on its next wait_for_speech,
      // so it can self-correct if its real response contradicts the ack
      // tone. Cleared after one read on the local-server side.
      localServer.setLastAckPhrase(ack);
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
    // #282: remember the name used in a Slack huddle (the slackBotName override,
    // else the bot name) so the profile selector + idle sub-line can show it.
    // The live Slack account name isn't readable, so this is our best signal.
    if (status === 'in-call' && slackProviderMode && store) {
      const slackName = store.get('slackBotName') || store.get('botName') || null;
      if (slackName && store.get('lastSlackName') !== slackName) store.set('lastSlackName', slackName);
    }
    // #189: a fresh call gets a fresh auto-posted whiteboard link.
    if (status !== 'in-call') whiteboardLinkPostedForCall = false;
    // Don't let a shadow draft from a finished call pair with the next call's
    // greeting (shadow-eval).
    if (status !== 'in-call') pendingTriage = null;
    // Forward to page-inject so the avatar can show 🫥 while joining/waiting.
    if (meetView && !meetView.webContents.isDestroyed()) {
      meetView.webContents.send('extension-message', {
        action: 'set-call-status',
        payload: { status },
      });
    }
    // Studio sound: if disabled by pref, turn off Meet's voice filter once in-call
    // so non-voice audio (SFX/music via play_audio) passes through. Delay lets the
    // in-call toolbar (More options ⋮) finish rendering. Default leaves it ON.
    if (status === 'in-call' && store.get('studioSound') === false && meetView && !meetView.webContents.isDestroyed()) {
      setTimeout(() => {
        if (meetView && !meetView.webContents.isDestroyed()) {
          console.log('[electron] Disabling Meet Studio sound (studioSound pref = false)');
          sendCallCmd(CALL_COMMANDS.setStudioSound, { enabled: false });
        }
      }, 2500);
    }
    // Also let the panel reflect real call state. Showing "Leave Call" between
    // "URL navigated" and "actually admitted" is misleading — especially when
    // entry is denied, since that 15s grace window leaves the button visible
    // while we wait for the denial page to be detected.
    if (panelView && !panelView.webContents.isDestroyed()) {
      panelView.webContents.send('call-status-changed', { status, provider: slackProviderMode ? 'slack' : 'meet' });
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

  onCaptionsChange: (on) => {
    // Captions are the bot's only ear — off === deaf. Flip the avatar emoji
    // so call participants (who can fix it) see the bot can't hear, instead
    // of just sitting silent. Cleared when captions return.
    if (meetView && !meetView.webContents.isDestroyed()) {
      meetView.webContents.send('extension-message', {
        action: 'set-deaf',
        payload: { deaf: on === false },
      });
    }
    // Keep the panel's caption badge consistent — this fires for the
    // self-correcting on-state (captions text arrived) as well as toggles.
    if (panelView && !panelView.webContents.isDestroyed()) {
      panelView.webContents.send('caption-state', { on: !!on });
    }
  },

  // Background working-memory refresh (two-tier experiment). Fired by
  // local-server when enough new transcript has accumulated. Runs the local
  // model off the hot path and writes the result back. Non-blocking and
  // best-effort — failures are swallowed in comprehend() and we just skip.
  onComprehensionDue: async (transcript, workingMemory, roster) => {
    // Uses the shared local-model endpoint directly — NOT gated on ackProvider
    // (comprehension is its own consumer; it runs even when the ack is builtin).
    // The enable switch is comprehendCharThreshold (0 disables, checked in
    // local-server). comprehend() fails gracefully if no endpoint is up.
    const config = require('./ack').getLocalModelConfig(store);
    const { comprehend } = require('./comprehend');
    const { classifyEngagement } = require('./engagement');
    const botName = getActiveBotName() || 'the bot';
    const cfg = { endpoint: config.endpoint, apiKey: config.apiKey, model: config.model };
    // Run the working-memory refresh and the dedicated engagement classifier
    // (#243) in parallel — separate calls because folding engagement into
    // comprehend's bundled JSON made the small model anchor the bot in every
    // exchange; the isolated speaker→addressee classifier doesn't. See
    // engagement.js for the why.
    const [result, eng] = await Promise.all([
      comprehend({ transcript, workingMemory, roster, botName, config: { ...cfg, timeoutMs: 8000 }, log: (m) => console.log(ts(), '🧩', m) }),
      classifyEngagement({ transcript, roster, botName, config: { ...cfg, timeoutMs: 6000 }, log: (m) => console.log(ts(), '🤝', m) }),
    ]);
    const patch = {};
    if (result) Object.assign(patch, result);
    if (eng && typeof eng.engagement === 'string') {
      patch.engagement = eng.engagement;
      console.log(ts(), `🤝 [engagement] ${eng.speaker} → ${eng.addressing} ⇒ "${eng.engagement}" (${eng.ms}ms)`);
    }
    if (Object.keys(patch).length) {
      localServer.setWorkingMemory({ ...patch, updatedBy: 'auto' });
    }
  },
  // Two-tier TRIAGE shadow (docs/two-tier-design.md): at each floor-open, the
  // fast model classifies whether the bot is being addressed (ack expected) vs
  // the others talking among themselves. LOG-ONLY — non-authoritative; the slow
  // session still drives all speech. Validates the classifier's accuracy before
  // wiring it to fire instant acks. The eval settled that the 7B can't be the
  // voice; turn-taking is the role it can actually do (classification).
  onTriageAck: async ({ lastUtterance, recentTranscript, roster }) => {
    // Gated by the triageAck pref: Apple triage decides ack yes/no for this turn.
    if (!store?.get('triageAck')) return;
    // Shared local-model endpoint, independent of ackProvider (builtin ack = low
    // contention while the triage shadow measures).
    const config = require('./ack').getLocalModelConfig(store);
    const { triage } = require('./triage');
    const botName = getActiveBotName() || 'the bot';
    // Feed the background-maintained engagement state (#243) so a bare "you" /
    // unnamed follow-up resolves to this bot when it's mid-exchange. comprehend
    // keeps this fresh on the same (Apple) local model; the slow session can
    // override it via post_understanding.
    const engagement = localServer.getWorkingMemory?.()?.engagement || '';
    const result = await triage({
      lastUtterance,
      recentTranscript,
      roster,
      botName,
      engagement,
      config: { endpoint: config.endpoint, apiKey: config.apiKey, model: config.model, timeoutMs: 5000 },
      log: (m) => console.log(ts(), '🚦 [triage]', m),
    });
    if (!result) { console.log(ts(), '🚦 [triage] no verdict (parse/endpoint failure)'); return; }
    // Log the EXACT utterance triage classified — the offline harness proved the
    // classifier is ~perfect on clean input, so any live miss is a stale/wrong
    // input or an eval-pairing artifact. This makes that diagnosable against [heard].
    console.log(ts(), `🚦 [triage] ack=${result.ack ? 'YES' : 'no'} [${result.category}] (${result.ms}ms) — ${result.reason} | on: "${(lastUtterance || '').slice(0, 120)}"`);
    // Dump the FULL input as one JSON line so a live miss can be replayed EXACTLY
    // in scripts/triage-eval.mjs (offline reconstruction couldn't reproduce the
    // 'other-bot' misclassification — the live recentTranscript differs).
    console.log(ts(), '🚦 [triage-input] ' + JSON.stringify({ botName, roster, lastUtterance, recentTranscript }));
    // Hold the verdict so the next slow-session utterance can confirm whether a
    // response really was expected (ground truth). Overwritten by the next
    // floor-open if the slow session stays quiet through this one.
    pendingTriage = { ack: result.ack, category: result.category, ms: result.ms, at: Date.now() };

    // INSTANT ACK (non-authoritative): if triage says the bot is being addressed,
    // play a quick filler to cover the slow model's ~2.5s TTFT — "On it" while the
    // slow session generates the real response. Triage being wrong is cheap: a
    // missed ack just means the slow answer arrives without a filler; a stray ack
    // is one short phrase. Only in active mode + in-call. The regex ack-on-thinking
    // is suppressed (above) while triage drives, so no double ack.
    if (result.ack && localServer.mode === 'active' && localServer.callStatus === 'in-call') {
      const wordCount = (lastUtterance || '').split(/\s+/).filter(Boolean).length;
      const prefs = require('./preferences-schema').PREFERENCES;
      const longMin = Number(store?.get('ackLongMin')) || prefs.ackLongMin.default;
      const arr = wordCount >= longMin
        ? (store?.get('ackLongPhrases') || prefs.ackLongPhrases.default)
        : (store?.get('ackShortPhrases') || prefs.ackShortPhrases.default);
      const phrase = arr[Math.floor(Math.random() * arr.length)];
      if (phrase) {
        console.log(ts(), `👂 [ack] (triage-gated) Playing: ${JSON.stringify(phrase)} (${result.ms}ms after floor-open)`);
        ackTtsPending = true;
        speakText(phrase);
        localServer.setLastAckPhrase(phrase);
      }
    }
  },

  // Active-listening firing gate (#245). The local-server detected a brief
  // opening (room went quiet, bot not directly addressed). Run the Apple/local
  // completeness judge on the last utterance: only a genuinely FINISHED thought
  // is a real opening worth interjecting at. If so, fire a banked/generic probe.
  // Cheap guards (mode, rate limit, name-mention) already passed in local-server.
  onProbeOpening: async ({ lastUtterance, recentTranscript, roster }) => {
    if (!store?.get('probeFiring')) return;
    const config = require('./ack').getLocalModelConfig(store);
    const { judgeComplete } = require('./completeness');
    // Judge the raw last utterance (strip the "Speaker: " label the gate added).
    const text = (lastUtterance || '').replace(/^[^:]+:\s*/, '').trim();
    if (!text) return;
    const verdict = await judgeComplete({
      text,
      config: { endpoint: config.endpoint, apiKey: config.apiKey, model: config.model, timeoutMs: 4000 },
      log: (m) => console.log(ts(), '🎣 [probe-gate]', m),
    });
    if (!verdict) { console.log(ts(), '🎣 [probe-gate] no verdict (endpoint/parse failure) — skip'); return; }
    console.log(ts(), `🎣 [probe-gate] complete=${verdict.complete} (${verdict.ms}ms) — ${verdict.reason} | on: "${text.slice(0, 100)}"`);
    if (!verdict.complete) return; // not a real opening — they're mid-thought
    const spoken = localServer.fireProbe();
    if (spoken) console.log(ts(), `🎣 [probe] spoke: ${JSON.stringify(spoken)}`);
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
    pushAvatarEmojiOverrides(overrides);
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

  onReadChat: async () => chatRequest(CALL_COMMANDS.readChat, {}),
  onSendChat: async (text) => chatRequest(CALL_COMMANDS.sendChat, { text }),
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
    } else if (key === 'studioSound') {
      // Toggle Meet's voice filter live (no rejoin needed) when in-call.
      if (localServer.callStatus === 'in-call' && meetView && !meetView.webContents.isDestroyed()) {
        console.log('[electron] studioSound pref changed →', value, '— applying live');
        sendCallCmd(CALL_COMMANDS.setStudioSound, { enabled: value !== false });
      }
    }
  },
});

function pushAvatarEmojiOverrides(overrides = {}) {
  console.log('[local-server] Avatar emoji override:', overrides);
  if (meetView && !meetView.webContents.isDestroyed()) {
    meetView.webContents.send('extension-message', {
      action: 'set-avatar-emoji-override',
      payload: overrides,
    });
  }
}

sync.updateConfig({
  onWhiteboardUpdate: (whiteboard) => {
    localServer.applyRemoteWhiteboard(whiteboard);
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
let meetAccountEmailPinned = false; // true when --meet-account-email pinned the account (#282)
let mainWindow = null;   // single window that holds both views
let panelView = null;     // left sidebar BrowserView
let meetView = null;      // right Meet BrowserView
let panelPopoutWindow = null; // when popped out, the panelView lives here instead
let whiteboardWindow = null;
let fullScreenShareRequested = false;
// Generation token for the whiteboard-share "Present now" retry loop. Bumped on
// every new share AND on stop/leave, so a stray retry can't fire after the share
// already succeeded or after the whiteboard window was torn down. On Slack the
// share control is a single TOGGLE, so a late retry re-click flips it OFF and
// then crashes getDisplayMedia ("no video stream") on the gone window.
let shareGeneration = 0;
// #189: whether we've already auto-posted the whiteboard URL to Meet chat
// this call. Reset when the call ends so the next call posts again.
let whiteboardLinkPostedForCall = false;

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
  // Pin the BrowserWindow title so the loaded page can't overwrite it. The
  // share-handler matches the desktopCapturer source by this exact title to
  // avoid accidentally picking the main app window (which holds the Meet
  // view) and triggering Meet's infinity-mirror warning (#158/#137).
  win.on('page-title-updated', (e) => { e.preventDefault(); });
  win.loadURL(roomUrl);
  win.webContents.on('did-finish-load', () => {
    console.log('[electron] Whiteboard window loaded OK:', win.webContents.getURL());
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.warn('[electron] Whiteboard window FAILED to load:', code, desc, url,
      '— the captured window will be blank, which Meet may reject as "Can\'t share your screen".');
  });
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

// ONE persistent session partition per app profile — for everything this
// profile does, Meet AND Slack (#282). Collapsed from the old three-partition
// split (meet-guest / meet-account-default / slack).
//
// The old design swapped the meetView between a "guest" and an "account"
// partition at runtime to flip identity, and gave Slack its own box so the
// swap wouldn't drag Slack's login around. That over-fit a *profile* property
// (is this seat signed into Google?) onto a *runtime* mechanism. The honest
// model: identity is decided by the PROFILE — a profile whose partition has
// no Google cookies IS a guest; one with Google cookies is the signed-in bot.
// No swap, no second partition. Because each app profile already sets its own
// userData dir, this single name is physically isolated per profile, so
// "one app profile = one partition = one identity" holds.
//
// Slack rides the same partition safely now: the wrong-workspace loop it used
// to hit came from the *swapping* Meet partition; a single fixed partition
// keeps slack.com cookies in one consistent place (they're domain-scoped, so
// they never collide with google.com's).
const SESSION_PARTITION = 'persist:session';

// The idle Meet view: instead of a custom branded placeholder, show the real
// Google Meet home page. Lets the operator see sign-in state at a glance, start
// meetings, and debug manually in the same browser the bot uses. Join automation
// is gated off here in preload-meet (only meeting-code URLs trigger it).
const MEET_HOME_URL = 'https://meet.google.com/';

// Track whether configureMeetSession has been applied to the partition so we
// don't double-register handlers (which would call callback() twice and crash
// getDisplayMedia / permission flows).
const _configuredMeetPartitions = new Set();
function ensureMeetSessionConfigured(partition) {
  if (_configuredMeetPartitions.has(partition)) return;
  configureMeetSession(session.fromPartition(partition));
  _configuredMeetPartitions.add(partition);
}

// The partition the meetView is bound to. There's only one now (#282) — kept as
// a named binding so the createMeetView / ensureMeetSessionConfigured call sites
// read clearly. Never reassigned; guest-vs-signed-in is decided by cookies, not
// by swapping this.
const currentMeetPartition = SESSION_PARTITION;

// True iff the partition holds live Google master-auth cookies — i.e. the bot
// is signed in (a "guest" profile simply has none). This replaces the old
// "which partition are we on" check now that there's a single partition (#282).
// Google's domain=.google.com auth cookies are the ground truth (the same set
// the bot presents to auto-admit into invited meetings).
async function isSignedInToGoogle(sess) {
  try {
    const all = await sess.cookies.get({});
    const AUTH = ['__Secure-1PSID', 'SID', '__Secure-3PSID', 'SSID', 'HSID', 'SAPISID'];
    return all.some((c) =>
      /(^|\.)google\.com$/.test((c.domain || '').replace(/^\./, '')) &&
      AUTH.includes(c.name) && c.value);
  } catch (err) {
    console.warn('[electron] isSignedInToGoogle check failed:', err.message);
    return false;
  }
}

// #282: append ?authuser=<email> to a Meet URL so Google selects the bot's
// bound account rather than the partition default (authuser=0). Idempotent —
// won't clobber an authuser already present. Returns the URL unchanged on any
// parse failure or when email is falsy.
function pinAuthUser(meetUrl, email) {
  if (!email) return meetUrl;
  try {
    const u = new URL(meetUrl);
    if (!u.searchParams.has('authuser')) u.searchParams.set('authuser', email);
    return u.toString();
  } catch {
    return meetUrl;
  }
}

// Wipe Meet-side identity caches on the given partition. Meet caches the
// guest "Your name" preference, and once it has *any* cached identity it
// skips the pre-join name input entirely — so without this the bot is stuck
// with whatever name it picked on first join. Scoped tightly so Google
// account sign-in (accounts.google.com) survives — only Meet's own caches
// are dropped.
//
// Three-pronged because clearStorageData's `origin` filter only matches
// origin-scoped storages (localStorage, IndexedDB, cachestorage), NOT
// cookies set with `domain=.google.com` — those have to be enumerated and
// removed by hand. Service workers are global on the partition; clearing
// them unscoped is fine since we don't use SWs elsewhere.
//
// Runs BEFORE each join, not after leave, so it doesn't matter how the
// previous call ended (host-ended, app quit, auto-leave, crash).
async function clearMeetIdentityCache(partition) {
  const sess = session.fromPartition(partition);
  const summary = { cookiesRemoved: 0, storagesCleared: [], errors: [] };

  // 1. Origin-scoped storages.
  try {
    await sess.clearStorageData({
      origin: 'https://meet.google.com',
      storages: ['localstorage', 'indexdb', 'cachestorage'],
    });
    summary.storagesCleared.push('localstorage', 'indexdb', 'cachestorage');
  } catch (err) {
    summary.errors.push(`origin-scoped: ${err.message}`);
  }

  // 2. Cookies whose domain covers meet.google.com (including .google.com
  // domain-wildcard cookies that origin filter misses). Don't touch
  // accounts.google.com cookies — those are sign-in state.
  try {
    const all = await sess.cookies.get({});
    for (const c of all) {
      const d = (c.domain || '').replace(/^\./, '');
      if (d === 'meet.google.com' || (d === 'google.com' && c.path !== '/accounts')) {
        const url = `https://${(c.domain || '').replace(/^\./, '')}${c.path || '/'}`;
        try {
          await sess.cookies.remove(url, c.name);
          summary.cookiesRemoved++;
        } catch (err) {
          summary.errors.push(`cookie ${c.name}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    summary.errors.push(`cookie enumeration: ${err.message}`);
  }

  // 3. Service workers — scoped to the Meet origin. (Unscoped would also wipe
  // Slack's SW, which now shares this partition (#282); Slack re-registers but
  // there's no reason to disturb it when we're only resetting Meet's guest state.)
  try {
    await sess.clearStorageData({ origin: 'https://meet.google.com', storages: ['serviceworkers'] });
    summary.storagesCleared.push('serviceworkers');
  } catch (err) {
    summary.errors.push(`serviceworkers: ${err.message}`);
  }

  console.log('[electron] Cleared Meet identity cache on', partition,
    '— cookies:', summary.cookiesRemoved,
    '· storages:', summary.storagesCleared.join(','),
    summary.errors.length ? '· errors: ' + summary.errors.join('; ') : '');
}

// Apply Meet-specific session config to a given session. Called per
// partition so each identity mode shares the exact same handler setup.
//   - Strip CSP so the preload's page-inject eval() isn't blocked by
//     Meet's Trusted Types policy.
//   - Auto-grant the media permissions Meet always asks for.
//   - Hand getDisplayMedia the right desktopCapturer source (#158).
//   - Set a Chrome-like UA so Meet doesn't show the "unsupported browser"
//     gate.
function configureMeetSession(sess) {
  sess.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    delete headers['content-security-policy'];
    delete headers['Content-Security-Policy'];
    delete headers['content-security-policy-report-only'];
    delete headers['Content-Security-Policy-Report-Only'];
    callback({ responseHeaders: headers });
  });

  sess.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(['media', 'microphone', 'camera', 'display-capture'].includes(permission));
  });

  sess.setPermissionCheckHandler((webContents, permission) => {
    return ['media', 'microphone', 'camera', 'display-capture'].includes(permission);
  });

  // Screen-share source selection — full screen, or the whiteboard window
  // with main-window exclusion to avoid the infinity-mirror trap (#158).
  sess.setDisplayMediaRequestHandler(async (request, callback) => {
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

    if (whiteboardWindow && !whiteboardWindow.isDestroyed()) {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['window'],
          thumbnailSize: { width: 0, height: 0 },
        });
        const wbSourceId = whiteboardWindow.getMediaSourceId();
        const mainSourceId =
          mainWindow && !mainWindow.isDestroyed() ? mainWindow.getMediaSourceId() : null;
        const wbTitle = whiteboardWindow.getTitle();
        console.log('[electron] Display media request — wb source:', wbSourceId, 'main:', mainSourceId, 'title:', wbTitle);
        console.log('[electron] Available sources:', sources.map(s => `${s.id} "${s.name}"`));

        const candidates = sources.filter(s => s.id !== mainSourceId);
        let source = candidates.find(s => s.id === wbSourceId);
        if (!source) source = candidates.find(s => s.name === wbTitle);
        if (!source) source = candidates.find(s => s.name.startsWith(wbTitle));

        if (source) {
          console.log('[electron] Matched whiteboard source:', source.id, source.name);
          callback({ video: source });
          return;
        }

        console.warn('[electron] No matching whiteboard source — using webContents fallback (avoiding main window).');
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

  sess.setUserAgent(CHROME_UA);
}

// ---------------------------------------------------------------------------
// CLI argument parsing — supports --meet-url, --bot-name, --sync-url,
// --website-url, --local-port, --profile, --devtools
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

function requestedProfileName() {
  const raw = cliArgs.profile || process.env.VIBECONF_PROFILE;
  if (!raw) return null;
  if (!/^[A-Za-z0-9_.-]+$/.test(String(raw))) {
    console.warn('[electron] Ignoring invalid profile name:', raw);
    return null;
  }
  return String(raw);
}

function requestedLocalPort() {
  const raw = cliArgs['local-port'] || process.env.VIBECONF_LOCAL_PORT;
  if (!raw) return null;
  if (!/^\d+$/.test(String(raw))) {
    console.warn('[electron] Ignoring invalid local port:', raw);
    return null;
  }
  const port = parseInt(raw, 10);
  if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  console.warn('[electron] Ignoring invalid local port:', raw);
  return null;
}

// Base userData (the default instance's dir) — captured BEFORE any profile swap
// so the profile manager can enumerate sibling profiles under <base>/profiles
// and share a registry there, regardless of which profile THIS instance is.
const BASE_USER_DATA = app.getPath('userData');
const PROFILES_ROOT = path.join(BASE_USER_DATA, 'profiles');

const appProfile = requestedProfileName();
if (appProfile) {
  const profileUserData = path.join(PROFILES_ROOT, appProfile);
  app.setPath('userData', profileUserData);
  localServer.localProfile = appProfile;
  console.log('[electron] Using app profile:', appProfile, 'userData:', profileUserData);
}

// Automated test instances (profile test*, or VIBECONF_NO_NOTIFICATIONS) must not
// fire OS push notifications — a scheduled nightly run would otherwise spam the
// user's devices with "Meet detected" / error toasts (e.g. the guest "present
// button not found" share error). Gate all Notification sites on this.
const SUPPRESS_NOTIFICATIONS = /^test/i.test(appProfile || '') || !!process.env.VIBECONF_NO_NOTIFICATIONS;
if (SUPPRESS_NOTIFICATIONS) console.log('[electron] OS notifications suppressed (test/headless instance)');

// ---------------------------------------------------------------------------
// Helper: speak text via TTS → send audio to Meet view
// ---------------------------------------------------------------------------

// Strip common markdown so TTS doesn't read "star ... star", backticks,
// heading hashes, list dashes, or link/image syntax aloud (#160). Only used on
// the spoken path — transcript/whiteboard/chat keep their markdown.
function stripMarkdownForTts(text) {
  if (!text) return text;
  let out = String(text);
  // Images first (would otherwise survive as ![alt](url) -> [alt])
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Links: [text](url) -> text
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Fenced and inline code: keep the contents, drop the fences/ticks
  out = out.replace(/```[\w-]*\n?([\s\S]*?)```/g, '$1');
  out = out.replace(/`([^`]+)`/g, '$1');
  // Bold/italic/strikethrough. Underscore variants are word-bounded so things
  // like my_var_name and __dunder__ identifiers aren't eaten.
  out = out.replace(/\*\*(.+?)\*\*/g, '$1');
  out = out.replace(/(?<![A-Za-z0-9_])__(.+?)__(?![A-Za-z0-9_])/g, '$1');
  out = out.replace(/\*(?=\S)([^*\n]+?)(?<=\S)\*/g, '$1');
  out = out.replace(/(?<![A-Za-z0-9_])_(?=\S)([^_\n]+?)(?<=\S)_(?![A-Za-z0-9_])/g, '$1');
  out = out.replace(/~~(.+?)~~/g, '$1');
  // Line-leading markers: heading #, blockquote >, list -/*/+, ordered "1."
  out = out.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');
  out = out.replace(/^[ \t]*>[ \t]?/gm, '');
  out = out.replace(/^[ \t]*[-*+][ \t]+/gm, '');
  out = out.replace(/^[ \t]*\d+\.[ \t]+/gm, '');
  // Horizontal rules on their own line
  out = out.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '');
  // Collapse the whitespace we may have introduced
  out = out.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

// Unmute the mic and send the audio to the renderer's TTS queue. Resolves AFTER
// the play-tts is sent (post the 300ms unmute settle), so callers can chain to
// preserve send order.
function sendPlayTts(base64Audio, emoji) {
  return new Promise((resolve) => {
    if (!meetView || meetView.webContents.isDestroyed()) {
      console.error('[electron] Meet view not available for audio playback');
      return resolve();
    }
    sendExtMsg({ action: CALL_COMMANDS.ACTIONS.unmuteMic });
    setTimeout(() => {
      sendExtMsg({ action: CALL_COMMANDS.ACTIONS.playTts, payload: { audioData: base64Audio, emoji } });
      console.log('[electron] Sent play-tts to Meet view', emoji ? `(emoji: ${emoji})` : '');
      resolve();
    }, 300);
  });
}

// Serialize audio PRODUCTION (TTS synth + play_audio fetch/read) so play-tts
// messages reach the renderer in REQUEST order. Without this, a fast play_audio
// fetch can overtake a slower TTS synth and the sound plays before the spoken
// ack (#audio). The renderer's ttsQueue then plays them in arrival = request
// order. It also removes a latent voice-override race between concurrent speaks.
// A failed/slow item is caught so it can't block the chain. Note: this serializes
// PRODUCTION only — a long clip doesn't block the chain (it returns once sent);
// playback serialization is the renderer's ttsQueue.
let _audioChain = Promise.resolve();
function enqueueAudio(produceAndSend) {
  _audioChain = _audioChain.then(produceAndSend).catch((e) => console.error('[electron] audio-chain item failed:', e?.message));
  return _audioChain;
}

function speakText(text, voice, emoji) {
  // Sanitize markdown out of the spoken string only (#160).
  const spokenText = stripMarkdownForTts(text);
  enqueueAudio(async () => {
    // Temporarily override voice if specified (works for both macOS and
    // ElevenLabs). Safe under serialization — no concurrent speak can clobber it.
    // Route by identity: a name that matches an installed macOS voice forces the
    // macOS provider (so it actually plays even with an EL key set); anything
    // else is treated as an ElevenLabs voice ID. Restored in finally.
    const originalMacVoice = tts.macosVoice;
    const originalELVoice = tts.voiceId;
    const originalProvider = tts.provider;
    if (voice) {
      if (macosVoiceNameSet.has(voice)) {
        tts.updateConfig({ provider: 'macos-say', macosVoice: voice });
      } else {
        tts.updateConfig({ provider: 'elevenlabs', voiceId: voice });
      }
    }
    try {
      const audioBuffer = await tts.synthesize(spokenText);
      if (!audioBuffer) { console.error('[electron] TTS returned null/empty buffer'); return; }
      const base64Audio = Buffer.from(audioBuffer).toString('base64');
      console.log('[electron] TTS synthesized:', text.slice(0, 40), '→', base64Audio.length, 'bytes base64');
      await sendPlayTts(base64Audio, emoji);
      // ElevenLabs is back — if we'd previously degraded to the macOS voice,
      // tell the agent its normal voice is restored (rides status.errors → the
      // agent sees it on its next wait_for_speech lull).
      if (ttsVoiceFallbackActive) {
        ttsVoiceFallbackActive = false;
        localServer.addError('Voice restored — ElevenLabs is working again; back to your normal voice.');
      }
    } catch (err) {
      console.error('[electron] TTS error:', err.message);
      broadcastError('TTS: ' + err.message.slice(0, 120));
      // Don't go silent on an ElevenLabs failure (esp. quota_exceeded mid-call):
      // fall back to the macOS `say` voice so the bot keeps talking, just in a
      // plainer voice. Only the audio degrades — the words still land.
      try {
        const fallbackBuffer = await tts.sayFallback(spokenText);
        if (fallbackBuffer) {
          const base64Audio = Buffer.from(fallbackBuffer).toString('base64');
          console.log('[electron] TTS fell back to macOS say:', text.slice(0, 40), '→', base64Audio.length, 'bytes base64');
          await sendPlayTts(base64Audio, emoji);
          // Tell the agent ONCE that its voice changed, so it knows it now
          // sounds different (and can mention it / not be surprised). Rides the
          // status.errors channel the agent already reads on each lull.
          if (!ttsVoiceFallbackActive) {
            ttsVoiceFallbackActive = true;
            const why = err.code === 'quota_exceeded' ? 'ElevenLabs quota exhausted' : `ElevenLabs unavailable (${(err.message || '').slice(0, 60)})`;
            localServer.addError(`Voice changed: ${why} — now speaking in the macOS fallback voice, which sounds noticeably different. Your words still play; you may briefly acknowledge the voice change if it fits.`);
          }
        }
      } catch (fbErr) {
        console.error('[electron] TTS macOS fallback also failed:', fbErr.message);
      }
    } finally {
      if (voice) {
        tts.updateConfig({ macosVoice: originalMacVoice });
        tts.voiceId = originalELVoice;
        tts.provider = originalProvider;
      }
    }
  });
}

// The in-flight `say` child for voice-preview auditions (preferences). Killed
// before starting a new one so rapid dropdown changes don't overlap.
let _voicePreviewChild = null;

// Installed macOS `say` voice names (populated at startup). Lets the speak()
// voice-override route a name to the right provider — a macOS voice name forces
// the macOS provider even when an ElevenLabs key is set, instead of being
// mis-sent to ElevenLabs as a (nonexistent) voice ID.
let macosVoiceNameSet = new Set();

// Enumerate installed macOS `say` voices → [{ name, locale, sample }], quality
// first (Premium > Enhanced > plain), then English, then name. Shared by the
// preferences dropdown IPC and the startup name-set build.
async function enumerateMacosVoices() {
  if (process.platform !== 'darwin') return [];
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile('say', ['-v', '?'], { timeout: 5000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) { console.error('[electron] enumerateMacosVoices failed:', err.message); return resolve([]); }
      // Lines: "Samantha  en_US  # Hello..." but newer multi-locale voices use a
      // single space and parens ("Eddy (English (US)) en_US  # ...") and some
      // locales carry digits ("Majed  ar_001  # ..."). Split on '#', then peel
      // the locale (last word) off the left; everything before it is the name.
      const voices = [];
      for (const line of String(stdout || '').split('\n')) {
        const hash = line.indexOf('#');
        if (hash < 0) continue;
        const left = line.slice(0, hash).trim();
        const sample = line.slice(hash + 1).trim();
        const m = /^(.*\S)\s+([A-Za-z]{2,3}(?:_[A-Za-z0-9]+)?)$/.exec(left);
        if (!m) continue;
        voices.push({ name: m[1].trim(), locale: m[2], sample });
      }
      const seen = new Set();
      const deduped = voices.filter((v) => (seen.has(v.name) ? false : seen.add(v.name)));
      const tier = (v) => (/\(Premium\)/i.test(v.name) ? 0 : /\(Enhanced\)/i.test(v.name) ? 1 : 2);
      deduped.sort((a, b) => {
        const ta = tier(a), tb = tier(b);
        if (ta !== tb) return ta - tb;
        const ae = a.locale.startsWith('en'), be = b.locale.startsWith('en');
        if (ae !== be) return ae ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      resolve(deduped);
    });
  });
}

// True while we've degraded from ElevenLabs to the macOS `say` voice (e.g.
// quota exhausted). Gates the one-shot "your voice changed" notice to the agent
// so it fires once on degrade and once on recovery, not on every utterance.
let ttsVoiceFallbackActive = false;

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
  if (SUPPRESS_NOTIFICATIONS) return;

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

// Track every Terminal window we open so we can close them all on quit —
// otherwise repeated testing leaves a pile of orphaned windows.
let claudeTerminalWindowIds = [];

function launchClaudeTerminal(meetCode) {
  const { execFile } = require('child_process');
  const claudeDir = store.get('claudeWorkDir') || '/tmp';
  // Use the ACTIVE provider's name: in Slack mode getActiveBotName() returns the
  // slackBotName override (else botName); for Meet it's botName. Keeps the
  // spawned /join-call <code> <name> + MCP env aligned with the call we're in.
  const botName = getActiveBotName() || store.get('botName') || 'Jimmy';

  // Profile instances (second bot, e.g. Samantha): the auto-launch runs `claude`
  // from a generic cwd (/tmp), which would pick up the USER-SCOPED ~/.claude.json
  // vibeconferencing server (port 7865 = the PRIMARY app) and talk to the wrong
  // bot. Write a profile-specific MCP config pointing at THIS app's port and pass
  // --mcp-config + --strict-mcp-config so the spawned session targets this app
  // only. The default (non-profile) instance keeps using the global config.
  let mcpFlags = '';
  if (appProfile) {
    try {
      const mcpServerPath = app.isPackaged
        ? path.join(process.resourcesPath, 'mcp-server', 'server.js')
        : path.join(__dirname, '..', 'mcp-server', 'server.js');
      const cfg = {
        mcpServers: {
          vibeconferencing: {
            command: 'node',
            args: [mcpServerPath],
            env: {
              VIBECONF_ROOM_ID: '',
              VIBECONF_BOT_NAME: botName,
              VIBECONF_BASE_URL: `http://127.0.0.1:${localServer.port}`,
            },
          },
        },
      };
      const cfgPath = path.join(app.getPath('userData'), 'mcp-config.json');
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      // Inner quotes escaped for the AppleScript `do script "…"` wrapper below;
      // quote the path because the profile userData dir contains spaces.
      mcpFlags = ` --mcp-config \\"${cfgPath}\\" --strict-mcp-config`;
      console.log('[electron] Profile', appProfile, '— launching Claude pinned to port', localServer.port, 'via', cfgPath);
    } catch (err) {
      console.error('[electron] Failed to write profile MCP config:', err.message);
    }
  }

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
  const claudeCmd = `claude${dangerousFlag}${mcpFlags} \\"/join-call ${meetCode} ${botName.replace(/"/g, '')}\\"`;

  // Open a Terminal window running the command. When Terminal isn't already
  // running, `do script` would spawn TWO windows — the auto-created launch
  // window plus the scripted one. Reuse the launch window (window 1) in that
  // case; only spawn a fresh window when Terminal is already up.
  // Set VIBECONF_LOCAL_PORT for the spawned session so the agent-activity hook
  // (a child process of claude) reports this bot's transcript to THIS app's
  // local server — not the default 7865 (correct for profile bots on 7866+).
  const cmd = `cd ${claudeDir.replace(/"/g, '\\"')} && VIBECONF_LOCAL_PORT=${localServer.port} ${claudeCmd}`;
  const script = `tell application "Terminal"
  if not running then
    do script "${cmd}" in window 1
  else
    do script "${cmd}"
  end if
  activate
  return id of window 1
end tell`;

  execFile('osascript', ['-e', script], (err, stdout, stderr) => {
    if (err) {
      console.error('[electron] Failed to launch Claude:', err.message, stderr);
    } else {
      const claudeTerminalWindowId = (stdout || '').trim();
      if (claudeTerminalWindowId && !claudeTerminalWindowIds.includes(claudeTerminalWindowId)) {
        claudeTerminalWindowIds.push(claudeTerminalWindowId);
      }
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
  if (claudeTerminalWindowIds.length === 0) return;
  const { execFile } = require('child_process');
  const windowIds = [...claudeTerminalWindowIds];
  claudeTerminalWindowIds = [];

  // Gracefully exit Claude in each window, then close it after a short wait.
  for (const windowId of windowIds) {
    const script = `tell application "Terminal"
  repeat with w in windows
    if id of w is ${windowId} then
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
      setTimeout(() => {
        const closeScript = `tell application "Terminal"
  repeat with w in windows
    if id of w is ${windowId} then
      close w saving no
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
}

// Synchronous close of all tracked terminal windows — used on app quit, where
// the async graceful path wouldn't finish before the process exits. Closes
// immediately (no graceful Claude exit) so we don't leave orphan windows.
function closeAllClaudeTerminalsSync() {
  if (claudeTerminalWindowIds.length === 0) return;
  const { execFileSync } = require('child_process');
  const windowIds = [...claudeTerminalWindowIds];
  claudeTerminalWindowIds = [];
  for (const windowId of windowIds) {
    const script = `tell application "Terminal"
  repeat with w in windows
    if id of w is ${windowId} then
      close w saving no
      return "closed"
    end if
  end repeat
  return "already gone"
end tell`;
    try {
      execFileSync('osascript', ['-e', script], { timeout: 3000 });
    } catch (err) {
      console.error('[electron] Failed to close terminal on quit:', err.message);
    }
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

// Single instance for the default profile. Named profiles are intentional
// separate bot seats, so they bypass the global lock and rely on profile +
// local-port separation instead.
if (!appProfile) {
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
} else {
  console.log('[electron] Allowing separate app instance for profile:', appProfile);
}

// ---------------------------------------------------------------------------
// Auto-install MCP config + Claude skill on first launch
// ---------------------------------------------------------------------------

// Agent-activity hook: a tiny PostToolUse hook, scoped to mcp__vibeconferencing__*
// tools, that reports the DRIVING session's transcript path to this app's local
// server. Scoping to our own MCP tools means only the session actually driving a
// bot reports (no cross-session noise), and it works for BOTH launch paths
// (app-spawned OR an existing session that ran /join-call). The app tails that
// transcript onto the debug overlay (gated by the debugOverlay toggle).
const AGENT_HOOK_CONTENT = `#!/usr/bin/env node
// Auto-installed by Vibeconferencing — reports the Claude session's transcript
// path to the local bot server for the debug-overlay agent-activity tail.
// Never blocks or breaks the agent: swallows all errors, exits 0 fast.
const http = require('http');
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let d = {};
  try { d = JSON.parse(raw); } catch (e) {}
  const transcriptPath = d.transcript_path;
  if (!transcriptPath) return done();
  const port = process.env.VIBECONF_LOCAL_PORT || '7865';
  const body = JSON.stringify({ sessionId: d.session_id, transcriptPath });
  const req = http.request({
    host: '127.0.0.1', port, path: '/api/agent-session', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    timeout: 500,
  }, (res) => { res.resume(); res.on('end', done); });
  req.on('error', done);
  req.on('timeout', () => { req.destroy(); done(); });
  req.write(body); req.end();
});
function done() { process.exit(0); }
setTimeout(done, 1500); // never hang the agent
`;

function ensureAgentActivityHook() {
  const home = process.env.HOME || process.env.USERPROFILE;
  const claudeDir = path.join(home, '.claude');
  const hookPath = path.join(claudeDir, 'vibeconf-agent-hook.cjs');
  const settingsPath = path.join(claudeDir, 'settings.json');
  try {
    fs.mkdirSync(claudeDir, { recursive: true });
    // Write the hook file only when its content differs (avoid needless churn).
    let existing = '';
    try { existing = fs.readFileSync(hookPath, 'utf-8'); } catch { /* missing */ }
    if (existing !== AGENT_HOOK_CONTENT) fs.writeFileSync(hookPath, AGENT_HOOK_CONTENT);

    // No port baked into the command: the hook reads VIBECONF_LOCAL_PORT from
    // its inherited env (app-spawned sessions set it to THEIR bot's port — see
    // launchClaudeTerminal) and falls back to 7865 (the primary app) for an
    // existing session that ran /join-call. This is why the same global hook
    // works for every bot — the port comes from the session, not the command.
    const desiredCmd = `node "${hookPath}"`;
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { /* none yet */ }
    if (!settings.hooks) settings.hooks = {};
    if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = [];
    // Is our entry already present with the right command? (idempotent)
    const isOurs = (e) => (e.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes('vibeconf-agent-hook'));
    const current = settings.hooks.PostToolUse.find(isOurs);
    if (current && current.matcher === 'mcp__vibeconferencing__.*' && current.hooks?.[0]?.command === desiredCmd) {
      return; // already correct
    }
    // Drop any stale vibeconf entries, then add the current one (preserves the
    // user's own hooks).
    settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter((e) => !isOurs(e));
    settings.hooks.PostToolUse.push({
      matcher: 'mcp__vibeconferencing__.*',
      hooks: [{ type: 'command', command: desiredCmd }],
    });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    console.log('[electron] Installed agent-activity PostToolUse hook (port from session env, default 7865)');
  } catch (err) {
    console.warn('[electron] Failed to install agent-activity hook:', err.message);
  }
}

function removeAgentActivityHook() {
  const home = process.env.HOME || process.env.USERPROFILE;
  const claudeDir = path.join(home, '.claude');
  const hookPath = path.join(claudeDir, 'vibeconf-agent-hook.cjs');
  const settingsPath = path.join(claudeDir, 'settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    if (Array.isArray(settings.hooks?.PostToolUse)) {
      const before = settings.hooks.PostToolUse.length;
      settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(
        (e) => !(e.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes('vibeconf-agent-hook'))
      );
      if (settings.hooks.PostToolUse.length !== before) {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
        console.log('[electron] Removed agent-activity hook from settings.json');
      }
    }
  } catch { /* no settings file */ }
  try { fs.rmSync(hookPath, { force: true }); } catch { /* ignore */ }
}

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
  const SKILL_VERSION = '22';  // Bump this when updating the skill content below
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

  // Agent-activity overlay hook (independent of the MCP/skill version bumps).
  // Port-agnostic: app-spawned sessions inject VIBECONF_LOCAL_PORT themselves.
  ensureAgentActivityHook();

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

  // Remove the agent-activity hook (settings.json entry + script file).
  removeAgentActivityHook();

  console.log('[electron] Claude integration uninstalled.');
}

app.whenReady().then(async () => {
  store = new Store(app.getPath('userData'));

  // #282: an explicit --meet-account-email pins this profile's bound Google
  // account deterministically (used by the test fleet so each gtest profile is
  // unambiguously alice@/jimmy@). When set, it wins over (and is never clobbered
  // by) the sign-in scrape, and survives sign-out. A bare email is the contract.
  {
    const cliEmail = cliArgs['meet-account-email'] || process.env.VIBECONF_MEET_ACCOUNT_EMAIL;
    if (cliEmail && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(cliEmail))) {
      meetAccountEmailPinned = true;
      store.set('meetAccountEmail', String(cliEmail));
      console.log('[electron] Pinned Meet account from CLI:', cliEmail);
    } else if (cliEmail) {
      console.warn('[electron] Ignoring invalid --meet-account-email:', cliEmail);
    }
  }

  // One-time migration: `shadowPhrase` was renamed to `triageAck` (it gates the
  // Apple triage-ack now, not the old two-tier shadow drafter). Carry an
  // existing value over, then drop the stale key.
  try {
    if (store.get('triageAck') === undefined && store.get('shadowPhrase') !== undefined) {
      store.set('triageAck', store.get('shadowPhrase'));
      store.delete('shadowPhrase');
      console.log('[electron] Migrated pref shadowPhrase → triageAck');
    }
  } catch { /* non-fatal */ }

  // Persistent rotating session log (#173). Tees stdout/stderr to a per-
  // session file under userData/logs/ so we can post-mortem mid-call
  // weirdness. The get_session_log MCP tool reads from the same file.
  try {
    const logPath = initSessionLog({
      userDataDir: app.getPath('userData'),
      header: {
        version: app.getVersion(),
        platform: process.platform,
        electron: process.versions.electron,
        profile: appProfile || 'default',
        // Behavior/experiment prefs in effect for this session, so a log
        // self-documents which knobs were on (blank = schema default).
        defaultSilenceSeconds: store?.get('defaultSilenceSeconds'),
        triageAck: store?.get('triageAck'),
        backgroundTickWords: store?.get('backgroundTickWords'),
        comprehendCharThreshold: store?.get('comprehendCharThreshold'),
        probeFiring: store?.get('probeFiring'),
        ackProvider: store?.get('ackProvider'),
        ackEndpoint: store?.get('ackEndpoint'),
        ackModel: store?.get('ackModel'),
      },
    });
    console.log('[electron] Session log:', logPath);
  } catch (err) {
    console.warn('[electron] Failed to init session log:', err.message);
  }

  // Start local HTTP server for agent communication. Multiple local app
  // instances can be aimed at distinct MCP clients by pinning different
  // starting ports; LocalServer still auto-increments if that port is busy.
  const explicitLocalPort = requestedLocalPort();
  if (explicitLocalPort) {
    localServer.port = explicitLocalPort;
    console.log('[electron] Requested local server port:', explicitLocalPort);
  }
  const localPort = await localServer.start();

  // Check/install Claude integration. Profiled instances are intended for
  // non-default agents (for example Codex) and must not steal Claude's global
  // MCP config from the primary app instance.
  if (appProfile) {
    console.log('[electron] Skipping Claude integration for app profile:', appProfile);
  } else {
    ensureClaudeIntegration(localPort);
  }

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

    if (screenAccess !== 'granted') {
      // Attempt a REAL screen capture so macOS registers Vibeconferencing in
      // the "Screen & System Audio Recording" list (and prompts if the status
      // is not-determined). The thumbnail size must be non-trivial — Electron
      // short-circuits {width:1,height:1}/{0,0} without actually capturing, so
      // TCC never sees a capture attempt and the app never appears in the list
      // (the bug after `tccutil reset` wipes the entry on every build).
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 192, height: 192 } })
        .then((sources) => {
          console.log('[electron] Screen capture probe returned', sources.length, 'source(s); first thumb empty?',
            sources[0] ? sources[0].thumbnail.isEmpty() : 'n/a');
        })
        .catch((err) => {
          console.error('[electron] Screen capture probe failed:', err && err.message);
        })
        .finally(() => {
          const newStatus = systemPreferences.getMediaAccessStatus('screen');
          console.log('[electron] Screen recording permission after capture attempt:', newStatus);
          localServer.setPermission('screenRecording', newStatus);
          // Still not granted (and not mid-prompt) → guide the user. The app is
          // now registered, so it'll be present with a toggle in Settings.
          if (newStatus === 'denied' || newStatus === 'restricted') {
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
  const savedConfig = store.getMultiple(['ttsApiKey', 'ttsVoiceId', 'botName', 'syncBaseUrl', 'macosVoice', 'ttsProvider']);
  if (savedConfig.ttsApiKey) {
    tts.updateConfig({ apiKey: savedConfig.ttsApiKey });
    stt.updateConfig({ apiKey: savedConfig.ttsApiKey });
  }
  if (savedConfig.ttsVoiceId) tts.updateConfig({ voiceId: savedConfig.ttsVoiceId });
  if (savedConfig.macosVoice) tts.updateConfig({ macosVoice: savedConfig.macosVoice });
  // Explicit provider override (e.g. bot chose a built-in voice as primary).
  if (savedConfig.ttsProvider) tts.updateConfig({ provider: savedConfig.ttsProvider });
  // Prime the macOS voice-name set so speak()'s voice-override can route a name
  // to the right provider from the first utterance (refreshed on each list call).
  enumerateMacosVoices().then((vs) => { macosVoiceNameSet = new Set(vs.map((v) => v.name)); }).catch(() => {});
  if (savedConfig.botName) sync.updateConfig({ botName: savedConfig.botName });
  if (savedConfig.syncBaseUrl) sync.updateConfig({ baseUrl: savedConfig.syncBaseUrl });

  // Configure the single session partition (#282). All Meet-specific handlers
  // — CSP stripping, media-permission auto-grant, screen-share source
  // selection, Chrome UA — live on this partition rather than defaultSession.
  // Slack shares it too; the Meet config is harmless-to-beneficial for Slack
  // (CSP strip helps injection; Slack sets its own per-view UA on top).
  ensureMeetSessionConfigured(SESSION_PARTITION);

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

  // --- Meet/Slack detection: poll Chrome/Safari/Brave tabs for active Meet
  // calls and Slack huddles ---
  let detectedMeetUrl = null;
  let detectedSlackHuddle = null;
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
        set tabTitle to ""
        try
          set tabTitle to title of t
        end try
        if tabURL starts with "https://meet.google.com/" then
          set allURLs to allURLs & "MEET:" & tabURL & linefeed
        else if tabURL starts with "https://app.slack.com/client/" then
          set allURLs to allURLs & "SLACK:" & tabURL & "|||" & tabTitle & linefeed
        else if tabURL is "about:blank" then
          set allURLs to allURLs & "BLANK:" & tabTitle & linefeed
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
        set tabTitle to ""
        try
          set tabTitle to title of t
        end try
        if tabURL starts with "https://meet.google.com/" then
          set allURLs to allURLs & "MEET:" & tabURL & linefeed
        else if tabURL starts with "https://app.slack.com/client/" then
          set allURLs to allURLs & "SLACK:" & tabURL & "|||" & tabTitle & linefeed
        else if tabURL is "about:blank" then
          set allURLs to allURLs & "BLANK:" & tabTitle & linefeed
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
        set tabTitle to ""
        try
          set tabTitle to title of t
        end try
        if tabURL starts with "https://meet.google.com/" then
          set allURLs to allURLs & "MEET:" & tabURL & linefeed
        else if tabURL starts with "https://app.slack.com/client/" then
          set allURLs to allURLs & "SLACK:" & tabURL & "|||" & tabTitle & linefeed
        else if tabURL is "about:blank" then
          set allURLs to allURLs & "BLANK:" & tabTitle & linefeed
        end if
      end repeat
    end repeat
  end tell
end if
allURLs`;

    console.log('[electron] Meet/Slack detection started');

    function pollForMeet() {
      if (currentMeetUrl || pollInFlight) return;
      // Already in a call (joined via the panel OR /join-call MCP, where
      // currentMeetUrl isn't set)? Don't scan the browser for other Meets —
      // it's pointless mid-call and was spamming "Google Meet Detected" push
      // notifications (and burning AppleScript timeouts) during live calls.
      if (localServer.callStatus === 'in-call') return;
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

        const lines = (stdout || '').trim().split('\n').map((l) => l.trim()).filter(Boolean);
        const urls = lines.filter((l) => l.startsWith('MEET:')).map((l) => l.slice(5))
          .filter((u) => /meet\.google\.com\/[a-z]+-[a-z]+-[a-z]+/.test(u));
        const meetUrl = urls[0] || null;

        // Slack huddle: a live browser huddle shows up as an about:blank window
        // (the huddle popup, whose TITLE carries the workspace) alongside a
        // workspace tab that carries the team/channel. With MULTIPLE Slack tabs
        // open we must pick the one actually IN the huddle, not just the first —
        // so match the huddle popup's workspace to the right tab's title.
        const slackTabs = lines.filter((l) => l.startsWith('SLACK:')).map((l) => {
          const [url, ...rest] = l.slice(6).split('|||');
          return { url, title: (rest.join('|||') || '').trim() };
        }).filter((t) => /app\.slack\.com\/client\/[^/]+\/[^/?#]+/.test(t.url));
        const blankTitles = lines.filter((l) => l.startsWith('BLANK:')).map((l) => l.slice(6).trim());
        const huddleTitle = blankTitles.find((t) => /^Huddle:/i.test(t));
        let slackHuddleUrl = null;
        if (huddleTitle) {
          // "Huddle: #channel - Workspace - Slack 🎤" → workspace is the 2nd
          // " - " segment; match the Slack tab whose title names that workspace.
          const ws = (huddleTitle.split(' - ')[1] || '').trim();
          const match = ws && slackTabs.find((t) => t.title.includes(ws));
          slackHuddleUrl = (match && match.url) || (slackTabs.length === 1 ? slackTabs[0].url : null);
          if (slackTabs.length > 1 && !match) {
            console.warn('[electron] Slack huddle "' + huddleTitle + '": ' + slackTabs.length +
              ' Slack tabs, none matched workspace "' + ws + '" — not auto-selecting. Tabs:',
              JSON.stringify(slackTabs.map((t) => t.title)));
          }
        } else if (blankTitles.length && slackTabs.length === 1) {
          // A blank (huddle) window + exactly one Slack tab → unambiguous.
          slackHuddleUrl = slackTabs[0].url;
        }

        // Forward all detected Meet URLs + any Slack huddle to local server for MCP access
        localServer.setDetectedMeetUrls(urls);
        localServer.setDetectedSlackHuddle(slackHuddleUrl);

        if (slackHuddleUrl && slackHuddleUrl !== detectedSlackHuddle) {
          detectedSlackHuddle = slackHuddleUrl;
          console.log('[electron] Slack huddle detected:', slackHuddleUrl);
          if (panelView && !panelView.webContents.isDestroyed()) {
            panelView.webContents.send('slack-huddle-detected', { url: slackHuddleUrl });
          }
          const { Notification } = require('electron');
          if (Notification.isSupported() && !SUPPRESS_NOTIFICATIONS) {
            const n = new Notification({
              title: 'Slack Huddle Detected',
              body: 'Found a Slack huddle in your browser. Open Vibeconferencing to connect your bot.',
              silent: false,
            });
            n.on('click', () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); } });
            n.show();
          }
        } else if (!slackHuddleUrl && detectedSlackHuddle) {
          detectedSlackHuddle = null;
          if (panelView && !panelView.webContents.isDestroyed()) panelView.webContents.send('slack-huddle-detected', null);
        }

        if (meetUrl && meetUrl !== detectedMeetUrl) {
          detectedMeetUrl = meetUrl;
          const meetCode = meetUrl.match(/meet\.google\.com\/([a-z]+-[a-z]+-[a-z]+)/)?.[1] || '';
          console.log('[electron] Meet detected:', meetCode);
          if (panelView && !panelView.webContents.isDestroyed()) {
            panelView.webContents.send('meet-detected', { url: meetUrl, meetCode });
          }
          // Show macOS notification
          const { Notification } = require('electron');
          if (Notification.isSupported() && !SUPPRESS_NOTIFICATIONS) {
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
    // Runtime provider switch: if we're currently on Slack, rebuild a Meet view
    // first so loadMeetURL doesn't try to drive the Slack surface.
    activateMeetProvider();
    currentMeetUrl = url;
    loadMeetURL(url);
    localServer.setRoom(meetCode);
    logSessionHeaderUpdate('roomId', meetCode);

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

  // Join a detected (or pasted) Slack huddle — the runtime provider switch. No
  // --provider flag needed: build the Slack two-surface on the workspace URL and
  // auto-join the huddle. (Agent connection is the same as a --provider=slack
  // launch — the bot auto-joins; an MCP client drives it.)
  ipcMain.on('join-detected-slack', (_event, { url }) => {
    if (!url) return;
    console.log('[electron] Join detected Slack huddle:', url);
    activateSlackProvider(url, { autojoin: true });
    // Spawn the Claude terminal with the MCP wired — same as Meet — so the agent
    // can drive the conversation loop. activateSlackProvider → setupSlackRoom has
    // already set localServer.roomId to the slack-<team>-<channel> code; pass it
    // as the /join-call code. The bot is auto-joining the huddle, and onJoinCall
    // skips Meet navigation for slack- codes, so /join-call just starts the loop.
    if (localServer.roomId) {
      launchClaudeTerminal(localServer.roomId);
    } else {
      console.warn('[electron] join-detected-slack: no room id; skipping Claude terminal launch');
    }
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

// Close any terminal windows we opened, synchronously, before the process
// exits — covers Cmd-Q and other quit paths the async close would miss.
app.on('before-quit', () => {
  closeAllClaudeTerminalsSync();
});

// ---------------------------------------------------------------------------
// Window creation — single window with panel sidebar + Meet view
// ---------------------------------------------------------------------------

// Build a meetView BrowserView bound to the given session partition (#168
// / #170). Handles all per-view setup that the previous inline block did:
// audio muting, zoom on dom-ready, and optional DevTools open at launch.
// Returns the view; caller is responsible for addBrowserView + load.
function createMeetView(partition) {
  const view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-meet.js'),
      contextIsolation: false,
      sandbox: false,
      partition,
    },
  });
  view.webContents.setAudioMuted(true);
  view.webContents.on('dom-ready', () => {
    if (!view.webContents.isDestroyed()) view.webContents.setZoomFactor(0.75);
  });
  if (cliArgs && cliArgs['devtools']) {
    view.webContents.openDevTools({ mode: 'detach' });
  }
  return view;
}

// Position panelView (fixed width on the left) and meetView (rest of the
// window). Module-level so both createMainWindow and swap-time relayouts
// share the same logic.
function layoutViews() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [width, height] = mainWindow.getContentSize();
  // When the panel is popped out into its own window, it's no longer a child of
  // mainWindow — Meet takes the full width and the popout window lays itself out.
  const poppedOut = !!panelPopoutWindow;
  const panelW = poppedOut ? 0 : PANEL_WIDTH;
  if (!poppedOut && panelView && !panelView.webContents.isDestroyed()) {
    panelView.setBounds({ x: 0, y: 0, width: PANEL_WIDTH, height });
  }
  if (meetView && !meetView.webContents.isDestroyed()) {
    meetView.setBounds({ x: panelW, y: 0, width: width - panelW, height });
  }
}

// Pop the panel out into its own resizable window (or dock it back). Re-parents
// the SAME panelView BrowserView, so every panelView.webContents.send(...) keeps
// working unchanged and the panel's state is preserved across the move. Lets the
// "bot's-eye view" sit at any size next to the bot's Meet window (Stan's ask).
function setPanelPoppedOut(out) {
  if (!panelView || panelView.webContents.isDestroyed()) return false;

  if (out && !panelPopoutWindow) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.removeBrowserView(panelView);
    const win = new BrowserWindow({
      width: PANEL_WIDTH + 80,
      height: 820,
      title: "Vibeconferencing — Bot's-eye view",
      icon: path.join(__dirname, 'icon.png'),
      parent: mainWindow || undefined, // closes with the app; still freely movable
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    panelPopoutWindow = win;
    win.addBrowserView(panelView);
    const fit = () => {
      if (win.isDestroyed() || panelView.webContents.isDestroyed()) return;
      const [w, h] = win.getContentSize();
      panelView.setBounds({ x: 0, y: 0, width: w, height: h });
    };
    fit();
    win.on('resize', fit);
    // Detach the view BEFORE teardown so its webContents (and all its state)
    // survives — then re-dock into the main window. Handles both the Dock
    // button and the user closing the popout window directly.
    win.on('close', () => { try { win.removeBrowserView(panelView); } catch { /* already gone */ } });
    win.on('closed', () => {
      panelPopoutWindow = null;
      if (panelView && !panelView.webContents.isDestroyed() && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.addBrowserView(panelView);
      }
      layoutViews();
      if (panelView && !panelView.webContents.isDestroyed()) {
        panelView.webContents.send('panel-popout-changed', { poppedOut: false });
      }
    });
    layoutViews();
    panelView.webContents.send('panel-popout-changed', { poppedOut: true });
    return true;
  }

  if (!out && panelPopoutWindow) {
    // Dock back by closing the popout; the close/closed handlers re-attach.
    panelPopoutWindow.close();
    return true;
  }
  return false;
}

// Point the (single-partition) meetView at a Google URL — used by sign-in to
// load the ServiceLogin flow, and by sign-out to reload the Meet home so the
// panel reflects the new logged-out state. There's no partition swap anymore
// (#282): identity lives in cookies, so this just navigates. Ensures a Meet
// view exists first (switching back from Slack if needed) and notifies the
// panel to refresh its sign-in/out button.
function navigateMeetView(url) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    console.warn('[electron] navigateMeetView: no mainWindow');
    return;
  }
  activateMeetProvider(); // rebuilds meetView on SESSION_PARTITION if we were on Slack
  if (meetView && !meetView.webContents.isDestroyed()) {
    meetView.webContents.loadURL(url || MEET_HOME_URL);
  }
  if (panelView && !panelView.webContents.isDestroyed()) {
    panelView.webContents.send('meet-mode-changed', { partition: SESSION_PARTITION });
  }
}

// --- Runtime provider switch (#264): join a Meet call OR a Slack huddle with no
// relaunch, so --provider is just a launch shortcut. Both rebuild `meetView`
// (same teardown pattern), now always on the single SESSION_PARTITION. ---

// Derive + register the Slack room (code → local server + vibeconferencing.com
// sync + ensureRoom). Shared by the launch-time slack block and activateSlackProvider.
function setupSlackRoom(slackUrl) {
  const { SLACK } = require('./slack-selectors');
  const slackRoom = SLACK.roomCodeFromUrl(slackUrl);
  if (!slackRoom) {
    console.warn('[electron] Slack: no team/channel in URL; room code not set —', slackUrl);
    return;
  }
  localServer.setRoom(slackRoom);
  sync.updateConfig({ roomId: slackRoom, baseUrl: getWebsiteUrl() });
  console.log('[electron] Slack room code:', slackRoom);
  sync.ensureRoom().then((ok) => {
    sync.startPolling();
    console.log('[electron] Slack room ensured:', slackRoom,
      ok ? 'OK' : '(NOT created — log into ' + getWebsiteUrl() + ' so the bot can create rooms)');
  }).catch((e) => console.warn('[electron] Slack ensureRoom error:', e && e.message));
}

// Switch the embedded view to the Slack two-surface on a workspace/huddle URL,
// tearing down whatever view (Meet, or an older Slack surface) was there.
function activateSlackProvider(slackUrl, { autojoin = true } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  console.log('[electron] Activating Slack provider:', slackUrl);
  if (meetView) {
    try { mainWindow.removeBrowserView(meetView); } catch (err) { console.warn('[electron] removeBrowserView failed:', err.message); }
    meetView = null;
  }
  ensureMeetSessionConfigured(SESSION_PARTITION);
  const { createSlackSurface } = require('./slack-surface');
  const surface = createSlackSurface(mainWindow, {
    partition: SESSION_PARTITION,
    url: slackUrl,
    devtools: !!(cliArgs && cliArgs['devtools']),
    autojoin,
  });
  meetView = surface.view;
  slackProviderMode = true;
  slackSurface = surface;
  mainWindow.addBrowserView(meetView);
  layoutViews();
  setupSlackRoom(slackUrl);

  console.log('[electron] Slack provider on partition:', SESSION_PARTITION);
}

// Ensure the embedded view is a Google Meet view (switching back from Slack if
// needed) before loading a Meet URL.
function activateMeetProvider() {
  if (!slackProviderMode && meetView && !meetView.webContents.isDestroyed()) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  console.log('[electron] Activating Meet provider (was slack=' + slackProviderMode + ')');
  if (meetView) {
    try { mainWindow.removeBrowserView(meetView); } catch (err) { console.warn('[electron] removeBrowserView failed:', err.message); }
    meetView = null;
  }
  slackProviderMode = false;
  slackSurface = null;
  ensureMeetSessionConfigured(currentMeetPartition);
  meetView = createMeetView(currentMeetPartition);
  mainWindow.addBrowserView(meetView);
  layoutViews();
}

function createMainWindow() {
  // Optional explicit window placement from CLI (--window-x/-y/-w/-h), used by
  // the multi-bot test launcher to tile windows in a grid. Setting x/y at
  // creation is reliable (System Events moves from outside get reverted by the
  // window server for some instances). Omitted → Electron centers as usual.
  const winX = cliArgs['window-x'] != null ? parseInt(cliArgs['window-x'], 10) : null;
  const winY = cliArgs['window-y'] != null ? parseInt(cliArgs['window-y'], 10) : null;
  const winW = cliArgs['window-w'] != null ? parseInt(cliArgs['window-w'], 10) : null;
  const winH = cliArgs['window-h'] != null ? parseInt(cliArgs['window-h'], 10) : null;
  mainWindow = new BrowserWindow({
    // Meet view = width - PANEL_WIDTH. Sized to fit a laptop screen comfortably.
    // (An earlier extra-large window chased a toolbar-collapse theory that turned
    // out not to be the real cause — the recurring "<button> not found" issues
    // were click/timing/selector bugs, since fixed. We keep the Meet view a touch
    // wider than the old 800px for a little toolbar margin, no more.)
    width: Number.isFinite(winW) ? winW : 880 + PANEL_WIDTH,
    height: Number.isFinite(winH) ? winH : 600,
    ...(Number.isFinite(winX) ? { x: winX } : {}),
    ...(Number.isFinite(winY) ? { y: winY } : {}),
    minWidth: 640 + PANEL_WIDTH,
    minHeight: 460,
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
        {
          // Advanced (#282 follow-up): drive the bot's own webview to any URL to
          // set up Slack/Google account state inside its partition.
          label: 'Navigate Webview…',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => {
            if (panelView && !panelView.webContents.isDestroyed()) {
              panelView.webContents.send('navigate-webview-prompt');
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

  // --- Call view (right) ---
  // Single partition (#282) — no "restore previous mode" anymore. Sign-in
  // stickiness now comes from the cookies persisting in this one partition,
  // not from remembering which partition to swap to.
  ensureMeetSessionConfigured(currentMeetPartition);

  // Provider selection (#264).
  //
  // The app now switches between Meet and Slack at RUNTIME (no relaunch):
  // browser detection finds either a meet.google.com call or an app.slack.com
  // huddle, the panel's Join routes to activateMeetProvider / activateSlackProvider
  // (above), and each rebuilds `meetView` into the right surface. So --provider is
  // just a launch SHORTCUT (and how the test fleet boots straight into Slack);
  // dropping it falls back to Meet-at-launch, then the runtime switch takes over.
  // Optional --slack-url=<deep-link> picks the channel to auto-join at launch.
  const slackMode = cliArgs['provider'] === 'slack';
  if (slackMode) {
    const { createSlackSurface } = require('./slack-surface');
    const slackUrl = cliArgs['slack-url'] || 'https://app.slack.com/';
    console.log('[electron] Provider: SLACK — loading', slackUrl);
    ensureMeetSessionConfigured(SESSION_PARTITION);
    const surface = createSlackSurface(mainWindow, {
      partition: SESSION_PARTITION,
      url: slackUrl,
      devtools: !!(cliArgs && cliArgs['devtools']),
      // Auto-join the channel's huddle (header button → lobby confirm). Default
      // on in the Slack scaffold; --slack-autojoin=false to just load the channel.
      autojoin: cliArgs['slack-autojoin'] !== 'false',
    });
    meetView = surface.view;
    // Enable provider-aware command routing: DOM commands → the huddle popup.
    slackProviderMode = true;
    slackSurface = surface;
    // Room code → local server + vibeconferencing.com sync + ensureRoom. The
    // code is deterministic from the URL (team+channel), the Slack analogue of a
    // Meet code. Shared with the runtime activateSlackProvider path.
    setupSlackRoom(slackUrl);
  } else {
    meetView = createMeetView(currentMeetPartition);
  }
  mainWindow.addBrowserView(meetView);

  // Open DevTools on demand from panel — registered once, references the
  // current module-level meetView so it always targets the live one after
  // a partition swap.
  ipcMain.on('open-devtools', () => {
    if (meetView && meetView.webContents) {
      meetView.webContents.openDevTools({ mode: 'detach' });
    }
  });

  layoutViews();
  mainWindow.on('resize', layoutViews);

  // Load idle placeholder in the Meet view. In Slack mode the surface already
  // loaded app.slack.com (or the channel deep-link) in createSlackSurface.
  if (!slackMode) meetView.webContents.loadURL(MEET_HOME_URL);

  mainWindow.on('closed', () => {
    mainWindow = null;
    panelView = null;
    meetView = null;
    sync.stopPolling();
  });
}

function showIdle() {
  if (!meetView || meetView.webContents.isDestroyed()) return;
  meetView.webContents.loadURL(MEET_HOME_URL);
  sync.stopPolling();
  // Close whiteboard window if open
  if (whiteboardWindow && !whiteboardWindow.isDestroyed()) {
    whiteboardWindow.close();
  }
  console.log('[electron] Returned to idle state');
}

async function loadMeetURL(meetUrl) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // Destroy and recreate the meetView before every join. Clearing storage
  // alone is insufficient: Meet caches the green-room identity *in-memory*
  // at the BrowserView level, so a webContents.loadURL into the same view
  // leaves the previous Meet SPA's state alive (visible in logs as
  // duplicated [electron-meet] / [bots-in-calls] lines from two live
  // preload contexts). Tearing down the view is the only thing that
  // matches what "quit and relaunch the app" does.
  if (meetView) {
    try { mainWindow.removeBrowserView(meetView); } catch (err) {
      console.warn('[electron] removeBrowserView failed:', err.message);
    }
    meetView = null;
  }

  // Is this profile signed into Google? Drives both the cache-clear decision
  // and the authuser pin below. With a single partition (#282) we can't infer
  // it from "which partition" anymore — read the live cookies.
  const sess = session.fromPartition(currentMeetPartition);
  const signedIn = await isSignedInToGoogle(sess);

  // Now that no view is bound to it, also wipe disk-backed Meet caches so the
  // fresh view starts truly blank (in-memory teardown above isn't enough;
  // localStorage/cookies could re-seed the identity).
  //
  // GUEST ONLY. This clear nukes .google.com path="/" cookies — which when
  // signed in ARE the Google master-auth cookies (SID/SSID/HSID/SAPISID/
  // __Secure-1PSID, all domain=.google.com path=/, NOT path=/accounts). Running
  // it while signed in silently signs the bot OUT before every join → it joins
  // un-authenticated and can't be auto-admitted to invited meetings (#250). The
  // cache only resets Meet's cached guest "Your name", moot when signed in.
  if (signedIn) {
    console.log('[electron] Signed in — skipping Meet identity-cache clear to preserve Google sign-in');
  } else {
    await clearMeetIdentityCache(currentMeetPartition);
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // #282: pin the Google account. When signed in, append ?authuser=<email> so
  // Meet uses the bot's bound account instead of whatever Google considers the
  // partition default (authuser=0) — which could be a stray second account that
  // crept in. The bound email comes from --meet-account-email or is captured at
  // sign-in (get-meet-account-email). No pin when guest or when unknown.
  const boundEmail = signedIn && store ? store.get('meetAccountEmail') : null;
  const urlToLoad = boundEmail ? pinAuthUser(meetUrl, boundEmail) : meetUrl;
  if (boundEmail) console.log('[electron] Pinning Meet account via authuser:', boundEmail);

  meetView = createMeetView(currentMeetPartition);
  mainWindow.addBrowserView(meetView);
  layoutViews();

  meetView.webContents.loadURL(urlToLoad);

  // Forward preload-meet's console output to main stdout so [electron-meet]
  // and [CC] log lines show up alongside [local-server] / [electron] in the
  // terminal we tail with cmux read-screen. Errors → console.error.
  meetView.webContents.on('console-message', (_e, level, message) => {
    // Only forward our prefixed lines — Meet's own console is noisy.
    // The preload-meet / page-inject console wrapper prepends HH:MM:SS.mmm,
    // so the source bracket may be at column 0 or after the timestamp. Match
    // both by stripping an optional leading ts prefix before checking.
    if (typeof message !== 'string') return;
    const body = message.replace(/^\d{2}:\d{2}:\d{2}\.\d{3}\s+/, '');
    if (body.startsWith('[electron-meet]') ||
        body.startsWith('[bots-in-calls]') || body.startsWith('[captions]') ||
        body.startsWith('[chat]') || body.startsWith('[speaker-tracker]') ||
        body.startsWith('[speaker-health]') || body.startsWith('[caption-health]') ||
        body.startsWith('[caption-stall]')) {
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
      // Restore debug overlay state across Meet reloads.
      if (store?.get('debugOverlay')) {
        meetView.webContents.send('extension-message', {
          action: 'set-debug-overlay',
          payload: { enabled: true },
        });
        updateDebugOverlayPushInterval(true);
      }
    }
  });
}

// Periodic call-state snapshot push to the meet view while the debug overlay
// is enabled. Re-uses LocalServer.getCallStateSnapshot — same data as the
// troubleshooting panel — so the on-camera view stays in sync with what the
// panel shows.
let debugOverlayPushTimer = null;
function updateDebugOverlayPushInterval(enabled) {
  if (debugOverlayPushTimer) {
    clearInterval(debugOverlayPushTimer);
    debugOverlayPushTimer = null;
  }
  if (!enabled) return;
  const push = () => {
    if (!meetView || meetView.webContents.isDestroyed()) return;
    try {
      const snap = localServer.getCallStateSnapshot();
      meetView.webContents.send('extension-message', {
        action: 'debug-info-update',
        payload: snap,
      });
    } catch { /* ignore */ }
  };
  push();
  debugOverlayPushTimer = setInterval(push, 1000);
}

// ---------------------------------------------------------------------------
// IPC routing — replaces chrome.runtime.onMessage
// ---------------------------------------------------------------------------

function setupIPC() {
  // --- Config ---
  ipcMain.handle('get-config', (_event, keys) => {
    return store.getMultiple(keys);
  });

  // Bot vitals for the panel: is the on-device fast model reachable? Pings the
  // configured ack endpoint (Apple wrapper / any openai-compat) GET /v1/models
  // with a short timeout. Read-only; never throws. The panel polls this.
  ipcMain.handle('get-fast-model-status', async () => {
    const { endpoint, model } = require('./ack').getLocalModelConfig(store);
    if (!endpoint) return { ok: false, endpoint: null, model: null, error: 'no endpoint' };
    const url = endpoint.replace(/\/+$/, '') + '/models';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      return { ok: resp.ok, endpoint, model, status: resp.status };
    } catch (err) {
      return { ok: false, endpoint, model, error: err.name === 'AbortError' ? 'timeout' : err.message };
    } finally {
      clearTimeout(timer);
    }
  });

  // #212: the name preload-meet should type into Meet's pre-join input — the
  // per-call override if one is active, else the persistent panel preference.
  // Separate from get-config('botName') (which the panel uses to show the
  // persistent preference) so a per-call name never leaks into the panel field.
  ipcMain.handle('get-meet-bot-name', () => {
    return localServer.getEffectiveBotName() || store.get('botName') || 'Jimmy';
  });

  ipcMain.handle('set-config', (_event, key, value) => {
    store.set(key, value);
  });

  ipcMain.handle('get-app-version', () => app.getVersion());

  ipcMain.handle('get-app-profile', () => appProfile || null);
  ipcMain.handle('get-local-port', () => localServer.port);

  // Reveal the profiles folder in Finder so the user can delete/rename profile
  // dirs directly (#282 debugging help).
  ipcMain.handle('open-profiles-folder', async () => {
    try { fs.mkdirSync(PROFILES_ROOT, { recursive: true }); } catch { /* exists */ }
    const err = await shell.openPath(PROFILES_ROOT);
    if (err) console.warn('[electron] open-profiles-folder failed:', err);
    return { ok: !err, path: PROFILES_ROOT, error: err || undefined };
  });

  // --- Profile switcher (#282): Chrome-style list + launch/focus ------------
  // A profile = a sibling userData dir under <base>/profiles, each its own
  // identity. You can't rehome a RUNNING instance (userData is fixed before
  // app-ready), so "switch" launches or focuses the instance for that profile.

  // Ping ports where instances may live and read each one's localProfile from
  // /api/sync/no-room, so we detect running profiles regardless of how they
  // were launched (switcher, fleet, or default). Returns { profileName: port }.
  async function scanRunningInstances() {
    const ports = [7865]; // default instance
    for (let p = profileManager.PROFILE_PORT_BASE; p <= profileManager.PROFILE_PORT_MAX; p++) ports.push(p);
    for (let p = 7901; p <= 7916; p++) ports.push(p); // test fleet range
    const running = {};
    await Promise.all(ports.map(async (port) => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 350);
        const r = await fetch(`http://127.0.0.1:${port}/api/sync/no-room`, { signal: ctrl.signal });
        clearTimeout(t);
        if (!r.ok) return;
        const j = await r.json();
        const name = j?.status?.localProfile;
        if (name) running[name] = port;
        else if (port === 7865) running['(default)'] = port;
      } catch { /* not listening */ }
    }));
    return running;
  }

  ipcMain.handle('list-profiles', async () => {
    const profiles = profileManager.listProfiles(PROFILES_ROOT);
    const reg = profileManager.loadPortRegistry(BASE_USER_DATA);
    const running = await scanRunningInstances();
    return {
      current: appProfile || null,
      profiles: profiles.map((p) => ({
        ...p,
        port: running[p.name] || reg[p.name] || null,
        running: !!running[p.name],
        isCurrent: p.name === appProfile,
      })),
    };
  });

  // Launch (or focus, if already running) the instance for a profile. Creating
  // a new profile is just launching a never-seen name — the dir is created by
  // that instance at startup.
  ipcMain.handle('switch-profile', async (_event, name) => {
    if (!profileManager.isValidProfileName(name)) {
      return { ok: false, error: 'Invalid profile name (letters, numbers, . _ - only)' };
    }
    if (name === appProfile) return { ok: true, focused: true, alreadyCurrent: true };

    // Already running? Focus it instead of spawning a duplicate.
    const running = await scanRunningInstances();
    if (running[name]) {
      const port = running[name];
      try {
        await fetch(`http://127.0.0.1:${port}/api/focus`, { method: 'POST' });
        return { ok: true, focused: true, port };
      } catch (err) {
        return { ok: false, error: `Profile running on ${port} but focus failed: ${err.message}` };
      }
    }

    // Otherwise launch a fresh instance bound to that profile + its stable port.
    let port;
    try { port = profileManager.portForProfile(BASE_USER_DATA, name); }
    catch (err) { return { ok: false, error: err.message }; }

    const { execFile } = require('child_process');
    const args = [`--profile=${name}`, `--local-port=${port}`];
    try {
      if (app.isPackaged) {
        // Resolve the .app bundle from the exe path and open a new instance.
        const exe = app.getPath('exe'); // …/Vibeconferencing.app/Contents/MacOS/Vibeconferencing
        const appBundle = exe.replace(/\/Contents\/MacOS\/[^/]+$/, '');
        execFile('open', ['-n', appBundle, '--args', ...args], (err) => {
          if (err) console.error('[electron] switch-profile launch failed:', err.message);
        });
      } else {
        // Dev: relaunch this Electron binary with the same app dir + profile args.
        execFile(process.execPath, [app.getAppPath(), ...args], { detached: true, stdio: 'ignore' })
          .on('error', (err) => console.error('[electron] switch-profile dev launch failed:', err.message));
      }
      console.log('[electron] Launching profile', name, 'on port', port, app.isPackaged ? '(packaged)' : '(dev)');
      return { ok: true, launched: true, port };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Debug overlay — renders the troubleshooting snapshot onto the bot's
  // virtual camera so non-technical users can diagnose state by looking at
  // the Meet tile. Stored under a non-schema key so it stays invisible to
  // the agent (no MCP set_preference access — would be a prompt-injection
  // vector for leaking state on demand).
  ipcMain.handle('get-debug-overlay', () => !!(store && store.get('debugOverlay')));
  ipcMain.handle('set-debug-overlay', (_event, enabled) => {
    const on = !!enabled;
    if (store) store.set('debugOverlay', on);
    if (meetView && !meetView.webContents.isDestroyed()) {
      meetView.webContents.send('extension-message', {
        action: 'set-debug-overlay',
        payload: { enabled: on },
      });
    }
    updateDebugOverlayPushInterval(on);
    return on;
  });

  // Pop the panel out into its own window (or dock it back) — lets the bot's-eye
  // view sit at any size next to the bot's Meet window.
  ipcMain.handle('toggle-panel-popout', () => {
    setPanelPoppedOut(!panelPopoutWindow);
    return { poppedOut: !!panelPopoutWindow };
  });
  ipcMain.handle('get-panel-popout', () => ({ poppedOut: !!panelPopoutWindow }));


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

  // Open a URL in the user's external default browser (e.g. the idle screen's
  // "Start default testing meet" link — so the operator can join the meet as a
  // human in their own browser, separate from the bot's Electron Meet view).
  ipcMain.on('open-external-url', (_event, url) => {
    if (typeof url === 'string' && /^https:\/\//i.test(url)) shell.openExternal(url);
  });

  ipcMain.on('leave-meet', () => {
    currentMeetUrl = null;
    detectedMeetUrl = null; // Reset so detection will re-notify about the same Meet
    localServer.clearRoom();
    closeClaudeTerminal();
    showIdle();
    // Identity cache is cleared at *join* time, not here — so it doesn't
    // matter how the previous call ended (host-ended, app quit, crash).
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

  // --- Meet identity (#170 / #282) ---
  // These IPCs let the panel sign the *bot* in to Google. Distinct from the
  // user's vibeconferencing.com login above — this is the Meet display
  // identity. Single partition now (#282): "guest vs signed-in" is decided by
  // whether the partition holds Google cookies, not by which partition is active.

  ipcMain.handle('get-meet-mode', async () => {
    const signedIn = await isSignedInToGoogle(session.fromPartition(currentMeetPartition));
    return { partition: currentMeetPartition, mode: signedIn ? 'account' : 'guest' };
  });

  // Which Google account the bot is ACTUALLY signed in as (not just "signed in"
  // — the real email). Surfaces the gap that hid #250: the app knew the mode but
  // never the identity, so a silently-logged-out bot looked "signed in". Reads
  // the single partition's live Google session (cookie-authoritative + a DOM
  // scrape for the email). Best-effort. Also CAPTURES the email as the profile's
  // bound account (store.meetAccountEmail) so loadMeetURL can pin authuser to it
  // (#282) — unless an explicit --meet-account-email already pinned it.
  ipcMain.handle('get-meet-account-email', async () => {
    const sess = session.fromPartition(currentMeetPartition);

    // AUTHORITATIVE signed-in check: the live cookie jar. Google's master-auth
    // cookies (domain=.google.com) are the ground truth — the bot auto-admitting
    // as a member proves they're present even when ListAccounts parsing fails.
    const signedIn = await isSignedInToGoogle(sess);
    if (!signedIn) return { signedIn: false, email: null };

    // Best-effort email: read it straight from the bot's live signed-in Google
    // page (the meetView). Meet renders the account in its account-switcher
    // button (aria-label "Google Account: <name> (<email>)"). This beats the
    // ListAccounts API (which 400s on its modern params). Only works while the
    // meetView is on a google.com page (in a call / Meet home); otherwise we
    // report signed-in without the email.
    let email = null;
    let name = null;
    let allEmails = [];
    try {
      if (meetView && !meetView.webContents.isDestroyed() &&
          /\bgoogle\.com\b/.test(meetView.webContents.getURL() || '')) {
        // The signed-in account is in the OneGoogle account chip:
        //   <a aria-label="Google Account: <name> (<email>)">
        // It renders asynchronously after page load, so the one-shot fetch at
        // panel load missed it — retry a few times. Confirmed not in an iframe.
        // We grab both the email AND the display name (for the big panel label).
        const SCAN = `(() => {
          const RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/g;
          const NAME_RE = /Google Account:\\s*(.+?)\\s*\\(/i;
          const out = new Set();
          let name = null;
          // Search the top doc + any SAME-ORIGIN iframes (the Google bar is
          // usually inline, but be safe). Cross-origin iframes throw → skipped.
          const docs = [document];
          for (const f of document.querySelectorAll('iframe')) {
            try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) { /* cross-origin */ }
          }
          const scan = (sel) => { for (const d of docs) {
            for (const el of d.querySelectorAll(sel)) {
              const al = el.getAttribute('aria-label') || '';
              ((al.match(RE)) || []).forEach((x) => out.add(x));
              if (!name) { const m = al.match(NAME_RE); if (m) name = m[1].trim(); }
            }
          } };
          scan('[aria-label*="Google Account" i]');
          if (!out.size) scan('[aria-label]'); // fallback: any aria-label
          return { emails: [...out], name };
        })()`;
        for (let attempt = 0; attempt < 5 && !email; attempt++) {
          if (attempt) await new Promise((r) => setTimeout(r, 400));
          try {
            const found = await meetView.webContents.executeJavaScript(SCAN, true);
            allEmails = Array.isArray(found?.emails) ? found.emails : [];
            if (found?.name) name = found.name;
            email = allEmails.find((e) => !/noreply|no-reply|example\.com/i.test(e)) || allEmails[0] || null;
          } catch { /* page mid-navigation; retry */ }
        }
        console.log('[electron] account-email:', email || '(none yet)', 'name=' + JSON.stringify(name), 'all=' + JSON.stringify(allEmails));
      }
    } catch (err) {
      console.warn('[electron] get-meet-account-email DOM read failed:', err.message);
    }

    // #282: bind this profile to the detected account so joins pin authuser to
    // it. An explicit --meet-account-email (meetAccountEmailPinned) always wins
    // and is never overwritten by a scrape. Otherwise capture the first real
    // email we see and persist it.
    if (email && store && !meetAccountEmailPinned && store.get('meetAccountEmail') !== email) {
      store.set('meetAccountEmail', email);
      console.log('[electron] Bound profile Meet account →', email);
    }
    // Remember the last Meet display name for this profile (the signed-in Google
    // name). Stable, so the profile selector + idle sub-line can show it without
    // a live call (#282). Display-only — distinct from the authuser-pinning email.
    if (name && store && store.get('lastMeetName') !== name) {
      store.set('lastMeetName', name);
    }

    return { signedIn, email, name, allEmails };
  });

  // Navigate the (single) meetView to Google's ServiceLogin flow. No partition
  // swap (#282): the bot signs in, cookies land in this profile's one partition
  // and persist across launches. Later calls bounce straight through to Meet's
  // home if already signed in.
  ipcMain.handle('meet-sign-in-as-bot', () => {
    const url = 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmeet.google.com%2F';
    navigateMeetView(url);
    return { ok: true, mode: 'account' };
  });

  // Advanced/power-user: point the embedded webview at an arbitrary URL so the
  // operator can drive Slack or Google into a needed state (accept an invite,
  // switch workspace, finish a sign-in) inside the bot's OWN partition — the
  // same cookies the bot uses. Navigates the CURRENT view in place (Meet or
  // Slack), without switching providers. Triggered by the "Navigate Webview…"
  // menu item (⌘⇧L) → panel prompt. Not exposed to the agent (operator-only).
  ipcMain.handle('navigate-webview', (_event, rawUrl) => {
    const url = String(rawUrl || '').trim();
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'URL must start with http(s)://' };
    if (!meetView || meetView.webContents.isDestroyed()) {
      activateMeetProvider();
    }
    if (meetView && !meetView.webContents.isDestroyed()) {
      console.log('[electron] navigate-webview →', url);
      meetView.webContents.loadURL(url);
      return { ok: true, url };
    }
    return { ok: false, error: 'no webview' };
  });

  // Sign the bot out: remove ONLY Google's auth cookies (the master-auth set,
  // domain=.google.com) so the partition reverts to a guest — WITHOUT touching
  // Slack's cookies, which now share this partition (#282). Then drop the bound
  // account and reload Meet home so the panel reflects logged-out state. A
  // deliberate, rare action — the old per-call partition swap is gone.
  ipcMain.handle('meet-sign-out-bot', async () => {
    try {
      const sess = session.fromPartition(currentMeetPartition);
      const all = await sess.cookies.get({});
      let removed = 0;
      for (const c of all) {
        const d = (c.domain || '').replace(/^\./, '');
        if (/(^|\.)google\.com$/.test(d) || d === 'google.com') {
          const url = `https://${d}${c.path || '/'}`;
          try { await sess.cookies.remove(url, c.name); removed++; } catch { /* best-effort */ }
        }
      }
      // Meet's own origin-scoped caches too (the guest "Your name" etc.).
      await sess.clearStorageData({ origin: 'https://meet.google.com', storages: ['localstorage', 'indexdb', 'cachestorage'] });
      if (store && !meetAccountEmailPinned) store.delete('meetAccountEmail');
      console.log('[electron] Signed bot out — removed', removed, 'google.com cookies (Slack login preserved)');
    } catch (err) {
      console.warn('[electron] meet-sign-out-bot clear failed:', err.message);
    }
    navigateMeetView(MEET_HOME_URL);
    return { ok: true, mode: 'guest' };
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
    sendExtMsg({ action: CALL_COMMANDS.ACTIONS.unmuteMic });
    setTimeout(() => {
      sendExtMsg({ action: CALL_COMMANDS.ACTIONS.playTts, payload: { audioData: base64Audio } });
    }, 300);
  });

  // --- Sync ---
  ipcMain.on('start-sync', (_event, { meetCode, botName }) => {
    // Re-establish the room in local-server if it isn't already this one. On a
    // normal join roomId is already set (skip — setRoom would wipe transcripts/
    // working memory). But if a spurious "You can't join" page made the error
    // path clearRoom() and the operator then manually recovered (#238), roomId
    // is null here and we must re-set it so the app tracks the call again.
    if (meetCode && localServer.roomId !== meetCode) {
      console.log('[electron] start-sync re-establishing room (was', localServer.roomId, '→', meetCode + ')');
      localServer.setRoom(meetCode);
    }
    sync.updateConfig({ roomId: meetCode, baseUrl: getWebsiteUrl() });
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
  ipcMain.on(CALL_EVENTS.botJoinedCall, (_event, { meetCode, botName }) => {
    console.log('[electron] Bot joined call, playing join chime');
    if (meetView && !meetView.webContents.isDestroyed()) {
      meetView.webContents.send('extension-message', { action: 'play-join-chime' });
    }
  });

  // --- Meet status updates (logged, DOM updated by preload) ---
  ipcMain.on(CALL_EVENTS.statusUpdate, (_event, status) => {
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
  ipcMain.on(CALL_EVENTS.screenShareError, (_event, errorMessage) => {
    console.error('[electron] Screen share error:', errorMessage);
    localServer.setSharing(false);
    localServer.addError('Screen share: ' + errorMessage);
    broadcastError('Screen share: ' + errorMessage);
  });

  ipcMain.on(CALL_EVENTS.screenShareStopped, () => {
    console.log('[electron] Screen share stopped');
    localServer.setSharing(false);
  });

  // Forwarded log lines from page-inject.js (via preload-meet). These are
  // emoji-change announcements right now but the channel is generic.
  ipcMain.on('page-inject-log', (_event, line) => {
    console.log('[page-inject]', line);
  });

  // Captions confirmed on (toolbar shows "Turn off captions"). This is the
  // canonical "the bot can actually hear what's said" signal — we use it to
  // flush any deferred bot speech (queued before the bot could be heard).
  // NOTE: this no longer engages the avatar. Captions are turned on by the
  // bot's OWN auto-setup with no agent involved, so flipping 🫥 → 🙂 here
  // showed a face before any agent backend was actually connected. Engagement
  // now gates on real agent activity (wait_for_speech / speak) in page-inject's
  // set-bot-state handler, so 🫥 means "in the call but no agent driving yet."
  ipcMain.on(CALL_EVENTS.captionsReady, () => {
    console.log('[electron] Captions ready — flushing pending bot speech');
    localServer._flushPendingBotSpeech();
  });

  ipcMain.on(CALL_EVENTS.ttsEnded, () => {
    // If only the ack just finished, stay in 'thinking' — the agent is still
    // generating the real response and will clear the flag when it speaks.
    if (ackTtsPending) {
      ackTtsPending = false;
      return;
    }
    // Back-off can stop TTS and move the bot to 'yielding'. The audio-ended
    // callback may still arrive afterward; do not let it erase the visible
    // "holding back" state while someone is still speaking.
    if (localServer.botState === 'yielding' && localServer.anyoneSpeaking) {
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
    // TTS playback finished. Three cases:
    //   - waiter active (agent already called wait_for_speech) → 'listening'.
    //     Agent explicitly handed the floor back; this turn is done.
    //   - no waiter, callStatus=in-call → 'thinking'. Agent might still be
    //     working on this turn (more tool calls, another speak, etc.). The
    //     avatar stays on 🤔 instead of flashing 🙂 between the speak and
    //     whatever comes next — matches "thinking = mid-turn, listening =
    //     waiting for next turn."
    //   - everything else (post-leave, between calls) → 'idle'.
    // force=true so the speaking→thinking|listening guard in _setBotState
    // (which prevents premature transitions when speak/wait_for_speech are
    // called back-to-back) doesn't block this legitimate end-of-speech.
    let nextState;
    if (localServer.waiters.length > 0) nextState = 'listening';
    else if (localServer.callStatus === 'in-call') nextState = 'thinking';
    else nextState = 'idle';
    localServer._setBotState(nextState, undefined, { force: true });
  });

  // User toggled the mic in Meet's UI — map to listening mode.
  // Muted = passive (only respond when name mentioned).
  // Unmuted = active (respond on every pause).
  // The MCP set_mode tool can still set 'silent' separately.
  ipcMain.on(CALL_EVENTS.micMuteChanged, (_event, { muted }) => {
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

  // Snapshot-style caption turns from the Meet caption scraper (#178). The
  // scraper sends the full current state of visible caption children each
  // tick (deduped if unchanged). updateTurns upserts and marks settled any
  // turn that's no longer bottommost.
  ipcMain.on(CALL_EVENTS.captionTurns, (_event, payload) => {
    const turns = payload?.turns;
    if (!Array.isArray(turns)) return;
    localServer.updateTurns(turns);
    // Mirror the live caption state into the troubleshooting panel — the
    // "bot's-eye view" of exactly what captions the bot is receiving, so you
    // can compare it in real time against the bot's Meet view.
    if (panelView && !panelView.webContents.isDestroyed()) {
      panelView.webContents.send('caption-feed', { turns });
    }
    // TODO(#178 phase 2): forward settled turns to the remote sync for the
    // webapp room view, replacing the old per-entry sync.postTranscripts feed
    // for captions.
  });

  // Captions toggled on/off mid-call (deaf-bot detection). The scraper
  // self-heals by re-clicking the CC button; this keeps the server state in
  // sync so the avatar can flip to 🙉 and wait_for_speech timeouts can
  // tell the agent the room isn't silent — the bot is deaf.
  ipcMain.on(CALL_EVENTS.captionsState, (_event, { on }) => {
    localServer.setCaptionsOn(!!on);
    if (panelView && !panelView.webContents.isDestroyed()) {
      panelView.webContents.send('caption-state', { on: !!on });
    }
  });

  // Captions report ON but the text stream is frozen (#259) — the bot is deaf
  // even though the CC button still says "on". Route it through the same deaf
  // path as captions-off so the 🙉 emoji flips and the wait_for_speech timeout
  // warns the agent. Auto-clears: the next real caption flips captionsOn back
  // ON (local-server self-corrects on incoming text).
  ipcMain.on(CALL_EVENTS.captionStall, (_event, info) => {
    const secs = Math.round((info?.ageMs || 0) / 1000);
    // ONLY real deafness: captions frozen WHILE a remote participant is actually
    // speaking. "No new captions" is also true when the room is quiet/muted or
    // when the bot itself is speaking (its own captions are excluded) — neither
    // is deafness. anyoneSpeaking is speaker-TILE based (independent of captions),
    // so it's the right discriminator. (Live 2026-06-23: a silent room got
    // flagged deaf and the bot announced "I've gone deaf" — #259.)
    if (!localServer.anyoneSpeaking) {
      console.log(`[electron] caption stall (${secs}s) but no remote speaker active — quiet/self-speaking, NOT deaf; ignoring`);
      return;
    }
    console.log(`[electron] caption stall (${secs}s, ${info?.nodes ?? '?'} nodes) while a remote is speaking — bot is deaf; escalating + self-healing`);
    localServer.setCaptionsOn(false);
    if (panelView && !panelView.webContents.isDestroyed()) {
      panelView.webContents.send('caption-state', { on: false });
    }
    // D (#259): self-heal — only on CONFIRMED deafness, never during quiet rooms.
    if (meetView && !meetView.webContents.isDestroyed()) {
      sendCallCmd(CALL_COMMANDS.recoverCaptions);
    }
  });

  // #263: dump the full denial/limbo page DOM to a file the instant the bot is
  // stuck on it (the "You can't join this video call" screen auto-dismisses in
  // ~30s, too fast to catch in DevTools). Written next to the session log so
  // it's easy to find after an unattended run.
  ipcMain.on('capture-dom', (_event, info) => {
    try {
      const logDir = path.dirname(getSessionLogPath());
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(logDir, `denial-capture-${stamp}.html`);
      fs.writeFileSync(file, info?.html || '', 'utf-8');
      console.warn(`[capture-dom] Saved denial/limbo DOM (${info?.reason || '?'}) → ${file}`);
      console.warn(`[capture-dom]   url=${info?.url || ''}`);
    } catch (err) {
      console.warn('[capture-dom] failed to save DOM:', err.message);
    }
  });

  // --- Speaking state ---
  ipcMain.on(CALL_EVENTS.speakingChanged, (_event, { name, speaking }) => {
    if (name && sync.roomId) {
      updateSpeakingState(name, speaking);
    }
  });

  // --- Participant list + presenting state from preload-meet.js ---
  ipcMain.on(CALL_EVENTS.participantsUpdated, (_event, participants) => {
    localServer.setParticipants(participants || []);
  });

  ipcMain.on(CALL_EVENTS.chatUnread, (_event, { unread }) => {
    localServer.setChatUnread(!!unread);
  });

  ipcMain.on(CALL_EVENTS.paneState, (_event, state) => {
    localServer.setPaneState(state || {});
  });

  ipcMain.handle('get-call-state', () => localServer.getCallStateSnapshot());

  // "Simulate speech" — the troubleshooting panel can inject a synthetic
  // caption turn as if a participant just spoke. Useful when coding in a
  // coffee shop, pasting test conversational data, or scripting flows
  // without a live mic.
  ipcMain.handle('simulate-speech', (_event, { text, speaker } = {}) => {
    return localServer.injectSimulatedTurn({ text, speaker });
  });

  ipcMain.on(CALL_EVENTS.someonePresenting, (_event, { presenting, presenterName }) => {
    localServer.setSomeoneElsePresenting(presenting, presenterName);
  });

  // Track our own presenting state from Meet UI (Stop presenting button visible)
  ipcMain.on(CALL_EVENTS.selfPresenting, (_event, { presenting }) => {
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
    // Built-in macOS `say` voice — used when no ElevenLabs key is set, and as
    // the fallback voice when ElevenLabs is unavailable (e.g. quota exhausted).
    if (config.macosVoice) {
      store.set('macosVoice', config.macosVoice);
    }
    // Explicit provider override ('macos-say' / 'elevenlabs' / 'auto'). Lets the
    // bot (or user) force the built-in voice as primary even with an EL key set.
    if (config.provider) {
      store.set('ttsProvider', config.provider);
    }
  });

  // List the installed macOS `say` voices for the preferences dropdown — the
  // exact voices our macOS TTS path (tts._macosSay → `say -v Name`) can use.
  // Returns [{ name, locale, sample }], quality-sorted (Premium > Enhanced >
  // plain), English first. Also refreshes the name set used by speak() routing.
  ipcMain.handle('list-macos-voices', async () => {
    const voices = await enumerateMacosVoices();
    macosVoiceNameSet = new Set(voices.map((v) => v.name));
    return voices;
  });

  // Speak a short sample in the given macOS voice through the LOCAL speakers
  // (not the call's virtual mic) so the user can audition a voice when they
  // pick it in preferences. `say` with no -o plays on the default output.
  // Cancels any in-flight preview so rapid changes don't overlap.
  ipcMain.handle('preview-macos-voice', (_event, name) => {
    if (process.platform !== 'darwin' || !name || typeof name !== 'string') return false;
    const { execFile } = require('child_process');
    try { if (_voicePreviewChild) _voicePreviewChild.kill(); } catch {}
    // Strip the "(Premium)"/"(Enhanced)" quality suffix for the spoken phrase
    // (keep the full name for `say -v`, which needs the exact identifier).
    const spoken = name.replace(/\s*\([^)]*\)\s*$/, '').trim() || name;
    _voicePreviewChild = execFile('say', ['-v', name, `Hello, my name is ${spoken}`], { timeout: 10000 }, () => {});
    return true;
  });

  // Open the macOS pane where users download additional system voices:
  // System Settings → Accessibility → Spoken Content → System Voice.
  ipcMain.handle('open-voice-settings', () => {
    if (process.platform !== 'darwin') return false;
    shell.openExternal('x-apple.systempreferences:com.apple.preference.universalaccess?SpeechContent');
    return true;
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
      sendCallCmd(CALL_COMMANDS.triggerScreenShare);
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
