// main.js — Electron main process
// Manages Meet BrowserView + panel sidebar in a single window,
// IPC routing, TTS, and sync.

const { app, BrowserWindow, BrowserView, ipcMain, session, shell, nativeImage, desktopCapturer, systemPreferences, dialog, Menu, net } = require('electron');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const Store = require('./store.js');
const { APP_LEVEL_KEYS, ScopedStore, migrateAppLevelKeys } = require('./config-scope.js');
const profileManager = require('./profile-manager.js');
const { MEET } = require('./meet-selectors.js'); // pure data — safe in the main process
const { resolveSvg } = require('./svg-resolver.js');
const { initSessionLog, logSessionHeaderUpdate, getRecentSessionLog, getSessionLogPath, configureRemoteLog, setRemoteLoggingEnabled } = require('./session-log.js');
// The call-provider contract. main.js is the consumer side: it subscribes to
// CALL_EVENTS (provider → app) and issues CALL_COMMANDS (app → provider) by
// constant rather than raw channel string, so the contract is shared on both
// sides of the IPC wire (provider impl in google-meet-provider.js). Values are
// byte-identical to the prior literals — same wire.
const { CALL_EVENTS, CALL_COMMANDS } = require('./call-provider.js');

// Git commit + dirty flag for the session-log header. Works when running from
// source (dev: __dirname is inside the repo); returns 'n/a' in a packaged app
// (no .git in the asar) or if git isn't available. Soft-fail, never throws.
function gitBuildInfo() {
  try {
    const { execSync } = require('child_process');
    const opts = { cwd: __dirname, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] };
    const hash = execSync('git rev-parse --short HEAD', opts).trim();
    const dirty = execSync('git status --porcelain', opts).trim().length > 0;
    return `${hash}${dirty ? '-dirty' : ''}`;
  } catch {
    return 'n/a (packaged or no git)';
  }
}

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
// signed-in Slack ACCOUNT name — which we don't yet read from the DOM (#283) —
// so fall back to the Meet botName until that lands. On Meet it's the botName
// (guest name / Google account name).
function getActiveBotName() {
  return store?.get('botName') || '';
}

// Round-trip request to the call preload (read/send chat). Sends on `channel`
// with a unique requestId and resolves with the matching 'chat-result' reply,
// or a timeout error. Handled by preload-meet.js (Meet) / preload-slack-huddle.js
// (Slack), routed to the right surface via callCmdWC.
// Once-per-call guard so a Chat-space warning doesn't spam the error list /
// overlay every time the agent retries chat. Reset on each new join (loadMeetURL).
let chatSpaceWarned = false;

// Inspect a chat IPC result and, if it's the known unreachable-Chat-space case,
// surface it to the operator: a panel/overlay error (once) and a log line. The
// result is returned unchanged so the agent still gets the actionable message
// (and can announce it aloud in the call).
function noteChatResult(result) {
  if (result && result.reason === 'chat-space-unreachable' && !chatSpaceWarned) {
    chatSpaceWarned = true;
    const msg = "Chat unavailable: this meeting's chat is a Google Chat space the bot can't reach. " +
      'Speak chat aloud, or organize the meeting from a personal @gmail account.';
    console.warn('[electron] [chat-space]', msg);
    try { localServer.addError(msg); } catch { /* best-effort */ }
  }
  return result;
}

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
  // A dead stdout/stderr pipe (terminal closed) delivers EPIPE here via the
  // stream's async 'error' event. Logging it writes to the same dead pipe →
  // another EPIPE → an unbounded loop that once wrote a 26 GB session log.
  // session-log.js installs no-op stream error handlers; this is the second
  // line of defense. Drop silently — there is nowhere to report a dead pipe.
  if (err?.code === 'EPIPE' && err?.syscall === 'write') return;
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

// True once the triage gate has failed to reach (or parse) the local fast model.
// While set, the regex-addressivity ack path below un-suppresses itself, so a
// down endpoint degrades the ack GATE to regex instead of deleting acks
// entirely. Cleared on the next successful verdict.
//
// One-turn lag by construction: triage is invoked AFTER the 'thinking'
// transition that drives the regex path, so the first failure costs one ack.
// Every turn after it falls back. Correcting that would mean blocking the
// thinking transition on a model call, which is exactly what the fast tier
// exists to avoid.
let triageEndpointDown = false;

// Local HTTP server for agent communication (replaces remote sync for MCP)
const localServer = new globalThis.LocalServer({
  appVersion: app.getVersion(),
  packaged: app.isPackaged, // release (installed .app/DMG) vs running from source

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
    // #372: invalidate any in-flight chunked utterance — a chunk still being
    // synthesized must NOT be sent after the barge-in stopped its siblings
    // (it would speak a stale mid-utterance tail over the interrupter).
    ttsStopGeneration++;
    if (meetView && !meetView.webContents.isDestroyed()) {
      meetView.webContents.send('extension-message', {
        action: 'stop-tts',
        payload: { reason: reason || 'back-off' },
      });
    }
  },
  // #350: resume an utterance that a barge-in cut off mid-playback. Fired by
  // local-server on the next silence edge (gated by age + content-delta); the
  // renderer resumes the retained buffer near the interruption point.
  onResumeTts: () => {
    console.log('[local-server] resume-tts (#350)');
    if (meetView && !meetView.webContents.isDestroyed()) {
      meetView.webContents.send('extension-message', {
        action: 'resume-tts',
        payload: {},
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
  // #321: forward custom whiteboard CSS to the remote sync so the whiteboard
  // window (which renders from the remote room page) applies it. The shared
  // board only re-fetches its style on a content change, so a style-only edit
  // wouldn't visibly apply to what's already on screen — after the CSS is
  // persisted we reload the whiteboard window so the current content inherits
  // the new styling immediately.
  onWhiteboardStyle: async (css, sender) => {
    const roomId = localServer.roomId;
    if (!roomId) return;
    console.log('[local-server] Whiteboard style from', sender, '·', String(css).length, 'chars');
    try {
      await fetch(`${getWebsiteUrl()}/api/sync/${roomId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender, role: 'bot', ownerName: sender, whiteboardStyle: css }),
      });
    } catch (err) {
      console.error('[local-server] Failed to forward whiteboard style:', err.message);
      return;
    }
    // Style is persisted — refresh the shared board so it inherits it now.
    reloadWhiteboardWindow('style change');
  },
  onReloadWhiteboard: () => {
    // Explicit reload (reload_whiteboard tool): re-fetch the shared board's
    // content + style without changing anything. No-op if nothing's shared.
    return reloadWhiteboardWindow('explicit reload');
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

      // P2: env-gated Runway photoreal face. VIBECONF_RUNWAY=1 auto-activates the
      // face for THIS seat ~8s after join (lets the Meet camera initialize). Default
      // OFF — without the env var this is a no-op and the emoji bot is unchanged.
      // De-hardcoded: eligibility is the opt-in env var, not a baked-in persona list
      // (the seat's avatar is resolved downstream). IDEMPOTENT: onJoinCall fires again
      // on a re-join, so only kick off the face if it isn't already enabled for this
      // seat — else two sessions race and the browser flaps between connects.
      if (process.env.VIBECONF_RUNWAY) {
        const seat = String(botName || '').toLowerCase();
        if (seat && !(_runway[seat] && _runway[seat].enabled)) {
          setTimeout(() => setRunwayFace(seat, true), 8000);
        }
      }
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
  onJoinSlack: (url) => {
    // Programmatic Slack-huddle join (#302): the same runtime provider switch +
    // auto-join that the panel "Join" button does (the join-detected-slack IPC),
    // but WITHOUT launching a Claude terminal — the agent calling join_call is
    // already the driver. activateSlackProvider → setupSlackRoom sets
    // localServer.roomId to slack-<team>-<channel>.
    console.log('[local-server] Join Slack huddle requested by agent:', url);
    activateSlackProvider(url, { autojoin: true });
    return localServer.roomId || null;
  },
  onLeaveCall: () => {
    console.log('[local-server] Leave call requested by agent');
    stopAllRunwayFaces('leave-call'); // P2: end Runway sessions + timers when leaving the call
    shareGeneration++; // cancel any in-flight Present-now retry loop before the view tears down

    // Wait for any in-flight TTS to finish so goodbye speech actually plays.
    // botState leaves 'speaking' when the `tts-ended` IPC fires (page-inject
    // posts it when its playback queue drains). Cap the wait so a stuck
    // synthesis can't block leave forever.
    const MAX_WAIT_MS = 8000;
    const POLL_MS = 150;
    const TAIL_MS = 400; // let the last audio buffer flush into the mic stream
    const deadline = Date.now() + MAX_WAIT_MS;

    // Give Google a clean leave BEFORE we navigate the view away. Clicking the
    // real "Leave call" button drops our participant tile immediately; skipping
    // it (the old behavior) just killed the media connection on nav-away and
    // left a ghost participant for others until Google's timeout reaped it.
    const LEAVE_CLICK_SETTLE_MS = 1000;
    const performLeave = () => {
      if (meetView && !meetView.webContents.isDestroyed()) {
        meetView.webContents.send('trigger-leave-call');
      }
      // Let the click register with Google's servers, then do the teardown
      // (panel → leave-meet → showIdle navigates the view to Meet home). The
      // teardown is the fallback path if the button wasn't present.
      setTimeout(() => {
        if (panelView && !panelView.webContents.isDestroyed()) {
          panelView.webContents.send('leave-requested');
        }
      }, LEAVE_CLICK_SETTLE_MS);
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
    // When triage is enabled (triageAck) AND reachable, the ack is gated by the
    // smart triage verdict in onTriageAck instead of this regex-addressivity
    // path — skip here to avoid a double ack. But when the local fast model is
    // down, triage returns no verdict and would ack nothing at all, so this
    // path takes back over: a dead endpoint degrades the gate to regex, it does
    // not silence the bot. (Same principle as ackProvider's llm→builtin fall
    // back for the PHRASE, and the probe gate's model→lexical fall back.)
    // A background_tick is a silent "think, don't speak" wake (#245) — never
    // fire a spoken ack there, or the bot interrupts whoever still has the floor.
    const triageGateActive = !!store?.get('triageAck') && !triageEndpointDown;
    if (state === 'thinking' && localServer.mode === 'active' && !triageGateActive && !extra?.backgroundTick) {
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
    // (lastSlackName is populated once we read the real Slack display name from
    // the huddle DOM — #283. We don't fake it from a preference anymore.)
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
    // #275: the bot just entered — bring the user's browser tab for this call to
    // the front (best-effort; no-op if there isn't one). Fires from any join path
    // and any provider (Meet / Slack / future).
    if (status === 'in-call') {
      focusBrowserCallTab(localServer.roomId);
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
    if (!result) {
      // The gate is unavailable. Don't silently stop acking — hand the decision
      // back to the regex-addressivity path, which needs no model at all.
      if (!triageEndpointDown) {
        console.log(ts(), '🚦 [triage] no verdict (parse/endpoint failure) — falling back to the regex ack gate');
      }
      triageEndpointDown = true;
      return;
    }
    if (triageEndpointDown) {
      console.log(ts(), '🚦 [triage] endpoint recovered — resuming triage-gated acks');
      triageEndpointDown = false;
    }
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
    const { judgeComplete, heuristicComplete } = require('./completeness');
    // Judge the raw last utterance (strip the "Speaker: " label the gate added).
    const text = (lastUtterance || '').replace(/^[^:]+:\s*/, '').trim();
    if (!text) return;
    let verdict = await judgeComplete({
      text,
      config: { endpoint: config.endpoint, apiKey: config.apiKey, model: config.model, timeoutMs: 4000 },
      log: (m) => console.log(ts(), '🎣 [probe-gate]', m),
    });
    // The on-device model is optional infrastructure — plenty of installs have
    // nothing listening on ackEndpoint. Skipping here meant one dead port
    // silently switched active listening off with no user-visible sign. Degrade
    // to the lexical gate instead; it is conservative, so the failure mode is a
    // quieter bot, never one that talks over people.
    if (!verdict) {
      verdict = heuristicComplete(text);
      console.log(ts(), '🎣 [probe-gate] model unavailable — falling back to the lexical gate');
    }
    console.log(ts(), `🎣 [probe-gate] complete=${verdict.complete} (${verdict.ms}ms${verdict.heuristic ? ', heuristic' : ''}) — ${verdict.reason} | on: "${text.slice(0, 100)}"`);
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

  // Capture the bot's OWN shared screen — i.e. the whiteboard window it's
  // presenting into the call — as opposed to onCaptureScreenshot which grabs the
  // Meet view. Ironically the Meet view can't show the bot its own share, so
  // this captures the source window directly. No-op if nothing is being shared.
  onCaptureSharedScreenshot: async ({ roomId }) => {
    if (!whiteboardWindow || whiteboardWindow.isDestroyed() || whiteboardWindow.webContents.isDestroyed()) {
      return { error: 'Nothing is being shared to capture (the bot is not presenting the whiteboard)' };
    }
    try {
      const image = await whiteboardWindow.webContents.capturePage();
      const buf = image.toPNG();
      const dir = path.join(app.getPath('temp'), 'vibeconf-screenshots');
      await fs.promises.mkdir(dir, { recursive: true });

      const KEEP_PER_ROOM = 10;
      const prefix = 'shared-' + (roomId || 'no-room') + '-';
      try {
        const existing = (await fs.promises.readdir(dir))
          .filter(f => f.startsWith(prefix) && f.endsWith('.png'))
          .sort();
        const toDelete = existing.slice(0, Math.max(0, existing.length - (KEEP_PER_ROOM - 1)));
        await Promise.all(toDelete.map(f => fs.promises.unlink(path.join(dir, f)).catch(() => {})));
      } catch { /* dir just created or unreadable — fine */ }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filePath = path.join(dir, `${prefix}${stamp}.png`);
      await fs.promises.writeFile(filePath, buf);
      console.log('[electron] Shared-screen screenshot saved:', filePath, '(' + buf.length + ' bytes)');
      return { path: filePath };
    } catch (err) {
      console.error('[electron] Shared screenshot capture failed:', err);
      return { error: err.message };
    }
  },

  onReadChat: async () => noteChatResult(await chatRequest(CALL_COMMANDS.readChat, {})),
  onSendChat: async (text) => noteChatResult(await chatRequest(CALL_COMMANDS.sendChat, { text })),
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
      // Appearance changed → the cached camera snapshot is now wrong. Drop it so
      // the panel falls back to the generated look and recaptures on the next call.
      try { store.delete('profileIcon'); store.set('profileIconAt', 0); } catch { /* ignore */ }
    } else if (key === 'emojiSet') {
      pushEmojiSet(value);
      try { store.delete('profileIcon'); store.set('profileIconAt', 0); } catch { /* ignore */ }
    } else if (key === 'studioSound') {
      // Toggle Meet's voice filter live (no rejoin needed) when in-call.
      if (localServer.callStatus === 'in-call' && meetView && !meetView.webContents.isDestroyed()) {
        console.log('[electron] studioSound pref changed →', value, '— applying live');
        sendCallCmd(CALL_COMMANDS.setStudioSound, { enabled: value !== false });
      }
    } else if (key === 'remoteLogging') {
      setRemoteLoggingEnabled(value === true);
      console.log('[electron] Remote logging', value === true ? 'ENABLED' : 'disabled', '(live)');
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
// Push the emoji graphics set (#316) to the virtual camera. 'twemoji' = the
// bundled SVG set; anything else = native OS font.
// #424: raise/clear the generic "something is wrong" avatar state (🥴). Unlike
// `deaf` (captions confirmed OFF — a known cause), this covers degraded states
// we can't fully diagnose: captions ON but no new text for a long stretch, a
// throttled/frozen renderer, etc. Making it VISIBLE beats the bot sitting there
// wearing a happy listening face while it hears nothing. Notifies the agent
// once per episode so it can say something rather than appear to ignore people.
let _impaired = false;
function setImpaired(on, reason = '') {
  on = !!on;
  if (on === _impaired) return;
  _impaired = on;
  if (meetView && !meetView.webContents.isDestroyed()) {
    meetView.webContents.send('extension-message', {
      action: 'set-impaired',
      payload: { impaired: on, reason },
    });
  }
  if (on) {
    console.warn('[electron] 🥴 impaired —', reason);
    try {
      localServer.addError(`You may not be hearing the room right now (${reason}). ` +
        `If people seem to be waiting on you, say so and ask them to repeat.`);
    } catch { /* non-fatal */ }
  } else {
    console.log('[electron] 🥴 impaired cleared — captions flowing again');
  }
}

function pushEmojiSet(value) {
  if (!meetView || meetView.webContents.isDestroyed()) return;
  // Pass the set name through; the renderer validates against its set registry
  // (unknown → native fallback).
  meetView.webContents.send('extension-message', {
    action: 'set-emoji-set',
    payload: { emojiSet: value || 'native' },
  });
}

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
// Bot-view thumbnail column (feat/bot-view-thumbnail-column). The app is a narrow
// column; the Meet view is either a shrunk thumbnail below the panel ('thumbnail')
// or floated into its own large window ('popped'). One button toggles them. See
// electron-app/bot-view-layout.js for the pure geometry/zoom.
let botViewState = 'thumbnail';
let meetPopoutWindow = null; // when 'popped', the meetView lives here instead
let appSettingsWindow = null; // #381: machine-wide App Settings (⌘,), a singleton

// #381: open (or focus) the App Settings window — machine-wide config shared by
// every profile on this Mac. A singleton on purpose: one window no matter how
// many profile windows are open, reinforcing "there's one machine config".
// Since window ↔ profile now correlate (#379), app-level config lives here rather
// than inside any one profile's panel.
// "Check for Updates…" (App menu). Talks to the GitHub releases API rather than
// electron-updater: our releases carry no latest-mac.yml, and every one of them
// is a PRERELEASE, which /releases/latest excludes by design. The version math
// lives in updates.js so it can be tested without a desktop.
//
// We hand the DMG to the user rather than swapping the app out from under them.
// The running instance may be mid-call, and a self-replacing installer is a much
// bigger promise than "there's a newer build, want it?".
let _updateCheckInFlight = false;
async function checkForUpdates({ silentWhenCurrent = true } = {}) {
  if (_updateCheckInFlight) return;
  _updateCheckInFlight = true;
  const { dialog, shell } = require('electron');
  const updates = require('./updates');
  const current = app.getVersion();
  try {
    const releases = await updates.fetchReleases();
    const latest = updates.pickUpdate(releases, current);

    if (!latest) {
      console.log(ts(), `[updates] ${current} is current (${releases.length} releases checked)`);
      if (!silentWhenCurrent) {
        await dialog.showMessageBox(mainWindow, {
          type: 'info',
          message: 'You’re up to date.',
          detail: `Vibeconferencing ${current} is the latest version.`,
          buttons: ['OK'],
        });
      }
      return;
    }

    const asset = updates.pickDmgAsset(latest);
    console.log(ts(), `[updates] ${current} → ${latest.tag_name} available` + (asset ? ` (${asset.name})` : ' (no matching .dmg)'));

    // Without a DMG for this architecture there is nothing to download; send
    // them to the release page instead of failing silently.
    const buttons = asset ? ['Download', 'Release Notes', 'Later'] : ['Release Notes', 'Later'];
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      message: `Vibeconferencing ${latest.tag_name.replace(/^v/, '')} is available.`,
      detail: `You have ${current}.` + (asset
        ? `\n\nDownloading puts the installer in your Downloads folder. Quit the app before installing.`
        : `\n\nNo installer for this Mac (${process.arch}) in that release.`),
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
    });
    const choice = buttons[response];

    if (choice === 'Release Notes') { shell.openExternal(latest.html_url); return; }
    if (choice !== 'Download') return;

    console.log(ts(), `[updates] downloading ${asset.name} (${Math.round((asset.size || 0) / 1048576)}MB)…`);
    let lastLogged = 0;
    const file = await updates.downloadAsset(asset, {
      onProgress: (frac) => {
        const pct = Math.floor(frac * 100);
        if (pct >= lastLogged + 10) { lastLogged = pct; console.log(ts(), `[updates] ${pct}%`); }
      },
    });
    console.log(ts(), `[updates] saved ${file}`);
    shell.showItemInFolder(file);
  } catch (err) {
    console.warn(ts(), '[updates] check failed:', err.message);
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'error',
      message: 'Could not check for updates.',
      detail: `${err.message}\n\nYou can always download the latest build from the Releases page.`,
      buttons: ['Open Releases Page', 'OK'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response === 0) shell.openExternal(`https://github.com/${process.env.VIBECONF_UPDATE_REPO || 'wanderingstan/vibeconferencing'}/releases`);
  } finally {
    _updateCheckInFlight = false;
  }
}

function openAppSettings() {
  if (appSettingsWindow && !appSettingsWindow.isDestroyed()) {
    appSettingsWindow.show();
    appSettingsWindow.focus();
    return;
  }
  appSettingsWindow = new BrowserWindow({
    width: 460,
    height: 560,
    title: 'App Settings',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-app-settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  appSettingsWindow.loadFile(path.join(__dirname, 'renderer', 'app-settings.html'));
  appSettingsWindow.on('closed', () => { appSettingsWindow = null; });
}

// ── P2: Runway photoreal face (opt-in) ──────────────────────────────────────
// Provision a puppet-mode avatar session (scripts/runway-session.mjs) and tell the Meet page to
// connect — runway-avatar.js renders the avatar video into the camera. Guard-preserving (our
// brain+TTS drive it). Reverts to emoji on disconnect / any failure. No-op unless triggered.
function loadRunwayEnv() {
  const need = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'RUNWAY_API_KEY'];
  if (need.every((k) => process.env[k])) return;
  const grab = (p, k) => { try { return (fs.readFileSync(p, 'utf8').match(new RegExp(`^${k}=("?)([^"\\n]+)\\1`, 'm')) || [])[2]; } catch { return undefined; } };
  // De-hardcoded (#297): credential files come from env, not a baked-in personal
  // path. VIBECONF_CREDENTIALS_FILE = a .env holding LIVEKIT_*/RUNWAY/ELEVENLABS
  // keys; VIBECONF_RUNWAY_ENV_FILE = optional separate file for RUNWAY_API_KEY.
  // Unset → skip (emoji bots, and any machine without Runway configured, unaffected).
  const vault = process.env.VIBECONF_CREDENTIALS_FILE;
  const proto = process.env.VIBECONF_RUNWAY_ENV_FILE;
  if (vault) for (const k of ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']) process.env[k] ||= grab(vault, k);
  process.env.RUNWAY_API_KEY ||= (proto && grab(proto, 'RUNWAY_API_KEY')) || (vault && grab(vault, 'RUNWAY_API_KEY'));
}
// P2: per-seat runway session state for auto-renewal. Runway realtime sessions expire after a few
// minutes (observed ~7m) — the avatar worker leaves the room and the face drops to emoji. So we
// re-provision a fresh session on a timer (ahead of expiry), send the bot a new connect, and tear
// down the previous session/room. A failure retries sooner so a transient error can't kill the face.
// P2: per-seat Runway session auto-renewal. Runway realtime_sessions expire after a few minutes
// (~7m observed) → the avatar worker leaves and the face drops to emoji. We re-provision ahead of
// expiry on a timer. Each seat carries a generation counter + `enabled` flag so overlapping
// renewals / a manual `off` / a Meet reload can't leave a stale session driving the face: every
// path re-checks (enabled && gen) after each await and tears down anything it created while stale.
// (New-room renewal = a brief emoji flash on rotate; gapless same-room renewal is a post-call
// enhancement — the avatar video is published by Runway's own lemonslice-avatar-agent identity,
// so overlap behaviour needs verifying before we keep both workers in one room. codex 2026-06-27.)
const _runway = {}; // seat -> { sessionId, roomName, mod, gen, enabled, timer }
const RUNWAY_RENEW_MS = 4 * 60 * 1000; // renew before the ~5-7m expiry

async function setRunwayFace(seat, on) {
  const st = _runway[seat] || (_runway[seat] = { gen: 0, enabled: false, sessionId: null, roomName: null, mod: null, timer: null });
  if (on) {
    st.enabled = true;
    const gen = ++st.gen;                              // this activation/renewal's generation
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    try {
      if (!meetView || meetView.webContents.isDestroyed()) return;
      loadRunwayEnv();
      const { pathToFileURL } = require('url');
      const mod = await import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'runway-session.mjs')).href);
      const prevSession = st.sessionId, prevRoom = st.roomName;
      // Zombie sweep (2026-06-29 wrong-face incident): kick any stale room for THIS seat before
      // minting, so a leftover worker from a crashed run can't coexist with the fresh session.
      // `keep` preserves the active room during renewals (deliberate same-seat overlap).
      try { const n = await mod.sweepStaleRooms(seat, { keep: prevRoom }); if (n) console.log('[runway] swept', n, 'stale room(s) for', seat); } catch (e) {}
      const s = await mod.createAvatarSession(seat);
      // staleness guard: a newer renewal or an `off` landed while we awaited → abort + clean up.
      if (!st.enabled || st.gen !== gen) {
        try { await mod.endAvatarSession({ sessionId: s.sessionId, roomName: s.roomName }); } catch (e) {}
        return;
      }
      meetView.webContents.send('runway-avatar', { type: 'connect', url: s.livekitUrl, token: s.botToken });
      // Log session + avatar ids — the 06-29 post-mortem stalled because neither was on the record.
      console.log('[runway] face', prevSession ? 'RENEWED' : 'ON', 'for', seat, '→ room', s.roomName, 'gen', gen, 'session', s.sessionId, 'avatar', (mod.AVATARS || {})[seat]);
      st.sessionId = s.sessionId; st.roomName = s.roomName; st.mod = mod;
      if (prevSession) { try { await mod.endAvatarSession({ sessionId: prevSession, roomName: prevRoom }); } catch (e) {} }
      if (st.enabled && st.gen === gen) st.timer = setTimeout(() => setRunwayFace(seat, true), RUNWAY_RENEW_MS);
    } catch (e) {
      console.error('[runway] setRunwayFace failed:', e && e.message);
      // transient failure: retry sooner without clobbering the active session record.
      if (st.enabled && st.gen === gen) { if (st.timer) clearTimeout(st.timer); st.timer = setTimeout(() => setRunwayFace(seat, true), 30000); }
    }
  } else {
    st.enabled = false; st.gen++;                       // invalidate any in-flight renewal
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    if (st.sessionId && st.mod) { try { await st.mod.endAvatarSession({ sessionId: st.sessionId, roomName: st.roomName }); } catch (e) {} }
    st.sessionId = null; st.roomName = null;
    if (meetView && !meetView.webContents.isDestroyed()) meetView.webContents.send('runway-avatar', { type: 'disconnect' });
    console.log('[runway] face OFF for', seat);
  }
}
// manual toggle from panel/devtools: ipcRenderer.invoke('runway-face', { seat:'<profile>', on:true })
ipcMain.handle('runway-face', (_e, { seat = String(process.env.VIBECONF_PROFILE || '').toLowerCase(), on = true } = {}) => setRunwayFace(seat, on));

// P2 loss-recovery: the renderer reports an unexpected room drop (network blip, Runway session
// death) → re-establish the face for THIS app's seat. Debounced so a burst of disconnect events
// collapses to one re-establish. Only acts if the face was meant to be on (enabled).
let _runwayReestablishing = false;
function runwayReestablish(why) {
  const seat = String(process.env.VIBECONF_PROFILE || '').toLowerCase();
  // De-hardcoded: no persona allowlist — the `enabled` check below is the real
  // gate (a seat that never had a face on has nothing to recover).
  if (!seat || _runwayReestablishing) return;
  if (!(_runway[seat] && _runway[seat].enabled)) return; // face wasn't on — nothing to recover
  _runwayReestablishing = true;
  console.log('[runway] re-establishing', seat, '(' + why + ')');
  Promise.resolve(setRunwayFace(seat, true)).finally(() => setTimeout(() => { _runwayReestablishing = false; }, 8000));
}
ipcMain.on('runway-avatar-lost', () => runwayReestablish('renderer reported loss'));

// P2: tear down ALL runway faces — clears renewal timers + ends server-side Runway/LiveKit
// sessions so we don't leak "ghost avatars" on leave-call / idle / window-close / quit. (codex.)
async function stopAllRunwayFaces(why) {
  const seats = Object.keys(_runway).filter((s) => _runway[s] && (_runway[s].enabled || _runway[s].sessionId));
  if (!seats.length) return;
  console.log('[runway] stopping all faces (' + why + '):', seats.join(', '));
  for (const seat of seats) { try { await setRunwayFace(seat, false); } catch (e) {} }
}

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

// Reload the shared whiteboard window so it re-fetches content + style. Used
// after a style change (so current content inherits it) and by the explicit
// reload_whiteboard tool. No-op (reported to the caller) if nothing's shared.
function reloadWhiteboardWindow(reason) {
  if (whiteboardWindow && !whiteboardWindow.isDestroyed() && !whiteboardWindow.webContents.isDestroyed()) {
    console.log('[whiteboard] Reloading shared board —', reason);
    whiteboardWindow.webContents.reload();
    return { ok: true };
  }
  return { ok: false, error: 'Nothing is being shared to reload' };
}

function createWhiteboardWindow(roomUrl) {
  // Position off the bottom-right of the screen so macOS doesn't clamp to (0,0)
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = display.workArea;

  // Square share surface (#4): Meet stacks the participant tiles down the RIGHT
  // of a shared screen, so a 16:9 board wasted width behind the tiles and left the
  // content as a tiny centered strip. A square surface fills better next to the
  // tile column. (The board content sizes itself in vw — see `.wb-shared` in
  // style.css — so it fills whatever aspect this is.)
  const win = new BrowserWindow({
    width: 800,
    height: 800,
    x: sw + 100,
    y: sh + 100,
    title: 'Vibeconferencing Whiteboard',
    skipTaskbar: true,
    // Share the bot's identity partition (same as meetView) so this shared-screen
    // surface inherits ALL the bot's credentials — Google, Slack, and cached HTTP
    // Basic-Auth. Without this it landed on Electron's default session, so a site
    // you'd logged into in the Meet webview showed up logged-OUT when shared.
    // #424: never throttle — this window is positioned OFF-SCREEN by design and
    // is captured as the bot's shared screen. Chromium would otherwise throttle
    // its timers/rAF (it is permanently occluded), freezing whiteboard/page
    // animations in what participants see.
    webPreferences: { contextIsolation: true, nodeIntegration: false, partition: SESSION_PARTITION, backgroundThrottling: false },
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

// The one place the vc_session cookie shape is defined — used by the login
// flow and by the #366 shared-login seeding, so an inherited login can never
// silently diverge from a direct one.
function setVcSessionCookie(baseUrl, token) {
  return session.defaultSession.cookies.set({
    url: baseUrl,
    name: 'vc_session',
    value: token,
    path: '/',
    httpOnly: true,
    secure: baseUrl.startsWith('https'),
    sameSite: 'lax',
    // 30-day cookie. If the server has since invalidated the token, checkAuth
    // simply reports unauthenticated — same as an expired login today.
    expirationDate: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
  });
}

// #366: one login for all profiles. The vibeconferencing.com auth is a
// vc_session cookie in this instance's defaultSession (per-profile on disk),
// so sharing it means mirroring through the app-level store on every launch:
//   • logout tombstone first: if THIS profile still holds a token the user
//     explicitly logged out of (vcSessionLoggedOutToken), drop it instead of
//     re-donating it — otherwise any other profile's surviving cookie jar
//     would silently undo the logout on its next launch;
//   • cookie matches the shared token → nothing to do;
//   • cookie differs → VALIDATE it against /api/auth/me before donating, so
//     a stale invalidated cookie from a long-unused profile can't clobber a
//     fresh login another profile just donated. Invalid + shared token
//     available → replace our cookie with the shared one;
//   • no cookie but a shared token exists → seed it into our cookie jar.
// Best-effort: auth still works exactly as before if any step fails.
async function syncSharedLoginCookie() {
  try {
    const baseUrl = getWebsiteUrl();
    const cookies = await session.defaultSession.cookies.get({ url: baseUrl, name: 'vc_session' });
    const local = cookies.length > 0 ? cookies[0].value : null;
    const shared = store.get('vcSessionToken');
    const tombstone = store.get('vcSessionLoggedOutToken');

    if (local && tombstone && local === tombstone) {
      await session.defaultSession.cookies.remove(baseUrl, 'vc_session');
      console.log('[auth] Dropped logged-out vibeconferencing.com token (logout tombstone, #366)');
      if (shared && shared !== tombstone) await setVcSessionCookie(baseUrl, shared);
      return;
    }
    if (local) {
      if (local === shared) return;
      const me = await checkAuth(); // uses our local cookie
      if (me?.authenticated) {
        store.set('vcSessionToken', local); // donate the (verified) login up
      } else if (shared) {
        await session.defaultSession.cookies.remove(baseUrl, 'vc_session');
        await setVcSessionCookie(baseUrl, shared);
        console.log('[auth] Replaced stale local login with the shared one (#366)');
      }
      // Neither valid locally nor shared → leave it; the normal auth UI applies.
    } else if (shared && shared !== tombstone) {
      await setVcSessionCookie(baseUrl, shared);
      console.log('[auth] Seeded vibeconferencing.com login from the shared app config (#366)');
    }
  } catch (err) {
    console.warn('[auth] Shared-login sync failed (non-fatal):', err?.message);
  }
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
        // #366: mirror the login to the shared app-level store so every other
        // profile inherits it (seeded into their session on next launch), and
        // clear any logout tombstone — a fresh login supersedes it.
        try {
          store?.set('vcSessionToken', token);
          store?.delete('vcSessionLoggedOutToken');
        } catch { /* non-fatal */ }
        // Set the cookie in Electron's session for the server URL
        setVcSessionCookie(baseUrl, token).then(() => {
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

// Idle placeholder for the bot's view when NOT in a call — a page we control on
// vibeconferencing.com (a branded landing / announcements page) instead of the
// Google Meet home. Uses getWebsiteUrl() so staging / a local dev site / an env
// override all resolve correctly. Google-login detection does NOT depend on this
// page: signed-in state is read from the cookie jar (isSignedInToGoogle) and the
// bot's remembered identity is cached in store (meetAccountEmail / lastMeetName).
function getIdleUrl() {
  return `${(getWebsiteUrl() || 'https://vibeconferencing.com').replace(/\/+$/, '')}/bot-view`;
}

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

// True iff the partition holds a live Slack session cookie — i.e. some Slack
// workspace is signed in on this profile. Slack's auth token lives in the `d`
// cookie (value starts `xoxd-`) on domain=.slack.com; its presence is the
// ground truth for "logged into Slack". We can't name the workspace/user from
// the cookie alone (that needs the huddle DOM — #283), but we CAN say
// connected-vs-not, which is all the main panel needs.
async function isSignedInToSlack(sess) {
  try {
    const all = await sess.cookies.get({ domain: '.slack.com' });
    return all.some((c) => c.name === 'd' && c.value);
  } catch (err) {
    console.warn('[electron] isSignedInToSlack check failed:', err.message);
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
// The default/fallback local-server port — the default instance listens here, the
// global Claude MCP config points here, and it's the fallback target discovery
// falls back to. Named profiles get stable registry ports instead.
const DEFAULT_PORT = 7865;

// Every bot — including the default — lives under profiles/<name>. There's no
// more special "default lives loose in BASE_USER_DATA" case: BASE now holds only
// the shared app-level config.json and the port registry. The default is simply
// the profile the app opens when launched with no --profile flag; an app-level
// `defaultProfile` pointer names it (falling back to 'Default', Chromium's convention).
//
// Two identities come out of this:
//   • appProfile        — the concrete profile THIS instance is (always a real
//                         name now, e.g. 'default' or 'bot2'); drives userData,
//                         the registry, and the switcher UI.
//   • isDefaultInstance — whether this is the privileged default instance (the
//                         no-flag launch, or an explicit --profile=<default>).
//                         Gates the single-instance lock, the global Claude
//                         integration, and using Claude's global MCP config —
//                         behaviors that must stay unique to one seat.
const explicitProfile = requestedProfileName();
const DEFAULT_PROFILE_NAME = profileManager.resolveDefaultProfileName(
  PROFILES_ROOT, new Store(BASE_USER_DATA, { fresh: true }).get('defaultProfile'));
const appProfile = explicitProfile || DEFAULT_PROFILE_NAME;
const isDefaultInstance = !explicitProfile
  || explicitProfile.toLowerCase() === DEFAULT_PROFILE_NAME.toLowerCase();
{
  const profileUserData = path.join(PROFILES_ROOT, appProfile);
  app.setPath('userData', profileUserData);
  localServer.localProfile = appProfile;
  console.log('[electron] Profile:', appProfile, isDefaultInstance ? '(default)' : '(named)',
    'userData:', profileUserData);
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

// #275: after the bot joins, bring the user's browser tab hosting THIS call to
// the front so they land on it — whether they clicked Join or used /join-call
// from the CLI. Provider-agnostic: derives the URL fragment that identifies the
// call's tab per calling provider (Meet today, Slack huddles today; Zoom/Teams
// slot in the same way). Best-effort: searches the running browsers
// (Chrome/Brave/Safari) for a tab whose URL contains that fragment and raises it;
// a silent no-op if there's no such tab (they may only have the app open, or the
// huddle is in the native Slack app) or AppleScript is unavailable. Off when
// focusCallTabOnJoin is disabled.
function _callTabUrlFragment(callId) {
  if (!callId) return null;
  // Slack huddle room ids are "slack-<team>-<channel>" (team/channel ids have no
  // dashes) → app.slack.com/client/<team>/<channel>.
  if (/^slack-/.test(callId)) {
    const parts = String(callId).split('-'); // ['slack', team, channel]
    if (parts.length >= 3 && /^[A-Za-z0-9]+$/.test(parts[1]) && /^[A-Za-z0-9]+$/.test(parts[2])) {
      return 'app.slack.com/client/' + parts[1] + '/' + parts[2];
    }
    return null;
  }
  // Default: a Google Meet code → meet.google.com/<code>.
  // (Future: zoom.us/j/<id>, teams.microsoft.com/... — add branches here.)
  const code = String(callId).replace(/[^a-zA-Z0-9-]/g, '');
  return code ? 'meet.google.com/' + code : null;
}

function focusBrowserCallTab(callId) {
  try {
    if (store && store.get('focusCallTabOnJoin') === false) return;
    const frag = _callTabUrlFragment(callId);
    if (!frag) return;
    const { execFile } = require('child_process');
    // Chrome/Brave select a tab by index (set active tab index); Safari by object
    // (set current tab). Each browser guarded by a running check so we never
    // launch a closed browser just to look.
    const script = `
set frag to "${frag}"
tell application "System Events"
  set chromeRunning to exists process "Google Chrome"
  set braveRunning to exists process "Brave Browser"
  set safariRunning to exists process "Safari"
end tell
if chromeRunning then
  tell application "Google Chrome"
    repeat with w in windows
      set i to 0
      repeat with t in tabs of w
        set i to i + 1
        if URL of t contains frag then
          set active tab index of w to i
          set index of w to 1
          activate
          return "chrome"
        end if
      end repeat
    end repeat
  end tell
end if
if braveRunning then
  tell application "Brave Browser"
    repeat with w in windows
      set i to 0
      repeat with t in tabs of w
        set i to i + 1
        if URL of t contains frag then
          set active tab index of w to i
          set index of w to 1
          activate
          return "brave"
        end if
      end repeat
    end repeat
  end tell
end if
if safariRunning then
  tell application "Safari"
    repeat with w in windows
      repeat with t in tabs of w
        if URL of t contains frag then
          set current tab of w to t
          set index of w to 1
          activate
          return "safari"
        end if
      end repeat
    end repeat
  end tell
end if
return "none"`;
    execFile('osascript', ['-e', script], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        console.log('[electron] focus-call-tab: AppleScript failed (' + (err.message || '').slice(0, 60) + ') — skipping');
        return;
      }
      const result = (stdout || '').trim();
      if (result && result !== 'none') {
        console.log('[electron] focus-call-tab: brought the call tab to front in ' + result);
      } else {
        console.log('[electron] focus-call-tab: no browser tab found for ' + frag + ' — nothing to focus (fine)');
      }
    });
  } catch (e) {
    console.log('[electron] focus-call-tab: error', e && e.message);
  }
}

// Unmute the mic and send the audio to the renderer's TTS queue. Resolves AFTER
// the play-tts is sent (post the 300ms unmute settle), so callers can chain to
// preserve send order.
function sendPlayTts(base64Audio, emoji, { unmutedAt, expectMore } = {}) {
  return new Promise((resolve) => {
    if (!meetView || meetView.webContents.isDestroyed()) {
      console.error('[electron] Meet view not available for audio playback');
      return resolve();
    }
    // #372: when the caller already unmuted (speakText does it BEFORE
    // synthesis so the 300ms settle overlaps the synth time), only wait out
    // whatever remains of the settle — usually 0ms. Callers that didn't
    // pre-unmute get the original unmute-then-settle behavior.
    let settleMs = 300;
    if (unmutedAt) {
      settleMs = Math.max(0, 300 - (Date.now() - unmutedAt));
    } else {
      sendExtMsg({ action: CALL_COMMANDS.ACTIONS.unmuteMic });
    }
    setTimeout(() => {
      // expectMore (#372 sentence-chunked TTS): tells the renderer another
      // chunk of the SAME utterance is coming, so it must not emit tts-ended
      // (and drop the speaking state) if the queue momentarily drains.
      sendExtMsg({ action: CALL_COMMANDS.ACTIONS.playTts, payload: { audioData: base64Audio, emoji, expectMore: !!expectMore } });
      console.log('[electron] Sent play-tts to Meet view', emoji ? `(emoji: ${emoji})` : '');
      resolve();
    }, settleMs);
  });
}

// #372: sentence-chunked TTS split — pure helper, unit-tested.
const { splitForTts } = require('./tts-chunking.js');

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

// #372: bumped by onStopTts (barge-in). A chunked speakText captures the
// value at start and stops sending further chunks once it changes, so a
// slow chunk-2 synth can't play a stale tail after an interruption.
let ttsStopGeneration = 0;

function speakText(text, voice, emoji) {
  // Sanitize markdown out of the spoken string only (#160).
  const spokenText = stripMarkdownForTts(text);
  enqueueAudio(async () => {
    // Temporarily override voice if specified (works for macOS, ElevenLabs, and
    // Voicebox). Safe under serialization — no concurrent speak can clobber it.
    // Route by identity: a name that matches an installed macOS voice forces the
    // macOS provider; a name that matches a Voicebox profile forces voicebox;
    // anything else is treated as an ElevenLabs voice ID. Restored in finally.
    const originalMacVoice = tts.macosVoice;
    const originalELVoice = tts.voiceId;
    const originalVoiceboxProfileId = tts.voiceboxProfileId;
    const originalVoiceboxEngine = tts.voiceboxEngine;
    const originalProvider = tts.provider;
    if (voice) {
      if (macosVoiceNameSet.has(voice)) {
        tts.updateConfig({ provider: 'macos-say', macosVoice: voice });
      } else if (voiceboxProfileNameSet.has(voice)) {
        const profile = [...voiceboxProfilesById.values()].find((p) => p.name === voice);
        tts.updateConfig({
          provider: 'voicebox',
          voiceboxProfileId: profile.id,
          voiceboxEngine: profile.preset_engine || profile.default_engine || 'kokoro',
        });
      } else {
        tts.updateConfig({ provider: 'elevenlabs', voiceId: voice });
      }
    }
    // #372: start the mic-unmute NOW so its 300ms settle runs concurrently
    // with synthesis instead of after it (the mic is the virtual TTS device —
    // unmuted-with-no-audio is just silence, so opening it early is safe).
    let unmutedAt = null;
    if (meetView && !meetView.webContents.isDestroyed()) {
      sendExtMsg({ action: CALL_COMMANDS.ACTIONS.unmuteMic });
      unmutedAt = Date.now();
    }
    // #372: sentence-chunked synthesis — play the first sentence while the
    // rest synthesizes, so first-audio latency stops scaling with reply
    // length. Chunk 1 carries the emoji + `expectMore` (the renderer holds
    // the speaking state across the seam); the final chunk clears it.
    const parts = splitForTts(spokenText);
    const genAtStart = ttsStopGeneration;
    try {
      for (let i = 0; i < parts.length; i++) {
        // #390/#372: a barge-in bumps ttsStopGeneration. Checked for EVERY
        // chunk (not just 2+): an utterance interrupted before its audio ever
        // started must not play at all.
        if (ttsStopGeneration !== genAtStart) {
          console.log('[electron] TTS chunk ' + (i + 1) + '/' + parts.length + ' dropped — barge-in stopped this utterance (#390)');
          break;
        }
        const expectMore = i < parts.length - 1;
        const chunkEmoji = i === 0 ? emoji : undefined;
        const chunkTag = parts.length > 1 ? ` (chunk ${i + 1}/${parts.length})` : '';
        try {
          const audioBuffer = await tts.synthesize(parts[i]);
          if (!audioBuffer) { console.error('[electron] TTS returned null/empty buffer' + chunkTag); continue; }
          // #390: the barge-in may have arrived DURING the synthesis await —
          // the Kate-era failure was exactly this (18s ElevenLabs synth, human
          // spoke at +9s, bot 'yielded', welcome played anyway at +18s).
          // Re-check before sending; the server-side stash already holds the
          // TEXT for #239 replay, so dropping the audio loses nothing.
          if (ttsStopGeneration !== genAtStart) {
            console.log('[electron] TTS synthesized but dropped — interrupted during synthesis (#390):', parts[i].slice(0, 40));
            break;
          }
          const base64Audio = Buffer.from(audioBuffer).toString('base64');
          console.log('[electron] TTS synthesized:', parts[i].slice(0, 40), '→', base64Audio.length, 'bytes base64' + chunkTag);
          await sendPlayTts(base64Audio, chunkEmoji, { unmutedAt, expectMore });
          // ElevenLabs is back — if we'd previously degraded to the macOS voice,
          // tell the agent its normal voice is restored (rides status.errors →
          // the agent sees it on its next wait_for_speech lull).
          if (ttsVoiceFallbackActive) {
            ttsVoiceFallbackActive = false;
            localServer.addError('Voice restored — ElevenLabs is working again; back to your normal voice.');
          }
        } catch (err) {
          console.error('[electron] TTS error' + chunkTag + ':', err.message);
          broadcastError('TTS: ' + err.message.slice(0, 120));
          // Don't go silent on an ElevenLabs failure (esp. quota_exceeded
          // mid-call): fall back to the macOS `say` voice for THIS chunk so
          // the bot keeps talking (per-chunk so an already-played chunk 1 is
          // never repeated). If the fallback also fails mid-utterance, the
          // renderer's expectMore grace window lapses and emits tts-ended on
          // its own — no stuck speaking state.
          try {
            const fallbackBuffer = await tts.sayFallback(parts[i]);
            if (fallbackBuffer) {
              // #390: same interrupted-during-synthesis re-check as the
              // primary path — the fallback synth also takes real time.
              if (ttsStopGeneration !== genAtStart) {
                console.log('[electron] TTS fallback synthesized but dropped — interrupted during synthesis (#390):', parts[i].slice(0, 40));
                break;
              }
              const base64Audio = Buffer.from(fallbackBuffer).toString('base64');
              console.log('[electron] TTS fell back to macOS say:', parts[i].slice(0, 40), '→', base64Audio.length, 'bytes base64' + chunkTag);
              await sendPlayTts(base64Audio, chunkEmoji, { unmutedAt, expectMore });
              // Tell the agent ONCE that its voice changed, so it knows it now
              // sounds different (and can mention it / not be surprised). Rides
              // the status.errors channel the agent already reads on each lull.
              if (!ttsVoiceFallbackActive) {
                ttsVoiceFallbackActive = true;
                const why = err.code === 'quota_exceeded' ? 'ElevenLabs quota exhausted' : `ElevenLabs unavailable (${(err.message || '').slice(0, 60)})`;
                localServer.addError(`Voice changed: ${why} — now speaking in the macOS fallback voice, which sounds noticeably different. Your words still play; you may briefly acknowledge the voice change if it fits.`);
              }
            }
          } catch (fbErr) {
            console.error('[electron] TTS macOS fallback also failed' + chunkTag + ':', fbErr.message);
          }
        }
      }
    } finally {
      if (voice) {
        tts.updateConfig({ macosVoice: originalMacVoice });
        tts.voiceId = originalELVoice;
        tts.voiceboxProfileId = originalVoiceboxProfileId;
        tts.voiceboxEngine = originalVoiceboxEngine;
        tts.provider = originalProvider;
      }
    }
  });
}

// Installed macOS `say` voice names (populated at startup). Lets the speak()
// voice-override route a name to the right provider — a macOS voice name forces
// the macOS provider even when an ElevenLabs key is set, instead of being
// mis-sent to ElevenLabs as a (nonexistent) voice ID.
let macosVoiceNameSet = new Set();

// In-flight HTTP Basic/Digest auth challenges for the bot webview: id → Electron
// login callback, awaiting the operator's credentials from the panel dialog.
const pendingBasicAuth = new Map();
let basicAuthSeq = 0;

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

// Voicebox (local TTS server, experimental) profile names/ids, mirroring
// macosVoiceNameSet above. Lets speak()'s voice-override route a profile name
// to the voicebox provider. Populated at startup and refreshed on each
// list-voicebox-profiles IPC call; stays empty if Voicebox isn't running.
let voiceboxProfileNameSet = new Set();
let voiceboxProfilesById = new Map();

// Fetch voice profiles from a locally running Voicebox instance's GET /profiles.
// Best-effort: returns [] (never throws) if Voicebox isn't running or the
// fetch fails/times out, matching enumerateMacosVoices()'s soft-fail shape.
async function listVoiceboxProfiles() {
  const url = `${tts.voiceboxUrl || 'http://127.0.0.1:17493'}/profiles`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const profiles = await res.json();
    return Array.isArray(profiles) ? profiles : [];
  } catch {
    return [];
  }
}

// Fetch the account's ElevenLabs voices (GET /v1/voices) for the unified voice
// picker (#340). Best-effort: returns [] (never throws) if no key is available
// or the request fails/times out — matching enumerateMacosVoices()'s soft-fail.
// `category` ('premade' / 'cloned' / 'professional' / 'generated') lets the UI
// surface custom/cloned voices distinctly if it wants.
async function listElevenLabsVoices(apiKey) {
  const key = apiKey || store?.get('ttsApiKey');
  if (!key) return [];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': key },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const data = await res.json();
    const voices = Array.isArray(data?.voices) ? data.voices : [];
    return voices.map((v) => ({ id: v.voice_id, name: v.name || v.voice_id, category: v.category || '' }));
  } catch {
    return [];
  }
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

// #305: make sure this profile has a dedicated, TRUSTED working dir and return
// its path. Creates …/<userData>/agent/, seeds .claude/settings.local.json with
// the bot's tool allowlist (only if absent — never clobber user edits), and marks
// the dir trusted in ~/.claude.json (the same file we already edit for the MCP
// server), so Claude Code honors the allowlist instead of dropping it as an
// untrusted /tmp workspace. Idempotent + best-effort: any failure falls back to
// the returned path, and the launch still proceeds.
function ensureAgentWorkdir() {
  const aw = require('./agent-workdir.js');
  const agentDir = aw.agentDirFor(app.getPath('userData'));
  try {
    fs.mkdirSync(path.join(agentDir, '.claude'), { recursive: true });
    const settingsPath = path.join(agentDir, '.claude', 'settings.local.json');
    if (!fs.existsSync(settingsPath)) {
      fs.writeFileSync(settingsPath, JSON.stringify(aw.defaultBotSettings(), null, 2) + '\n');
      console.log('[electron] Seeded bot allowlist at', settingsPath);
    }
    // Seed the bot's personality CLAUDE.md (#305/#291) — auto-loaded as standing
    // instructions since the session starts in this dir. Only if absent.
    const claudeMdPath = path.join(agentDir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      fs.writeFileSync(claudeMdPath, aw.defaultClaudeMd());
      console.log('[electron] Seeded bot personality CLAUDE.md at', claudeMdPath);
    }
    // Mark the dir trusted in ~/.claude.json (only writing if it isn't already).
    const home = process.env.HOME || process.env.USERPROFILE;
    const claudeJsonPath = path.join(home, '.claude.json');
    let claudeJson = {};
    try { claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8')); } catch { /* fresh */ }
    if (!aw.isProjectTrusted(claudeJson, agentDir)) {
      fs.writeFileSync(claudeJsonPath, JSON.stringify(aw.withTrustedProject(claudeJson, agentDir), null, 2) + '\n');
      console.log('[electron] Marked agent workdir trusted in ~/.claude.json:', agentDir);
    }
  } catch (err) {
    console.warn('[electron] ensureAgentWorkdir failed (continuing):', err.message);
  }
  return agentDir;
}

function launchClaudeTerminal(meetCode) {
  const { execFile } = require('child_process');
  // #305: default to this profile's trusted agent dir instead of the untrusted
  // /tmp. An explicit Settings → "Claude Working Directory" still wins.
  const claudeDir = store.get('claudeWorkDir') || ensureAgentWorkdir();
  // Use the bot's name (getActiveBotName) so the spawned /join-call <code> <name>
  // + MCP env align with the call we're in. (Slack's real account name is read
  // separately — #283; until then this is the Meet/Bot Name.)
  const botName = getActiveBotName() || store.get('botName') || 'Jimmy';

  // Named profile instances (second bot, e.g. Samantha): the auto-launch runs
  // `claude` which would otherwise pick up the USER-SCOPED ~/.claude.json
  // vibeconferencing server (the fallback port = the PRIMARY app) and talk to the
  // wrong bot. Write a profile-specific MCP config pointing at THIS app's port and
  // pass --mcp-config + --strict-mcp-config so the spawned session targets this
  // app only. The default instance keeps using the global config.
  let mcpFlags = '';
  if (!isDefaultInstance) {
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
  // Model for the launched session (Settings → "Claude Model"). Empty now means
  // sonnet rather than "no flag, let the CLI pick" — sonnet is the right default
  // for this workload, and an implicit default that can shift under us is worse
  // than an explicit one. Accepts an alias (sonnet / opus / haiku) or a full model
  // id; sanitized in claude-model.js, since this is interpolated into an
  // AppleScript-wrapped shell command. See tests/claude-model.test.mjs.
  const { claudeModelFlag } = require('./claude-model.js');
  const modelFlag = claudeModelFlag(store.get('claudeModel'));
  const claudeCmd = `claude${dangerousFlag}${modelFlag}${mcpFlags} \\"/join-call ${meetCode} ${botName.replace(/"/g, '')}\\"`;

  // Open a Terminal window running the command. When Terminal isn't already
  // running, `do script` would spawn TWO windows — the auto-created launch
  // window plus the scripted one. Reuse the launch window (window 1) in that
  // case; only spawn a fresh window when Terminal is already up.
  // Set VIBECONF_LOCAL_PORT for the spawned session so the agent-activity hook
  // (a child process of claude) reports this bot's transcript to THIS app's
  // local server — not the default 7865 (correct for profile bots on 7866+).
  // Quote the working dir — the #305 agent dir lives under "Application Support",
  // which has spaces (the old /tmp default didn't, so this never mattered before).
  // See launch-command.js for the AppleScript+shell double-quoting.
  const { buildTerminalCommand } = require('./launch-command.js');
  const cmd = buildTerminalCommand({ workdir: claudeDir, port: localServer.port, innerCmd: claudeCmd });
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
if (isDefaultInstance) {
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

function ensureClaudeIntegration() {
  const home = process.env.HOME || process.env.USERPROFILE;
  const claudeDir = path.join(home, '.claude');
  const claudeJsonPath = path.join(home, '.claude.json');
  const skillDir = path.join(claudeDir, 'skills', 'join-call');
  const skillPath = path.join(skillDir, 'SKILL.md');

  // Determine paths based on whether we're packaged or in dev
  const isPackaged = app.isPackaged;
  const mcpServerRoot = isPackaged
    ? path.join(process.resourcesPath, 'mcp-server')
    : path.join(__dirname, '..', 'mcp-server');
  const mcpServerPath = path.join(mcpServerRoot, 'server.js');
  const appLaunchCmd = isPackaged
    ? 'open -a Vibeconferencing'
    : `cd ${__dirname} && npx electron .`;

  // ~/.claude.json is durable config; only point it at a server that can
  // actually start. Packaged builds get prod deps via beforePack; a fresh
  // source checkout has none until someone installs them in mcp-server/.
  const serverEntryExists = fs.existsSync(mcpServerPath);
  // The server needs BOTH the MCP SDK and zod to boot — check both, not just the SDK.
  const serverDepsPresent = isPackaged || (
    fs.existsSync(path.join(mcpServerRoot, 'node_modules', '@modelcontextprotocol', 'sdk')) &&
    fs.existsSync(path.join(mcpServerRoot, 'node_modules', 'zod')));

  // A linked git worktree (`.git` is a file, not a dir) is a removable
  // checkout — repointing durable config at one strands the entry when the
  // worktree goes away.
  let isTempWorktree = false;
  if (!isPackaged) {
    try { isTempWorktree = fs.statSync(path.join(__dirname, '..', '.git')).isFile(); } catch {}
  }

  let changed = false;

  // --- Ensure global MCP config in ~/.claude.json ---
  // Read defensively: a missing file is fine (we create it), but a present-but-
  // unreadable/malformed file must NOT be rewritten from {} — that would erase
  // every other MCP server the user has. See claude-config.js.
  const { readClaudeConfigSafe, atomicWriteJson } = require('./claude-config.js');
  const { config: claudeJson, readable: configReadable, mtimeMs: claudeMtimeMs } = readClaudeConfigSafe(claudeJsonPath);
  if (!configReadable) {
    console.warn('[electron] ~/.claude.json exists but is unreadable/malformed —',
      'leaving MCP config untouched to avoid clobbering other servers');
  }

  if (!claudeJson.mcpServers) claudeJson.mcpServers = {};

  // Always pin the global config at the stable fallback port, NOT the writing
  // instance's own port — this entry is app-level and must point bare-terminal
  // `claude` at a fixed target regardless of who installs it. (On join_call the
  // MCP server re-binds by profile name anyway; this is just the default target.)
  const localBaseUrl = `http://127.0.0.1:${DEFAULT_PORT}`;
  const configuredBotName = store.get('botName') || 'Jimmy';
  const currentMcp = claudeJson.mcpServers.vibeconferencing;
  const needsUpdate = !currentMcp ||
    currentMcp.env?.VIBECONF_BASE_URL !== localBaseUrl ||
    currentMcp.env?.VIBECONF_BOT_NAME !== configuredBotName ||
    currentMcp.args?.[0] !== mcpServerPath;
  const existingServerOk = !!currentMcp?.args?.[0] && fs.existsSync(currentMcp.args[0]);

  if (!configReadable) {
    /* warned above — never rewrite an unreadable/malformed config from {} */
  } else if (!serverEntryExists) {
    console.warn('[electron] MCP server entrypoint missing at', mcpServerPath,
      '— leaving MCP config untouched');
  } else if (!serverDepsPresent) {
    console.warn('[electron] mcp-server deps not installed (no node_modules/@modelcontextprotocol/sdk).',
      'Run `npm install` (or pnpm) in', mcpServerRoot, '— leaving MCP config untouched');
  } else if (isTempWorktree && existingServerOk && currentMcp.args[0] !== mcpServerPath) {
    console.warn('[electron] running from a git worktree — keeping existing MCP server path',
      currentMcp.args[0], 'instead of repointing durable config at', mcpServerPath);
  } else if (needsUpdate) {
    claudeJson.mcpServers.vibeconferencing = {
      command: 'node',
      args: [mcpServerPath],
      env: {
        VIBECONF_ROOM_ID: '',
        VIBECONF_BOT_NAME: configuredBotName,
        VIBECONF_BASE_URL: localBaseUrl,
      },
    };
    atomicWriteJson(claudeJsonPath, claudeJson, { expectedMtimeMs: claudeMtimeMs });
    console.log('[electron] Updated MCP config → local server at', localBaseUrl, 'botName:', configuredBotName);
    changed = true;
  } else {
    console.log('[electron] MCP config already pointing to local server');
  }

  // --- Ensure global skill in ~/.claude/skills/join-call/ ---
  // Version-tracked: updates when app version changes
  const SKILL_VERSION = '23';  // Bump this when updating the skill content below
  const versionFile = path.join(skillDir, '.version');
  let installedVersion = '';
  try { installedVersion = fs.readFileSync(versionFile, 'utf-8').trim(); } catch {}

  const skillSourcePath = path.join(mcpServerRoot, 'join-call-skill.md');
  if (installedVersion !== SKILL_VERSION && !fs.existsSync(skillSourcePath)) {
    console.warn('[electron] join-call skill source missing at', skillSourcePath, '— skipping skill install');
  } else if (installedVersion !== SKILL_VERSION) {
    fs.mkdirSync(skillDir, { recursive: true });
    const skillContent = fs.readFileSync(skillSourcePath, 'utf-8');
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
  // P2: force plain system DNS (no DoH). Chromium's built-in resolver does Secure DNS by
  // default, which can't resolve LiveKit's dynamic media/TURN hosts (*.host/.turn.livekit.cloud)
  // → -105 in WebRTC → the Runway avatar video never connects. The OS resolver handles them, so
  // route host resolution through it. Harmless for Meet/everything else.
  try { app.configureHostResolver({ secureDnsMode: 'off' }); console.log('[runway] host resolver → secureDnsMode off (plain system DNS)'); } catch (e) { console.warn('[runway] configureHostResolver failed:', e && e.message); }

  // #366 preference scoping: app-level keys (ElevenLabs key, website login,
  // URL overrides, dangerousMode — see config-scope.js) live in the BASE
  // userData config.json shared by all profiles; everything else stays in
  // this profile's own agent dir. The shared store is `fresh` because several
  // profile instances (the fleet, Jimmy+Samantha) read/write that one file
  // concurrently.
  //
  // #305 follow-on: the per-profile config lives in the bot's agent dir
  // (<userData>/agent/config.json), NOT loose in <userData>. That makes the agent
  // dir the single, clean home for everything that defines the bot — config.json
  // (voice, name, avatar, model, ack phrases) alongside CLAUDE.md (#291) and the
  // tool allowlist. App-level keys stay in the shared BASE config.json.
  //
  // Uniform across ALL profiles now (the default included) — the default lives
  // under profiles/<name> like every other bot, so <userData> is never BASE and
  // there is no special-casing here.
  {
    const appLevelStore = new Store(BASE_USER_DATA, { fresh: true });
    // Persist the default-profile pointer so it's an explicit, editable value
    // ("which profile is the default"), not just an implicit fallback.
    if (isDefaultInstance && !appLevelStore.get('defaultProfile')) {
      appLevelStore.set('defaultProfile', DEFAULT_PROFILE_NAME);
    }
    const aw = require('./agent-workdir.js');
    const profileDir = app.getPath('userData');   // = profiles/<appProfile>
    const agentDir = aw.agentDirFor(profileDir);
    const newCfgPath = path.join(agentDir, 'config.json');
    const oldCfgPath = path.join(profileDir, 'config.json');
    let profileConfigDir = agentDir;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      // One-time, non-destructive migration of a legacy loose config.json (older
      // profiles kept config at <profileDir>/config.json) into the agent dir,
      // filtered to just the per-profile keys. The old file is left as a safety
      // net. Promote any un-promoted ttsApiKey up first so filtering can't lose it
      // (profileDir is never BASE, so this Store is always a distinct file).
      if (!fs.existsSync(newCfgPath) && fs.existsSync(oldCfgPath)) {
        migrateAppLevelKeys(appLevelStore, new Store(profileDir));
        const old = JSON.parse(fs.readFileSync(oldCfgPath, 'utf-8'));
        fs.writeFileSync(newCfgPath, JSON.stringify(aw.perProfileSubset(old, APP_LEVEL_KEYS), null, 2) + '\n');
        console.log('[config] Migrated per-profile config into', newCfgPath);
      }
    } catch (err) {
      console.warn('[config] agent-dir config migration failed:', err.message);
      // If there WAS a loose config we failed to bring over, keep reading it so
      // the bot doesn't lose its prefs. A fresh install starts cleanly in the
      // agent dir.
      if (fs.existsSync(oldCfgPath) && !fs.existsSync(newCfgPath)) {
        profileConfigDir = profileDir;
        console.warn('[config] falling back to the loose config location:', profileDir);
      }
    }
    const profileStore = new Store(profileConfigDir);
    migrateAppLevelKeys(appLevelStore, profileStore);
    store = new ScopedStore(appLevelStore, profileStore);
  }

  // #366: inherit (or donate) the shared vibeconferencing.com login before
  // anything checks auth. Awaited — cheap, and the panel's first auth check
  // should see the seeded cookie.
  await syncSharedLoginCookie();

  // #326 — start the overlay-independent agent-activity feed for the avatar
  // head-jostle. Self-guards on meetView, so it's safe to start early.
  startAgentActivityPush();

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
        // Git commit + dirty status — the version string alone is ambiguous when
        // running from source (an un-bumped package.json reads e.g. "beta55" even
        // with newer code). This makes a log unambiguous about exactly what ran.
        git: gitBuildInfo(),
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
  await localServer.start();

  // Remote log shipping (opt-in via `remoteLogging` pref). Build a stable
  // instanceId from hostname + profile so the same bot is recognizable across
  // restarts; meta is read at flush time so the current room is always fresh.
  try {
    const sanitize = (s) => String(s || '').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
    const hostShort = sanitize(require('os').hostname().split('.')[0]);
    const instanceId = `${hostShort}--${sanitize(appProfile || 'default')}`;
    // Default ON (schema default) when the user hasn't set it — only an explicit
    // `false` keeps logs local. `=== true` would ignore the schema default for
    // unset installs, so use `!== false`.
    const remoteLoggingOn = store?.get('remoteLogging') !== false;
    configureRemoteLog({
      enabled: remoteLoggingOn,
      endpointBase: () => getWebsiteUrl(),
      instanceId,
      token: process.env.VIBECONF_LOGS_TOKEN || '',
      // #386: send the vibeconferencing.com login (app-level vcSessionToken, the
      // vc_session JWT mirror) so the backend authorizes log writes by USER — no
      // bundled secret. Read fresh each flush so login/logout takes effect live.
      sessionToken: () => (store && store.get('vcSessionToken')) || '',
      meta: () => ({
        version: app.getVersion(),
        platform: process.platform,
        profile: appProfile || 'default',
        host: hostShort,
        port: localServer.port,
        room: localServer.roomId || null,
        callStatus: localServer.callStatus || null,
      }),
    });
    console.log('[electron] Remote logging', remoteLoggingOn ? 'ENABLED' : 'available (off)', '— instance:', instanceId);
  } catch (err) {
    console.warn('[electron] Failed to configure remote logging:', err.message);
  }

  // Check/install the machine-global Claude integration (~/.claude.json MCP entry,
  // the /join-call skill, the agent-activity hook). This content is app-level, not
  // profile-level — it always points bare-terminal `claude` at the fallback port
  // (DEFAULT_PORT). We run it from the single default instance purely as a
  // single-writer election so N running profiles don't race on the same global
  // files; named instances skip it (and self-pin their own --mcp-config instead).
  if (!isDefaultInstance) {
    console.log('[electron] Skipping global Claude integration for named profile:', appProfile);
  } else if (store.get('claudeIntegrationRemoved') === true) {
    // "Leave no trace": the user explicitly uninstalled the Claude integration
    // (menu → Uninstall Claude Integration). Without this gate the next launch
    // would silently re-write ~/.claude.json / the skill / the hook, undoing
    // the uninstall. Re-enable via menu → Install Claude Integration.
    console.log('[electron] Claude integration NOT installed (user uninstalled it — leave-no-trace flag set)');
  } else {
    ensureClaudeIntegration();
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
  const savedConfig = store.getMultiple(['ttsApiKey', 'ttsVoiceId', 'botName', 'syncBaseUrl', 'macosVoice', 'ttsProvider', 'voiceboxUrl', 'voiceboxProfileId', 'voiceboxEngine']);
  if (savedConfig.ttsApiKey) {
    tts.updateConfig({ apiKey: savedConfig.ttsApiKey });
    stt.updateConfig({ apiKey: savedConfig.ttsApiKey });
  }
  if (savedConfig.ttsVoiceId) tts.updateConfig({ voiceId: savedConfig.ttsVoiceId });
  if (savedConfig.macosVoice) tts.updateConfig({ macosVoice: savedConfig.macosVoice });
  if (savedConfig.voiceboxUrl) tts.updateConfig({ voiceboxUrl: savedConfig.voiceboxUrl });
  if (savedConfig.voiceboxProfileId) tts.updateConfig({ voiceboxProfileId: savedConfig.voiceboxProfileId });
  if (savedConfig.voiceboxEngine) tts.updateConfig({ voiceboxEngine: savedConfig.voiceboxEngine });
  // Explicit provider override (e.g. bot chose a built-in voice as primary).
  if (savedConfig.ttsProvider) tts.updateConfig({ provider: savedConfig.ttsProvider });
  // Prime the macOS voice-name set so speak()'s voice-override can route a name
  // to the right provider from the first utterance (refreshed on each list call).
  enumerateMacosVoices().then((vs) => { macosVoiceNameSet = new Set(vs.map((v) => v.name)); }).catch(() => {});
  // Same idea for Voicebox profile names — lets speak()'s voice override route
  // a profile name to the voicebox provider (best-effort: silently empty if
  // Voicebox isn't running).
  listVoiceboxProfiles().then((ps) => { voiceboxProfileNameSet = new Set(ps.map((p) => p.name)); voiceboxProfilesById = new Map(ps.map((p) => [p.id, p])); }).catch(() => {});

  // P2 real voices: if no ElevenLabs key is stored, load it from a credentials file
  // pointed at by VIBECONF_CREDENTIALS_FILE (de-hardcoded — no baked-in personal
  // path). No-op if the env/key aren't present (emoji bots unaffected).
  if (!savedConfig.ttsApiKey && process.env.VIBECONF_CREDENTIALS_FILE) {
    const _grab = (p, k) => { try { return (fs.readFileSync(p, 'utf8').match(new RegExp(`^${k}=("?)([^"\\n]+)\\1`, 'm')) || [])[2]; } catch { return undefined; } };
    const _elKey = _grab(process.env.VIBECONF_CREDENTIALS_FILE, 'ELEVENLABS_API_KEY');
    if (_elKey) { tts.updateConfig({ apiKey: _elKey }); stt.updateConfig({ apiKey: _elKey }); console.log('[tts] ElevenLabs key loaded from VIBECONF_CREDENTIALS_FILE → real voice'); }
  }
  // Per-seat voice is config-driven — no hardcoded persona→voice map. It comes from
  // the profile's config.json (savedConfig.ttsVoiceId, applied above) or the
  // VIBECONF_TTS_VOICE env override, which wins. De-hardcoded: personas and their
  // voice ids live in each seat's own config, not in shared source.
  if (process.env.VIBECONF_TTS_VOICE) {
    tts.updateConfig({ voiceId: process.env.VIBECONF_TTS_VOICE });
    console.log('[tts] voice → (VIBECONF_TTS_VOICE override)');
  }
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
    // A launch --bot-name is an EPHEMERAL session/display override, not a change
    // to the user's saved botName. Set it as the active call identity (which
    // getEffectiveBotName/get-meet-bot-name read for the Meet display name) but
    // do NOT persist to config.json — otherwise the test fleet's per-run -r<tag>
    // ghost-avoidance suffix (e.g. "Jimmy-rc3b") leaks into the profile's
    // persistent botName and sticks across runs.
    localServer.currentCallBotName = cliArgs['bot-name'];
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

    // Note: Firefox is not supported — it has no AppleScript tab API.
    //
    // PERF (Stan, 2026-07-05 — polls timed out on EVERY tick, so detection
    // silently never fired). Two independent fixes, both needed:
    //   1. NO System Events. The old `tell application "System Events" …
    //      exists process` preamble alone measured 16.8s on a busy machine —
    //      the whole 8s budget gone before touching a browser. The
    //      `application "X" is running` form asks launchd directly (fast) and,
    //      critically, does NOT launch the app the way a bare `tell
    //      application` would.
    //   2. BATCHED tab reads: `URL of tabs of w` is one Apple Event per
    //      window vs two per TAB. ~48 tabs measured 0.25s batched vs 8s+
    //      per-tab.
    // Per-window try blocks skip a misbehaving window without aborting the
    // whole scan; the per-item try skips tabs whose URL is `missing value`
    // (empty Safari tabs).
    const browserScanBlock = (appName) => `
if application "${appName}" is running then
  try
    tell application "${appName}"
      repeat with w in windows
        try
          set tabURLs to URL of tabs of w
          set tabTitles to title of tabs of w
          repeat with i from 1 to count of tabURLs
            try
              set tabURL to (item i of tabURLs) as text
              set tabTitle to ""
              try
                set tabTitle to (item i of tabTitles) as text
              end try
              if tabURL starts with "https://meet.google.com/" then
                set allURLs to allURLs & "MEET:" & tabURL & linefeed
              else if tabURL starts with "https://app.slack.com/client/" then
                set allURLs to allURLs & "SLACK:" & tabURL & "|||" & tabTitle & linefeed
              else if tabURL is "about:blank" then
                set allURLs to allURLs & "BLANK:" & tabTitle & linefeed
              end if
            end try
          end repeat
        end try
      end repeat
    end tell
  end try
end if`;
    const appleScript = `
set allURLs to ""
${browserScanBlock('Google Chrome')}
${browserScanBlock('Safari')}
${browserScanBlock('Brave Browser')}
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
  stopAllRunwayFaces('before-quit'); // P2: best-effort end of Runway sessions on quit (fire-and-forget)
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
      // #424 CRITICAL: the bot is a headless worker — its view must keep
      // running whether or not the window is visible. Chromium's default
      // (backgroundThrottling: true) throttles timers / rAF / rendering when
      // the window is occluded, which FROZE the caption DOM and every tile's
      // mutation counter (mut=0 across all tiles, incl. self) for 85s in the
      // 2026-07-09 call — the bot went silently deaf while showing a happy
      // face, then flushed the whole backlog at once on wake. This is not an
      // optimization we can afford: never throttle the call view.
      backgroundThrottling: false,
    },
  });
  view.webContents.setAudioMuted(true);
  view.webContents.on('dom-ready', () => {
    // Re-assert the state-appropriate zoom. A real document reload (manual refresh
    // / the mid-call reload path) resets setZoomFactor, and dom-ready fires on
    // exactly those — so the thumbnail doesn't snap back to full size on a reload.
    if (view.webContents.isDestroyed()) return;
    if (view === meetView) { applyMeetZoom(); sendBannerVisibility(); }
    else view.webContents.setZoomFactor(botViewLayout.POPPED_ZOOM);
  });
  if (cliArgs && cliArgs['devtools']) {
    view.webContents.openDevTools({ mode: 'detach' });
  }
  return view;
}

// Position panelView (fixed width on the left) and meetView (rest of the
// window). Module-level so both createMainWindow and swap-time relayouts
// share the same logic.
const botViewLayout = require('./bot-view-layout.js');
let placeholderView = null; // shown in the thumbnail region while Meet is popped out

// The "Meet is popped out" placeholder that fills the thumbnail region so the
// column isn't an empty rectangle while the Meet view floats in its own window.
// A tiny self-contained data: page — no file, no assets — painted in the app's
// dark surface so it reads as part of the panel, not a blank gap.
function ensurePlaceholderView() {
  if (placeholderView && !placeholderView.webContents.isDestroyed()) return placeholderView;
  placeholderView = new BrowserView({ webPreferences: { contextIsolation: true } });
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#202124;color:#9aa0a6;
      font-family:'Google Sans',Roboto,Arial,sans-serif;-webkit-user-select:none;cursor:default}
    .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;text-align:center;padding:12px;box-sizing:border-box}
    .icon{font-size:30px;line-height:1}
    .title{font-size:14px;font-weight:600;color:#e8eaed}
    .sub{font-size:12px;color:#9aa0a6}
  </style><div class="wrap">
    <div class="icon">🪟</div>
    <div class="title">Popped out</div>
    <div class="sub">The bot's view is in its own window.<br>Use <b>Dock</b> above to bring it back.</div>
  </div>`;
  placeholderView.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return placeholderView;
}

// Re-assert the Meet zoom for the current state. setZoomFactor is per-webContents
// and survives Meet's SPA routing, but a REAL document reload resets it — so this
// is also called from createMeetView's dom-ready hook, not just on state change.
function applyMeetZoom() {
  if (!meetView || meetView.webContents.isDestroyed()) return;
  const l = botViewLayout.computeLayout(botViewState, { width: PANEL_WIDTH, height: 0 }, { panelWidth: PANEL_WIDTH });
  try { meetView.webContents.setZoomFactor(l.meetZoom); } catch { /* view gone */ }
}

function layoutViews() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [width, height] = mainWindow.getContentSize();

  // The panel-popout (an older, independent feature) removes the panel from the
  // main window. When that's active, fall back to the legacy full-width Meet
  // layout so the two features don't fight; the thumbnail column assumes the
  // panel is docked.
  if (panelPopoutWindow) {
    if (meetView && !meetView.webContents.isDestroyed() && !meetPopoutWindow) {
      meetView.setBounds({ x: 0, y: 0, width, height });
    }
    return;
  }

  const l = botViewLayout.computeLayout(botViewState, { width, height }, { panelWidth: PANEL_WIDTH });
  if (l.panelBounds && panelView && !panelView.webContents.isDestroyed()) {
    panelView.setBounds(l.panelBounds);
  }
  if (l.meetBounds && meetView && !meetView.webContents.isDestroyed()) {
    meetView.setBounds(l.meetBounds);
    // The zoom is stateful (per-webContents), so set it here too — a resize while
    // in 'thumbnail' keeps the same 380px column, so the zoom is stable, but this
    // keeps it correct if PANEL_WIDTH ever changes.
    applyMeetZoom();
  }

  // Placeholder occupies the thumbnail region while Meet is popped out; removed
  // (and left detached, but kept for reuse) when Meet is docked back.
  if (l.placeholderBounds) {
    const pv = ensurePlaceholderView();
    if (mainWindow.getBrowserViews && !mainWindow.getBrowserViews().includes(pv)) {
      mainWindow.addBrowserView(pv);
    }
    pv.setBounds(l.placeholderBounds);
  } else if (placeholderView && !placeholderView.webContents.isDestroyed()) {
    try { mainWindow.removeBrowserView(placeholderView); } catch { /* not attached */ }
  }
}

// Toggle the Meet view between the docked thumbnail and its own large window.
// Mirrors setPanelPoppedOut: the SAME meetView BrowserView is reparented, so its
// webContents — the live call, caption scraper, virtual camera — survives the move
// untouched.
function setBotViewState(state) {
  if (!botViewLayout.STATES.includes(state)) state = 'thumbnail';
  botViewState = state;

  if (state === 'popped' && !meetPopoutWindow) {
    if (meetView && !meetView.webContents.isDestroyed() && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.removeBrowserView(meetView);
    }
    const win = new BrowserWindow({
      width: 900, height: 620,
      title: "Vibeconferencing — Bot's view",
      icon: path.join(__dirname, 'icon.png'),
      parent: mainWindow || undefined,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    meetPopoutWindow = win;
    if (meetView && !meetView.webContents.isDestroyed()) win.addBrowserView(meetView);
    const fit = () => {
      if (win.isDestroyed() || !meetView || meetView.webContents.isDestroyed()) return;
      const [w, h] = win.getContentSize();
      meetView.setBounds({ x: 0, y: 0, width: w, height: h });
      try { meetView.webContents.setZoomFactor(botViewLayout.POPPED_ZOOM); } catch { /* gone */ }
    };
    fit();
    win.on('resize', fit);
    // Survive teardown: detach the view before the window dies so the call lives,
    // then re-dock. Covers both the toggle and the user closing the window.
    win.on('close', () => { try { win.removeBrowserView(meetView); } catch { /* gone */ } });
    win.on('closed', () => {
      meetPopoutWindow = null;
      botViewState = 'thumbnail';
      if (meetView && !meetView.webContents.isDestroyed() && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.addBrowserView(meetView);
      }
      applyMeetZoom();
      layoutViews(); // removes the placeholder + re-docks the thumbnail
      broadcastBotViewState();
    });
    layoutViews(); // panel reclaims the top region; the placeholder fills the rest
    broadcastBotViewState();
    return true;
  }

  if (state === 'thumbnail' && meetPopoutWindow) {
    // Dock back by closing the window; the closed handler re-attaches + relayouts.
    meetPopoutWindow.close();
    return true;
  }

  // No reparent needed (already in the target arrangement) — just re-zoom/relayout.
  applyMeetZoom();
  layoutViews();
  broadcastBotViewState();
  return true;
}

function broadcastBotViewState() {
  if (panelView && !panelView.webContents.isDestroyed()) {
    panelView.webContents.send('bot-view-changed', { state: botViewState });
  }
  sendBannerVisibility();
}

// The injected banner stays (it shows status + errors), but its "🤖 Bot's view —"
// prefix is shown only when the view is POPPED; in the thumbnail column the panel
// bar already labels it, so the prefix is redundant there. Also called from
// createMeetView's dom-ready so a page reload re-applies it without a flash.
function sendBannerVisibility() {
  if (!meetView || meetView.webContents.isDestroyed()) return;
  try {
    meetView.webContents.send('extension-message', {
      action: 'set-banner-prefix-visible',
      payload: { visible: botViewState === 'popped' },
    });
  } catch { /* view gone */ }
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
    // The app launches as a NARROW COLUMN (panel on top, shrunk Meet thumbnail
    // below) so it never looks like the user's own Meet window — Seth and new
    // users kept confusing the two. The Meet view is a scaled-down thumbnail (see
    // bot-view-layout.js); a button pops it out to its own large window. Explicit
    // CLI sizes (the multi-bot test launcher tiles with --window-w/-h) still win.
    width: Number.isFinite(winW) ? winW : PANEL_WIDTH,
    height: Number.isFinite(winH) ? winH : 820,
    ...(Number.isFinite(winX) ? { x: winX } : {}),
    ...(Number.isFinite(winY) ? { y: winY } : {}),
    minWidth: PANEL_WIDTH,
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
        {
          label: 'Check for Updates…',
          click: () => checkForUpdates({ silentWhenCurrent: false }),
        },
        { type: 'separator' },
        {
          // #381: ⌘, opens machine-wide Settings (macOS-native Preferences→Settings
          // convention). Per-profile settings are their own item below + the
          // panel's gear button.
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => openAppSettings(),
        },
        {
          label: 'Bot Settings…',
          accelerator: 'CmdOrCtrl+Shift+,',
          click: () => {
            if (panelView && !panelView.webContents.isDestroyed()) {
              panelView.webContents.send('show-settings');
            }
          },
        },
        { type: 'separator' },
        {
          // "Leave no trace" (F&F): remove EVERYTHING the app wrote into the
          // user's Claude Code setup, and remember the choice so the next
          // launch doesn't silently re-install it.
          label: 'Uninstall Claude Integration...',
          click: () => {
            const { dialog } = require('electron');
            dialog.showMessageBox(mainWindow, {
              type: 'question',
              buttons: ['Cancel', 'Uninstall'],
              defaultId: 0,
              title: 'Uninstall Claude Integration',
              message: 'Remove everything Vibeconferencing added to Claude Code?',
              detail:
                'Removes all of it — leave no trace:\n' +
                '• the vibeconferencing MCP server from ~/.claude.json\n' +
                '• the join-call skill from ~/.claude/skills/\n' +
                '• the agent-activity hook from ~/.claude/settings.json (and its script)\n\n' +
                'It will NOT be reinstalled on the next launch. The app itself keeps working; ' +
                'use "Install Claude Integration" to bring it back.',
            }).then(({ response }) => {
              if (response === 1) {
                uninstallClaudeIntegration();
                try { store?.set('claudeIntegrationRemoved', true); } catch { /* non-fatal */ }
                dialog.showMessageBox(mainWindow, {
                  type: 'info',
                  message: 'Claude integration removed — no trace left. Restart Claude Code to apply.',
                });
              }
            });
          },
        },
        {
          label: 'Install Claude Integration',
          click: () => {
            const { dialog } = require('electron');
            try { store?.delete('claudeIntegrationRemoved'); } catch { /* non-fatal */ }
            ensureClaudeIntegration();
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              message: 'Claude integration installed. Restart Claude Code to pick it up.',
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
      label: 'File',
      submenu: [
        {
          // #379: create a brand-new profile and open it in its own window. The
          // name prompt happens in the panel (inline dialog); a never-seen name
          // creates the profile. Distinct from "New Window", which opens the
          // Default profile without creating anything.
          label: 'New Bot…',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            if (panelView && !panelView.webContents.isDestroyed()) {
              panelView.webContents.send('new-profile-prompt');
            }
          },
        },
        {
          // Open another app window on the Default profile — a fresh window with no
          // profile picker/prompt. Additive multi-profile path: lives here (out of
          // the panel) so it stays available even in-call — where the in-panel
          // switcher is hidden — because opening a SEPARATE window never touches
          // the current call.
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            if (panelView && !panelView.webContents.isDestroyed()) {
              panelView.webContents.send('new-window');
            }
          },
        },
        { type: 'separator' },
        {
          // Advanced (#282 follow-up): drive the bot's own webview to any URL to
          // set up Slack/Google account state inside its partition. Pre-fills the
          // prompt with the view's CURRENT URL so you can see where it landed
          // (redirects/blank pages) and edit from there.
          label: 'Navigate Webview…',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => {
            if (panelView && !panelView.webContents.isDestroyed()) {
              let currentUrl = '';
              try { if (meetView && !meetView.webContents.isDestroyed()) currentUrl = meetView.webContents.getURL(); } catch { /* ignore */ }
              // Focus the panel view first — otherwise the prompt input's .focus()
              // in the renderer doesn't grab the keyboard (the panel BrowserView
              // isn't the focused frame), so you'd have to click it before typing.
              try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus(); } catch { /* ignore */ }
              try { panelView.webContents.focus(); } catch { /* ignore */ }
              panelView.webContents.send('navigate-webview-prompt', { currentUrl });
            }
          },
        },
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
  if (!slackMode) meetView.webContents.loadURL(getIdleUrl());

  mainWindow.on('closed', () => {
    mainWindow = null;
    panelView = null;
    meetView = null;
    sync.stopPolling();
  });
}

function showIdle() {
  if (!meetView || meetView.webContents.isDestroyed()) return;
  meetView.webContents.loadURL(getIdleUrl());
  sync.stopPolling();
  // Close whiteboard window if open
  if (whiteboardWindow && !whiteboardWindow.isDestroyed()) {
    whiteboardWindow.close();
  }
  setImpaired(false); // #424: don't carry a 🥴 into the next call
  console.log('[electron] Returned to idle state');
}

async function loadMeetURL(meetUrl) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  chatSpaceWarned = false; // fresh call — allow one Chat-space warning again

  // Record what we're pointing at so the panel's URL field reflects it (covers
  // --meet-url CLI launches and any programmatic join), and notify the panel now.
  try {
    localServer.setCurrentUrl(meetUrl);
    if (panelView && !panelView.webContents.isDestroyed()) {
      const meetCode = (meetUrl.match(/meet\.google\.com\/([a-z]+-[a-z]+-[a-z]+)/) || [])[1] || '';
      panelView.webContents.send('meet-detected', { url: meetUrl, meetCode });
    }
  } catch { /* non-fatal */ }

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
        body.startsWith('[runway-avatar]') ||
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
      // P2 reload-recovery: a Meet page reload (e.g. the pre-join limbo re-join) silently destroys
      // the renderer's LiveKit connection without a Disconnected event. If the face was on, the
      // freshly-loaded runway-avatar.js has nothing — re-establish once it's had a moment to load.
      if (_runway[String(process.env.VIBECONF_PROFILE || '').toLowerCase()]?.enabled) {
        setTimeout(() => runwayReestablish('meet page (re)load'), 4000);
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
      // Push the emoji set across Meet reloads (#316) — the stored value, or the
      // schema default (fluent3d) when the user hasn't chosen one.
      const emojiSetDefault = require('./preferences-schema').PREFERENCES.emojiSet?.default;
      const effEmojiSet = store?.get('emojiSet') ?? emojiSetDefault;
      if (effEmojiSet && effEmojiSet !== 'native') pushEmojiSet(effEmojiSet);
      // Restore debug overlay state across Meet reloads (per-category #overlay).
      if (overlayAnyOn()) {
        meetView.webContents.send('extension-message', {
          action: 'set-debug-overlay',
          payload: { enabled: true, flags: overlayPayloadFlags() },
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

// #326 — always-on agent-activity push (independent of the debug overlay).
// Feeds the avatar "head jostle" proof-of-life: whenever the driving Claude
// session emits a new activity line (tailed continuously into
// localServer.agentLog), tell the renderer so it can nudge the head. On-change
// only, so it's cheap — no per-tick traffic while the agent is idle.
let agentActivityPushTimer = null;
let _lastAgentActivityLine = null;
function startAgentActivityPush() {
  if (agentActivityPushTimer) return;
  agentActivityPushTimer = setInterval(() => {
    try {
      if (!meetView || meetView.webContents.isDestroyed()) return;
      const log = (localServer && localServer.agentLog) || [];
      const latest = log.length ? log[log.length - 1] : '';
      if (!latest || latest === _lastAgentActivityLine) return;
      _lastAgentActivityLine = latest;
      meetView.webContents.send('extension-message', {
        action: 'agent-activity',
        payload: { latest, len: log.length },
      });
    } catch { /* renderer not ready / view gone */ }
  }, 500);
}

// Debug overlay is split into independent categories (#overlay). Each is a
// human-only store key (NOT in the agent-facing schema — same prompt-injection
// guard as the old single toggle). Health defaults ON for early testing; the
// noisier sections default OFF. The on-camera overlay draws iff any is on.
const OVERLAY_DEFAULTS = {
  overlayHealth: true,        // CALL + LOOP + response-time
  overlayCaptions: false,     // what the bot is hearing (heard/proc)
  overlayAgentLog: false,     // driving Claude session's activity tail ("log output")
  overlayExperiments: false,  // EXP flags + banked probes
};
function overlayFlags() {
  const f = {};
  for (const k of Object.keys(OVERLAY_DEFAULTS)) {
    const v = store?.get(k);
    f[k] = v === undefined ? OVERLAY_DEFAULTS[k] : !!v;
  }
  return f;
}
function overlayAnyOn() { return Object.values(overlayFlags()).some(Boolean); }
// Short-keyed flags for the page-inject renderer.
function overlayPayloadFlags() {
  const f = overlayFlags();
  return { health: f.overlayHealth, captions: f.overlayCaptions, agentLog: f.overlayAgentLog, experiments: f.overlayExperiments };
}

// ---------------------------------------------------------------------------
// IPC routing — replaces chrome.runtime.onMessage
// ---------------------------------------------------------------------------

function setupIPC() {
  // --- Config ---
  // #381: open the machine-wide App Settings window (used by the panel's
  // "voice is off" onboarding banner, and available via ⌘,).
  ipcMain.handle('open-app-settings', () => { openAppSettings(); return { ok: true }; });

  // #381: the app-level (scope:'app') schema prefs, for App Settings' schema-driven
  // section. Only prefs in BOTH the user-facing schema AND config-scope's app-level
  // set — so future app-level prefs appear automatically, and internal keys
  // (session tokens etc., not in the schema) are naturally excluded.
  ipcMain.handle('get-app-settings-schema', () => {
    const P = require('./preferences-schema').PREFERENCES;
    const { isAppLevel } = require('./config-scope.js');
    return Object.entries(P)
      .filter(([k, def]) => isAppLevel(k) && def && typeof def === 'object' && 'type' in def)
      .map(([k, def]) => ({
        key: k,
        type: def.type,
        enum: def.enum || null,
        default: def.default,
        description: def.description || '',
        requiresRestart: !!def.requiresRestart,
      }));
  });

  ipcMain.handle('get-config', (_event, keys) => {
    const vals = store.getMultiple(keys);
    // Fill unset schema prefs with their default so the panel shows the EFFECTIVE
    // config (e.g. emojiSet defaults to fluent3d even before the user picks it).
    const P = require('./preferences-schema').PREFERENCES;
    for (const k of (keys || [])) {
      if (vals[k] === undefined && P[k] && P[k].default !== undefined) vals[k] = P[k].default;
    }
    return vals;
  });

  // Profile icon from the real camera feed. The panel used to reconstruct the icon
  // from background+emoji, which drifts from the actual avatar (different emoji
  // sets, and Runway faces). Instead: while in a call, pull a small snapshot of the
  // live virtual-camera canvas (page-inject's __vibeconfCaptureAvatarIcon, which
  // only returns a RESTING face) and cache it as `profileIcon`. Staleness-gated —
  // refresh at most every few hours; the per-minute check no-ops until the cached
  // icon is old AND the bot is caught in a resting frame. Best-effort; the panel
  // falls back to the generated look when `profileIcon` is unset.
  const PROFILE_ICON_MAX_AGE_MS = 4 * 60 * 60 * 1000; // ~4h
  function profileIconIsFresh() {
    const at = Number(store.get('profileIconAt')) || 0;
    return !!store.get('profileIcon') && (Date.now() - at) < PROFILE_ICON_MAX_AGE_MS;
  }
  async function maybeCaptureProfileIcon() {
    try {
      if (!meetView || meetView.webContents.isDestroyed()) return false;
      if (profileIconIsFresh()) return false;
      const dataUrl = await meetView.webContents
        .executeJavaScript('window.__vibeconfCaptureAvatarIcon ? window.__vibeconfCaptureAvatarIcon(128) : null')
        .catch(() => null);
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image')) {
        store.set('profileIcon', dataUrl);
        store.set('profileIconAt', Date.now());
        console.log('[profile-icon] captured a fresh avatar snapshot from the camera feed');
        return true;
      }
    } catch { /* best-effort — never disrupt the call */ }
    return false;
  }

  // __vibeconfCaptureAvatarIcon only returns a frame when the camera is showing
  // the resting 🙂 face. Measured across a 45-minute call, that face is on screen
  // ~19% of the time — so the old fixed 60s poll was a one-in-five lottery, and it
  // had won 5 times across 36 logged sessions. Capture on the EDGE instead: the
  // renderer pings us the moment it settles onto 🙂.
  ipcMain.on(CALL_EVENTS.avatarResting, () => {
    if (profileIconIsFresh()) return; // nothing wanted — don't touch the renderer
    maybeCaptureProfileIcon();
  });

  // Backstop for the edge we can miss: if the avatar was ALREADY 🙂 when the call
  // started, no transition ever fires. Poll hard while there's no icon, then idle
  // once one is cached — a fresh icon needs no work at all until it ages out.
  const ICON_POLL_WANTED_MS = 5 * 1000;
  const ICON_POLL_IDLE_MS = 5 * 60 * 1000;
  let _iconPollTimer = null;
  function scheduleProfileIconPoll() {
    clearTimeout(_iconPollTimer);
    const delay = profileIconIsFresh() ? ICON_POLL_IDLE_MS : ICON_POLL_WANTED_MS;
    _iconPollTimer = setTimeout(async () => {
      await maybeCaptureProfileIcon();
      scheduleProfileIconPoll();
    }, delay);
    if (_iconPollTimer.unref) _iconPollTimer.unref();
  }
  scheduleProfileIconPoll();

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
    // Live-apply the visual prefs the panel can set here (the agent path goes
    // through applyPref, which already pushes these). #316.
    if (key === 'emojiSet') pushEmojiSet(value);
    // Appearance change from the panel → invalidate the cached camera-snapshot icon
    // so it regenerates (matches the applyPref/agent path above).
    if (key === 'emojiSet' || key === 'avatarBackgroundSvg') {
      try { store.delete('profileIcon'); store.set('profileIconAt', 0); } catch { /* ignore */ }
    }
  });

  ipcMain.handle('get-app-version', () => ({ version: app.getVersion(), packaged: app.isPackaged }));

  // null for the default instance (the panel shows "Default bot."); the concrete
  // name only for named --profile instances.
  ipcMain.handle('get-app-profile', () => (isDefaultInstance ? null : appProfile));
  ipcMain.handle('get-local-port', () => localServer.port);

  // Reveal the profiles folder in Finder so the user can delete/rename profile
  // dirs directly (#282 debugging help).
  ipcMain.handle('open-profiles-folder', async () => {
    try { fs.mkdirSync(PROFILES_ROOT, { recursive: true }); } catch { /* exists */ }
    const err = await shell.openPath(PROFILES_ROOT);
    if (err) console.warn('[electron] open-profiles-folder failed:', err);
    return { ok: !err, path: PROFILES_ROOT, error: err || undefined };
  });

  // #305: the bot's EFFECTIVE working dir — the Settings override if set, else the
  // auto-managed trusted per-profile agent dir. Path only (no side effects), for
  // the panel to display.
  ipcMain.handle('get-agent-workdir', () => {
    const override = (store.get('claudeWorkDir') || '').trim();
    const auto = require('./agent-workdir.js').agentDirFor(app.getPath('userData'));
    return { path: override || auto, isOverride: !!override, autoPath: auto };
  });

  // Reveal the bot's working dir in Finder. If it's the auto dir, ensure it exists
  // (creates + seeds + trusts) so the folder opens rather than 404s.
  ipcMain.handle('open-agent-workdir', async () => {
    const override = (store.get('claudeWorkDir') || '').trim();
    const dir = override || ensureAgentWorkdir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists / override path */ }
    const err = await shell.openPath(dir);
    if (err) console.warn('[electron] open-agent-workdir failed:', err);
    return { ok: !err, path: dir, error: err || undefined };
  });

  // #305/#291: the bot's personality CLAUDE.md, editable from Settings. Reads the
  // CLAUDE.md in the EFFECTIVE working dir (override or auto agent dir). If none
  // exists yet, returns the default starter template so the editor is pre-filled
  // with something the user can save. `exists` distinguishes on-disk vs starter.
  ipcMain.handle('get-agent-claudemd', () => {
    const aw = require('./agent-workdir.js');
    const override = (store.get('claudeWorkDir') || '').trim();
    const dir = override || aw.agentDirFor(app.getPath('userData'));
    const file = path.join(dir, 'CLAUDE.md');
    try {
      return { path: file, content: fs.readFileSync(file, 'utf-8'), exists: true };
    } catch {
      return { path: file, content: aw.defaultClaudeMd(), exists: false };
    }
  });

  // Save the bot's personality CLAUDE.md. Ensures the dir exists first (the auto
  // dir is created/trusted via ensureAgentWorkdir; an override path is just
  // mkdir'd). Writing an empty string is allowed — it clears the personality.
  ipcMain.handle('save-agent-claudemd', (_e, content) => {
    const override = (store.get('claudeWorkDir') || '').trim();
    const dir = override || ensureAgentWorkdir();
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'CLAUDE.md');
      fs.writeFileSync(file, String(content == null ? '' : content));
      return { ok: true, path: file };
    } catch (err) {
      console.warn('[electron] save-agent-claudemd failed:', err.message);
      return { ok: false, error: err.message };
    }
  });

  // Reveal this instance's session-log folder in Finder — where past calls'
  // logs live (named by session timestamp; each call is a `[call] id=…` block
  // inside). Honors the per-profile userData path (#292).
  ipcMain.handle('open-logs-folder', async () => {
    const logsDir = path.join(app.getPath('userData'), 'logs');
    try { fs.mkdirSync(logsDir, { recursive: true }); } catch { /* exists */ }
    const err = await shell.openPath(logsDir);
    if (err) console.warn('[electron] open-logs-folder failed:', err);
    return { ok: !err, path: logsDir, error: err || undefined };
  });

  // --- Profile switcher (#282): Chrome-style list + launch/focus ------------
  // A profile = a userData dir under <base>/profiles, each its own identity —
  // including the default, which lives at profiles/<DEFAULT_PROFILE_NAME> like
  // every other bot. You can't rehome a RUNNING instance (userData is fixed
  // before app-ready), so "switch" launches or focuses the instance for that
  // profile. The default is just the profile matched by the pointer.
  const isDefaultName = (n) => String(n || '').toLowerCase() === DEFAULT_PROFILE_NAME.toLowerCase();

  // Ping ports where instances may live and read each one's localProfile from
  // /api/sync/no-room, so we detect running profiles regardless of how they
  // were launched (switcher, fleet, or default). Returns { profileName: port }.
  async function scanRunningInstances() {
    const ports = [DEFAULT_PORT]; // default instance
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
        // Every instance now reports a concrete localProfile (the default reports
        // its resolved name). Fall back to the default name only for an old build
        // on the fallback port that reports nothing.
        const name = j?.status?.localProfile || (port === DEFAULT_PORT ? DEFAULT_PROFILE_NAME : null);
        if (name) running[name] = port;
      } catch { /* not listening */ }
    }));
    return running;
  }

  ipcMain.handle('list-profiles', async () => {
    const named = profileManager.listProfiles(PROFILES_ROOT);
    const reg = profileManager.loadPortRegistry(BASE_USER_DATA);
    const running = await scanRunningInstances();
    // The default is a real profile dir under profiles/ now, so it comes straight
    // out of listProfiles — no synthesized entry. Guarantee it always appears even
    // on a machine where the default was never launched (so the switcher can still
    // offer it).
    if (!named.some((p) => isDefaultName(p.name))) {
      named.unshift({ name: DEFAULT_PROFILE_NAME, ...profileManager.readConfigFields(path.join(PROFILES_ROOT, DEFAULT_PROFILE_NAME)) });
    }
    return {
      current: appProfile,
      profiles: named.map((p) => {
        const def = isDefaultName(p.name);
        return {
          ...p,
          isDefault: def,
          port: running[p.name] || (def ? DEFAULT_PORT : reg[p.name]) || null,
          running: !!running[p.name],
          isCurrent: p.name === appProfile,
        };
      }),
    };
  });

  // Launch (or focus, if already running) the instance for a profile. Creating
  // a new profile is just launching a never-seen name — the dir is created by
  // that instance at startup.
  // Launch the target profile's instance, or focus it if already running. Does
  // NOT touch the current window — callers decide: switch-profile closes the
  // current window afterward (switch in place, #379); open-profile-window leaves
  // it open (the additive "new window" path). Returns `runningKey` so a switch
  // caller can poll for the target coming up before it closes itself.
  async function launchOrFocusProfile(name) {
    const isDefault = isDefaultName(name);
    if (!profileManager.isValidProfileName(name)) {
      return { ok: false, error: 'Invalid profile name (letters, numbers, . _ - only)' };
    }
    const runningKey = name;

    // Already the current window?
    if (name === appProfile) {
      return { ok: true, focused: true, alreadyCurrent: true, runningKey };
    }

    // Already running? Focus it instead of spawning a duplicate.
    const running = await scanRunningInstances();
    if (running[runningKey]) {
      const port = running[runningKey];
      try {
        await fetch(`http://127.0.0.1:${port}/api/focus`, { method: 'POST' });
        return { ok: true, focused: true, port, runningKey };
      } catch (err) {
        return { ok: false, error: `Profile running on ${port} but focus failed: ${err.message}` };
      }
    }

    // Otherwise launch a fresh instance. The default takes no --profile (and the
    // default port); a named profile gets its stable registry port.
    let port = null;
    let args = [];
    if (!isDefault) {
      try { port = profileManager.portForProfile(BASE_USER_DATA, name); }
      catch (err) { return { ok: false, error: err.message }; }
      args = [`--profile=${name}`, `--local-port=${port}`];
    }

    // #379: open the new profile window where THIS one is, not centered. The main
    // window already honors --window-x/y/w/h (createMainWindow, used by the test
    // launcher), so just forward the current window's bounds. Default + named.
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const b = mainWindow.getBounds();
        args = [...args, `--window-x=${b.x}`, `--window-y=${b.y}`, `--window-w=${b.width}`, `--window-h=${b.height}`];
      }
    } catch { /* ignore — fall back to Electron's default centering */ }

    const { execFile } = require('child_process');
    try {
      if (app.isPackaged) {
        // Resolve the .app bundle from the exe path and open a new instance.
        const exe = app.getPath('exe'); // …/Vibeconferencing.app/Contents/MacOS/Vibeconferencing
        const appBundle = exe.replace(/\/Contents\/MacOS\/[^/]+$/, '');
        const openArgs = args.length ? ['-n', appBundle, '--args', ...args] : ['-n', appBundle];
        execFile('open', openArgs, (err) => {
          if (err) console.error('[electron] profile launch failed:', err.message);
        });
      } else {
        // Dev: relaunch this Electron binary with the same app dir + profile args.
        execFile(process.execPath, [app.getAppPath(), ...args], { detached: true, stdio: 'ignore' })
          .on('error', (err) => console.error('[electron] profile dev launch failed:', err.message));
      }
      console.log('[electron] Launching profile', isDefault ? '(default)' : name, port ? 'on port ' + port : '', app.isPackaged ? '(packaged)' : '(dev)');
      return { ok: true, launched: true, port, runningKey };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // #379: SWITCH IN PLACE. Launch/focus the target, then close THIS window so we
  // end on a single window. (The pre-#379 behavior left both windows open, which
  // accumulated windows and made a terminal join_call ambiguous — "which
  // instance?".) Only ever invoked from the idle state — the in-panel switcher is
  // hidden in-call — so there is no live call to tear down here.
  ipcMain.handle('switch-profile', async (_event, name) => {
    const r = await launchOrFocusProfile(name);
    if (!r.ok || r.alreadyCurrent) return r;

    // If we just launched, wait for the new instance to actually bind before
    // closing ours — a failed/slow launch must never leave zero windows. (Focus
    // case: the target is already up, skip the wait.)
    if (r.launched) {
      const deadline = Date.now() + 8000;
      let up = false;
      while (Date.now() < deadline) {
        const running = await scanRunningInstances();
        if (running[r.runningKey]) { up = true; break; }
        await new Promise((res) => setTimeout(res, 250));
      }
      if (!up) return { ok: false, error: 'New profile window did not come up in time — staying here.' };
    }
    // Target is up. Each profile is its own process, so closing this instance IS
    // the switch. Quit shortly after the IPC resolves so the renderer settles.
    setTimeout(() => app.quit(), 200);
    return { ok: true, switched: true, port: r.port };
  });

  // #379: ADDITIVE "open in a new window" — launch/focus the target but LEAVE the
  // current window open. The advanced, less-discoverable path (⌥-click a profile
  // in the switcher, or File ▸ New Profile…). Because it opens a SEPARATE window
  // and never touches the current call, it's safe to use mid-call.
  ipcMain.handle('open-profile-window', async (_event, name) => {
    return await launchOrFocusProfile(name);
  });

  // File ▸ New Window — open a genuinely NEW window with no picker/prompt. The app
  // is one-window-per-profile (one locked userData dir + one fixed port each; see
  // #393), so a "new window" MUST be a profile that isn't already running: open
  // Default if it's free, else the first idle existing profile. If every profile
  // is already up, there's nothing new to open — the panel reports 'all-running'.
  ipcMain.handle('open-next-available-window', async () => {
    const running = await scanRunningInstances();
    // Always mark THIS instance's profile as running. The scan is a best-effort
    // HTTP sweep with a 350ms per-port timeout, so under load it can miss our own
    // server — which would make New Window re-target our own profile (Default gets
    // reopened, or a named window needlessly opens Default first). We know our own
    // identity for certain, so seed it deterministically.
    running[appProfile] = localServer.port;
    // listProfiles now includes the default; make sure it's a candidate even if
    // its dir doesn't exist yet, and try it first (New Window prefers the default).
    const names = profileManager.listProfiles(PROFILES_ROOT).map((p) => p.name);
    const candidates = names.some(isDefaultName) ? names : [DEFAULT_PROFILE_NAME, ...names];
    const target = candidates.find((name) => !running[name]);
    if (!target) return { ok: false, error: 'all-running' };
    return await launchOrFocusProfile(target);
  });

  // Debug overlay — renders the troubleshooting snapshot onto the bot's
  // virtual camera so non-technical users can diagnose state by looking at
  // the Meet tile. Stored under a non-schema key so it stays invisible to
  // the agent (no MCP set_preference access — would be a prompt-injection
  // vector for leaking state on demand).
  // Per-category debug overlay (#overlay). Panel reads all flags, sets one at a
  // time. The camera draws iff any category is on.
  ipcMain.handle('get-overlay-flags', () => overlayFlags());
  ipcMain.handle('set-overlay-flag', (_event, key, enabled) => {
    if (!(key in OVERLAY_DEFAULTS)) return overlayFlags();
    if (store) store.set(key, !!enabled);
    const anyOn = overlayAnyOn();
    if (meetView && !meetView.webContents.isDestroyed()) {
      meetView.webContents.send('extension-message', {
        action: 'set-debug-overlay',
        payload: { enabled: anyOn, flags: overlayPayloadFlags() },
      });
    }
    updateDebugOverlayPushInterval(anyOn);
    return overlayFlags();
  });

  // Pop the panel out into its own window (or dock it back) — lets the bot's-eye
  // view sit at any size next to the bot's Meet window.
  ipcMain.handle('toggle-panel-popout', () => {
    setPanelPoppedOut(!panelPopoutWindow);
    return { poppedOut: !!panelPopoutWindow };
  });
  ipcMain.handle('get-panel-popout', () => ({ poppedOut: !!panelPopoutWindow }));

  // Bot-view toggle: thumbnail column ↔ Meet in its own large window.
  ipcMain.handle('toggle-bot-view', () => {
    setBotViewState(botViewLayout.nextState(botViewState));
    return { state: botViewState };
  });
  ipcMain.handle('get-bot-view', () => ({ state: botViewState }));


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
    // #366: read the token being logged out BEFORE removing it, and leave it
    // behind as a tombstone. Other profiles' cookie jars still hold this
    // token on disk; without the tombstone, their next launch would find it,
    // re-donate it to the shared store, and silently undo the logout. With
    // it, syncSharedLoginCookie drops the token instead of donating it.
    // (Profiles already RUNNING keep their session until restart — logout is
    // per-machine at launch boundaries, not push.)
    try {
      const cookies = await session.defaultSession.cookies.get({ url: baseUrl, name: 'vc_session' });
      const dying = store?.get('vcSessionToken') || (cookies.length > 0 ? cookies[0].value : null);
      if (dying) store?.set('vcSessionLoggedOutToken', dying);
      store?.delete('vcSessionToken');
    } catch { /* non-fatal */ }
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

  // Is this profile signed into Slack? Cookie-authoritative (the `d` session
  // cookie). We don't know WHICH workspace/user without the huddle DOM (#283),
  // so this is just connected-vs-not for the Slack row on the main panel.
  ipcMain.handle('get-slack-mode', async () => {
    const signedIn = await isSignedInToSlack(session.fromPartition(currentMeetPartition));
    return { signedIn };
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
        // #401: a meeting page's DOM contains OTHER PARTICIPANTS' emails in
        // aria-labels (host/participant tooltips, info panel). The old
        // any-aria-label fallback harvested the meeting ORGANIZER's address in
        // the Kate call and bound it as the bot's identity. Rules now:
        //   • chip-sourced emails (the OneGoogle "Google Account: …" label)
        //     are identity-quality;
        //   • the broad fallback runs ONLY off meeting pages, and its result
        //     is display-only — never bound.
        const inMeetingPage = MEET.url.meetingCodePath.test((() => {
          try { return new URL(meetView.webContents.getURL()).pathname; } catch { return ''; }
        })());
        const inCall = localServer.callStatus === 'in-call';
        const SCAN = `(() => {
          const RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/g;
          const NAME_RE = /Google Account:\\s*(.+?)\\s*\\(/i;
          const chip = new Set();
          const other = new Set();
          let name = null;
          // Search the top doc + any SAME-ORIGIN iframes (the Google bar is
          // usually inline, but be safe). Cross-origin iframes throw → skipped.
          const docs = [document];
          for (const f of document.querySelectorAll('iframe')) {
            try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) { /* cross-origin */ }
          }
          const scan = (sel, into) => { for (const d of docs) {
            for (const el of d.querySelectorAll(sel)) {
              const al = el.getAttribute('aria-label') || '';
              ((al.match(RE)) || []).forEach((x) => into.add(x));
              if (!name) { const m = al.match(NAME_RE); if (m) name = m[1].trim(); }
            }
          } };
          scan('[aria-label*="Google Account" i]', chip);
          if (!chip.size && ${inMeetingPage ? 'false' : 'true'}) scan('[aria-label]', other); // display-only fallback, never on meeting pages (#401)
          return { chipEmails: [...chip], otherEmails: [...other], name };
        })()`;
        let chipEmail = null;
        for (let attempt = 0; attempt < 5 && !email; attempt++) {
          if (attempt) await new Promise((r) => setTimeout(r, 400));
          try {
            const found = await meetView.webContents.executeJavaScript(SCAN, true);
            const real = (arr) => (Array.isArray(arr) ? arr : []).filter((e) => !/noreply|no-reply|example\.com/i.test(e));
            const chips = real(found?.chipEmails);
            const others = real(found?.otherEmails);
            allEmails = [...chips, ...others];
            if (found?.name) name = found.name;
            chipEmail = chips[0] || null;
            email = chipEmail || others[0] || null;
          } catch { /* page mid-navigation; retry */ }
        }
        console.log('[electron] account-email:', email || '(none yet)',
          'name=' + JSON.stringify(name), 'chip=' + JSON.stringify(chipEmail),
          'all=' + JSON.stringify(allEmails), inCall ? '(in-call: no binding)' : '');

        // #282/#401: bind this profile to the detected account so joins pin
        // authuser to it. An explicit --meet-account-email always wins and is
        // never overwritten. Binding now requires ALL of:
        //   • a CHIP-sourced email (the account switcher's own label — the
        //     NAME_RE context — not a bare email found somewhere in the page),
        //   • not currently in a call (identity is established at sign-in /
        //     pre-join; mid-call the DOM is full of other people).
        if (chipEmail && !inCall && store && !meetAccountEmailPinned && store.get('meetAccountEmail') !== chipEmail) {
          store.set('meetAccountEmail', chipEmail);
          console.log('[electron] Bound profile Meet account →', chipEmail);
        }
      }
    } catch (err) {
      console.warn('[electron] get-meet-account-email DOM read failed:', err.message);
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
    // Prepend https:// when the user typed a bare host (a different explicit
    // scheme is still refused). See nav-url.js.
    const { normalizeNavUrl } = require('./nav-url.js');
    const norm = normalizeNavUrl(rawUrl);
    if (!norm.ok) return { ok: false, error: norm.error };
    const url = norm.url;
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

  // HTTP Basic/Digest auth for the bot's webview. Electron cancels auth
  // challenges by default — a site behind Basic Auth (e.g. navigated to via
  // Navigate Webview…) just returns a bare 401 "access denied" with no prompt.
  // Handle the `login` event: for a real (non-proxy) Basic/Digest challenge on
  // OUR meetView, ask the operator once for credentials, then hand them to
  // Chromium. Chromium caches accepted credentials per origin for the session's
  // partition, so the site stays authenticated afterwards — including when the
  // bot shares its screen. Google/Slack sign-in is OAuth (never triggers a Basic
  // challenge), so this only ever fires for genuinely Basic-protected sites.
  app.on('login', (event, webContents, _details, authInfo, callback) => {
    if (authInfo.isProxy) return; // proxy auth: leave Electron's default behavior
    if (!/^(basic|digest)$/i.test(authInfo.scheme || '')) return; // NTLM/Negotiate: default
    // Only the bot's own surfaces — the Meet webview and the shared-screen window.
    // Both sit on SESSION_PARTITION, so credentials the operator enters here cache
    // once and are reused across both (log in in one, it's live in the other).
    const isMeet = meetView && !meetView.webContents.isDestroyed() && webContents === meetView.webContents;
    const isShared = whiteboardWindow && !whiteboardWindow.isDestroyed()
      && !whiteboardWindow.webContents.isDestroyed() && webContents === whiteboardWindow.webContents;
    if (!isMeet && !isShared) return;
    event.preventDefault();
    if (!panelView || panelView.webContents.isDestroyed()) { callback(); return; } // no UI → cancel (401)
    const id = ++basicAuthSeq;
    pendingBasicAuth.set(id, callback);
    panelView.webContents.send('basic-auth-prompt', {
      id, host: authInfo.host || '', realm: authInfo.realm || '',
    });
  });
  // Panel returns the operator's input (or a cancel). Empty user → cancel → 401.
  ipcMain.on('basic-auth-result', (_event, { id, user, password } = {}) => {
    const cb = pendingBasicAuth.get(id);
    if (!cb) return;
    pendingBasicAuth.delete(id);
    if (user) cb(user, password || ''); else cb();
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

  // --- Bot Slack identity (#285) — parity with the Google sign-in above. Slack
  // has no account pin; the bot uses whatever you log into. Both just drive the
  // embedded view (same `session` partition as Meet now). ---

  // Open Slack in the bot's view for login (no autojoin — we're not joining a
  // huddle, just signing in). Loads the Slack home; user logs in + picks the
  // workspace.
  ipcMain.handle('slack-sign-in', () => {
    activateSlackProvider('https://app.slack.com/', { autojoin: false });
    return { ok: true };
  });

  // Sign out of Slack: remove ONLY slack.com cookies from the partition (mirror
  // of meet-sign-out-bot, which clears google.com and preserves Slack). Then
  // reload Slack so the view reflects the logged-out state.
  ipcMain.handle('slack-sign-out', async () => {
    try {
      const sess = session.fromPartition(currentMeetPartition);
      const all = await sess.cookies.get({});
      let removed = 0;
      for (const c of all) {
        const d = (c.domain || '').replace(/^\./, '');
        if (/(^|\.)slack\.com$/.test(d)) {
          const url = `https://${d}${c.path || '/'}`;
          try { await sess.cookies.remove(url, c.name); removed++; } catch { /* best-effort */ }
        }
      }
      console.log('[electron] Slack sign-out — removed', removed, 'slack.com cookies (Google login preserved)');
    } catch (err) {
      console.warn('[electron] slack-sign-out failed:', err.message);
    }
    activateSlackProvider('https://app.slack.com/', { autojoin: false });
    return { ok: true };
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
      } else if (status.startsWith('Notice:')) {
        // #404: agent-visible notices from the call view (time-limit warning,
        // unhandled-dialog surfacing). Rides status.errors, which the agent
        // reads on its next wait_for_speech lull — same channel as the
        // voice-change notices. Not a call-state change.
        localServer.addError(status.slice('Notice:'.length).trim());
      } else if (status.startsWith('Call ended')) {
        // #417: the renderer detected the in-call UI collapsing (everyone left
        // / the tab fell out of the call). Exit cleanly — resolve the agent's
        // waiters with the terminal autoLeft and tear the call down — instead
        // of ghost-polling captions for minutes.
        localServer.handleCallEnded(status);
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
    // #368: tts-ended = the audio queue fully drained, i.e. the bot is no longer
    // speaking aloud. This is the authoritative release for the speaking-aloud
    // latch — clear it FIRST, before any early-return below, so botState can
    // never get trapped in 'speaking' if the audio ends via an unusual path.
    localServer.speakingAloud = false;
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
    // #424: real caption text is proof we're hearing again — drop the 🥴.
    if (turns.some((t) => t && String(t.text || '').trim())) setImpaired(false);
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

    // #368 / #424: a long bot MONOLOGUE also produces a 0-remote-caption gap
    // (the bot's own captions are filtered out), so such a gap is explained by
    // the bot talking, not by deafness. This MUST be evaluated FIRST — it holds
    // whether or not a remote is speaking. Caught live 2026-07-09: the 🥴
    // impaired face lit up while the bot was mid-answer, because the ambiguous
    // branch below ran first and nobody else happened to be talking.
    const gapOverlapsBotSpeech = localServer.speakingAloud
      || (Date.now() - (localServer.lastSpokeAloudAt || 0) < (info?.ageMs || 0));
    if (gapOverlapsBotSpeech) {
      console.log(`[electron] caption stall (${secs}s) explained by the bot's own speech (self-captions excluded) — NOT deaf/impaired; ignoring`);
      return;
    }

    // ONLY real deafness: captions frozen WHILE a remote participant is actually
    // speaking. "No new captions" is also true when the room is quiet/muted —
    // that is not deafness. anyoneSpeaking is speaker-TILE based (independent of
    // captions), so it's the right discriminator. (Live 2026-06-23: a silent
    // room got flagged deaf and the bot announced "I've gone deaf" — #259.)
    if (!localServer.anyoneSpeaking) {
      // No remote speaker: we CANNOT distinguish "the room is simply quiet"
      // from "we've gone deaf and the tracker is frozen too" — both look like
      // "no captions lately". Observe, don't act.
      //
      // An earlier cut of #424 raised 🥴 at 20s and force-toggled captions at
      // 45s here. Caught live 2026-07-09: with the room merely quiet while the
      // bot worked, the stall climbed 29s → 64s → 94s, the bot wore an alarming
      // impaired face, and it re-toggled the room's captions every 30s — trying
      // to fix a problem that did not exist. Acting on ambiguous evidence was
      // worse than the (now-fixed) root cause: `backgroundThrottling: false`
      // removes the freeze this branch was speculating about.
      //
      // Log loudly so post-mortems can still see it. To raise 🥴 here we need
      // POSITIVE evidence of a degraded renderer (a freeze detector, or the
      // audio-RMS signal from #387) — not the absence of captions. See #424.
      console.log(`[electron] caption stall (${secs}s) with no remote speaker — quiet room or (rarely) a frozen tracker; NOT acting (see #424)`);
      return;
    }
    // (The bot-monologue guard that used to live here now runs FIRST — see the
    // top of this handler. It has to precede the ambiguous branch above, which
    // would otherwise raise 🥴 during any long bot answer.)
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
    // Explicit provider override ('macos-say' / 'elevenlabs' / 'voicebox' /
    // 'auto'). Lets the bot (or user) force the built-in voice as primary even
    // with an EL key set.
    if (config.provider) {
      store.set('ttsProvider', config.provider);
    }
    // Voicebox (local TTS server, experimental) — mirrors the macosVoice/
    // ttsVoiceId persistence above. voiceboxProfileId can be explicitly
    // cleared to '' (revert to "None"), so persist using 'in' rather than
    // truthiness, same as apiKey above.
    if (config.voiceboxUrl) {
      store.set('voiceboxUrl', config.voiceboxUrl);
    }
    if ('voiceboxProfileId' in config) {
      if (config.voiceboxProfileId) {
        store.set('voiceboxProfileId', config.voiceboxProfileId);
      } else {
        store.delete('voiceboxProfileId');
      }
    }
    if (config.voiceboxEngine) {
      store.set('voiceboxEngine', config.voiceboxEngine);
    }
  });

  // List voice profiles from a locally running Voicebox instance, mirroring
  // list-macos-voices below. Returns [] (never throws) if Voicebox isn't
  // running — the renderer falls back to a single "not in use" option.
  ipcMain.handle('list-voicebox-profiles', async () => {
    const profiles = await listVoiceboxProfiles();
    voiceboxProfileNameSet = new Set(profiles.map((p) => p.name));
    voiceboxProfilesById = new Map(profiles.map((p) => [p.id, p]));
    return profiles;
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

  // List the account's ElevenLabs voices for the unified voice picker (#340).
  // Optional apiKey arg lets the panel fetch with a just-typed key before it's
  // saved; falls back to the stored key. Returns [{ id, name, category }] or [].
  ipcMain.handle('list-elevenlabs-voices', async (_event, apiKey) => {
    return listElevenLabsVoices(apiKey);
  });

  // Audition a voice when it's picked in the preferences dropdown — ONE path for
  // every provider (macOS `say`, ElevenLabs, Voicebox). Synthesize a short sample
  // in the SELECTED voice (a throwaway TTSProvider, independent of the saved
  // config) and hand it back as a data URL; the panel plays it via an Audio
  // element through the LOCAL speakers (never the call mic). The sample text
  // (with the voice's name) is composed by the panel so it's identical across
  // providers. Best-effort — returns { ok:false } on failure (no EL key, Voicebox
  // not running, etc.) and the panel just stays quiet.
  ipcMain.handle('synth-voice-sample', async (_event, opts = {}) => {
    try {
      const preview = new globalThis.TTSProvider({
        provider: opts.provider,
        apiKey: store.get('ttsApiKey') || '', // app-level ElevenLabs key
        ...(opts.voiceId ? { voiceId: opts.voiceId } : {}),
        ...(opts.macosVoice ? { macosVoice: opts.macosVoice } : {}),
        voiceboxProfileId: opts.voiceboxProfileId || '',
        voiceboxEngine: opts.voiceboxEngine || 'kokoro',
      });
      const buf = await preview.synthesize(opts.text || 'Hi, this is how I sound.');
      if (!buf) return { ok: false, error: 'no audio' };
      // ElevenLabs returns mp3; macOS `say` (afconvert) and Voicebox return WAV.
      const mime = opts.provider === 'elevenlabs' ? 'audio/mpeg' : 'audio/wav';
      return { ok: true, dataUrl: `data:${mime};base64,${Buffer.from(buf).toString('base64')}` };
    } catch (e) {
      console.warn('[voice-preview] synth failed:', e && e.message);
      return { ok: false, error: e && e.message };
    }
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
