// main.js — Electron main process
// Manages Meet BrowserView + panel sidebar in a single window,
// IPC routing, TTS, and sync.

const { app, BrowserWindow, BrowserView, ipcMain, session, shell, nativeImage, desktopCapturer, dialog, Menu, net } = require('electron');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const Store = require('./store.js');
const { APP_LEVEL_KEYS, ScopedStore, migrateAppLevelKeys } = require('./config-scope.js');
const profileManager = require('./profile-manager.js');
const { MEET } = require('./meet-selectors.js'); // pure data — safe in the main process
const { resolveSvg } = require('./svg-resolver.js');
// One source of truth for the unconfigured bot name — see preferences-schema.
const { DEFAULT_BOT_NAME, PREFERENCES } = require('./preferences-schema');
const { resolveBotName, botNameForAppUI } = require('./bot-name.js');
const { resolveVoice } = require('./voice-status.js');
const { isInCall, isFinished, isCallComplete } = require('./call-phase.js');

// Assigned once the app is ready (the implementation needs nextBotProfileName /
// seedNewBotName / launchOrFocusProfile, which live in the app-ready block).
// Held at module scope so the local server's extraRoutes — defined long before
// that block runs — can reach it. Null until then; the route says so rather
// than throwing.
let adoptSessionAsBot = null;
const { SHARE_SIZE, resolveShareSize, shareWindowPosition, keyEventsFor, clickEventsFor } = require('./share-surface.js');
const { CallRecordingSession } = require('./call-recorder.js');
const { createCallRecordingWindow, createShareCaptureWindow, stopFrameCaptureWindow } = require('./call-recording-window.js');
const { mergeCallMedia } = require('./call-media-merge.js');
const { evictStaleEventIds, selectEventToJoin, selectUpcomingMatches, matchesCalendarEvent, ownerHasConfirmed, isEventUpcoming, msUntilStart, eventDedupeKey, resolveMeetUrl: resolveCalendarMeetUrl } = require('./calendar-auto-join.js');
const { createMergeProgressWindow, closeMergeProgressWindow } = require('./call-recording-merge-window.js');
const { initSessionLog, logSessionHeaderUpdate, getRecentSessionLog, getSessionLogPath, configureRemoteLog, setRemoteLoggingEnabled } = require('./session-log.js');
const {
  codexConfigPath,
  readCodexConfigSafe,
  installCodexMcpConfig,
  uninstallCodexMcpConfig,
  currentCodexMcpServerPath,
} = require('./codex-config.js');
// The call-provider contract. main.js is the consumer side: it subscribes to
// CALL_EVENTS (provider → app) and issues CALL_COMMANDS (app → provider) by
// constant rather than raw channel string, so the contract is shared on both
// sides of the IPC wire (provider impl in google-meet-provider.js). Values are
// byte-identical to the prior literals — same wire.
const { CALL_EVENTS, CALL_COMMANDS } = require('./call-provider.js');

// How Claude Code should launch our stdio MCP server.
//
// It used to be the bare string 'node', which silently requires the user to
// have Node on PATH. macOS ships none, and Claude Code's own native installer
// (~/.local/share/claude/...) doesn't bring one — so a non-developer who does
// everything right gets `spawn node ENOENT` and a bot that never appears.
// This never showed up in our own testing because every machine we test on has
// Homebrew node, and that's machine-wide: a fresh macOS *account* still sees it.
//
// Electron already contains a Node runtime, so use ours. ELECTRON_RUN_AS_NODE
// makes the app binary behave exactly like `node <script>`. It costs nothing
// (already on disk), pins a known-good version, and adds no new fragility —
// args[0] already points inside the app bundle, so the config was always tied
// to the app's existence.
function mcpNodeLauncher() {
  return {
    command: process.execPath,
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

function bundledMcpServerRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'mcp-server')
    : path.join(__dirname, '..', 'mcp-server');
}

function bundledMcpServerPath() {
  return path.join(bundledMcpServerRoot(), 'server.js');
}

function mcpServerDepsPresent(mcpServerRoot = bundledMcpServerRoot()) {
  return app.isPackaged || (
    fs.existsSync(path.join(mcpServerRoot, 'node_modules', '@modelcontextprotocol', 'sdk')) &&
    fs.existsSync(path.join(mcpServerRoot, 'node_modules', 'zod')));
}

function runningFromGitWorktree() {
  if (app.isPackaged) return false;
  try { return fs.statSync(path.join(__dirname, '..', '.git')).isFile(); } catch { return false; }
}

// Let the shared board play sound unprompted. Now that the whiteboard window's
// audio is captured into the screen share, a board pointed at a page with a
// <video>/<audio> would otherwise sit silent: Chromium's autoplay policy needs a
// user gesture, and nobody can click an off-screen capture window. (The app's own
// executeJavaScript calls pass userGesture:true, so only externally-loaded URLs
// were affected.) Must run before app ready to take effect.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

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
  CALL_COMMANDS.setStudioSound, CALL_COMMANDS.setCaptionLanguage, CALL_COMMANDS.recoverCaptions,
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

// Generic "ask the call view to do something and tell me how it went". chatRequest
// is the same shape hard-wired to the chat events; this is it with the event and
// timeout as parameters, for operations whose outcome the agent must actually see.
// Apply the captionLanguage preference once the bot is in a call with captions
// live. Captions-ready is the right moment: before it, the caption region (and
// the Settings dialog that owns the language) may not be there to drive.
//
// Once per call — the walk opens Meet's Settings dialog, which briefly covers
// the caption region, and repeating it on every captions-ready blip would make
// the bot intermittently deaf for no gain.
// What the caption language is CURRENTLY set to, and for which call:
// { room, requested, resolved }. Set by onSetCaptionLanguage — the one place
// every path (join-time pref, a mid-call set_caption_language, a preference
// write) funnels through — so any of them can tell whether the work is already
// done. Both spellings are kept because Meet resolves loose tags: ask for "es"
// and it selects "es-ES", and the next request may use either form.
let _captionLanguageApplied = null;
function captionLanguageAlreadyApplied(room, language) {
  const a = _captionLanguageApplied;
  if (!a || !room || a.room !== room) return false;
  return a.requested === language || a.resolved === language;
}

// What the bot can currently speak with. Read live from the store rather than
// cached: the ElevenLabs key can be entered in the App Settings window, and a
// voice can be changed mid-call, both without a relaunch.
// A preference's EFFECTIVE value: what is stored, or the schema default when it
// has never been set. store.get() alone gives the raw value, so an unset pref
// reads as undefined and every `|| 0` / `|| ''` fallback silently wins over the
// documented default.
// Tell the panel a config value changed, so its controls re-read.
//
// Both write paths call this: set-config (the wizard and the panel itself) and
// applyPref (an agent's set_preference). Before, only applyPref's botName branch
// sent it — and nothing in the panel listened, so even that was dropped. The
// result was a panel showing a boot-time snapshot forever, and settings that
// looked like they had failed to save when they had not (#190, #143).
function notifyConfigChanged(key, value) {
  broadcastToRenderers('extension-message', { action: 'config-updated', payload: { key, value } });
  // #231: switching backends must take effect now, not at the next poll. Going
  // to codex/other has to clear a stale "signed out" banner immediately, and
  // coming back to claude has to re-check rather than sit on the `null` we
  // parked while it wasn't our business.
  if (key === 'agentBackend') {
    try { refreshClaudeAuth().catch(() => {}); } catch { /* not ready yet */ }
    if (value === 'codex' && isDefaultInstance && store?.get('codexIntegrationRemoved') !== true) {
      try { ensureCodexIntegration(); } catch (err) { console.warn('[electron] Codex integration install failed:', err.message); }
    }
  }
}

function prefValue(key) {
  const stored = store?.get(key);
  if (stored !== undefined && stored !== null) return stored;
  return PREFERENCES[key]?.default;
}

// #209: call audio recording. The page-world CallRecorder captures each track;
// this side owns the on-disk session (one file per track + manifest). One call
// at a time — the bot is only ever in one.
let activeRecording = null;

// #606: the session stopCallRecording() has CLAIMED but not yet finalized —
// null the rest of the time. stopCallRecording used to guard with
// `if (!activeRecording) return` and then reach `activeRecording.stop()` two
// awaits later, which is a check-then-use across a yield: both leave routes
// (requestCleanLeave's fire-and-forget stop, and the teardown's
// step('stopCallRecording')) passed the guard, the first one won and nulled the
// global, and the second resumed into `null.stop()` — "error finalizing
// recording: Cannot read properties of null (reading 'stop')", 8 times across 5
// session logs in late August 2026. Nothing was ever lost (the first pass saved
// every track and its merge produced the mp4s); the cost was that a call which
// recorded perfectly looked broken in the log and in the nightly meet-test
// output. The fix is to claim the session into a local and null the global
// before the first await — and this holds that claimed session meanwhile, so
// finalizeRecordingSync can still write its manifest if a quit lands during
// those awaits. See there for why the manifest is the one thing that genuinely
// cannot be reconstructed afterwards.
let finalizingRecording = null;

// The video half (#209-video): a small visible control window (see
// call-recording-window.js) that answers its OWN session's getDisplayMedia()
// with meetView's live frame and streams the resulting MediaRecorder chunks
// back here as one more 'video' track on activeRecording. null whenever video
// capture isn't running — startCallRecording() always tries to create this
// alongside activeRecording, but it degrades to audio-only on any failure
// (no ffmpeg, no display-media support, window creation error, etc.) without
// affecting the audio recording at all.
let activeRecordingWindow = null;

// #328: the control window shows elapsed time, and the renderer has no way to
// know how much disk that time is actually costing — a 36-minute stand-up wrote
// a 1.06 GB video.webm. Main owns the only live byte counts (per-track totals on
// activeRecording), so it pushes them over IPC on this timer; the renderer just
// formats what it receives. Every 2s: the number is a reassurance gauge, not a
// readout anyone watches tick.
const RECORDING_STATS_MS = 2000;
let _recordingStatsTimer = null;

// Free space on the volume the recording is being written to, or null if it
// can't be determined. statfs is best-effort by design: it's a nice-to-have on
// the indicator, and an older/odd platform without it must not break the size
// display that IS the point.
function volumeFreeBytes(dir) {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bsize) * Number(st.bavail);
  } catch { return null; }
}

function startRecordingStatsPush() {
  stopRecordingStatsPush();
  const tick = () => {
    if (!activeRecording || !activeRecordingWindow || activeRecordingWindow.isDestroyed()) return;
    try {
      activeRecordingWindow.webContents.send('recording-stats', {
        bytes: activeRecording.totalBytes(),
        freeBytes: volumeFreeBytes(activeRecording.dir),
        dir: activeRecording.dir,
      });
    } catch { /* window torn down between the check and the send */ }
  };
  tick(); // don't make the window wait a full interval for its first number
  _recordingStatsTimer = setInterval(tick, RECORDING_STATS_MS);
  if (_recordingStatsTimer.unref) _recordingStatsTimer.unref();
}

function stopRecordingStatsPush() {
  if (_recordingStatsTimer) clearInterval(_recordingStatsTimer);
  _recordingStatsTimer = null;
}

// The whiteboard-share side-capture (extension, see call-recording-window.js's
// createShareCaptureWindow): a full-resolution recording of the bot's own
// whiteboard-window share content, independent of and in addition to the
// video track above (which only shows Meet's lower-res call-layout render of
// it). Only ever running while BOTH a call recording is active AND a
// whiteboard share is live — see maybeStartShareCapture()/
// stopShareCaptureIfActive() below, hooked into onShareWhiteboard's
// display-media handler and onStopSharing/stopCallRecording respectively.
// Lands at <dir>/share.webm, kept separate from video.webm rather than muxed
// in as a second video track (multi-video-track containers aren't reliably
// playable across players/tools).
let activeShareCaptureWindow = null;

// The AbortController for the most recently started ffmpeg merge run (see
// runPostRecordingMerges and call-recording-merge-window.js's "Preparing
// recording…" window). null whenever no merge is in flight. The
// 'merge-cancel-requested' IPC handler (setupIPC) just calls .abort() on
// whatever this currently points to, so a stray/late cancel click with
// nothing running is a harmless no-op. Since #388 detached the merge from
// stopCallRecording, two runs can (rarely) overlap — this always points at
// the newest one, and each run only nulls it back out if it still owns it.
let activeMergeAbortController = null;

// #388: how many detached runPostRecordingMerges runs are currently in
// flight. Only consulted at quit, for an honest log line — quitting kills any
// running ffmpeg with the app, which loses nothing but the combined mp4 (the
// raw tracks and their RECOVERY.md stay on disk until a merge SUCCEEDS).
let mergesInFlight = 0;

// Spoken when an explicit start_recording begins, so participants are told
// the call is being recorded (consent). Short on purpose. Just "recording this
// call" — not "audio for debugging": that description is stale now that this
// captures video too and is a real feature, not only a debug tool.
const RECORDING_NOTICE = "Just so everyone knows — I'm now recording this call.";

function recordCallEnabled() {
  // Env wins so the test fleet can force it on without touching config.
  if (process.env.VIBECONF_RECORD_CALL === '1') return true;
  try { return !!prefValue('recordCallAudio'); } catch { return false; }
}

// force=true is the explicit request (start_recording MCP tool): record
// even when the recordCallAudio pref is off. The auto path (bot-joined) leaves
// force=false so it stays gated. Returns a small status for the MCP tool.
// A call can be recorded, stopped, and recorded again (start_recording /
// stop_recording can be called at any point, more than once, in the same
// call). Every recording within a call shares the same callDir — without
// this, a second recording would reuse the exact same call-recording-tracks/
// dir and call-recording.mp4 name as the first, and CallRecordingSession
// opens track files with 'w' (truncating), so the second recording starting
// would silently clobber the first's raw tracks the moment its first chunk
// arrives, and the second merge would overwrite the first's output file.
// '' for the call's first recording (keeps today's plain names for the
// overwhelmingly common case); '-2', '-3', ... for each later recording in
// the SAME call, so nothing already on disk is ever touched. Checks for the
// MERGED output files too, not just the tracks dir: keepCallRecordingTracks
// defaults OFF, so a successful first recording's tracks dir is typically
// already gone by the time a second recording starts — only its
// call-recording.mp4 survives — and checking the tracks dir alone would miss
// that and let the second recording's merge silently overwrite it.
function nextRecordingSuffix(callDir) {
  let n = 1;
  while (true) {
    const suffix = n === 1 ? '' : `-${n}`;
    const inUse = fs.existsSync(path.join(callDir, `call-recording-tracks${suffix}`))
      || fs.existsSync(path.join(callDir, `call-recording${suffix}.mp4`))
      || fs.existsSync(path.join(callDir, `call-recording-share${suffix}.mp4`));
    if (!inUse) return suffix;
    n++;
  }
}

function startCallRecording(room, botName, { force = false } = {}) {
  if (activeRecording) return { ok: true, already: true, dir: activeRecording.dir };
  if (!force && !recordCallEnabled()) return { ok: false, code: 'disabled' };
  try {
    // Save under the bot's HOME (its agent workdir), alongside call-notes/, so a
    // call's artifacts live together: <home>/calls/<callId>/call-recording-tracks/.
    // Prefer the first-class per-join call id (#292) so this matches
    // call-notes/<call-id>.md exactly; fall back to room+timestamp if the id
    // hasn't been minted yet (recording started before the call went active).
    const agentDir = require('./agent-workdir.js').agentDirFor(app.getPath('userData'));
    const safeRoom = String(room || 'call').replace(/[^a-zA-Z0-9._-]/g, '_');
    const fallbackStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const callId = (localServer && localServer.callId) || `${safeRoom}-${fallbackStamp}`;
    const safeCallId = String(callId).replace(/[^a-zA-Z0-9._-]/g, '_');
    const callDir = path.join(agentDir, 'calls', safeCallId);
    const suffix = nextRecordingSuffix(callDir);
    const dir = path.join(callDir, `call-recording-tracks${suffix}`);
    activeRecording = new CallRecordingSession(dir, {
      room: room || null,
      callId,
      botName: botName || store?.get('botName') || null,
      startedAt: Date.now(),
    });
    // Stashed here (not a separate module-scope variable) so it travels
    // naturally with the session through stopCallRecording, which reads it
    // back before activeRecording is cleared — see the outputName below.
    activeRecording.outputSuffix = suffix;
    console.log(`[call-record] recording call audio to ${dir}${suffix ? ` (recording ${suffix.slice(1)} of this call)` : ''}`);

    // Video rides along unconditionally whenever recording starts — no
    // separate flag, no gating decided at meetView creation time (that's the
    // whole point of this design over the abandoned offscreen-BrowserView
    // approach: it can start/stop mid-call). Best-effort: any failure here
    // just means this call gets audio-only, same as the pre-existing
    // ffmpeg-missing fallback.
    try {
      activeRecordingWindow = createCallRecordingWindow(meetView);
      startRecordingStatsPush(); // #328 — feed the window its running size
      console.log('[call-record] recording control window created — capturing video');
    } catch (err) {
      activeRecordingWindow = null;
      console.warn('[call-record] could not start video capture (falling back to audio-only):', err.message);
    }

    if (meetView && !meetView.webContents.isDestroyed()) {
      meetView.webContents.send('trigger-record', { recording: true, room, startedAt: activeRecording.startedAt, botName: activeRecording.botName });
    }
    // Consent: an EXPLICIT start (start_recording) speaks a notice so the
    // room knows it's being recorded. The auto path (test fleet, force=false)
    // stays silent — it's all bots, and an extra utterance would skew the
    // nightly's speech-timing checks. The notice is captured in the recording.
    let announced = false;
    if (force) {
      try { speakText(RECORDING_NOTICE); announced = true; }
      catch (err) { console.warn('[call-record] recording notice failed to speak:', err.message); }
    }
    return { ok: true, dir, room: room || null, announced };
  } catch (err) {
    console.warn('[call-record] could not start recording:', err.message);
    activeRecording = null;
    return { ok: false, code: 'error', detail: err.message };
  }
}

// Extension: start the whiteboard-share side capture — a full-resolution
// recording of the bot's own share content, independent of the (lower-res)
// video track of Meet's own render of it. Called from the whiteboard branch
// of setDisplayMediaRequestHandler above, at the moment a share actually
// engages. Idempotent (a share can re-trigger getDisplayMedia — e.g. the
// Present-now retry loop — without starting a second capture window), and a
// no-op unless a call recording is currently active: this side capture only
// ever exists alongside one.
function maybeStartShareCapture() {
  if (!activeRecording) return;
  if (activeShareCaptureWindow) return;
  if (!whiteboardWindow || whiteboardWindow.isDestroyed()) return;
  try {
    activeShareCaptureWindow = createShareCaptureWindow(whiteboardWindow);
    console.log('[call-record] capturing whiteboard share to share.webm');
  } catch (err) {
    activeShareCaptureWindow = null;
    console.warn('[call-record] could not start share capture:', err.message);
  }
}

// Stop+finalize the share capture window, if one is running. Called both when
// the share itself ends (onStopSharing, before whiteboardWindow closes — the
// capture's source frame is about to go away) and when the whole call
// recording stops (stopCallRecording) — whichever comes first. Safe to call
// when nothing is active (no-op).
async function stopShareCaptureIfActive() {
  if (!activeShareCaptureWindow) return;
  const win = activeShareCaptureWindow;
  activeShareCaptureWindow = null;
  try {
    await stopFrameCaptureWindow(win);
  } catch (err) {
    console.warn('[call-record] error stopping share capture:', err.message);
  }
}

// Async: waiting for the control window's final video chunk takes a moment,
// but only a moment — everything awaited in here is the FAST half of stopping
// (close the capture windows, flush the last chunks, write manifest.json).
// The ffmpeg merge is NOT awaited (#388): it can run 20+ minutes on a long
// call, and this function sits directly under the stop_recording MCP tool
// (via setCallRecording → onRecord → /api/call/record), so awaiting the merge
// here left the agent comatose in the room — unable to speak, read chat, or
// even issue leave_call — until ffmpeg finished. The merge now runs detached
// via runPostRecordingMerges below; by the time this returns, the raw tracks
// and manifest are safely on disk and the combined mp4(s) are on their way.
// Callers that don't need even the fast result (leave-call teardown, the IPC
// 'call-record-stopped' notification) still fire this without awaiting —
// best-effort, never blocks the call from ending (each step below is
// independently try/caught for the same reason).
async function stopCallRecording() {
  // Claim the session BEFORE the first await (#606). The `already` guard below
  // is only meaningful if the global is cleared here: leave the clear until
  // after the awaits and two concurrent callers both get past it, which is
  // exactly what happened in production — see finalizingRecording's declaration
  // for the log line it produced. Everything downstream already works off a
  // local, so claiming is all it takes.
  const session = activeRecording;
  if (!session) return { ok: true, already: true };
  activeRecording = null;
  finalizingRecording = session; // until stop() below has written the manifest
  const dir = session.dir;
  const callDir = path.dirname(dir); // call-recording-tracks/'s parent — where call-recording.mp4 lands
  const outputSuffix = session.outputSuffix || ''; // see nextRecordingSuffix
  try {
    if (meetView && !meetView.webContents.isDestroyed()) {
      meetView.webContents.send('trigger-record', { recording: false });
    }
  } catch { /* window already gone */ }

  // A live share's capture must stop too — its source (whiteboardWindow) may
  // well outlive the recording, but there's no longer an activeRecording to
  // route its chunks into.
  await stopShareCaptureIfActive();

  // Stop the control window's MediaRecorder and wait (bounded) for its last
  // chunk BEFORE finalizing the claimed session — otherwise the video track's
  // file could still be receiving a chunk after we've already closed it.
  stopRecordingStatsPush(); // #328 — nothing to report once we're finalizing
  if (activeRecordingWindow) {
    const win = activeRecordingWindow;
    activeRecordingWindow = null;
    try {
      await stopFrameCaptureWindow(win);
    } catch (err) {
      console.warn('[call-record] error stopping video capture window:', err.message);
    }
  }

  let tracks = 0;
  let manifest = null;
  try {
    manifest = session.stop();
    tracks = manifest.tracks.length;
    console.log(`[call-record] saved ${tracks} track(s) to ${dir}`);
  } catch (err) {
    console.warn('[call-record] error finalizing recording:', err.message);
  }
  finalizingRecording = null; // manifest is on disk; a quit no longer needs to finalize this one

  // Merge is additive — the raw per-track files stay on disk either way, so a
  // failed/skipped merge just means no call-recording.mp4, not lost material.
  // That's exactly why it can run detached (#388): nothing after this point
  // needs the merge's outcome, and everything before it is already safe.
  // Fire-and-forget with the same framing as the share merge inside — the
  // .catch is belt-and-braces (every step in there is independently caught).
  if (manifest) {
    // finishedSession is the same claimed local — runPostRecordingMerges needs
    // it for removeRecoveryNote() once the merges land (#343).
    runPostRecordingMerges({ callDir, tracksDir: dir, manifest, outputSuffix, finishedSession: session })
      .catch((err) => console.warn('[call-record] detached merge failed:', err.message));
  }

  return { ok: true, dir, tracks, merging: !!manifest };
}

// #388: the slow half of stopping a recording — the ffmpeg merge(s) plus the
// cleanup that depends on their outcome — split out of stopCallRecording so
// it can run detached from the request path (see the comment there). Only
// ever started by stopCallRecording, exactly once per finalized manifest, so
// a double stop can't double-merge (the second stop finds activeRecording
// already null and returns {already:true} without reaching this). A NEW
// recording started while this is still running can't collide with it either:
// nextRecordingSuffix treats a still-present call-recording-tracks<suffix>/
// dir OR an already-merged call-recording<suffix>.mp4 as "in use", and this
// merge's tracks dir stays on disk until the merge succeeds — so the next
// recording always picks a fresh suffix and a fresh output name.
async function runPostRecordingMerges({ callDir, tracksDir, manifest, outputSuffix, finishedSession }) {
  const dir = tracksDir;
  mergesInFlight++;
  try {
    let mainMerge = null;
    let shareMerge = null; // stays null when there was no share track to merge
    const shareTrack = manifest.tracks.find((t) => t.track === 'share');
    const hasVideo = manifest.tracks.some((t) => t.track === 'video');
    // The merge can take a while and pins a CPU core — by this point BOTH
    // capture windows have already closed, so without this there's no UI at
    // all explaining the fan noise. Skip showing it for the (fast, no-op)
    // case where there's nothing to actually encode. This also gives the
    // user a way to bail if they don't care about the recording: cancelling
    // aborts whichever merge is in flight and skips any not yet started —
    // the raw tracks are untouched either way (see allAttemptedMergesOk
    // below), so cancelling never loses material, only the combined file(s).
    const mergeWin = hasVideo ? createMergeProgressWindow() : null;
    // Per-run controller, published to the module-level slot only while this
    // run owns it: with the merge detached, a stop→start→stop in quick
    // succession can (rarely) have two runs alive at once, and the Cancel
    // button should abort the latest one without an older run's cleanup
    // nulling the slot out from under it (see the ===-guard below).
    const abort = mergeWin ? new AbortController() : null;
    if (abort) {
      activeMergeAbortController = abort;
    }
    const mainOutputName = `call-recording${outputSuffix}.mp4`;
    try {
      mainMerge = await mergeCallMedia(callDir, { tracksDir: dir, tracks: manifest.tracks, outputName: mainOutputName, signal: abort?.signal });
      if (mainMerge.ok) console.log(`[call-record] merged ${mainOutputName} -> ${mainMerge.file}`);
      else console.log(`[call-record] merge skipped: ${mainMerge.reason}`);
    } catch (err) {
      console.warn('[call-record] merge failed:', err.message);
      mainMerge = { ok: false, reason: err.message };
    }

    // Extension: call-recording-share.mp4 — the same mix, but muxed onto the
    // full-resolution share.webm instead of video.webm, when a share was
    // captured this call. Additive and best-effort like the main merge: a
    // failure here never touches call-recording.mp4 or the raw tracks.
    if (shareTrack) {
      try {
        if (mergeWin && !mergeWin.isDestroyed()) {
          mergeWin.webContents.send('merge-status', { label: 'Preparing share recording…' });
        }
        // share.webm's own t=0 is when the share BEGAN (often minutes into
        // the call) while the audio tracks' t=0 is recording start (same as
        // the 'video' track's) — pad the share video by that delta so its
        // picture lines up with the (borrowed) mixed audio in call-recording-share.mp4.
        // Falls back to no padding if either startWallClock is missing.
        const videoTrackManifest = manifest.tracks.find((t) => t.track === 'video');
        let padStartMs = 0;
        if (videoTrackManifest && Number.isFinite(shareTrack.startWallClock) && Number.isFinite(videoTrackManifest.startWallClock)) {
          padStartMs = Math.max(0, shareTrack.startWallClock - videoTrackManifest.startWallClock);
        }
        const shareOutputName = `call-recording-share${outputSuffix}.mp4`;
        shareMerge = await mergeCallMedia(callDir, {
          tracksDir: dir,
          tracks: manifest.tracks,
          videoTrackName: 'share',
          outputName: shareOutputName,
          padStartMs,
          signal: abort?.signal,
        });
        if (shareMerge.ok) console.log(`[call-record] merged ${shareOutputName} -> ${shareMerge.file} (padded ${padStartMs}ms)`);
        else console.log(`[call-record] share merge skipped: ${shareMerge.reason}`);
      } catch (err) {
        console.warn('[call-record] share merge failed:', err.message);
        shareMerge = { ok: false, reason: err.message };
      }
    }
    if (mergeWin) {
      closeMergeProgressWindow(mergeWin);
      if (activeMergeAbortController === abort) activeMergeAbortController = null;
    }

    // call-recording-tracks/ (the raw per-participant audio + video.webm +
    // share.webm + manifest.json) is verbose and, once the merge succeeds,
    // redundant for nearly everyone — the keepCallRecordingTracks pref (OFF
    // by default) controls whether it's kept. Only delete when every merge
    // that was actually attempted succeeded: a failed/skipped merge (no
    // ffmpeg, no video captured, share mux error, ...) means the raw tracks
    // are the ONLY copy of that material, so they're never removed in that
    // case regardless of the pref.
    // #422 — per-PERSON audio: who is actually on each track, when.
    //
    // Gated on keepCallRecordingTracks rather than a switch of its own. That
    // pref already means "I am going to look at the raw material of this
    // recording", and there is no reason to keep the tracks but decline to
    // learn who is on them: a recorded remote-* track is NOT one participant,
    // so the tracks alone answer almost nothing without this.
    //
    // Labels only, not the per-person WAVs. Keeping the tracks is precisely
    // what makes the audio reproducible on demand — scripts/extract-speaker-
    // tracks.mjs regenerates it in a couple of minutes — so writing ~300MB per
    // person per hour automatically would spend a gigabyte a call to save one
    // command. attribution.json and the label tracks come to ~10MB and answer
    // every question asked of the corpus so far.
    let keepTracksPref = false;
    try { keepTracksPref = !!prefValue('keepCallRecordingTracks'); } catch { /* default off */ }
    if (keepTracksPref) {
      try {
        const { extractSpeakerTracks } = require('./speaker-extract.js');
        const { resolveFfmpegPath } = require('./call-media-merge.js');
        const res = await extractSpeakerTracks({
          tracksDir: dir,
          eventsFile: path.join(callDir, 'speaking-events.jsonl'),
          ffmpegPath: resolveFfmpegPath() || 'ffmpeg',
          writeAudio: false,
          cleanup: true, // the decode cache is ~300MB per slot and rebuildable
          log: (line) => console.log(`[speaker-extract] ${line}`),
        });
        if (res.ok) {
          console.log(`[speaker-extract] ${res.segments} segments, ${res.people.length} people, `
            + `${res.unresolved} unresolved -> ${res.outDir}`);
        } else {
          console.log(`[speaker-extract] skipped: ${res.reason}`);
        }
      } catch (err) {
        // Diagnostics must never be why a recording is lost.
        console.warn('[speaker-extract] failed:', err.message);
      }
    }

    const allAttemptedMergesOk = !!mainMerge?.ok && (!shareTrack || !!shareMerge?.ok);
    // #343: the recovery note's PRESENCE is what marks a recording as
    // unfinished, so it comes off here and nowhere earlier — this is the first
    // moment there is genuinely nothing left to do by hand. A skipped merge (no
    // ffmpeg, no video, cancelled) deliberately KEEPS it: the raw tracks are
    // then the only copy, and the note is what says so and how to finish them.
    if (allAttemptedMergesOk) {
      try { finishedSession?.removeRecoveryNote(); } catch { /* best-effort */ }
      if (!keepTracksPref) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          console.log(`[call-record] removed raw tracks (${dir}) — keepCallRecordingTracks is off`);
        } catch (err) {
          console.warn('[call-record] failed to remove raw tracks:', err.message);
        }
      } else {
        // keepTracksPref keeps the tracks dir — but the VIDEO track in it is
        // pure duplication once the merge has succeeded: video.webm is the raw
        // capture of the bot's Meet view and the mp4 beside it contains that
        // same footage, transcoded. It is also, by a distance, the largest
        // thing we write — measured across a 53-call archive, video.webm was
        // 30 GB of 39 GB, while the per-speaker audio that keepTracksPref
        // exists to preserve was 2.3 GB in total.
        //
        // So drop the video and keep everything else. What survives is exactly
        // what cannot be reconstructed from the mp4: one audio file per
        // participant (the #422 ground truth — the mp4 is mixed and cannot be
        // un-mixed), the manifest, and the per-track speaking events.
        //
        // Only on allAttemptedMergesOk. If the merge was skipped or cancelled
        // the raw video is the ONLY copy, the recovery note stays, and
        // scripts/finish-call-recording.mjs still has what it needs.
        for (const t of (manifest?.tracks || [])) {
          if (t.kind !== 'video') continue;             // 'share' is its own capture, not in the main mp4
          const p = path.join(dir, t.file || '');
          if (!t.file) continue;
          try {
            const bytes = fs.statSync(p).size;
            fs.rmSync(p, { force: true });
            console.log(`[call-record] removed ${t.file} (${Math.round(bytes / 1e6)} MB) — already in the muxed mp4`);
          } catch (err) {
            if (err.code !== 'ENOENT') console.warn(`[call-record] failed to remove ${t.file}:`, err.message);
          }
        }
      }
    }
  } finally {
    mergesInFlight--;
  }
}

// #343: the cheap half of stopping a recording, done SYNCHRONOUSLY, for the
// exits that cannot await anything — 'before-quit' above all.
//
// The split that makes this possible: closing the track fds and writing
// manifest.json are a handful of sync fs calls, while the ffmpeg merge is
// minutes of CPU. Holding up a quit for the merge would be absurd, but skipping
// the manifest was quietly catastrophic — it carries each track's
// startWallClock, the only thing that aligns the tracks to each other and to the
// transcript, and it cannot be reconstructed from the webm files afterwards. So
// quitting mid-recording used to leave a folder of orphan files that NOTHING
// could turn back into a recording.
//
// Now it leaves a complete, mergeable set plus the RECOVERY.md explaining how to
// finish it (see call-recorder.js's _writeRecoveryNote). The last ~1s of video
// is lost with the capture window, which is the right trade for a quit.
function finalizeRecordingSync(reason) {
  // Either a live recording, or one stopCallRecording has claimed but not yet
  // finalized (#606) — for the couple of awaits it spends closing the capture
  // windows the global is already null, and a quit landing in that window must
  // still get the manifest written. session.stop() is idempotent, so finalizing
  // here and again when stopCallRecording resumes costs nothing.
  const session = activeRecording || finalizingRecording;
  if (!session) return;
  activeRecording = null; // before stop(), so nothing re-enters on the way out
  finalizingRecording = null;
  stopRecordingStatsPush();
  try {
    const m = session.stop();
    console.log(`[call-record] ${reason}: finalized ${m.tracks.length} track(s) in ${session.dir} `
      + '(merge skipped — see RECOVERY.md in that folder to finish it)');
  } catch (err) {
    console.warn('[call-record] could not finalize recording on ' + reason + ':', err && err.message);
  }
}

// Explicit on/off for the start_recording / stop_recording MCP
// tools. Requires an active call to start (no tracks otherwise).
function setCallRecording({ on } = {}) {
  if (on) {
    const room = localServer?.roomId || null;
    if (!room) return { ok: false, code: 'not-in-call' };
    return startCallRecording(room, store?.get('botName') || null, { force: true });
  }
  return stopCallRecording();
}

function currentVoiceStatus() {
  const status = resolveVoice({
    ttsApiKey: store?.get('ttsApiKey'),
    ttsProvider: store?.get('ttsProvider'),
    voiceboxProfileId: store?.get('voiceboxProfileId'),
    platform: process.platform,
  });
  // A key can be PRESENT and dead. resolveVoice only asks whether one is set,
  // which is the right question for "can this bot make a sound" (it can — the
  // OS voice covers it) and the wrong one for "is your ElevenLabs key working".
  // Carried alongside rather than folded in, so canSpeak keeps meaning what it
  // means and Settings can show the key problem where the key is EDITED.
  return elevenLabsKeyProblem
    ? { ...status, keyProblem: { kind: elevenLabsKeyProblem.kind, message: elevenLabsKeyProblem.message } }
    : status;
}

// A bot with no voice used to join and simply never make a sound — indis­tin­guish­able,
// from the room's side, from one that had crashed or wasn't listening. It now says
// so out loud, once, using a pre-recorded clip (it cannot synthesise the sentence
// for the very reason it needs to say it), and tells its agent to use chat.
let _noVoiceAnnouncedFor = null;
function announceNoVoiceOnce() {
  const room = localServer.roomId;
  const status = currentVoiceStatus();
  if (status.canSpeak || !room || _noVoiceAnnouncedFor === room) return;
  _noVoiceAnnouncedFor = room;
  console.log('[electron] No voice available — announcing in-call and switching to chat.', status.reason);
  try {
    localServer.onPlayAudio({ path: noVoiceClipPath, emoji: '\u{1F507}' });
  } catch (err) {
    // The clip is a courtesy to the room; the agent instruction below is the
    // part that actually keeps the call working, so never let this stop it.
    console.warn('[electron] No-voice clip failed to play:', err.message);
  }
  // Rides the status.errors channel the agent already reads on each lull, the
  // same way the ElevenLabs-fallback notice does.
  localServer.addError(
    'You have NO VOICE in this call: ' + status.reason
    + ' A short recorded notice has been played to the room telling them you will type instead. '
    + 'Do not call speak — nothing will be heard. Use send_chat for every reply, and keep them '
    + 'brief since people are reading rather than listening. '
    // Wear the state on the face too. 😶 is already this app's "no mouth — will
    // act but cannot speak" (MODE_EMOJIS.silent in page-inject.js), so a
    // voiceless bot showing it reads the same way silent mode does — the room
    // can see the reason instead of watching a smiling face say nothing.
    //
    // Asked of the agent rather than forced by the renderer because the agent
    // already owns its face via set_avatar_emoji, and this needs no new state
    // plumbed through to the camera. Set BOTH: the idle override always applies,
    // but the listening one is only honoured in active mode (page-inject.js).
    + 'Also call set_avatar_emoji with idle:"\u{1F636}" and listening:"\u{1F636}" so the room can SEE '
    + 'you have no voice rather than wondering why you are quiet. '
    + 'If someone asks how to give you a '
    + 'voice, tell them: open the app, add an ElevenLabs API key in App Settings, or run Voicebox locally.'
  );
}

// ── After-call work (#139) ───────────────────────────────────────────────────
// The bot has left the Meet. Its agent may still have work to do — summarising,
// filing, writing a receipt — and until it says otherwise the call's state has to
// stay exactly where it is.
//
// Gated on the afterCallWorkSeconds preference, 300s by default. That default is
// a BACKSTOP, not a schedule: an agent that finishes calls end_session and the
// app tears down at once, so the usual cost is seconds. Setting it to 0 turns the
// phase off and reproduces the old teardown-on-leave exactly.
let _afterCallWorkTimer = null;

// Bot names already spoken for on this machine.
//
// Used both when naming a NEW bot and when offering candidates during setup: two
// bots answering to one name is not merely confusing, since MCP routes by name.
function takenBotNames() {
  try {
    const profileManager = require('./profile-manager.js');
    return profileManager.listProfiles(PROFILES_ROOT).map((p) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(PROFILES_ROOT, p.name, 'config.json'), 'utf-8')).botName;
      } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function beginAfterCallWorkOrTeardown(reason) {
  // Through the schema, NOT store.get(): a raw read returns undefined for any
  // profile that has never set this, so `Number(undefined) || 0` disabled the
  // phase everywhere despite a 300s default. The default only ever showed up in
  // list_preferences, and this gate disagreed with afterCallWorkPlan() — which
  // does resolve the default, so the agent was told it had 300 seconds while the
  // app tore the call down immediately.
  const seconds = Number(prefValue('afterCallWorkSeconds')) || 0;
  // No agent driving means nobody to do the work — #156 already tracks this, so
  // a button-only call (or one whose agent died) tears down as it always did
  // rather than waiting out a timer for a session that cannot answer.
  const hasAgent = (() => {
    try { return !localServer.agentAbsentInCall(); } catch { return false; }
  })();

  if (seconds <= 0 || !hasAgent) {
    console.log('[electron] Call ended (' + reason + ') — tearing down'
      + (seconds > 0 && !hasAgent ? ' (no agent to do after-call work)' : ''));
    finishCall();
    return;
  }

  console.log('[electron] Call ended (' + reason + ') — entering after-call work for up to ' + seconds + 's');
  // From here the live agent is finishing the call it was launched for, not
  // serving a live one. That, not the meet code, is what makes it a lame duck:
  // calling a bot back into the SAME room is a new call, and keying on the code
  // made the reuse guard say "same call" about an agent already winding down
  // (observed 20:51:31 on 2026-08-23, right after this fix's first outing).
  headlessAgentCallOver = true;
  localServer.setCallStatus('after-call-work');
  clearTimeout(_afterCallWorkTimer);
  // A backstop, not a schedule. Nothing reaps a terminal window on its own, so an
  // agent that never says it is finished would otherwise leave one open forever —
  // the stale-process failure, reintroduced.
  _afterCallWorkTimer = setTimeout(() => {
    console.warn('[electron] After-call work hit its ' + seconds + 's limit — finishing');
    finishCall();
  }, seconds * 1000);
}

// The one clean way to leave a Meet call, whichever side asked for it (the
// agent's leave_call tool or the panel's Leave Call button). Clicks Google's
// own "Leave call" button BEFORE navigating the view away — skipping that
// (the old panel-button behavior) just killed the media connection on
// nav-away and left a ghost participant for others until Google's timeout
// reaped it — then hands off to beginAfterCallWorkOrTeardown for the rest.
function requestCleanLeave(reason) {
  // #209: finalize any call audio(+video) recording before teardown. Async
  // now (video stop + merge are real work) — fire-and-forget, teardown must
  // not block on it; errors are already logged inside.
  stopCallRecording().catch((err) => console.warn('[call-record] stop on leave failed:', err.message));
  stopAllRunwayFaces('leave-call'); // P2: end Runway sessions + timers when leaving the call
  shareIntended = false; // no present is pending once we're leaving
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
  // real "Leave call" button drops our participant tile immediately.
  const LEAVE_CLICK_SETTLE_MS = 1000;
  const performLeave = () => {
    if (meetView && !meetView.webContents.isDestroyed()) {
      meetView.webContents.send('trigger-leave-call');
    }
    // Let the click register with Google's servers, then END THE BOT'S
    // PARTICIPATION — which is not the same as tearing the app down.
    //
    // If after-call work is enabled, the bot enters that phase here and the
    // teardown waits for it: the room, the transcript and every tool stay live
    // while the agent wraps up. Otherwise this is the old behaviour, teardown
    // immediately. See call-phase.js.
    setTimeout(() => beginAfterCallWorkOrTeardown(reason), LEAVE_CLICK_SETTLE_MS);
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
}

// End of the lifecycle: the app-side teardown finally runs. Routed through the
// panel because that is where the existing leave path lives — showIdle, the
// terminal close and clearRoom all hang off it.
// #255 — sharing ONE call's log.
//
// Deliberately NOT a preference. remoteLogging is an app-level setting someone
// chose; this is a one-call grant made in the moment, and the two must not
// share storage or teardown. Keeping the grant in memory makes the scoping
// structural rather than a matter of remembering to clean up: a crash or
// force-quit cannot leave sharing switched on, and there is nothing to
// reconcile at the next launch.
//
// _sharedCallId  — which call the user granted (so a second press is a no-op)
// _sharingWeEnabled — did OUR grant turn streaming on? Only then may call end
//                     turn it off. If remoteLogging was already on, the user's
//                     standing preference must survive the call.
let _sharedCallId = null;
let _sharingWeEnabled = false;

function revokeCallLogShare(reason) {
  if (!_sharedCallId) return;
  if (_sharingWeEnabled) {
    const { setRemoteLoggingEnabled } = require('./session-log.js');
    setRemoteLoggingEnabled(false);
    console.log('[electron] call-log share ended (' + reason + ') — streaming back off');
  }
  _sharedCallId = null;
  _sharingWeEnabled = false;
}

// The actual teardown. It lives here, callable from main, rather than only at
// the end of a main → renderer → main round trip.
//
// #254: the round trip was the whole bug. finishCall() set 'call-complete' and
// sent 'leave-requested' to the panel; only the panel's reply ran clearRoom(),
// and clearRoom() is what sets 'idle'. So any break in that loop — a destroyed
// panelView, a renderer that never answers — stranded the session at
// 'call-complete' forever. Joins only navigate from a settled state, so
// Bethany Crystal's app accepted SEVEN join_call requests for a new meeting and
// silently dropped every one, telling her agent "navigating to the call" each
// time. Recovery needed a quit and relaunch. (This is #229's shape: state that
// depends on a specific window hearing a message.)
//
// Idempotent, because the watchdog and the panel reply race by design and both
// must be safe.
let _teardownDone = false;
// #422: one audio-device sample per call edge, never two. Fire-and-forget —
// system_profiler takes a few hundred ms and a join must never wait on
// diagnostics.
let _audioSampledInCall = false;
function logAudioDevicesOnCallEdge(status) {
  const { sampleAudioDevices, formatAudioDevices } = require('./audio-devices.js');
  const emit = (phase) => {
    sampleAudioDevices()
      .then((parsed) => {
        const line = formatAudioDevices(parsed, phase);
        if (line) console.log(ts(), line);
      })
      .catch(() => { /* diagnostics never break a call */ });
  };
  if (status === 'in-call' && !_audioSampledInCall) { _audioSampledInCall = true; emit('join'); }
  else if (_audioSampledInCall && status !== 'in-call') { _audioSampledInCall = false; emit('leave'); }
}

function performLeaveTeardown(via) {
  clearTimeout(_idleWatchdog);
  _idleWatchdog = null;
  if (_teardownDone) return;
  _teardownDone = true;
  currentMeetUrl = null;
  detectedMeetUrl = null; // Reset so detection will re-notify about the same Meet
  // Each step is independent: a throw in one must not strand the rest, because
  // the whole point is that reaching 'idle' cannot be conditional. clearRoom()
  // is what sets 'idle', so it goes first — if anything here is going to fail,
  // the session should already be joinable by the time it does.
  const step = (name, fn) => {
    try { fn(); } catch (err) {
      console.error(ts(), '[electron] teardown step "' + name + '" failed:', err && err.message);
    }
  };
  step('clearRoom', () => localServer.clearRoom());
  // #326: every leave route converges here, so this is where the recording has
  // to end. Before this, only onLeaveCall (agent leave_call / auto-leave /
  // host-ended) stopped it — the panel's Leave button reaches teardown via
  // 'leave-meet' and stopped nothing, so capture kept running against a dead
  // call until someone clicked Stop: 24s of "recording" an idle view on the
  // 2026-08-11 stand-up, and a stale activeRecording that would have made the
  // next startCallRecording return {already:true}. Placed after clearRoom (which
  // is what sets 'idle' — that ordering is load-bearing) but BEFORE showIdle,
  // which navigates meetView to the idle page: after that the audio tracks are
  // gone and there is nothing left to finalize. No-op when no recording is
  // active, so it's harmless on the routes where onLeaveCall already fired it.
  step('stopCallRecording', () => {
    stopCallRecording().catch((err) => console.warn('[call-record] stop on teardown failed:', err.message));
  });
  step('closeClaudeTerminal', () => closeClaudeTerminal());
  step('showIdle', () => showIdle());
  console.log(ts(), '[electron] Call teardown complete (via ' + via + ') — status',
    localServer.callStatus);
  // Identity cache is cleared at *join* time, not here — so it doesn't
  // matter how the previous call ended (host-ended, app quit, crash).
}

// How long to let the panel do its own teardown before main does it anyway.
// Generous: the normal path finishes in well under a second, so anything near
// this is already a fault, and a late-but-correct teardown beats a wedged app.
const IDLE_WATCHDOG_MS = 10000;
let _idleWatchdog = null;

function finishCall() {
  clearTimeout(_afterCallWorkTimer);
  _afterCallWorkTimer = null;
  // #255: a shared-log grant was for THIS call. Revoking here rather than
  // trusting the next call to notice is what keeps "share this one" honest.
  revokeCallLogShare('call ended');
  _teardownDone = false;
  localServer.setCallStatus('call-complete');
  if (panelView && !panelView.webContents.isDestroyed()) {
  // ADDRESSED, not broadcast (#229). This is a COMMAND: the panel replies with
  // 'leave-meet', which runs teardown. Three windows would each reply, so the
  // teardown would run three times.
    panelView.webContents.send('leave-requested');
  } else {
    // No panel to ask. Don't wait out the watchdog for a reply that provably
    // cannot come.
    console.warn(ts(), '[electron] No panel to run teardown — doing it here');
    performLeaveTeardown('no-panel');
    return;
  }
  clearTimeout(_idleWatchdog);
  _idleWatchdog = setTimeout(() => {
    console.error(ts(), '[electron] #254: panel never completed teardown in '
      + (IDLE_WATCHDOG_MS / 1000) + 's — forcing idle so the next join is not dropped');
    try {
      localServer.addError('Call teardown stalled: the app forced itself back to idle after '
        + (IDLE_WATCHDOG_MS / 1000) + 's. The previous call may still be open in the Meet view. '
        + 'Joining a new call should work; if it does not, quit and relaunch.');
    } catch { /* addError is best-effort */ }
    performLeaveTeardown('watchdog');
  }, IDLE_WATCHDOG_MS);
  if (_idleWatchdog.unref) _idleWatchdog.unref();
}

// The walk takes a second or two and captions-ready can fire repeatedly in that
// window. The success latch alone can't stop a second walk starting before the
// first finishes, so the automatic paths also hold this while one is running.
// (An explicit set_caption_language is not gated by it — the agent asked.)
let _captionLanguageInFlight = false;

function applyCaptionLanguagePref() {
  const want = String(store?.get('captionLanguage') || '').trim();
  if (!want) return;                                     // unset = leave Meet alone
  const room = localServer.roomId;
  if (!room || _captionLanguageInFlight || captionLanguageAlreadyApplied(room, want)) return;
  _captionLanguageInFlight = true;
  localServer.onSetCaptionLanguage({ language: want })
    .then((r) => {
      if (r && r.ok) console.log('[electron] Caption language applied on join:', r.language);
      // A failure needs no un-latching: onSetCaptionLanguage only records the
      // language when it actually succeeded, so the next captions-ready retries.
      else console.warn('[electron] Caption language on join failed:', r && r.error);
    })
    .catch((err) => { console.warn('[electron] Caption language on join threw:', err.message); })
    .finally(() => { _captionLanguageInFlight = false; });
}

function callViewRequest(channel, payload, resultEvent, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const wc = callCmdWC(channel);
    if (!wc) {
      resolve({ ok: false, error: 'No active call view' });
      return;
    }
    const requestId = `${channel}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const timer = setTimeout(() => {
      ipcMain.removeListener(resultEvent, handler);
      resolve({ ok: false, error: `${channel} timed out` });
    }, timeoutMs);
    const handler = (_event, data) => {
      if (data?.requestId !== requestId) return;
      clearTimeout(timer);
      ipcMain.removeListener(resultEvent, handler);
      resolve(data);
    };
    ipcMain.on(resultEvent, handler);
    wc.send(channel, { requestId, ...payload });
  });
}

// NOTE: a timeout here does NOT mean the renderer flow stopped — it keeps
// running and may still send. Callers must treat CHAT_TIMEOUT_ERROR as
// "unknown, possibly still in flight" and never retry on it (a retry queues
// a duplicate send behind the one that may yet succeed).
const CHAT_TIMEOUT_ERROR = 'Chat operation timed out';
function chatRequest(channel, payload, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const wc = callCmdWC(channel);
    if (!wc) {
      resolve({ ok: false, error: 'No active call view' });
      return;
    }
    const requestId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const timer = setTimeout(() => {
      ipcMain.removeListener('chat-result', handler);
      resolve({ ok: false, error: CHAT_TIMEOUT_ERROR });
    }, timeoutMs);
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

// The ElevenLabs voice_settings preferences (#594). They pass straight through
// to tts.updateConfig under the same names, so they are listed once here and
// used by BOTH the boot-time load and the live-apply path. Those two drifting
// apart is exactly how a setting ends up saved, shown in the panel, and not
// actually applied until a restart.
const VOICE_SETTING_KEYS = ['ttsSpeed', 'ttsStability', 'ttsSimilarityBoost', 'ttsStyle', 'ttsSpeakerBoost'];

const tts = new globalThis.TTSProvider();
const stt = new globalThis.STTProvider();
const sync = new globalThis.SyncClient({
  // Merge the website's room presence into the local roster. The local list is
  // otherwise written only by posts to THIS instance's local server, so it holds
  // exactly one bot — itself — and the barge-in check's "is this interrupter a
  // bot?" question could never come back yes for a peer.
  onMembers: (members) => {
    localServer.mergeRemoteMembers(members);
  },
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
  // The bot workdir, so afterCallWorkPlan can inline CLAUDE.md's after-call
  // duties for sessions that don't run in that directory (terminal-driven).
  getAgentWorkdir: () => require('./agent-workdir.js').agentDirFor(app.getPath('userData')),

  // A write-up a re-join cut short. Persisted rather than held in memory: the
  // whole point is that it survives the agent that was doing it, and it should
  // survive an app restart in between too.
  getUnfinishedWrapUp: () => { try { return store.get('agentUnfinishedWrapUp') || null; } catch { return null; } },
  clearUnfinishedWrapUp: () => { try { store.set('agentUnfinishedWrapUp', null); } catch { /* noop */ } },

  // Claude-ready feedback loop: a launched Claude session's SessionStart hook POSTs here
  // once it's up — which only happens when Claude Code is BOTH installed and signed in
  // (a session can't start otherwise). Open, localhost-only, no side effects but flipping
  // the flag. See markClaudeReady + ensureClaudeReadyHook.
  extraRoutes: async (req, res) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; } catch { return false; }
    // Turn the CALLER's Claude session into a bot (/call-new-bot). An HTTP route
    // rather than only IPC because the caller is a terminal, not the panel.
    if (pathname === '/api/adopt-session-as-bot' && req.method === 'POST') {
      let body = '';
      try {
        body = await new Promise((resolve) => {
          let buf = '';
          req.on('data', (c) => { buf += c; });
          req.on('end', () => resolve(buf));
          req.on('error', () => resolve(''));
        });
      } catch { /* no body */ }
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch { /* not JSON */ }
      let result;
      if (!adoptSessionAsBot) {
        result = { ok: false, error: 'The app is still starting up — try again in a moment.' };
      } else {
        try { result = await adoptSessionAsBot(payload); }
        catch (err) { result = { ok: false, error: err.message }; }
      }
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return true;
    }
    if (pathname === '/claude-ready' && req.method === 'POST') {
      markClaudeReady('session-hook');
      // The hook forwards its stdin, which carries session_id — the id to
      // --resume on the next launch. Best-effort by design: an older hook (or a
      // curl that could not read stdin) posts an empty body, and readiness above
      // must still be recorded. See ensureClaudeReadyHook.
      let body = '';
      try {
        body = await new Promise((resolve) => {
          let buf = '';
          req.on('data', (c) => { buf += c; });
          req.on('end', () => resolve(buf));
          req.on('error', () => resolve(''));
        });
      } catch { /* no body */ }
      try {
        const payload = JSON.parse(body || '{}');
        if (payload && payload.session_id) recordAgentSessionId(payload.session_id);
      } catch { /* not JSON — pre-session-id hook */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }
    return false;
  },

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
  getConfiguredBotName: () => resolvedBotName(),
  // Candidate names for the setup call's "what should I be called" step.
  getTakenBotNames: () => takenBotNames(),
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
  // Returns delivery status so the caller can tell the bot the truth (#221).
  // Was fire-and-forget with a bare .catch(), which caught NETWORK errors only —
  // a 500 from the sync server is a resolved promise, so an outage that dropped
  // every board write logged nothing and still reported success to the bot.
  onWhiteboardUpdate: async (content, sender) => {
    console.log('[local-server] Whiteboard update from', sender, ':', content.slice(0, 80));
    const roomId = localServer.roomId;
    if (roomId) {
      const baseUrl = getWebsiteUrl();
      const roomUrl = whiteboardShareUrl(baseUrl, roomId);

      // If the whiteboard window was navigated to an external URL (via load-url),
      // navigate it back to the room page so it can receive SSE updates
      if (whiteboardWindow && !whiteboardWindow.isDestroyed()) {
        const currentUrl = whiteboardWindow.webContents.getURL();
        if (!currentUrl.includes('/room/')) {
          console.log('[local-server] Whiteboard showing external URL, navigating back to room');
          whiteboardWindow.loadURL(roomUrl);
        }
      }

      // Forward to remote sync server so the whiteboard window picks it up.
      // RETURNED, not fired off: the caller reports delivery to the bot, and a
      // bare call here would fall through to the no-room `delivered: null`
      // below — which reads as "nothing to deliver to" and hides the failure
      // just as thoroughly as the old fire-and-forget did.
      return fetch(`${baseUrl}/api/sync/${roomId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender,
          ...(selfRole() ? { role: selfRole() } : {}),
          ownerName: sender,
          whiteboard: { content },
        }),
      }).then(async (resp) => {
        if (resp.ok) {
          // A 200 is not enough. The sync server catches a failed whiteboard
          // write into results.whiteboard = { ok: false, error } and STILL
          // returns 200 { success: true } — so during the Aug 1 rate limit our
          // writes were reported delivered and never persisted. The board still
          // held the previous call's content afterwards, which is how this was
          // caught: it survived the outage that supposedly wrote over it.
          let body = null;
          try { body = await resp.json(); } catch { /* not JSON — treat as delivered */ }
          const wb = body?.results?.whiteboard;
          if (wb && wb.ok === false) {
            const error = `sync server accepted the request but did not store it${wb.error ? `: ${wb.error}` : ''}`;
            console.error('[local-server] Whiteboard write NOT persisted:', error);
            return { delivered: false, error };
          }
          return { delivered: true };
        }
        // Body first — the sync server puts the real reason there; the status
        // alone ("500") tells the bot nothing it can act on or repeat aloud.
        let detail = '';
        try { detail = ((await resp.json())?.error) || ''; } catch { /* not JSON */ }
        const error = `sync server ${resp.status}${detail ? `: ${detail}` : ''}`;
        console.error('[local-server] Whiteboard update REJECTED by sync server:', error);
        return { delivered: false, error };
      }).catch((err) => {
        console.error('[local-server] Failed to forward whiteboard update:', err.message);
        return { delivered: false, error: `could not reach the sync server (${err.message})` };
      });
    }
    // No room means no shared board to deliver to — local-only, not a failure.
    return { delivered: null };
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
        body: JSON.stringify({ sender, ...(selfRole() ? { role: selfRole() } : {}),
          ownerName: sender, whiteboardStyle: css }),
      });
    } catch (err) {
      console.error('[local-server] Failed to forward whiteboard style:', err.message);
      return;
    }
    // Style is persisted — refresh the shared board so it inherits it now.
    reloadWhiteboardWindow('style change');
  },
  onReloadWhiteboard: () => {
    // Explicit reload (reload_share tool): re-fetch the shared board's
    // content + style without changing anything. No-op if nothing's shared.
    return reloadWhiteboardWindow('explicit reload');
  },
  onListFonts: () => listLocalFonts(),

  onJoinCall: (meetCode, botName) => {
    console.log('[local-server] Join call requested by agent:', meetCode, botName);
    // Joining cancels any pending after-call teardown.
    //
    // leave_call arms a timer (afterCallWorkSeconds, 300 by default) that ends
    // the agent when the wrap-up window expires. Nothing cleared it on a JOIN, so
    // an agent that left and came back inside that window was still carrying its
    // own execution date: the timer fired mid-call, tore the call down and killed
    // the agent, for no reason visible from inside the room.
    //
    // That makes leave-then-rejoin viable, which matters — it is the only way to
    // change the Meet display name, since Meet takes it at join (#249).
    if (_afterCallWorkTimer) {
      console.log('[electron] Join during after-call work — cancelling the pending teardown');
      clearTimeout(_afterCallWorkTimer);
      _afterCallWorkTimer = null;
    }
    // #254: a join is also the loudest possible signal that the previous call is
    // over. If teardown was started but never finished, don't make this join
    // wait out the watchdog (or, before the watchdog existed, wait forever) —
    // finish it now, then navigate from a settled state.
    if (localServer.callStatus === 'call-complete' && !_teardownDone) {
      console.warn(ts(), '[electron] Join arrived with teardown unfinished — completing it first');
      performLeaveTeardown('join');
    }
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
  // The agent has finished its after-call work. Ends the phase now instead of
  // waiting out the backstop.
  onEndSession: () => {
    console.log('[local-server] After-call work finished by the agent — tearing down');
    finishCall();
  },

  onLeaveCall: () => {
    console.log('[local-server] Leave call requested by agent');
    requestCleanLeave('agent');
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
  onShareWhiteboard: () => {
    console.log('[local-server] Whiteboard share requested by agent');
    const meetCode = localServer.roomId;
    if (meetCode) {
      // `sharing` is the PUBLISHED, honest presenting state: it goes true only
      // when the provider confirms we are actually presenting ("Stop presenting"
      // in the Meet/Slack DOM, via selfPresenting → setSharing). Do NOT pre-set it
      // here on either platform — the present flow engages a few seconds later
      // (Meet's Present-now retry loop below; Slack's popup click), so an
      // optimistic true would claim a share that hasn't started (or silently
      // failed) and let a too-early stop get masked. Intent — "the agent asked to
      // present" — lives in `shareIntended`, kept separate so status never lies
      // about what is really on screen. (#282: the old optimistic Meet flag made
      // status.sharing flicker true→false during spin-up, which the whiteboard-e2e
      // harness misread as an "environmental" share collapse.)
      shareIntended = true;
      {
        // Whiteboard share — open whiteboard window first.
        externalShareRequest = null; // POC: switching to the whiteboard drops any tab source
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
          // Wait for the call before clicking anything. A share requested while
          // Meet is still on "Getting ready…" has no Present button to find, and
          // the old fixed 5×2s budget could expire entirely inside that window —
          // the share then failed silently, having burned all five attempts
          // clicking at a page that had not loaded yet. Joining is not on a
          // budget here: the generation token still cancels this loop on
          // stop/leave/new-share, so waiting cannot strand it.
          const joinDeadline = Date.now() + PRESENT_JOIN_WAIT_MS;
          while (localServer.callStatus !== 'in-call' && Date.now() < joinDeadline) {
            await new Promise((r) => setTimeout(r, 500));
            if (myGen !== shareGeneration) {
              console.log('[electron] Whiteboard share: Present trigger loop cancelled while waiting to join');
              return;
            }
          }
          if (localServer.callStatus !== 'in-call') {
            console.warn('[electron] Whiteboard share: still not in call after',
              Math.round(PRESENT_JOIN_WAIT_MS / 1000) + 's (status: ' + localServer.callStatus + ')',
              '— triggering anyway');
          }

          // Then retry until Meet confirms we are presenting. Backs off so a
          // slow-but-working share isn't hammered (and so a genuinely broken
          // one doesn't emit a screen-share error every 2s for the whole
          // window): ~1.8s, 2s, 3s, 4s… capped, ending near PRESENT_RETRY_MS.
          const retryDeadline = Date.now() + PRESENT_RETRY_MS;
          let attempt = 0;
          let waitMs = 1800;
          while (Date.now() < retryDeadline) {
            await new Promise((r) => setTimeout(r, waitMs));
            waitMs = Math.min(Math.round(waitMs * 1.4), 8000);
            attempt++;
            if (myGen !== shareGeneration) {
              console.log('[electron] Whiteboard share: Present trigger loop cancelled (superseded by stop/leave/new share)');
              return;
            }
            // Stop as soon as the share is really engaged. `sharing` is now the
            // provider's confirmed read of the actual UI ("Stop presenting"
            // visible) on BOTH platforms — no longer set optimistically — so it is
            // the honest engagement signal. This matters beyond tidiness on Slack,
            // where the control is a single TOGGLE and a late re-click would flip
            // sharing back OFF.
            if (localServer.sharing) {
              console.log('[electron] Whiteboard share: engaged (attempt ' + attempt + ') — stopping retries');
              return;
            }
            if (meetView && !meetView.webContents.isDestroyed()) {
              console.log('[electron] Whiteboard share: Present-now trigger attempt ' + attempt);
              sendCallCmd(CALL_COMMANDS.triggerScreenShare, { shareType: 'window' });
            } else {
              console.warn('[electron] Whiteboard share: meetView unavailable on Present trigger attempt ' + attempt + ' (#269)');
            }
          }
          if (myGen !== shareGeneration) return;
          if (localServer.sharing) return;
          // Give up loudly. `sharing` is already false here (it only ever goes
          // true on a confirmed present), so the app — and any agent reading
          // status — correctly sees "not sharing" rather than a board nobody can
          // see. Clear the intent so nothing keeps believing a present is pending.
          console.error('[electron] Whiteboard share: never engaged after',
            Math.round(PRESENT_RETRY_MS / 1000) + 's and ' + attempt + ' attempts — giving up');
          shareIntended = false;
          localServer.setSharing(false);
          localServer.addError('Screen share never started — Meet did not accept the Present-now trigger.');
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
            // surface=viewer marks this as a link a PERSON will open, which is
            // what lets the web page show a signup CTA here and never on the
            // board we are screen-sharing (surface=share). The two URLs used to
            // be identical, so the page had no way to tell them apart — and the
            // bot's capture window runs on a session with a plain Chrome user
            // agent, so there was no passive signal to fall back on either.
            //
            // #102: this used to say src=chat. Wrong axis — that describes where
            // the link CAME FROM, and the same human-facing URL also reaches
            // people via get_room_info, pasted into email, or read aloud. What
            // the page needs to know is WHO IS LOOKING, so it pairs with
            // surface=share as one parameter with two values. src= is kept
            // alongside as optional provenance for analytics ONLY — never the
            // thing the CTA keys off.
            const url = `${base}/room/${meetCode}?mode=whiteboard&surface=viewer&src=chat`;
            // #241: the chat pane can be slow/flaky to open right after a share,
            // so retry a few times rather than failing on one bad attempt (the
            // user may only share once, so "retry on next share" wasn't enough).
            let posted = false;
            for (let i = 1; i <= 3 && !posted; i++) {
              // 45s: a send flow can legitimately take a long time right after a
              // share (chat pane contention with speaker tracking). The generous
              // timeout is what makes "timed out" trustworthy enough to act on.
              const result = await chatRequest(CALL_COMMANDS.sendChat, { text: `Whiteboard (live): ${url}` }, 45000);
              if (result?.ok) {
                posted = true;
                console.log('[main] #189 posted whiteboard link to chat:', url);
              } else if (result?.error === CHAT_TIMEOUT_ERROR) {
                // The renderer flow may still be typing/sending — retrying here is
                // exactly what interleaved three copies of this link into one
                // gibberish chat message. Stop; the link may yet post on its own.
                console.warn('[main] #189 whiteboard link post attempt', i, 'timed out — not retrying (send may still be in flight)');
                break;
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
    shareIntended = false;
    // POC (share-agent-tab): if we were sharing an external browser tab, close
    // its throwaway (isolated) window on stop so no window is left hanging.
    const stoppedTabUrl = externalShareRequest && externalShareRequest.url;
    externalShareRequest = null;
    if (stoppedTabUrl) {
      require('./share-external-tab.js').closeShareWindowByUrl(stoppedTabUrl)
        .then((r) => console.log('[electron] closed external-tab share window:', r.ok))
        .catch(() => { /* best-effort tidy-up */ });
    }
    shareGeneration++; // cancel any in-flight Present-now retry loop (it would re-toggle Slack)
    const myShareGen = shareGeneration; // see the generation check below, before this IIFE closes the window
    // Click Meet's "Stop presenting" button — works for both whiteboard and full-screen shares
    if (meetView && !meetView.webContents.isDestroyed()) {
      sendCallCmd(CALL_COMMANDS.triggerStopSharing);
    }
    // Extension: stop the whiteboard-share side capture BEFORE closing
    // whiteboardWindow — its source frame is about to go away, so the capture
    // must flush its final chunk while the window (and the frame it's
    // capturing) still exist. onStopSharing itself stays synchronous (callers
    // don't await it); the window-close is what waits, via this async IIFE.
    (async () => {
      try {
        await stopShareCaptureIfActive();
      } catch (err) {
        console.warn('[call-record] share capture stop failed:', err.message);
      }
      // A fast re-share can land while the await above is still in flight —
      // its 'start-whiteboard-share'/'share-whiteboard' handler sees this
      // SAME whiteboardWindow (still non-null/non-destroyed from here) and
      // reuses it rather than creating a new one. Closing unconditionally at
      // this point would tear down the window the new share now depends on
      // and null the reference out from under it. Both re-share entry points
      // bump shareGeneration on start (same guard startShare's own retry
      // loop uses), so a mismatch here means exactly that happened — leave
      // the window alone; it's no longer this stop's to close.
      if (shareGeneration !== myShareGen) return;
      // Close the whiteboard window — this ends the display media stream for whiteboard shares
      closeWhiteboardWindow('stop sharing');
    })();
  },
  // POC (share-agent-tab): the 'share-tab' action lands here with the URL the
  // agent is browsing. Resolve → stash → Present-now (see startExternalTabShare).
  onShareTab: (url, appName) => { startExternalTabShare({ url, appName }); },
  onLoadUrl: (url) => {
    console.log('[local-server] Load URL in whiteboard:', url);
    if (whiteboardWindow && !whiteboardWindow.isDestroyed()) {
      whiteboardWindow.loadURL(url);
    } else {
      whiteboardWindow = createWhiteboardWindow(url);
    }
  },
  // Profile switcher (#282): a sibling instance asked us to come forward.
  // /call → POST /api/call/start → the same path the panel button takes.
  onStartCall: (opts) => createAndJoinMeet(opts),
  onRecord: (opts) => setCallRecording(opts), // #209: start/stop call recording

  onFocusRequest: () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    if (app.dock) app.dock.show();
    app.focus({ steal: true });
  },
  // Silence the shared surface's audio without touching the share itself.
  //
  // The mute itself happens in page-inject, on the gain node feeding the track
  // Meet publishes. Not here: webContents.setAudioMuted() mutes this machine's
  // speakers, and the capture tap sits upstream of that — a call verified the
  // asymmetry, with the host laptop silent while a remote device heard the
  // board. So the host already hears nothing during a share, and muting the
  // window would only silence a local output nobody is listening to.
  // The caption language the bot listens in. Fire-and-report: the provider walks
  // Meet's Settings dialog, which takes a second or two, so we await it and hand
  // the real outcome back rather than an optimistic ok — a silently-failed change
  // here leaves the bot hearing nonsense, which is the whole failure this guards.
  onSetCaptionLanguage: async ({ language } = {}) => {
    const want = String(language || '').trim();
    if (!want) return { ok: false, error: 'Provide a language (e.g. "es-ES", "en-GB", "fr-FR")' };
    if (localServer.callStatus !== 'in-call') {
      return { ok: false, error: 'Not in a call — the caption language is a per-call Meet setting' };
    }
    // Round-trip through the call view — it owns the DOM walk and reports which
    // tag Meet actually selected, which can differ from what was asked ("es" →
    // "es-ES"). Same requestId pattern as chatRequest; 30s because this clicks
    // through a menu, a tab and a listbox with verification at each step.
    const result = await callViewRequest(
      CALL_COMMANDS.setCaptionLanguage,
      { language: want },
      CALL_EVENTS.captionLanguageResult,
      30000,
    );
    if (result && result.ok) {
      console.log('[local-server] Caption language →', result.language);
      // Record what's now live, so the other paths into here (the join-time
      // pref, a preference write) can see the work is already done rather than
      // walking Meet's Settings dialog a second time for the same value.
      _captionLanguageApplied = { room: localServer.roomId, requested: want, resolved: result.language };
      // PERSIST it as this bot's own language.
      //
      // Meet stores its "Language of the meeting" against the shared browser
      // session, not the bot — so without this the choice leaks and is lost at
      // the same time. Observed: a bot set to German left Meet in German, and
      // every bot created afterwards started in German, because an unset
      // captionLanguage means "leave whatever Meet already has". Meanwhile the
      // German bot had not saved anything either, so it was only still German
      // by accident.
      //
      // Storing it makes the language the BOT'S property: re-applied on its next
      // join, which also overwrites whatever another bot left behind.
      try {
        if (store && store.get('captionLanguage') !== result.language) {
          store.set('captionLanguage', result.language);
          console.log('[local-server] Saved captionLanguage =', result.language, '(this bot, future calls)');
        }
      } catch (err) {
        console.warn('[local-server] Could not save captionLanguage:', err.message);
      }
    } else console.warn('[local-server] Caption language change failed:', result && result.error);
    return result;
  },
  onSetShareAudio: async ({ muted } = {}) => {
    const want = !!muted;
    if (!whiteboardWindow || whiteboardWindow.isDestroyed()) {
      return { ok: false, error: 'Nothing is being shared' };
    }
    sendExtMsg({ action: CALL_COMMANDS.ACTIONS.setShareAudio, payload: { muted: want } });
    shareAudioMuted = want;
    console.log('[local-server] Share audio', want ? 'muted' : 'unmuted');
    return { ok: true, muted: want };
  },
  // Resize the shared board. Works with or without a live share: with one, the
  // window resizes and the capture follows; without, the size is remembered and
  // the next share opens at it. That symmetry is deliberate — a bot setting up
  // a board shouldn't have to know whether it is already presenting.
  onSetShareSize: async ({ width, height } = {}) => {
    const resolved = resolveShareSize({ width, height }, shareSize);
    shareSize = { width: resolved.width, height: resolved.height };

    let applied = false;
    if (whiteboardWindow && !whiteboardWindow.isDestroyed()) {
      try {
        // setContentSize, to match how the window was created: these numbers
        // are the page's viewport, which is what the agent reasoned about and
        // what participants actually see. Position is left alone — the window
        // lives off-screen by design.
        whiteboardWindow.setContentSize(shareSize.width, shareSize.height);
        // Re-anchor: the RIGHT edge is what hugs the app, so a wider board must
        // extend leftward rather than sliding under the app window.
        positionShareWindow(whiteboardWindow);
        applied = true;
      } catch (err) {
        return { ok: false, error: 'Could not resize the shared window: ' + err.message };
      }
    }
    console.log('[local-server] Share size →', shareSize.width + '×' + shareSize.height,
      applied ? '(applied to the live share)' : '(saved for the next share)');
    return { ok: true, width: shareSize.width, height: shareSize.height, applied, notes: resolved.notes };
  },

  // Click into the shared board.
  //
  // A selector is the preferred target: the bot can find one with inspect_dom,
  // and it survives the board being a different size than the screenshot it was
  // measured from. Raw x/y stays available for canvas-style content with no
  // addressable elements.
  onShareClick: async ({ selector, x, y, button, clickCount } = {}) => {
    const wc = shareWebContents();
    if (!wc) return { ok: false, error: 'Nothing is being shared to click' };

    let point = { x, y };
    if (selector) {
      const found = await elementCenterInShare(wc, selector);
      if (!found.ok) return found;
      point = found;
    }
    const { events, error } = clickEventsFor({ ...point, button, clickCount });
    if (error) return { ok: false, error };

    vcShowCursor(wc, vcClickScript(point.x, point.y));
    for (const ev of events) wc.sendInputEvent(ev);
    console.log('[local-server] Share click at', point.x + ',' + point.y,
      selector ? '(' + selector + ')' : '', button || 'left');
    return { ok: true, x: point.x, y: point.y, selector: selector || null };
  },

  // Type into the shared board. An optional selector is focused first, since
  // keystrokes go to whatever the page considers focused — without that, text
  // aimed at a form field lands on the body and vanishes.
  onShareType: async ({ text, key, modifiers, selector } = {}) => {
    const wc = shareWebContents();
    if (!wc) return { ok: false, error: 'Nothing is being shared to type into' };

    const { events, error } = keyEventsFor({ text, key, modifiers });
    if (error) return { ok: false, error };

    if (selector) {
      const focused = await focusInShare(wc, selector);
      if (!focused.ok) return focused;
    }
    // The window is off-screen and never focused by the user, so Chromium would
    // otherwise route key events to a page that considers itself inactive.
    // webContents.focus() marks the CONTENTS focused without raising or
    // activating the window, so it can't steal the user's foreground app.
    try { wc.focus(); } catch { /* best effort */ }

    vcShowCursor(wc, vcTypeScript(selector || null));
    for (const ev of events) wc.sendInputEvent(ev);
    console.log('[local-server] Share type:', key ? 'key ' + key : JSON.stringify(text),
      (modifiers && modifiers.length) ? 'mods ' + modifiers.join('+') : '',
      selector ? 'into ' + selector : '');
    return { ok: true, typed: text ?? null, key: key ?? null, selector: selector || null };
  },

  // Show or hide the shared window's OS title bar.
  //
  // Electron fixes `frame` at construction, so this cannot be toggled on a live
  // window — it has to be rebuilt. Rebuilding mid-share would drop the capture
  // and force a re-present, so during a share the setting is saved and applied
  // to the next one. Idle, the window is rebuilt immediately at the same URL,
  // so the bot sees the change take effect straight away.
  onSetShareTitleBar: async ({ visible } = {}) => {
    const want = visible !== false;
    if (want === shareTitleBar) {
      return { ok: true, visible: want, applied: true, unchanged: true };
    }
    shareTitleBar = want;

    const live = whiteboardWindow && !whiteboardWindow.isDestroyed();
    // Defer on `sharing` OR `shareIntended`: rebuilding the window mid-share drops
    // the capture, and during the present spin-up `sharing` is honestly still
    // false while a share is nonetheless pending — intent covers that window.
    if (live && (localServer.sharing || shareIntended)) {
      console.log('[local-server] Share title bar →', want, '(deferred — a share is live)');
      return { ok: true, visible: want, applied: false };
    }
    if (live) {
      let url = null;
      try { url = whiteboardWindow.webContents.getURL() || null; } catch { /* going away */ }
      closeWhiteboardWindow('title bar rebuild');
      if (url) whiteboardWindow = createWhiteboardWindow(url);
      console.log('[local-server] Share title bar →', want, '(window rebuilt)');
      return { ok: true, visible: want, applied: true };
    }
    console.log('[local-server] Share title bar →', want, '(saved for the next share)');
    return { ok: true, visible: want, applied: false };
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
  // Sandboxed JS eval against the share surface (#244).
  onEvalShare: async ({ expression } = {}) => {
    const wc = shareWebContents();
    if (!wc) return { ok: false, error: 'Nothing is being shared to evaluate against' };
    if (!expression) return { ok: false, error: 'expression is required' };
    const result = await evalInShare(wc, expression);
    console.log('[local-server] eval_share →', result.ok ? 'ok' : `error: ${result.error}`);
    return result;
  },
  // Locate an element by description on the share surface (#244).
  onFindShareElement: async ({ description, max_results } = {}) => {
    const wc = shareWebContents();
    if (!wc) return { ok: false, error: 'Nothing is being shared to search' };
    if (!description) return { ok: false, error: 'description is required' };
    const result = await findInShare(wc, description, { maxResults: max_results });
    console.log('[local-server] find_share_element', JSON.stringify(description), '→',
      result.ok ? `${result.matches.length} match(es)` : `error: ${result.error}`);
    return result;
  },
  // Read the share surface's buffered console messages (#244).
  onReadShareConsole: async ({ limit } = {}) => {
    const wc = shareWebContents();
    return readShareLog(shareConsoleLogs, wc, { limit });
  },
  // Read the share surface's buffered network requests (#244).
  onReadShareNetwork: async ({ limit } = {}) => {
    const wc = shareWebContents();
    return readShareLog(shareNetworkLogs, wc, { limit });
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
      // #359: the hand (🙋 "yielding") means a reply is already stashed and
      // ready. Firing "let me think about that" on top of a raised hand is
      // dishonest — it trains people not to call on the bot. The stash's own
      // opening/resolve paths (_maybeReplayStashOnOpening,
      // _maybeReplayBargeInStash) already own delivering it; this path just
      // has to stay out of the way.
      if (localServer.bargeInStash) {
        console.log(ts(), '🤐 [ack] Suppressing — a reply is already stashed and the hand is up');
        return;
      }

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
      // Quiet only while someone is actually speaking — see speakOptionsFor in
      // ack/index.js for why timing decides this and pool membership does not
      // (#534). anyoneSpeaking is read HERE, at the moment the ack plays,
      // because that is the moment the question is about.
      speakText(ack, undefined, undefined, ackModule.speakOptionsFor({
        pool: ackResult.pool,
        anyoneSpeaking: localServer.anyoneSpeaking,
        ackVolume: prefValue('ackVolume'),
      }));
      // Surface the phrase to the slow model on its next wait_for_speech,
      // so it can self-correct if its real response contradicts the ack
      // tone. Cleared after one read on the local-server side.
      localServer.setLastAckPhrase(ack);
    }
  },
  // Someone else's speech named the bot directly (#343's name-gate, fired
  // once per caption turn from updateTurns). Purely cosmetic — a brief
  // avatar reaction so it's visible on camera that the bot noticed, the way
  // a dog cocks its head at the sound of its name. Carries no payload; the
  // renderer owns the animation's timing.
  onNameMentioned: () => {
    if (meetView && !meetView.webContents.isDestroyed()) {
      meetView.webContents.send('extension-message', { action: 'name-mentioned' });
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
    // A live call cancels any pending after-call teardown, on EVERY route in.
    //
    // onJoinCall already did this, but only for the agent's own join_call. A
    // join from the panel, the calendar, or the CLI never passed through it, so
    // the previous call's fuse kept burning: armed 07:49:35 for 1800s, it fired
    // at 08:19:35 in the middle of a half-hour conversation, tore the call down
    // and killed the agent (exit 143) with nothing visible from inside the room
    // to explain it. Observed 2026-08-24.
    //
    // It hid until now because re-joining during after-call work used to leave
    // you with no agent at all (see launchClaudeHeadless); once that worked, the
    // stale fuse outlived the call it belonged to.
    //
    // Here rather than in each join path because this is where every route
    // converges — a new one cannot forget to defuse it.
    if (_afterCallWorkTimer && isInCall(status)) {
      console.log('[electron] Call live again — cancelling the pending after-call teardown');
      clearTimeout(_afterCallWorkTimer);
      _afterCallWorkTimer = null;
    }
    // The bot's view only takes up window space during a call — grow/shrink the
    // column here, before anything else, so the layout tracks the call.
    setBotViewInCall(status);
    // #422: record what this machine hears and speaks through, once on the way
    // in and once on the way out. Whether a participant is on SPEAKERS decides
    // whether the bot can hear its own voice back (#378), and that is the one
    // condition about a call that no other log captures. Sampled at both ends
    // because devices change mid-call — measured 2026-08-17, one machine went
    // from built-in speakers to external headphones eight minutes in.
    logAudioDevicesOnCallEdge(status);
    // A call we spawned has ended (host ended it, bot was removed, whatever) —
    // hand the room back. leave-meet covers the button; this covers the rest.
    // An update that landed mid-call has been sitting staged and unmentioned.
    // Now that the call is over, it's safe to offer.
    // Only once everything is torn down. Offering an update during
    // after-call-work would interrupt the agent mid-wrap-up, and 'idle' is too
    // broad — it also means "app just launched, no call yet".
    if (isCallComplete(status)) { try { offerStagedUpdate(); } catch { /* not wired yet */ } }
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
        // The NAME rides along, because the arrival card needs it and this is
        // the one message that fires exactly when that card appears. page-inject
        // has a `config.botName`, but nothing ever sets it — it stayed on its
        // placeholder "AI Assistant" forever, which is what every bot's arrival
        // card said. Sending it here means the name is right from the first
        // frame rather than arriving later, if at all.
        payload: { status, botName: resolvedBotName() },
      });
    }
    // #275: the bot just entered — bring the user's browser tab for this call to
    // the front (best-effort; no-op if there isn't one). Fires from any join path
    // and any provider (Meet / Slack / future).
    if (status === 'in-call') {
      focusBrowserCallTab(localServer.roomId);
      // Say it early: the room should learn the bot is typing-only before they
      // spend the call waiting for it to answer out loud.
      announceNoVoiceOnce();
    }
    // Kick off ack-cache prewarming (tts.js) as early in the call lifecycle as
    // possible — 'navigating' fires well before the agent is ready to speak,
    // so synthesis happens in the background while the bot is still joining.
    if (isInCall(status)) prewarmAckCache();
    if (isFinished(status)) { _noVoiceAnnouncedFor = null; ackCachePrewarmedForCall = false; }
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
    broadcastToRenderers('call-status-changed', { status, provider: slackProviderMode ? 'slack' : 'meet' });
    // Rebuild the menu bar for the same reason: Call Now and Hang Up are a
    // pair, and exactly one of them should be available. A handful of rebuilds
    // per call (idle → joining → in-call → idle), not a poll.
    try { refreshAppMenuRef && refreshAppMenuRef(); } catch (err) { console.warn('[electron] menu refresh on call status failed:', err.message); }
  },

  // The countdown to the bot taking its turn. Pushed on every arm/re-arm so the
  // animation always lands on the real moment — the deadline genuinely moves
  // (name-mention fast-resolve, and the #372 re-arm that corrects a late timer),
  // and a countdown that finishes at the wrong time is worse than none: the
  // whole value is that the room learns to trust the endpoint.
  onSilenceGateChange: (gate) => {
    if (meetView && !meetView.webContents.isDestroyed()) {
      meetView.webContents.send('extension-message', {
        action: 'set-silence-gate',
        payload: gate,   // { deadline, from } or null
      });
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
    broadcastToRenderers('caption-state', { on: !!on });
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
    // #359: same rule as the regex ack gate above — a raised hand means a
    // reply is already stashed and ready; don't ack over it.
    if (result.ack && localServer.mode === 'active' && localServer.callStatus === 'in-call' && !localServer.bargeInStash) {
      const wordCount = (lastUtterance || '').split(/\s+/).filter(Boolean).length;
      const prefs = require('./preferences-schema').PREFERENCES;
      const longMin = Number(store?.get('ackLongMin')) || prefs.ackLongMin.default;
      // Same rule as the builtin decider: a long ack asserts the speaker has
      // FINISHED, so it needs an utterance that looks finished — not merely a
      // long one. See ack/builtin.js. Heuristic judge only; an ack must be
      // instant, and this path is already covering a slow model's TTFT.
      let ackComplete = false;
      try { ackComplete = !!require('./completeness').heuristicComplete(lastUtterance || '').complete; }
      catch { /* treat as unfinished */ }
      const arr = (wordCount >= longMin && ackComplete)
        ? (store?.get('ackLongPhrases') || prefs.ackLongPhrases.default)
        : (store?.get('ackShortPhrases') || prefs.ackShortPhrases.default);
      const phrase = arr[Math.floor(Math.random() * arr.length)];
      if (phrase) {
        const isLong = arr === (store?.get('ackLongPhrases') || prefs.ackLongPhrases.default);
        console.log(ts(), `👂 [ack] (triage-gated) Playing: ${JSON.stringify(phrase)} (${result.ms}ms after floor-open, ${isLong ? 'long' : 'short'})`);
        ackTtsPending = true;
        // Same rule as the other ack site, from the same function (#534). This
        // one fires into a detected OPENING, so anyoneSpeaking is normally
        // false and it plays at full volume — which is right: firing into a
        // gap is taking the floor, not murmuring under someone.
        speakText(phrase, undefined, undefined, require('./ack').speakOptionsFor({
          pool: isLong ? 'long' : 'short',
          anyoneSpeaking: localServer.anyoneSpeaking,
          ackVolume: prefValue('ackVolume'),
        }));
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
      let image = null;
      try { image = await meetView.webContents.capturePage(); }
      catch { image = null; } // "Current display surface not available" — heal below

      // #103: an EMPTY capture means the compositor has no display surface for
      // this view yet. It happens when the 'hidden' host window has never been
      // shown, or was hidden before its first frame landed — and capturePage
      // resolves with a 0x0 image rather than throwing, so without this the app
      // cheerfully writes a 0-byte PNG and reports success. (Observed exactly
      // that on the first real run of the hidden host.)
      //
      // Self-heal: put the host on screen just long enough for a frame, capture
      // again, hide it. Costs a brief flash the first time and nothing after.
      if ((!image || image.isEmpty()) && meetHiddenWindow && !meetHiddenWindow.isDestroyed()) {
        console.warn('[electron] Empty capture — waking the hidden bot-view host for a frame');
        try {
          meetHiddenWindow.showInactive();
          for (let i = 0; i < 20 && (!image || image.isEmpty()); i++) {
            await new Promise((r) => setTimeout(r, 100));
            try { image = await meetView.webContents.capturePage(); } catch { image = null; }
          }
        } finally {
          try { if (!meetHiddenWindow.isDestroyed()) meetHiddenWindow.hide(); } catch { /* gone */ }
        }
      }

      // Never report success for an empty image. A 0-byte PNG read back as "the
      // call looks like nothing" is worse than an error the agent can act on.
      if (!image || image.isEmpty()) {
        return { error: 'Capture came back empty — the bot view has no display surface yet. Retry in a moment; if it persists, set the botViewMode preference to "thumbnail".' };
      }

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

  // #615 — capture one of the app's own UI surfaces, for a visual changelog of
  // how the app has looked over time.
  //
  // WHY IN-PROCESS, rather than `screencapture` from a shell script: capturePage()
  // grabs exactly the window's own pixels. A shell capture needs a CoreGraphics
  // window id to hunt for, needs Screen Recording permission (which a launchd job
  // cannot be prompted for — see the nightly's preflight), and picks up whatever
  // else is on the desktop behind a translucent edge. None of that applies here.
  //
  // Returns a SIGNATURE alongside the file so a caller can decide whether this
  // frame is worth keeping. See uiSignature() for why it isn't a checksum.
  onCaptureUi: async ({ surface } = {}) => {
    const name = surface || 'panel';
    const target = UI_SURFACES[name];
    if (!target) {
      return { error: `Unknown UI surface '${name}'. Known: ${Object.keys(UI_SURFACES).join(', ')}` };
    }
    const contents = target();
    if (!contents || contents.isDestroyed()) {
      return { error: `The '${name}' surface is not open right now, so there is nothing to capture` };
    }
    try {
      const image = await contents.capturePage();
      const size = image.getSize();
      if (!size.width || !size.height) {
        // A window with no display surface captures as 0x0 rather than throwing.
        return { error: `The '${name}' surface captured as ${size.width}x${size.height} — it has no display surface (hidden, or not yet painted)` };
      }
      const buf = image.toPNG();
      const dir = path.join(app.getPath('temp'), 'vibeconf-ui-history');
      await fs.promises.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filePath = path.join(dir, `ui-${name}-${stamp}.png`);
      await fs.promises.writeFile(filePath, buf);
      console.log('[electron] UI capture saved:', filePath, `(${buf.length} bytes, ${size.width}x${size.height})`);
      return {
        path: filePath,
        surface: name,
        width: size.width,
        height: size.height,
        bytes: buf.length,
        signature: uiSignature(image),
        appVersion: app.getVersion(),
      };
    } catch (err) {
      console.error('[electron] UI capture failed:', err);
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
  setPref: (key, value) => {
    // `avatarBackgroundSvg` takes SVG source, which is fine for an agent that
    // WRITES an SVG and useless for one that has an image file — including one
    // it just generated. So the value also accepts `file:<path>`, converted here
    // to the same self-contained SVG the "Choose image…" button produces
    // (downscaled, inlined, no reference that can break when the file moves).
    //
    // Same shape as emojiSet's `dir:` and `font:`: one value, an open form for
    // the thing only the user's machine knows. Converted on WRITE so the stored
    // preference is always real SVG — nothing downstream needs to know.
    if (key === 'avatarBackgroundSvg' && /^file:/.test(String(value || ''))) {
      const filePath = String(value).slice(5).trim();
      return buildBackgroundSvgFromImage(filePath).then((svg) => {
        store?.set('avatarBackgroundSvg', svg);
        try { store?.set('avatarBackgroundCaption', require('path').basename(filePath)); } catch { /* noop */ }
        pushAvatarBackground(svg);
        notifyConfigChanged('avatarBackgroundSvg', svg);
        console.log(ts(), '[electron] Background set from', filePath, '->', svg.length, 'chars of SVG');
        return svg;
      });
    }
    return store?.set(key, value);
  },
  applyPref: (key, value) => {
    // An agent's set_preference lands here. The panel re-reads on this, the same
    // way it does for a set-config write, so a value changed mid-call shows up in
    // Bot Settings instead of the boot-time snapshot.
    notifyConfigChanged(key, value);
    // Live-apply hooks per-key. Anything we leave out is read on next use
    // (the ack thresholds, for example, are read every time a thinking state
    // fires — no live-apply needed).
    // The voice keys, live. All four have to be here: set_voice writes the
    // provider AND that provider's identifier together, and applying only the
    // id (which is all this did) left the engine on its old provider until the
    // next restart — the change looked saved but the bot kept its old voice.
    if (key === 'ttsVoiceId') {
      tts.updateConfig?.({ voiceId: value });
    } else if (key === 'ttsProvider') {
      tts.updateConfig?.({ provider: value });
    } else if (key === 'macosVoice') {
      tts.updateConfig?.({ macosVoice: value });
    } else if (key === 'voiceboxProfileId') {
      tts.updateConfig?.({ voiceboxProfileId: value });
    } else if (key === 'voiceboxEngine') {
      tts.updateConfig?.({ voiceboxEngine: value });
    } else if (VOICE_SETTING_KEYS.includes(key)) {
      // ElevenLabs voice_settings, live (#594). Same reasoning as the voice keys
      // above: without this the value is saved, the panel shows it, and the bot
      // keeps talking exactly as before until a restart — a change that looks
      // applied but is not. tts.js keys its audio cache on all five, so the next
      // line is re-synthesized rather than replayed at the old setting.
      tts.updateConfig?.({ [key]: value });
    } else if (key === 'botName') {
      applyAllWindowTitles(); // every window is named after the bot, not just the main one
    } else if (key === 'avatarBackgroundSvg') {
      pushAvatarBackground(value);
      // (The panel re-renders its own avatar — and its switcher thumbnail — off
      // these prefs directly, so nothing to invalidate here.)
    } else if (key === 'emojiSet') {
      pushEmojiSet(value);
    } else if (key === 'captionLanguage') {
      // Take effect now if we're in a call; otherwise it lands on the next join.
      //
      // Skipped when this language is already live — set_caption_language now
      // SAVES what it applied, so it arrives here immediately after doing the
      // work, and re-walking Meet's Settings dialog would cover the caption
      // region (making the bot briefly deaf) to reach the state it's already in.
      const want = String(value || '').trim();
      if (localServer.callStatus === 'in-call' && want
          && !_captionLanguageInFlight
          && !captionLanguageAlreadyApplied(localServer.roomId, want)) {
        _captionLanguageInFlight = true;
        localServer.onSetCaptionLanguage({ language: want })
          .then((r) => console.log('[electron] Caption language pref applied live:', r && (r.language || r.error)))
          .catch(() => {})
          .finally(() => { _captionLanguageInFlight = false; });
      }
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
  // #221: the poll reads the SAME room state the whiteboard viewer reads, so a
  // run of failures means the board is dark for everyone in the room — the bot's
  // writes still land, they just cannot be fetched back. On Aug 1 that lasted a
  // whole call and the only trace was a console line nobody was watching.
  //
  // Three audiences, because each can do something different about it:
  //   - the operator, via broadcastError (panel + system notification)
  //   - the AGENT, via addError, so it can say so aloud and use chat instead —
  //     the only one of the three that can salvage the moment
  //   - update_whiteboard, via the flag, so the next write fails loudly rather
  //     than reporting a success nobody can see
  onReadHealthChange: ({ healthy, status }) => {
    localServer.setBoardReadHealthy(healthy);
    if (!healthy) {
      const msg = `The shared whiteboard can't be read right now (sync server ${status}). `
        + 'Anything you put on the board will not be visible to anyone in the call — '
        + 'send it with send_chat instead, and say the board is down.';
      console.error('[sync] board reads unhealthy:', status);
      try { localServer.addError(msg); } catch { /* best-effort */ }
      broadcastError(`Whiteboard unavailable — the sync server is returning ${status} for room state.`);
    } else {
      console.log('[sync] board reads recovered');
      try { localServer.addError('The shared whiteboard is readable again — the board works normally now.'); }
      catch { /* best-effort */ }
    }
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
// #38: nobody is driving. A bot whose agent died looks exactly like one
// listening politely — resting face, in the call, saying nothing — and it is the
// only one of #155's four silences that is a real fault rather than the system
// working as designed.
//
// Polled rather than event-driven because the interesting transition is an
// ABSENCE of requests, which by definition fires no event. Cheap: one integer
// comparison every 15s. See agent-liveness.js for why the 55s wait_for_speech
// cap makes this safe, and why it is deliberately thin pending #113.
let _agentAbsent = false;
let _agentAbsentReason = null;
// Names the condition, not the wording: all three absence reasons raise under
// this key so recovery can retract whichever one is on screen (#533).
const AGENT_ABSENT_ERROR_KEY = 'agent-absent';
// 5s, not 15: the socket-close path sets the state instantly, so this interval
// is now the only thing between the agent dying and the face showing it.
const AGENT_LIVENESS_POLL_MS = 5_000;
function pollAgentLiveness() {
  let absent = false;
  try { absent = localServer.agentAbsentInCall(); } catch { return; }
  if (absent === _agentAbsent) return;
  _agentAbsent = absent;
  try { _agentAbsentReason = absent ? localServer.agentAbsenceReason() : null; } catch { _agentAbsentReason = null; }
  if (meetView && !meetView.webContents.isDestroyed()) {
    meetView.webContents.send('extension-message', {
      action: 'set-agent-absent',
      // The reason rides along so the avatar can be as certain as we are: a
      // dropped socket topples the face, a merely-quiet agent does not.
      payload: { absent, reason: absent ? _agentAbsentReason : null },
    });
  }
  console.warn('[electron]', absent
    ? '\u{1FAE5} no agent driving — avatar shows nobody home'
    : '\u{1FAE5} agent back — avatar restored');

  // Raise it as a real app error on the way OUT. broadcastError already does
  // both halves of what this needs: the notice over the avatar in the panel,
  // and a system notification when the app isn't in the foreground (deduped, so
  // a long outage doesn't spam).
  //
  // This is the one silence in #155 that is a genuine fault, so unlike the
  // others it earns an interruption rather than just a face.
  //
  // #533: and TAKE IT DOWN on the way back. Recovery stays quiet — no alert, no
  // sound, an alert for "everything is fine again" trains people to dismiss
  // alerts — but quiet was previously implemented as doing nothing at all, so
  // the banner outlived the condition. From the outside a stale "this bot has
  // gone quiet" is indistinguishable from a live one, which makes it useless
  // even when it IS live: you cannot tell whether you are looking at now or at
  // something that fixed itself five minutes ago. The face already recovers
  // here (set-agent-absent above); the notice now recovers with it.
  if (!absent) {
    clearBroadcastError(AGENT_ABSENT_ERROR_KEY);
    return;
  }

  // Word it to match how sure we actually are. A dropped socket means the
  // process is gone; a quiet stretch might just as easily be an agent sitting
  // on a permission prompt, and telling someone to restart a session that is
  // alive and waiting for them would be actively unhelpful.
  const reason = _agentAbsentReason || 'quiet';
  const message = reason === 'dropped'
    ? "The agent driving this bot disconnected. Its terminal has exited or lost "
      + 'its connection, so nothing is answering in the call. Restart the session to reconnect it.'
    : reason === 'never'
      ? "No agent ever attached to this bot. It's in the call but nothing is driving it. "
        + 'Check the terminal: the session may have failed to start, or be waiting on a Claude login.'
      : "This bot has gone quiet: no agent activity for a while, so it may not answer. "
        + 'Check its terminal. It could be waiting on a permission prompt, busy on a long task, or stopped.';
  try {
    // One key for all three reasons: recovery retracts the notice whichever
    // way the bot was absent, and only one of them can be showing anyway.
    broadcastError(message, AGENT_ABSENT_ERROR_KEY);
  } catch (err) {
    console.error('[electron] Failed to surface agent-absent error:', err.message);
  }
}
setInterval(pollAgentLiveness, AGENT_LIVENESS_POLL_MS);

// #38's mirror image: the agent is alive and busy, but the CALL is over.
//
// leave_call deliberately leaves the agent up to write its summary and memory
// files — 87s of it on the 2026-08-23 test call. From outside that is invisible
// and easy to misread: the avatar keeps reacting, which reads as "still in the
// call" rather than "finishing the last one". It also matters now, because a
// re-join during that window ends the wrap-up early (see launchClaudeHeadless),
// so the window is something to be able to wait out rather than guess at.
//
// Polled on the same interval as liveness rather than wired into every call-end
// path: this is a two-input derivation (agent alive, call not live) and both
// inputs already change under this poll's nose.
let _agentWrappingUp = false;
// A panel opened mid-wrap-up missed the broadcast, so it asks on load. Without
// this the banner is simply absent for anyone who opens the window during the
// very window it exists to explain.
ipcMain.handle('get-agent-wrapping-up', () => {
  try { return { active: _agentWrappingUp, botName: resolvedBotName() }; } catch { return null; }
});
function pollAgentWrapUp() {
  // headlessAgentCallOver, NOT "callStatus is not in-call". Those look
  // equivalent and are not: a call spends its first seconds in navigating /
  // joining / waiting-to-be-admitted, all of which are "not in-call", so the
  // banner fired on EVERY launch and announced that a brand-new agent was
  // finishing the last call (seen 07:34:48 on 2026-08-24, one second after
  // the launch that created it).
  //
  // The launcher already computes this exact question to decide whether an
  // agent is a lame duck, and the banner is the same question asked for the
  // user's benefit — so it reads the same flag rather than re-deriving it and
  // getting a different answer.
  const wrapping = !!headlessAgentChild && headlessAgentCallOver;
  if (wrapping === _agentWrappingUp) return;
  _agentWrappingUp = wrapping;
  try {
    broadcastToRenderers('extension-message', {
      action: 'agent-wrapping-up',
      payload: { active: wrapping, botName: resolvedBotName() },
    });
  } catch { /* no window yet */ }
  console.log('[electron]', wrapping
    ? '\u{1F9F9} call over, agent still writing up the last one'
    : '\u{1F9F9} agent finished its after-call work');
}
setInterval(pollAgentWrapUp, AGENT_LIVENESS_POLL_MS);

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

// Installed font families, for the agent to name one exactly.
//
// queryLocalFonts() is a RENDERER API, so main borrows a live webContents to
// call it. That is worth it: `system_profiler SPFontsDataType` is the obvious
// main-process alternative and takes 14.7 SECONDS on this machine, which is not
// a thing you can call mid-call. queryLocalFonts returns in milliseconds.
//
// Cached, because the answer changes only when someone installs a font, and
// timed out, because #254's lesson is that anything waiting on a renderer needs
// a way to give up.
let _fontCache = null;
async function listLocalFonts() {
  if (_fontCache) return _fontCache;
  const host = [panelView, meetView].find((v) => v && !v.webContents.isDestroyed());
  if (!host) throw new Error('no renderer available to enumerate fonts');
  const js = `(async () => {
    if (!window.queryLocalFonts) return null;
    const fs = await window.queryLocalFonts();
    return [...new Set(fs.map((f) => f.family))].sort();
  })()`;
  const families = await Promise.race([
    host.webContents.executeJavaScript(js, true),
    new Promise((_, rej) => setTimeout(() => rej(new Error('font enumeration timed out')), 5000)),
  ]);
  if (!Array.isArray(families)) throw new Error('this build cannot enumerate local fonts');
  _fontCache = families;
  return families;
}

// A `dir:` set that matches no files is the quiet failure here: every face
// falls back to the native glyph, which is indistinguishable from "the setting
// didn't take". Say so, to the log and to the agent.
function warnIfEmptyEmojiDir(value) {
  const ea = require('./emoji-assets.js');
  const dir = ea.parseDirSet(value);
  if (!dir) return;
  ea.forgetExternalDir(dir);            // the folder may have changed since last time
  const { count } = ea.describeExternalDir(dir);
  console.log(ts(), '[electron] emoji dir', dir, '->', count, 'usable image(s)');
  if (count === 0) {
    try {
      localServer.addError(`Emoji folder "${dir}" has no usable images, so every face stays native. `
        + 'Files must be images (png/svg/webp/gif/jpg) named after the emoji — "🙂.png", '
        + '"1f642.png", "1F642.svg" and "emoji_u1f642.png" all work.');
    } catch { /* best-effort */ }
  }
}

function pushEmojiSet(value) {
  warnIfEmptyEmojiDir(value);
  if (!meetView || meetView.webContents.isDestroyed()) return;
  // Pass the set name through; the renderer validates against its set registry
  // (unknown → native fallback).
  meetView.webContents.send('extension-message', {
    action: 'set-emoji-set',
    payload: { emojiSet: value || 'native' },
  });
}

// preferences-schema caps avatarBackgroundSvg at 1,000,000 chars. That cap is
// enforced on the agent's set_preference path but NOT on the panel's set-config
// path, so the import below has to respect it itself — otherwise a phone photo
// writes a config.json nothing will accept afterwards.
const AVATAR_BG_MAX_CHARS = 1_000_000;

// Wrap a picked image file in a 16:9 background SVG, inlined as a data URI.
//
// Inlined rather than referenced as file://: a reference breaks the moment the
// file is moved or deleted, and svg-resolver would then hand the renderer an
// SVG whose <image> silently fails to load — a black camera with no explanation.
// Inlining costs size, which is why we downscale first.
//
// PNG is tried before JPEG so screenshots and flat graphics keep their crisp
// edges and alpha; photos blow the budget as PNG and fall through to the JPEG
// quality ladder. JPEG has no alpha, but this image fills the whole frame, so
// there is nothing behind it to show through.
async function buildBackgroundSvgFromImage(filePath) {
  // An SVG is already the native format for this preference — the agent sets
  // avatarBackgroundSvg to SVG source directly — so take it as-is rather than
  // rasterising it into a data URI inside another SVG. It stays sharp at any
  // size and a fraction of the bytes. (nativeImage cannot read SVG at all, so
  // the raster path below would have rejected it outright.)
  //
  // resolveSvg does the two things an imported file needs: strips <script>, and
  // inlines any <image href="file://…"> it references, so the stored SVG is
  // self-contained and does not break when the author moves their assets.
  if (path.extname(filePath).toLowerCase() === '.svg') {
    const source = await fs.promises.readFile(filePath, 'utf8');
    const svg = await resolveSvg(source);
    if (!/<svg[\s>]/i.test(svg)) throw new Error('That file does not look like an SVG');
    if (svg.length > AVATAR_BG_MAX_CHARS) {
      throw new Error('That SVG is too large to store — try one with fewer embedded images');
    }
    return svg;
  }

  const { nativeImage } = require('electron');
  let img = nativeImage.createFromPath(filePath);
  if (img.isEmpty()) throw new Error('Could not read that image');

  // Scale so the image still COVERS the 1280x720 camera frame — never upscale,
  // that only inflates bytes. preserveAspectRatio="slice" crops the overflow.
  const { width, height } = img.getSize();
  const scale = Math.max(1280 / width, 720 / height);
  if (scale < 1) {
    img = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' });
  }

  const budget = AVATAR_BG_MAX_CHARS - 300; // headroom for the SVG wrapper
  let dataUri = null;
  const png = `data:image/png;base64,${img.toPNG().toString('base64')}`;
  if (png.length <= budget) {
    dataUri = png;
  } else {
    for (const quality of [85, 70, 55, 40]) {
      const jpeg = `data:image/jpeg;base64,${img.toJPEG(quality).toString('base64')}`;
      if (jpeg.length <= budget) { dataUri = jpeg; break; }
    }
  }
  if (!dataUri) throw new Error('That image is too large to store even at low quality — try a smaller one');

  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">' +
    `<image href="${dataUri}" x="0" y="0" width="1280" height="720" preserveAspectRatio="xMidYMid slice"/>` +
    '</svg>';
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
// Calendar auto-join (#299): this bot's matching events within the next 24h,
// for the panel's "upcoming meeting" notice. Written by
// pushUpcomingCalendarEvents (inside the whenReady closure, where the poll
// runs); read by the get-upcoming-calendar-events IPC handler in setupIPC —
// a SEPARATE top-level function, so this can't be a local of either.
let latestUpcomingCalendarEvents = [];
// Calendar poll health, for the panel's warning banner: null while polls
// succeed (or fail for expected reasons: signed out, not connected, offline),
// or { code, message } once the backend reports a broken Google connection —
// the invalid_grant case, where calendar WAS working and silently stopped
// (vibeconferencing#512). Same cross-closure split as the events above.
let latestCalendarPollError = null;
// launchOrFocusProfile is a local of setupIPC() (it needs isDefaultName/
// scanRunningInstances, also locals there) — checkOtherProfilesForCalendarMatch
// runs in the whenReady closure and can't see it directly. setupIPC() runs
// before calendar polling starts (see the setupIPC() call site), so this ref
// is populated well before anything tries to call it.
let launchOrFocusProfileRef = null;
// #502: the Bot menu is built in createMainWindow() but these windows are
// opened from setupIPC(), which is a different scope. Same ref pattern as
// launchOrFocusProfileRef above, for the same reason — the menu needs to reach
// them, and a menu item is not an IPC client so it cannot go through the
// handler the panel uses.
let openBrainWindowRef = null;
let openTroubleshootingWindowRef = null;
// Same reason, other direction: the call-status setter (onCallStatusChange,
// far above this file's window code) has to rebuild the menu so Call Now and
// Hang Up can carry a REAL `enabled:` instead of one frozen at startup.
let refreshAppMenuRef = null;
let mainWindow = null;   // single window that holds both views
let panelView = null;     // left sidebar BrowserView

// #615 — the app's own UI surfaces, by name, each resolving to a webContents at
// call time (they come and go, so this cannot be a table of objects).
//
// Deliberately only two for now. The other eight windows in the app are not open
// during an unattended run, so capturing them needs something to OPEN each one
// first — a bigger job, and the baseline is the part with a deadline: it can only
// be taken while the current UI still exists.
const UI_SURFACES = {
  panel: () => panelView?.webContents,
  whiteboard: () => whiteboardWindow?.webContents,
};

// #615 — see ui-signature.js for why this is a downscaled perceptual signature
// rather than a checksum of the PNG.
const { SIGNATURE_SIDE, signatureFromBitmap } = require('./ui-signature.js');
function uiSignature(image) {
  return signatureFromBitmap(image.resize({ width: SIGNATURE_SIDE, height: SIGNATURE_SIDE, quality: 'good' }).toBitmap());
}
let meetView = null;      // right Meet BrowserView
let panelPopoutWindow = null; // when popped out, the panelView lives here instead
let troubleshootingWindow = null; // the ⓘ window — a second copy of panel.html
let brainWindow = null;           // #242: the 🧠 window — the agent's activity feed
// Bot-view thumbnail column (feat/bot-view-thumbnail-column). The app is a narrow
// column; the Meet view is either a shrunk thumbnail below the panel ('thumbnail')
// or floated into its own large window ('popped'). One button toggles them. See
// electron-app/bot-view-layout.js for the pure geometry/zoom.
let botViewState = 'hidden'; // #103: resting state, reconciled to botViewMode on first layout
let meetPopoutWindow = null; // when 'popped', the meetView lives here instead
let meetHiddenWindow = null; // when 'hidden', a never-shown host giving meetView a big surface
let appSettingsWindow = null; // #381: machine-wide App Settings (⌘,), a singleton

// Closing a sub-window should hand focus back to the main window rather than
// dropping it to whatever else is behind — call from every sub-window's
// 'closed' handler.
function focusMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
}

// #381: open (or focus) the App Settings window — machine-wide config shared by
// every profile on this Mac. A singleton on purpose: one window no matter how
// many profile windows are open, reinforcing "there's one machine config".
// Since window ↔ profile now correlate (#379), app-level config lives here rather
// than inside any one profile's panel.
// ── Self-update (electron-updater) ─────────────────────────────────────────
// Replaces a hand-rolled GitHub-releases checker that could only hand the user
// a .dmg to install themselves. That existed because electron-updater wants a
// publish provider and a latest-*.yml, and because every release was flagged a
// prerelease — all three of which are now false.
//
// electron-updater is the cross-platform layer, not the mechanism: on macOS it
// delegates to Electron's built-in autoUpdater (Squirrel.Mac) and needs the
// signed .zip, not the .dmg; on Windows it drives the NSIS installer directly;
// on Linux it self-updates an AppImage. WHEN we let it run lives in
// update-policy.js so those rules can be tested without a desktop.
const updatePolicy = require('./update-policy');

// Where releases live. Keeps the old VIBECONF_UPDATE_REPO override so anyone
// pointing a test build at a fork keeps working.
const UPDATE_REPO = process.env.VIBECONF_UPDATE_REPO || 'wanderingstan/vibeconf-app';

let _updateCheckInFlight = false;
let _updateDownloaded = null;   // the info of a build staged and waiting to install
let _updateNotifiedFor = null;  // don't re-nag about a version already declined
let _manualCheckPending = false; // a menu-triggered check is waiting to hear back

// A menu "Check for Updates…" must give feedback the MOMENT an update is found —
// not after the whole build finishes downloading (autoDownload is on, so a plain
// menu check would otherwise sit silent through the entire download and look
// dead). Fired from the 'update-available' event (which lands right after the
// check, before the download) AND, as a fallback, from checkForUpdates' found
// branch — whichever gets there first. Idempotent via _manualCheckPending, so
// the passive background check stays quiet.
function announceManualUpdateDownloading(version) {
  if (!_manualCheckPending) return;
  _manualCheckPending = false;
  const { dialog } = require('electron');
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    message: `Update available: Vibeconferencing ${version}`,
    detail: "It's downloading in the background now — you'll get a prompt to install "
      + 'when it\'s ready, and you can keep working until then.',
    buttons: ['OK'],
  });
}

function autoUpdaterInstance() {
  const { autoUpdater } = require('electron-updater');
  autoUpdater.logger = {
    info: (m) => console.log(ts(), '[updates]', m),
    warn: (m) => console.warn(ts(), '[updates]', m),
    error: (m) => console.error(ts(), '[updates]', m),
    debug: () => {},
  };
  // We ship CLEAN SEMVER now (0.8.10, 0.8.11, …) — no `-beta` suffix. Keep this
  // OFF: with no prerelease component in the running version, electron-updater
  // never auto-enables allowPrerelease, and the provider just asks GitHub which
  // release is Latest (highest semver) and installs that release's latest-*.yml
  // in ONE hop — the newest is the one everybody gets, no stepping.
  //
  // Why the scheme changed: tags used to be `0.8.0-beta9` (no dot). semver reads
  // `beta9` as a single ALPHANUMERIC identifier, so versions compared LEXICALLY,
  // not numerically — `beta10` sorts BELOW `beta9`, so once a series crossed
  // single digits neither GitHub's "Latest" nor electron-updater could tell
  // which build was actually newest. The updater lagged / appeared to step
  // through intermediate versions instead of jumping to the true latest. Dropping
  // the prerelease identifier fixes the ordering for good. (allowPrerelease also
  // used to be force-enabled here because the RUNNING version always had a
  // prerelease component — with clean semver it no longer does, so this line is
  // now a belt-and-suspenders guard rather than a workaround.)
  // Channel switch (#release): the 'candidate' update channel (Stan + Seth) opts
  // into GitHub PRERELEASE builds — the release-candidates tested before promotion;
  // 'release' (default — real users) sees only promoted releases. Promoted versions
  // are clean semver (no prerelease component), so a 'release' client is never
  // offered an rc even after its GitHub prerelease flag is flipped. Fail safe to
  // 'release' if the pref/store isn't readable yet.
  try { autoUpdater.allowPrerelease = prefValue('updateChannel') === 'candidate'; }
  catch { autoUpdater.allowPrerelease = false; }
  // Stage the download, but never restart on our own: installing is gated on
  // not being in a call, and the user gets the last word either way.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  return autoUpdater;
}

// The updater lease lives beside the app-level config and the port registry —
// BASE_USER_DATA is the one directory every profile on this machine shares, and
// a lease that lived in a per-profile userData dir would be invisible to exactly
// the instances it needs to coordinate with.
function updaterLeasePath() {
  return path.join(BASE_USER_DATA, 'updater-lease.json');
}

function readUpdaterLease() {
  try { return JSON.parse(fs.readFileSync(updaterLeasePath(), 'utf8')); }
  catch { return null; }  // absent or corrupt reads as "nobody holds it"
}

function writeUpdaterLease(lease) {
  try { fs.writeFileSync(updaterLeasePath(), JSON.stringify(lease)); }
  catch (err) { console.warn(ts(), '[updates] could not write lease:', err.message); }
}

// Drop the lease on a clean quit so the next instance takes over immediately
// rather than waiting out the expiry. Best-effort: the expiry is what makes an
// unclean exit survivable, and this only saves the wait.
function releaseUpdaterLease() {
  const held = readUpdaterLease();
  if (held && held.pid === process.pid) {
    try { fs.unlinkSync(updaterLeasePath()); } catch { /* already gone */ }
  }
}

function updateContext() {
  return {
    platform: process.platform,
    packaged: app.isPackaged,
    env: process.env,
    lease: readUpdaterLease(),
    profile: appProfile,
  };
}

// Offer the staged build. Called when a download finishes and again when a call
// ends, since the usual sequence is "update arrives mid-call, install after".
async function offerStagedUpdate() {
  if (!_updateDownloaded) return;
  const version = _updateDownloaded.version;
  if (_updateNotifiedFor === version) return;

  const installable = updatePolicy.canInstallNow({ callStatus: localServer.callStatus });
  if (!installable.ok) {
    console.log(ts(), `[updates] ${version} staged; waiting (${installable.reason})`);
    return;
  }
  _updateNotifiedFor = version;

  const { dialog } = require('electron');
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    message: `Vibeconferencing ${version} is ready to install.`,
    detail: 'It has already downloaded. Restarting takes a few seconds, or it '
      + 'will install by itself the next time you quit.',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;

  // Re-check: the dialog is modal to the window, not to the world, and a call
  // can start via /join-call or browser detection while it sits open.
  const stillSafe = updatePolicy.canInstallNow({ callStatus: localServer.callStatus });
  if (!stillSafe.ok) {
    console.log(ts(), '[updates] install cancelled — a call started while asking');
    return;
  }
  // On macOS, autoUpdater.quitAndInstall() closes all windows before calling
  // app.quit(), so the 'before-quit' handler that normally sets this flag
  // fires too late to suppress the close-window quit-confirmation dialog.
  appIsQuitting = true;
  autoUpdaterInstance().quitAndInstall();
}

async function checkForUpdates({ silentWhenCurrent = true } = {}) {
  if (_updateCheckInFlight) return;

  // A manual check from the menu should say something even when this build
  // can't update itself — silence would just look broken.
  const allowed = updatePolicy.shouldCheck(updateContext());
  if (!allowed.ok) {
    console.log(ts(), `[updates] skipped (${allowed.reason})`);
    if (!silentWhenCurrent) {
      const { dialog, shell } = require('electron');
      // Another window holding the lease is temporary and not a property of the
      // build, so it gets its own wording — "not available for this build" would
      // read as permanent for something that resolves on its own.
      if (allowed.reason === 'another-instance-updating') {
        const who = allowed.lease && allowed.lease.profile;
        await dialog.showMessageBox(mainWindow, {
          type: 'info',
          message: 'Another window is already handling updates.',
          detail: `${who ? `The "${who}" window` : 'Another window'} is checking for this machine — `
            + 'only one does at a time, so several bots never download the same build at once. '
            + 'Close it and this window will take over.',
          buttons: ['OK'],
        });
        return;
      }
      const DETAIL = {
        'dev-build': 'This is a development build — there is nothing to update.',
        'linux-not-appimage': 'This copy was installed from a .deb, which your package '
          + 'manager owns. Download new builds from the Releases page (or use the AppImage, '
          + 'which updates itself).',
      };
      const buttons = allowed.reason === 'linux-not-appimage' ? ['Open Releases Page', 'OK'] : ['OK'];
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        message: 'Automatic updates are not available for this build.',
        detail: DETAIL[allowed.reason] || allowed.reason,
        buttons,
        defaultId: buttons.length - 1,
        cancelId: buttons.length - 1,
      });
      if (buttons[response] === 'Open Releases Page') {
        shell.openExternal(`https://github.com/${UPDATE_REPO}/releases`);
      }
    }
    return;
  }

  // Claimed it — record that before any slow work, so a sibling checking a
  // second later sees the lease rather than starting its own download.
  writeUpdaterLease(allowed.lease);

  // Already have one staged — re-offer instead of downloading it twice.
  if (_updateDownloaded) { _updateNotifiedFor = null; await offerStagedUpdate(); return; }

  _updateCheckInFlight = true;
  // Only a MANUAL check wants the "found → downloading" popup; the passive check
  // stays silent until the build is staged.
  _manualCheckPending = !silentWhenCurrent;
  const current = app.getVersion();
  try {
    const result = await autoUpdaterInstance().checkForUpdates();
    const found = result && result.updateInfo && result.updateInfo.version !== current;
    if (found) {
      // Fallback in case the 'update-available' event didn't beat us here.
      announceManualUpdateDownloading(result.updateInfo.version);
    } else if (!silentWhenCurrent) {
      _manualCheckPending = false;
      const { dialog } = require('electron');
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        message: `Vibeconferencing ${current} is up to date.`,
        buttons: ['OK'],
      });
    }
  } catch (err) {
    console.warn(ts(), '[updates] check failed:', err.message);
    _manualCheckPending = false;
    if (!silentWhenCurrent) {
      const { dialog, shell } = require('electron');
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'error',
        message: 'Could not check for updates.',
        detail: `${err.message}\n\nYou can always download the latest build from the Releases page.`,
        buttons: ['Open Releases Page', 'OK'],
        defaultId: 1,
        cancelId: 1,
      });
      if (response === 0) shell.openExternal(`https://github.com/${UPDATE_REPO}/releases`);
    }
  } finally {
    _updateCheckInFlight = false;
  }
}

// Check on a delay after launch, then every few hours. The delay is jittered so
// a fleet starting together doesn't hit GitHub in one burst.
function startUpdateChecks() {
  // Only the STATIC question here — can this build ever update itself? Whether
  // this instance is the one that checks is a per-check question now: the lease
  // holder can quit at any time, and answering it once at launch would leave a
  // still-running sibling permanently silent.
  const updatable = updatePolicy.canAutoUpdate(updateContext());
  if (!updatable.ok) {
    console.log(ts(), `[updates] automatic checks off (${updatable.reason})`);
    return;
  }
  app.on('will-quit', releaseUpdaterLease);
  const updater = autoUpdaterInstance();
  // Fires right after a check finds an update — BEFORE the download. Used to give
  // a manual "Check for Updates…" instant feedback instead of a silent wait for
  // the full download (no-op for the passive check, which leaves the flag off).
  updater.on('update-available', (info) => announceManualUpdateDownloading(info.version));
  updater.on('update-downloaded', (info) => {
    _updateDownloaded = info;
    _updateNotifiedFor = null;
    console.log(ts(), `[updates] ${info.version} downloaded and staged`);
    offerStagedUpdate();
  });
  updater.on('error', (err) => {
    console.warn(ts(), '[updates] updater error:', err && err.message);
    _manualCheckPending = false; // don't leave a manual check armed after a failed download
  });

  const SIX_HOURS = 6 * 60 * 60 * 1000;
  setTimeout(() => {
    checkForUpdates();
    const timer = setInterval(() => checkForUpdates(), SIX_HOURS);
    if (timer.unref) timer.unref();
  }, updatePolicy.firstCheckDelayMs()).unref?.();
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
  // #628 — hold the close just long enough to save what is still in a field.
  //
  // Text inputs commit on 'change', which fires on blur or Enter. ⌘W straight
  // after typing destroys the window with the edit still only in the DOM, and
  // it looks exactly like a successful save. So ask the renderer to flush and
  // wait for its answer.
  //
  // BOUNDED, and closing anyway on timeout: a settings window that refuses to
  // shut because a write is wedged is a worse bug than the one being fixed.
  // 600ms is generous for a same-machine IPC round trip and short enough that
  // nobody perceives it.
  let settingsFlushed = false;
  appSettingsWindow.on('close', (e) => {
    if (settingsFlushed || !appSettingsWindow || appSettingsWindow.isDestroyed()) return;
    e.preventDefault();
    const finish = () => {
      if (settingsFlushed) return;
      settingsFlushed = true;
      ipcMain.removeListener('settings-flushed', finish);
      if (appSettingsWindow && !appSettingsWindow.isDestroyed()) appSettingsWindow.close();
    };
    const timer = setTimeout(() => {
      console.warn(ts(), '[settings] flush did not answer in 600ms — closing anyway');
      finish();
    }, 600);
    ipcMain.once('settings-flushed', () => { clearTimeout(timer); finish(); });
    try { appSettingsWindow.webContents.send('flush-settings'); }
    catch { clearTimeout(timer); finish(); }
  });
  appSettingsWindow.on('closed', () => { appSettingsWindow = null; focusMainWindow(); });
}

// ── About window ────────────────────────────────────────────────────────────
// Replaces Electron's default About panel, which showed the Electron icon and
// no product identity of ours. A custom window rather than
// app.setAboutPanelOptions because that API takes no icon on macOS (iconPath is
// Linux/Windows only) — the native panel draws the BUNDLE's icon, so it is the
// Electron icon in any `pnpm dev` run and only becomes ours once packaged.
// Owning the window means the logo is right in development too, and identical
// on every platform.
let aboutWindow = null;
function openAboutWindow() {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.show(); aboutWindow.focus(); return;
  }
  aboutWindow = new BrowserWindow({
    width: 340, height: 375, // sized to the content — measured, not guessed
    title: 'About Vibeconferencing',
    icon: path.join(__dirname, 'icon.png'),
    // Fixed size: the content is a fixed block of text, so a resize handle
    // would only ever produce empty space.
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    center: true,
    show: false,
    // Frameless, like the macOS About panel it stands in for. The body carries
    // -webkit-app-region: drag so the window is still movable.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#202124', // paint the final colour before first frame
    webPreferences: {
      preload: path.join(__dirname, 'preload-about.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  aboutWindow.loadFile(path.join(__dirname, 'renderer', 'about.html'));
  aboutWindow.once('ready-to-show', () => {
    if (aboutWindow && !aboutWindow.isDestroyed()) aboutWindow.show();
  });
  // The website link must leave the app, not navigate this window into a web
  // page with no way back — there is no chrome here to go back with.
  aboutWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  aboutWindow.on('closed', () => { aboutWindow = null; focusMainWindow(); });
}

// ── First-run setup wizard (onboarding) ─────────────────────────────────────
// A guided walkthrough shown once on first launch (guarded by the per-profile
// `onboardingComplete` flag) and re-runnable from the app menu. Pure step logic
// lives in onboarding-flow.js; the renderer is renderer/onboarding.html.
let onboardingWindow = null;

// Startup work that would raise a macOS permission prompt, held back while the
// wizard is up so the asking happens on its Permissions step instead of in a
// stack of system dialogs over an unread window. Drained when the wizard ends —
// by finishing OR by being closed, since abandoning setup must not leave the app
// permanently missing its browser detection until the next launch. Idempotent:
// every deferred start guards against running twice.
const deferredStarts = [];
function runDeferredStarts() {
  while (deferredStarts.length) {
    const fn = deferredStarts.shift();
    try { fn(); } catch (err) { console.error('[electron] Deferred start failed:', err && err.message); }
  }
}

function createOnboardingWindow() {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.show(); onboardingWindow.focus(); return;
  }
  onboardingWindow = new BrowserWindow({
    width: 520, height: 660, title: 'Set up Vibeconferencing',
    icon: path.join(__dirname, 'icon.png'),
    center: true, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-onboarding.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  onboardingWindow.loadFile(path.join(__dirname, 'renderer', 'onboarding.html'));
  // Show only once painted, and pull it in front of the main app window (on
  // first run the main window is created around the same time and would
  // otherwise cover the wizard). moveTop + focus wins the z-order race.
  onboardingWindow.once('ready-to-show', () => {
    if (!onboardingWindow || onboardingWindow.isDestroyed()) return;
    onboardingWindow.show();
    onboardingWindow.moveTop();
    onboardingWindow.focus();
  });
  onboardingWindow.on('closed', () => { onboardingWindow = null; runDeferredStarts(); focusMainWindow(); });
}

// Probe (and, on first send, trigger) the macOS "Automation" permission by sending
// a benign Apple Event to whichever supported browser is running. macOS has no API
// to read Automation status, so we infer it: a successful reply = granted, error
// -1743 = denied, no browser running = unknown.
function probeBrowserAutomation() {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    const script = `
set out to ""
tell application "System Events"
  set procNames to name of every process
end tell
repeat with b in {"Google Chrome", "Brave Browser", "Safari"}
  if procNames contains (b as string) then
    try
      tell application (b as string) to set out to out & (count windows) & ";"
    on error errMsg number errNum
      if errNum is -1743 then return "denied"
    end try
  end if
end repeat
if out is "" then return "unknown"
return "granted"`;
    execFile('osascript', ['-e', script], { timeout: 8000 }, (err, stdout) => {
      const s = String(stdout || '').trim();
      if (s === 'granted' || s === 'denied' || s === 'unknown') return resolve(s);
      if (err) return resolve(/-1743|not allowed|not authori/i.test(err.message || '') ? 'denied' : 'unknown');
      resolve('unknown');
    });
  });
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
// POC (share-agent-tab): when set to a desktopCapturer window source, the
// display-media handler shares THAT external window (a specific Chrome tab the
// agent is browsing) instead of the whiteboard. Cleared on stop/leave. See
// share-external-tab.js + docs/share-agent-tab-poc.md.
let externalShareRequest = null; // { source, title, url } | null

// POC (share-agent-tab): resolve a Chrome tab (by URL) to a desktopCapturer
// window source, stash it, and trigger Meet's Present-now. Called from the
// 'share-tab' /api/sync action (via onShareTab) and the 'share-external-tab'
// IPC. Fire-and-forget like onShareWhiteboard — the MCP tool polls `sharing`.
// TODO for productionization: reuse the whiteboard-share Present-now retry loop
// (generation token) instead of a single trigger; see docs/share-agent-tab-poc.md.
async function startExternalTabShare({ url, appName } = {}) {
  const { resolveTabShareSource } = require('./share-external-tab.js');
  const excludeIds = [
    mainWindow && !mainWindow.isDestroyed() ? mainWindow.getMediaSourceId() : null,
    whiteboardWindow && !whiteboardWindow.isDestroyed() ? whiteboardWindow.getMediaSourceId() : null,
  ].filter(Boolean);

  const resolved = await resolveTabShareSource(desktopCapturer, url, { appName, excludeIds });
  if (!resolved.ok) {
    console.warn('[electron] share-external-tab failed:', resolved.reason);
    if (localServer) localServer.addError('Screen share failed: ' + resolved.reason);
    return { success: false, error: resolved.reason };
  }
  externalShareRequest = { source: resolved.source, title: resolved.title, url };
  shareIntended = true; // intent only — `sharing` goes true when Meet confirms the present (selfPresenting)
  console.log('[electron] share-external-tab →', resolved.source.id, `"${resolved.title}"`);

  if (meetView && meetView.webContents) {
    sendCallCmd(CALL_COMMANDS.triggerScreenShare, { shareType: 'window' });
  }
  // Now that the page is captured, bring the user's Meet window back to the
  // front so they're looking at the call, not the shared page (capture is
  // occlusion-proof, so the browsing window can sit behind). Best-effort; no-op
  // if the call isn't in this browser. Small delay lets the share engage first.
  setTimeout(() => {
    require('./share-external-tab.js').raiseMeetWindow()
      .then((r) => console.log('[electron] raised Meet window after share:', r.ok))
      .catch(() => { /* best-effort */ });
  }, 800);
  return { success: true, title: resolved.title };
}

// The shared window's webContents, or null if there is nothing to drive.
function shareWebContents() {
  if (!whiteboardWindow || whiteboardWindow.isDestroyed()) return null;
  if (whiteboardWindow.webContents.isDestroyed()) return null;
  return whiteboardWindow.webContents;
}

// --- Virtual cursor overlay (#244 follow-up) ---
// Purely cosmetic: gives the room something to look at when click_share
// or type_share acts, the way Claude in Chrome's own cursor overlay
// does — otherwise a click on the shared board is invisible until its effect
// shows up. Injected into the shared PAGE itself (not the Electron window
// chrome), so it's part of what desktopCapturer actually captures. Survives
// nothing across navigation by design — a fresh page gets a fresh overlay,
// re-created lazily on the next click/type. Best-effort throughout: a failure
// here must never break the click/type it's illustrating.
// Deliberately built WITHOUT a <style> tag or any external/data-URI resource:
// a lot of real-world sites (banks, e-commerce, anything security-conscious —
// Uber Eats among them) run a CSP that blocks inline stylesheets (style-src)
// and/or data: image sources (img-src), which would make an injected
// <style>-based overlay silently invisible — unstyled 0×0 divs, no error, no
// signal anything went wrong. Direct CSSOM property assignment (el.style.foo
// = ...) is NOT governed by style-src (it's a scripting API, not a
// stylesheet), and clip-path with literal polygon() points draws the arrow
// without loading anything, so it's unaffected by img-src too.
function vcEnsureOverlayJs() {
  return `(() => {
    if (window.__vcCursor) return;
    const mk = (styles) => {
      const el = document.createElement('div');
      Object.assign(el.style, { position: 'fixed', left: '0px', top: '0px', pointerEvents: 'none' }, styles);
      document.documentElement.appendChild(el);
      return el;
    };
    // Sized and colored to read clearly at video-call resolution against ANY
    // page background — a subtle white arrow was tried first and was
    // basically invisible on light pages (#244 testing).
    //
    // The clip-path polygon below is the actual pointer shape (points taken
    // from a standard arrow-cursor icon, viewBox 0-13 x 0-20: tip(0,0),
    // (0,18), (6.9,14.5), (10.8,20), (14.6,19), (10.8,13.5), (20,13.5) —
    // reduced to percentages of ITS OWN bounding box). The div's width:height
    // (18:28 ≈ 0.64) matches that box's own ratio (13:20 = 0.65) — a prior
    // attempt guessed dimensions instead of deriving them and the shape came
    // out visibly squashed (#244 testing).
    //
    // box-shadow would give a glow too, but clip-path clips box-shadow along
    // with the element — filter: drop-shadow() renders on the POST-CLIP
    // shape instead, so it's the only way to glow around a clipped shape.
    window.__vcCursor = mk({
      zIndex: '2147483647', width: '18px', height: '28px', opacity: '0',
      background: '#ff5a1f',
      clipPath: 'polygon(0% 0%, 0% 90%, 34.6% 72.5%, 53.8% 100%, 73.1% 95%, 53.8% 67.5%, 100% 67.5%)',
      filter: 'drop-shadow(0 0 1.5px #ffffff) drop-shadow(0 0 1.5px #ffffff) drop-shadow(0 0 6px rgba(255,90,31,0.9)) drop-shadow(0 0 11px rgba(255,90,31,0.6))',
      transition: 'left 130ms ease-out, top 130ms ease-out, opacity 200ms ease-out',
    });
    window.__vcRipple = mk({
      zIndex: '2147483646', width: '40px', height: '40px',
      marginLeft: '-20px', marginTop: '-20px', borderRadius: '50%',
      border: '4px solid #ff5a1f', boxShadow: '0 0 0 1px rgba(255,255,255,0.9)',
      opacity: '0', transform: 'scale(0.4)',
    });
    window.__vcHighlight = mk({
      zIndex: '2147483645', border: '3px solid #ff5a1f', borderRadius: '4px',
      opacity: '0', boxShadow: '0 0 0 4px rgba(255,90,31,0.35), 0 0 0 1px rgba(255,255,255,0.9)',
      transition: 'opacity 200ms ease-out',
    });
  })();`;
}

// Move the arrow to (x, y) and fire a click ripple there. Coordinates are the
// same CSS-pixel viewport space click_share already resolves to. Held
// visible for 30s — even a couple of seconds read as an instant flash in
// testing (#244); the arrow just marks "here's where the last click landed"
// until the NEXT click/type moves it or the timer runs out, whichever first.
function vcClickScript(x, y) {
  return `${vcEnsureOverlayJs()}
  (() => {
    const c = window.__vcCursor, r = window.__vcRipple;
    c.style.left = ${JSON.stringify(x + 'px')}; c.style.top = ${JSON.stringify(y + 'px')}; c.style.opacity = '1';
    r.style.transition = 'none';
    r.style.left = ${JSON.stringify(x + 'px')}; r.style.top = ${JSON.stringify(y + 'px')};
    r.style.opacity = '0.9'; r.style.transform = 'scale(0.4)';
    void r.offsetWidth; // force a reflow so the next assignment actually transitions
    r.style.transition = 'opacity 700ms ease-out, transform 700ms ease-out';
    r.style.opacity = '0'; r.style.transform = 'scale(1.8)';
    clearTimeout(window.__vcFadeTimer);
    window.__vcFadeTimer = setTimeout(() => { c.style.opacity = '0'; }, 30000);
  })();`;
}

// Draw a brief highlight box around whatever's being typed into — the
// selector if one was given, else whatever the page already has focused.
// Typing has no single "point" the way a click does, so a box reads better
// than trying to place the arrow inside a text field.
function vcTypeScript(selector) {
  const sel = selector ? JSON.stringify(selector) : 'null';
  return `${vcEnsureOverlayJs()}
  (() => {
    const el = ${sel} ? document.querySelector(${sel}) : document.activeElement;
    const h = window.__vcHighlight;
    if (!el || el === document.body || el === document.documentElement) return;
    const r = el.getBoundingClientRect();
    h.style.left = (r.left - 3) + 'px';
    h.style.top = (r.top - 3) + 'px';
    h.style.width = (r.width + 6) + 'px';
    h.style.height = (r.height + 6) + 'px';
    h.style.opacity = '1';
    clearTimeout(window.__vcHighlightTimer);
    window.__vcHighlightTimer = setTimeout(() => { h.style.opacity = '0'; }, 30000);
  })();`;
}

// Fire-and-forget: never let a broken overlay delay or fail the real action.
function vcShowCursor(wc, script) {
  try { wc.executeJavaScript(script, true).catch(() => {}); } catch { /* best effort */ }
}

// Resolve a CSS selector to the CENTRE of the element, in the page's own CSS
// pixels — which is the coordinate space sendInputEvent expects, and notably
// NOT the pixel space of get_shared_screenshot (2× on a Retina host). Going
// through the DOM sidesteps that mismatch entirely.
async function elementCenterInShare(wc, selector) {
  const js = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, error: 'no element matches ' + ${JSON.stringify(JSON.stringify(selector))} };
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return { ok: false, error: 'element matches but has zero size (hidden?)' };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r2 = el.getBoundingClientRect();
    return { ok: true, x: Math.round(r2.left + r2.width / 2), y: Math.round(r2.top + r2.height / 2) };
  })()`;
  try {
    const r = await wc.executeJavaScript(js, true);
    return r?.ok ? r : { ok: false, error: r?.error || 'could not locate ' + selector };
  } catch (err) {
    return { ok: false, error: 'selector lookup failed: ' + err.message };
  }
}

// Focus an element so typed keys land in it.
async function focusInShare(wc, selector) {
  const js = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, error: 'no element matches ' + ${JSON.stringify(JSON.stringify(selector))} };
    if (typeof el.focus !== 'function') return { ok: false, error: 'element cannot be focused' };
    el.focus();
    // #101: place the caret at the END. DOM .focus() on a field that already has
    // text leaves the caret at index 0, so type_share would insert at the front
    // (and a following select-all/replace could no-op). Wrapped so a field type
    // that doesn't support selection (e.g. number/email inputs) can't break the
    // focus that already succeeded.
    try {
      if (typeof el.setSelectionRange === 'function' && typeof el.value === 'string') {
        el.setSelectionRange(el.value.length, el.value.length);
      } else if (el.isContentEditable) {
        const r = document.createRange();
        r.selectNodeContents(el); r.collapse(false);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      }
    } catch (e) { /* selection unsupported on this field — focus still succeeded */ }
    return { ok: document.activeElement === el, error: 'element did not take focus' };
  })()`;
  try {
    const r = await wc.executeJavaScript(js, true);
    return r?.ok ? { ok: true } : { ok: false, error: r?.error || 'could not focus ' + selector };
  } catch (err) {
    return { ok: false, error: 'focus failed: ' + err.message };
  }
}

// --- eval_share / find_share_element / read_share_console /
// read_share_network (#244) ---
// Electron has no JS-land "attach the Chrome DevTools Protocol" call the way
// Puppeteer does; these are built on Electron's own native equivalents —
// executeJavaScript, the 'console-message' webContents event, and
// session.webRequest — scoped to the share surface, rather than a raw
// `webContents.debugger` session (which would also fight anyone who opens
// real DevTools on this window). Console/network are captured continuously
// into small ring buffers so the read tools can be called anytime, not only
// from the moment they're invoked.
const SHARE_LOG_MAX_ENTRIES = 200;
const shareConsoleLogs = new Map(); // webContents.id -> entries[]
const shareNetworkLogs = new Map(); // webContents.id -> entries[]
let shareNetworkListenersInstalled = false;

function pushShareLogEntry(map, id, entry) {
  let arr = map.get(id);
  if (!arr) { arr = []; map.set(id, arr); }
  arr.push(entry);
  if (arr.length > SHARE_LOG_MAX_ENTRIES) arr.shift();
}

// Installed once, globally, on the share surface's session partition — NOT
// per-window, since Electron's webRequest API allows only one handler per
// event type per session. Filters by webContentsId so other webContents on
// the same partition (the Meet view, the main window) don't pollute the log.
function installShareNetworkListeners() {
  if (shareNetworkListenersInstalled) return;
  shareNetworkListenersInstalled = true;
  const sess = session.fromPartition(SESSION_PARTITION);
  const pending = new Map(); // request id -> { method, url, startedAt }
  sess.webRequest.onBeforeRequest((details, callback) => {
    pending.set(details.id, { method: details.method, url: details.url, startedAt: Date.now() });
    callback({});
  });
  sess.webRequest.onCompleted((details) => {
    const wcId = details.webContentsId;
    const started = pending.get(details.id);
    pending.delete(details.id);
    if (wcId == null) return;
    pushShareLogEntry(shareNetworkLogs, wcId, {
      method: details.method,
      url: details.url,
      status: details.statusCode,
      resourceType: details.resourceType,
      durationMs: started ? Date.now() - started.startedAt : null,
      timestamp: new Date().toISOString(),
    });
  });
  sess.webRequest.onErrorOccurred((details) => {
    const wcId = details.webContentsId;
    pending.delete(details.id);
    if (wcId == null) return;
    pushShareLogEntry(shareNetworkLogs, wcId, {
      method: details.method,
      url: details.url,
      status: null,
      error: details.error,
      resourceType: details.resourceType,
      timestamp: new Date().toISOString(),
    });
  });
}

// Console capture IS per-webContents (a real event on that object), so this
// is safe to call once per whiteboardWindow instance without stepping on
// anything else.
function installShareConsoleListener(wc) {
  if (!wc || wc.isDestroyed() || wc.__shareConsoleInstalled) return;
  wc.__shareConsoleInstalled = true;
  const LEVELS = ['verbose', 'info', 'warning', 'error'];
  wc.on('console-message', (event) => {
    pushShareLogEntry(shareConsoleLogs, wc.id, {
      level: LEVELS[event.level] ?? String(event.level),
      message: event.message,
      line: event.lineNumber,
      sourceId: event.sourceId,
      timestamp: new Date().toISOString(),
    });
  });
}

// Sandboxed JS eval against the share surface. `executeJavaScript` already
// runs in the page's own isolated world (contextIsolation: true on this
// window), so this is "sandboxed" in the same sense CDP's Runtime.evaluate
// would be: it can't reach the Electron/Node side, only the page.
async function evalInShare(wc, expression) {
  installShareNetworkListeners();
  installShareConsoleListener(wc);
  try {
    const result = await wc.executeJavaScript(expression, true);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function readShareLog(map, wc, { limit } = {}) {
  if (!wc) return { ok: false, error: 'nothing is currently being shared' };
  const all = map.get(wc.id) || [];
  const n = Math.max(1, Math.min(limit || 50, SHARE_LOG_MAX_ENTRIES));
  return { ok: true, total: all.length, returned: Math.min(n, all.length), entries: all.slice(-n) };
}

// Locate elements by a natural-language-ish description — matched against
// text content, aria-label, placeholder, title, name and id — rather than a
// selector the caller already has to know. Ranks interactive/labelled
// elements first, so "the submit button" beats an unrelated div containing
// the word "submit" deep in a paragraph.
async function findInShare(wc, description, { maxResults } = {}) {
  const js = `(() => {
    const query = ${JSON.stringify(String(description || '').toLowerCase())};
    const terms = query.split(/\\s+/).filter(Boolean);
    if (!terms.length) return { ok: false, error: 'description is empty' };
    const candidates = document.querySelectorAll(
      'a, button, input, textarea, select, [role], [onclick], [tabindex], label, h1, h2, h3, li, td, th, span, div, p'
    );
    const results = [];
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const text = (el.innerText || el.value || '').trim().slice(0, 200);
      const label = el.getAttribute('aria-label') || '';
      const placeholder = el.getAttribute('placeholder') || '';
      const title = el.getAttribute('title') || '';
      const name = el.getAttribute('name') || '';
      const id = el.id || '';
      const haystack = [text, label, placeholder, title, name, id].join(' ').toLowerCase();
      let score = 0;
      for (const t of terms) if (haystack.includes(t)) score += 1;
      if (score === 0) continue;
      // Prefer tight, labelled matches over huge containers that merely
      // contain the words somewhere inside them.
      const isInteractive = /^(a|button|input|textarea|select|label)$/i.test(el.tagName) || el.hasAttribute('role') || el.hasAttribute('onclick');
      if (isInteractive) score += 1;
      if (text.length && text.length < 80) score += 0.5;
      results.push({
        score,
        tag: el.tagName.toLowerCase(),
        text: text.slice(0, 120),
        ariaLabel: label || undefined,
        id: id || undefined,
        selector: id ? '#' + CSS.escape(id) : undefined,
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
    }
    results.sort((a, b) => b.score - a.score);
    return { ok: true, matches: results.slice(0, ${JSON.stringify(Math.max(1, Math.min(maxResults || 5, 20)))}) };
  })()`;
  try {
    const r = await wc.executeJavaScript(js, true);
    return r?.ok ? r : { ok: false, error: r?.error || 'find failed' };
  } catch (err) {
    return { ok: false, error: 'find failed: ' + err.message };
  }
}

// Size of the shared board. Held here rather than read off the window so a
// size set BEFORE a share (or between shares) survives the window being
// recreated — createWhiteboardWindow opens at whatever this says.
let shareSize = { ...SHARE_SIZE.recommended };
// Whether the shared window keeps its OS title bar. Default true: it labels the
// share and is the only way to grab the window by hand. Electron fixes `frame`
// at construction, so changing this recreates the window.
let shareTitleBar = true;
// Whether the board window is shown on screen. Hidden by DEFAULT: for most
// people it is a capture surface, not something to look at, and a hidden window
// still shares fine — it falls out of desktopCapturer's window list, so the
// handler uses frame capture instead. Persisted, so someone who wants it around
// (to drive the board by hand) keeps it across shares.
let shareWindowVisible = false;  // seeded from the store in createWhiteboardWindow
// How long the Present-now trigger waits for the bot to actually be in the call
// before clicking, and how long it then keeps retrying. Both were effectively
// one combined 10s budget, which a slow Meet join could consume on its own.
const PRESENT_JOIN_WAIT_MS = 60_000;
const PRESENT_RETRY_MS = 30_000;
// Intent to present: the agent asked to share (whiteboard / screen / tab) and we
// have not yet stopped, left, or given up. Distinct from localServer.sharing,
// which is the PUBLISHED, confirmed reality — true only once the provider reports
// "Stop presenting" on screen (selfPresenting). Intent covers the few-second
// spin-up window (e.g. deferring a title-bar rebuild) WITHOUT ever making status
// claim a live share. Replaces the old confirmed-presenting var, which existed
// only because `sharing` used to be set optimistically and so couldn't be trusted
// as the engagement signal; `sharing` is now honest, so the retry loop reads it
// directly. (#282)
let shareIntended = false;
// Agent-controlled mute for the shared surface's audio (set_share_audio).
// Mirrors the state page-inject holds, purely so the main process can report
// it; the mute is enforced there, on the gain node feeding the published track.
let shareAudioMuted = false;
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
// reload_share tool. No-op (reported to the caller) if nothing's shared.
function reloadWhiteboardWindow(reason) {
  if (whiteboardWindow && !whiteboardWindow.isDestroyed() && !whiteboardWindow.webContents.isDestroyed()) {
    console.log('[whiteboard] Reloading shared board —', reason);
    whiteboardWindow.webContents.reload();
    return { ok: true };
  }
  return { ok: false, error: 'Nothing is being shared to reload' };
}

// The one place that closes the whiteboard/share window. close() is not
// guaranteed — a page-level beforeunload handler (ours or a loaded site's,
// via onLoadUrl) can make it hang — so this always forces destroy() shortly
// after, and always nulls the module var so a stuck webContents can never
// again masquerade as a live share. Every call site used to do its own
// close()+null, which is how a window could end up orphaned: any site that
// forgot the null (or skipped closing because of a state guard that assumed
// clean teardown) left `whiteboardWindow` pointing at nothing while the real
// OS window stayed on screen with no way to reach it — worse still if
// shareTitleBar was off, since a frameless window has no close button either.
function closeWhiteboardWindow(reason) {
  const win = whiteboardWindow;
  whiteboardWindow = null;
  if (!win || win.isDestroyed()) return;
  console.log('[whiteboard] Closing share window —', reason);
  try { win.close(); } catch (err) { console.warn('[whiteboard] close() failed:', err.message); }
  // Give a well-behaved close a moment, then force it regardless.
  setTimeout(() => {
    try { if (!win.isDestroyed()) win.destroy(); } catch { /* already gone */ }
  }, 500);
  broadcastShareWindowState();
}

/**
 * URL for the OFF-SCREEN window we capture as the bot's screen share.
 *
 * surface=share tells the web page this board is being broadcast, not read, so
 * it suppresses the signup CTA that the chat link (src=chat) turns on. Getting
 * this wrong paints a CTA into a live call's shared screen, so every caller
 * that loads the capture window must come through here — the page cannot work
 * it out on its own, since this window runs on the bot's session partition with
 * a plain Chrome user agent and is indistinguishable from a real browser.
 */
function whiteboardShareUrl(baseUrl, roomId) {
  return `${baseUrl}/room/${roomId}?mode=whiteboard&surface=share`;
}

// #366-followup: peers already see WHO is presenting via Meet's own UI
// (google-meet-provider.js's DOM probe), but not WHAT — whether it's this
// board or some other URL. Announce our own sharing state on the room's
// presence channel so other bots can read it via get_room_info without
// guessing. Fire-and-forget and best-effort on purpose:
//   - No roomId (never joined via vibeconferencing.com, or between calls) —
//     nothing to announce to, and that's not a failure.
//   - No auth is required for /api/sync (unlike /api/logs) — a bot that
//     isn't logged into a vibeconferencing.com account still gets through.
//   - A failed POST is logged and dropped, never retried — the #386 outage
//     that happened from retrying a rate-limited endpoint is exactly the
//     failure mode to not repeat for a path that fires on every share toggle.
async function announceSharing(active) {
  const roomId = localServer.roomId;
  if (!roomId) return; // no room association — fail gracefully, nothing to tell
  try {
    const baseUrl = getWebsiteUrl();
    const screenShareUrl = active ? (localServer.getWhiteboardLoadedUrl() || whiteboardShareUrl(baseUrl, roomId)) : null;
    const resp = await fetch(`${baseUrl}/api/sync/${roomId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: resolvedBotName(),
        ...(selfRole() ? { role: selfRole() } : {}),
        sharing: { active, screenShareUrl },
      }),
    });
    if (!resp.ok) console.warn('[share] sharing announce rejected by sync server:', resp.status);
  } catch (err) {
    console.warn('[share] failed to announce sharing state (non-fatal):', err.message);
  }
}

// The board's title, carrying the bot's name so it is obvious WHICH bot is
// presenting — the title bar is visible in the share by default, and with
// several bots in a call that question otherwise means cross-referencing Meet's
// own UI. getEffectiveBotName() honours a per-call override; the persistent
// preference is the fallback. Stays distinct from the MAIN window's bare
// "Vibeconferencing" title — matching that one is what caused #158.
function whiteboardWindowTitle() {
  let name = null;
  try { name = localServer?.getEffectiveBotName?.() || store?.get('botName') || null; } catch { /* early */ }
  return name ? `Vibeconferencing Whiteboard - ${name}` : 'Vibeconferencing Whiteboard';
}

// Put the board beside the app window, and keep it there as the app moves.
//
// It used to be placed at `x: workArea.width + 100` with a comment about being
// off-screen — but workArea.width is a SIZE, not a right edge, and macOS refuses
// to leave a window fully off-screen anyway, so it was clamped into the corner
// of the display and has been visible (and used) all along. Now the placement is
// deliberate: left of the app, top-aligned, right edge hugging it.
//
// Follows the app's move/resize the way the Slack huddle popup does
// (slack-surface.js), with one difference that matters: once the USER drags the
// board somewhere, following stops. The huddle popup can overlay unconditionally
// because nobody moves it; this window gets moved by hand, and snapping it back
// on every app nudge would be maddening.
function positionShareWindow(win, { force = false } = {}) {
  if (!win || win.isDestroyed()) return;
  if (win.__userPlaced && !force) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const { screen } = require('electron');
    const bounds = win.getBounds();
    const area = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
    const at = shareWindowPosition({
      mainBounds: mainWindow.getBounds(),
      workArea: area,
      width: bounds.width,
      height: bounds.height,
    });
    if (!at) return;
    if (bounds.x === at.x && bounds.y === at.y) return; // already there
    // Our own setPosition fires 'moved' too, so mark the move as ours — else the
    // first reposition looks like a drag and disables following forever.
    console.log('[electron] Share window placed', at.side, 'of the app at', at.x + ',' + at.y,
      '(' + bounds.width + 'x' + bounds.height + ')');
    win.__movingProgrammatically = true;
    win.setPosition(at.x, at.y);
    setImmediate(() => { win.__movingProgrammatically = false; });
  } catch (err) {
    console.warn('[electron] Could not position the share window:', err.message);
  }
}

// Tell the panel whether there is a board window and whether it is on screen,
// so the toggle can label itself and disappear when there is nothing to toggle.
function broadcastShareWindowState() {
  const exists = !!(whiteboardWindow && !whiteboardWindow.isDestroyed());
  try {
    broadcastToRenderers('share-window-state', {
      exists,
      visible: exists && shareWindowVisible,
      // Capture is always frame-based now, so hiding the window never blacks
      // out a live share — nothing for the toggle to refuse.
      lockedVisible: false,
    });
  } catch { /* panel not up yet */ }
}

function createWhiteboardWindow(roomUrl) {
  // Re-read the preference each time: it is the user's standing choice, and the
  // window is rebuilt on every share.
  try {
    shareWindowVisible = store.get('shareWindowVisible') === true;
  } catch (err) {
    console.warn('[electron] Could not read shareWindowVisible:', err.message);
    shareWindowVisible = false;
  }
  console.log('[electron] Share window will start', shareWindowVisible ? 'VISIBLE' : 'hidden');

  // Square share surface (#4): Meet stacks the participant tiles down the RIGHT
  // of a shared screen, so a 16:9 board wasted width behind the tiles and left the
  // content as a tiny centered strip. A square surface fills better next to the
  // tile column. (The board content sizes itself in vw — see `.wb-shared` in
  // style.css — so it fills whatever aspect this is.)
  //
  // Square stays the RECOMMENDED default, but the bot can pick another shape —
  // the board hosts arbitrary URLs, and a phone mock or a wide dashboard has its
  // own natural aspect. shareSize carries whatever was last asked for.
  const win = new BrowserWindow({
    width: shareSize.width,
    height: shareSize.height,
    // Size the CONTENT, not the window. What gets captured — and what the page
    // lays out into — is the content area, so a bot asking for a 390x844 phone
    // mock should get exactly that viewport rather than 28px less height once
    // the title bar takes its cut. (Slightly taller board than the previous
    // 800x772 content area; the width the whiteboard is tuned for is unchanged.)
    useContentSize: true,
    show: false,               // positioned below, then shown — no visible jump
    title: whiteboardWindowTitle(),
    skipTaskbar: true,
    // The title bar is captured along with the window, so it shows up in the
    // share. That is the DEFAULT and usually wanted: it labels what people are
    // looking at, and it is the only handle for dragging or minimising this
    // window by hand. A bot can turn it off (set_share_title_bar) for a clean
    // edge-to-edge capture — a screenshot, a mock, anything where a strip of
    // macOS chrome would read as an accident.
    //
    // Construction-only in Electron, which is why this is a window-creation
    // setting rather than something toggled on a live window.
    frame: shareTitleBar,
    // Share the bot's identity partition (same as meetView) so this shared-screen
    // surface inherits ALL the bot's credentials — Google, Slack, and cached HTTP
    // Basic-Auth. Without this it landed on Electron's default session, so a site
    // you'd logged into in the Meet webview showed up logged-OUT when shared.
    // #424: never throttle. This window is normally HIDDEN (not off-screen — an
    // earlier version of this comment said off-screen, but shareWindowPosition
    // deliberately clamps it into the work area, since macOS won't reliably keep
    // a window off it). Hidden or occluded, Chromium would throttle its
    // timers/rAF and freeze whiteboard/page animations in what participants see.
    webPreferences: { contextIsolation: true, nodeIntegration: false, partition: SESSION_PARTITION, backgroundThrottling: false },
  });
  // Pin the BrowserWindow title so the loaded page can't overwrite it. The
  // share-handler matches the desktopCapturer source by this exact title to
  // avoid accidentally picking the main app window (which holds the Meet
  // view) and triggering Meet's infinity-mirror warning (#158/#137).
  win.on('page-title-updated', (e) => { e.preventDefault(); });
  // Captured now, not read off win.webContents in the 'closed' handler below —
  // webContents is already destroyed by the time 'closed' fires.
  const wcId = win.webContents.id;
  installShareNetworkListeners();
  installShareConsoleListener(win.webContents);
  win.loadURL(roomUrl);
  win.webContents.on('did-finish-load', () => {
    console.log('[electron] Whiteboard window loaded OK:', win.webContents.getURL());
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.warn('[electron] Whiteboard window FAILED to load:', code, desc, url,
      '— the captured window will be blank, which Meet may reject as "Can\'t share your screen".');
  });
  // Place it beside the app, then reveal it — created with show:false so it
  // never flashes at wherever macOS would have put it first.
  positionShareWindow(win, { force: true });
  // showInactive, never show(): even when visible this window must not steal
  // focus from the call.
  if (shareWindowVisible) win.showInactive();

  // Follow the app window. Same mechanism as the Slack huddle popup, minus the
  // parenting: parenting would force the board to float above the app, and this
  // one sits BESIDE it, where the user may well want the app on top.
  const follow = () => positionShareWindow(win);
  mainWindow?.on('move', follow);
  mainWindow?.on('resize', follow);

  // A drag by hand wins permanently — see positionShareWindow. Programmatic
  // moves set a flag so they aren't mistaken for one.
  win.on('moved', () => {
    if (win.__movingProgrammatically) return;
    if (!win.__userPlaced) {
      win.__userPlaced = true;
      console.log('[electron] Share window moved by hand — it will stay put from now on');
    }
  });

  win.on('closed', () => {
    try {
      mainWindow?.removeListener('move', follow);
      mainWindow?.removeListener('resize', follow);
    } catch { /* main window already gone */ }
    // webContents is already destroyed by the time 'closed' fires — read its
    // id up front (wcId, captured above right after the window was created)
    // rather than here.
    shareConsoleLogs.delete(wcId);
    shareNetworkLogs.delete(wcId);
    whiteboardWindow = null;
    broadcastShareWindowState();
    focusMainWindow();
  });
  setImmediate(broadcastShareWindowState);
  return win;
}

// The width of the app's main window — which IS the panel. There is no wider
// window with a 380px strip down one side; that arrangement is gone.
//
// It was called PANEL_WIDTH, from when the main window held the panel beside a
// full-size Meet view. #103 made 'hidden' the resting state: meetView now lives
// in a host window the user never sees, and surfaces only as a thumbnail under
// the panel or as the 👁 popout. So the number stopped meaning "width of one
// region" and started meaning "width of the whole window" — same value, and
// nothing renamed it.
//
// That cost a reader a wrong mental model of the UI while debugging #254, which
// is the only reason this comment exists. bot-view-layout.js takes it as
// `windowWidth` for the same reason. `panelBounds` there is still honestly
// named: it really is the panel's bounds WITHIN this column, and in the
// thumbnail state it is shorter than the window.
const WINDOW_WIDTH = 380;

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

// ── Instant meetings: POST /api/meet/create ────────────────────────────────
// "Call <bot> now" spawns a Google Meet anyone with the link can join — no
// admit prompt, no host required — then sends the bot into it.
//
// MAIN PROCESS ONLY. A renderer fetch sends an Origin header and the backend
// only allows https://vibeconferencing.com, so it would 403.
//
// The response is a BEARER CAPABILITY: holding meetingUri/meetingCode is
// permission to enter the room. The server never logs them and neither do we —
// with remoteLogging on (the default) a stray console.log would ship live
// capabilities off the machine. Log the shape, never the value.
// Rooms we create are retired SERVER-side by the TTL reaper (api/meet/reap), and
// the client no longer tries to help.
//
// It used to: leaving a call POSTed /api/meet/retire, which runs closeSpace +
// endActiveConference — and endActiveConference EJECTS everyone still in the
// room. The bot leaving a call is not the same event as the meeting being over,
// so asking the bot to drop off would end the meeting for the humans who stayed
// to keep talking.
//
// Nothing is lost by dropping it. The retire endpoint's own header calls client
// retire "best-effort… the durable TTL reaper is the real guarantee", and a
// create returns your existing room rather than 429ing, so an un-retired room
// costs a lingering TTL and nothing else.

// Point the bot at a Meet URL and bring up everything a call needs: sync, and
// the bot's Claude session. Shared by the manual join ('join-meet') and the
// "Call <bot> now" path — duplicating it once left the bot in the room with no
// agent behind it, a face that never speaks.
//
// spawnAgent: whether to open a Terminal running Claude to drive the bot. TRUE
// for the panel button, where a human pressed it and nothing else is attached —
// without it the bot is a face in the room with nobody behind it. FALSE when the
// request arrived over MCP, because an agent making that request IS the agent;
// spawning a second one gives the call two drivers that fight over
// wait_for_speech, which is exactly what happened on 2026-07-29.
// calendarEvent: the matched Google Calendar event, when this join was
// triggered by one (#299) — recorded on the local server (setRoom clears any
// prior one first) so get_room_info can tell the spawned agent WHY it's
// here, instead of it walking into the call cold.
function joinMeetUrl(meetUrl, { spawnAgent = true, onboardingCall = false, calendarEvent = null } = {}) {
  currentMeetUrl = meetUrl;
  loadMeetURL(meetUrl);

  const match = meetUrl.match(/meet\.google\.com\/([a-z]+-[a-z]+-[a-z]+)/);
  if (!match) return;
  const meetCode = match[1];
  localServer.setRoom(meetCode);
  localServer.setCalendarEventContext(calendarEvent);
  sync.updateConfig({ roomId: meetCode, baseUrl: getWebsiteUrl() });
  sync.ensureRoom().then(() => {
    sync.startPolling();
    console.log('[electron] Sync started for room:', meetCode);
  });
  if (spawnAgent) {
    // calendarEvent rides along for #570: its invitees are what a per-meeting
    // session is keyed on. Only this path has it — a panel join or a pasted
    // link has no event, and so keeps the bot's single session.
    launchClaudeTerminal(meetCode, { onboardingCall, calendarEvent }); // the agent behind the face
  } else {
    console.log('[electron] Agent terminal not spawned — the caller is already an agent');
  }
}

async function websiteRequest(pathname, { method = 'GET', headers = {}, body = null } = {}) {
  const baseUrl = getWebsiteUrl();
  const { net } = require('electron');
  const cookies = await session.defaultSession.cookies.get({ url: baseUrl, name: 'vc_session' });
  const cookie = cookies.length ? `vc_session=${cookies[0].value}` : (store.get('vcSessionToken') ? `vc_session=${store.get('vcSessionToken')}` : '');
  return new Promise((resolve) => {
    const request = net.request({ method, url: `${baseUrl}${pathname}` });
    if (cookie) request.setHeader('Cookie', cookie);
    for (const [k, v] of Object.entries(headers)) request.setHeader(k, v);
    let raw = '';
    request.on('response', (response) => {
      response.on('data', (c) => { raw += c.toString(); });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* non-JSON error body */ }
        resolve({ status: response.statusCode, json });
      });
    });
    request.on('error', (err) => resolve({ status: 0, json: null, error: err.message }));
    if (body) request.write(JSON.stringify(body));
    request.end();
  });
}

// Give the room back when the call ends, so it closes promptly instead of
// lingering to its TTL. Hygiene, not a prerequisite: missing it doesn't block
// the next call — the server reaper collects it. Safe to call twice.
// "Call <bot> now": create a room, send the bot in, and open the human's
// browser to it. Returns a discriminated result callers map to UI — never the
// raw upstream body. Shared by the panel button (IPC) and the /call command
// (POST /api/call/start), so the two can't drift.
// openBrowser:false is for a caller who ISN'T at this machine — someone driving
// Claude Code from their phone, who wants the meeting made here and the link
// handed back so they can join from where they actually are. Opening a browser
// on an unattended desktop would just leave a stray tab in an empty call.
// onboardingCall: run the spawned agent through /onboarding-call instead of
// /join-call, so it walks the user through name/voice/emoji/etc live rather
// than having a normal conversation. Only meaningful alongside spawnAgent —
// the MCP start_call route never sets it (see /api/call/start's spawnAgent:false).
async function createAndJoinMeet({ openBrowser = true, spawnAgent = true, onboardingCall = false } = {}) {
  // A FRESH key per press. Reusing one returns the SAME room instead of a new
  // one, which is right for a retry of one press and wrong for a second press.
  const idempotencyKey = require('crypto').randomUUID();
  const r = await websiteRequest('/api/meet/create', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
  });

  if (r.status === 200 && r.json?.meetingUri) {
    // Shape only — meetingUri/meetingCode are capabilities, never logged.
    console.log(`[meet-create] room ready (replay=${!!r.json.replay})`);
    joinMeetUrl(r.json.meetingUri, { spawnAgent, onboardingCall });
    // …and get the HUMAN in too. The bot joins inside the Electron webview;
    // the user joins as themselves in their own browser, with their own
    // camera and Google account. Without this the button puts the bot in an
    // empty room and leaves you to find your own way there.
    //
    // Their browser tab is also what focusBrowserCallTab (#275) brings
    // forward once the bot is admitted, and what the app's tab detection
    // watches — so opening it here fits the paths that already exist.
    if (openBrowser) openExternalUrl(r.json.meetingUri);
    else console.log('[meet-create] browser launch suppressed — caller is remote');
    return { ok: true, url: r.json.meetingUri };
  }

  // Keys only: the body may carry a spaceName, and while that isn't a join
  // link it's still server state we don't need in a shipped log.
  console.warn(`[meet-create] failed → status ${r.status}`
    + (r.json ? ` (body keys: ${Object.keys(r.json).join(',')})` : ''));
  if (r.status === 401) return { ok: false, code: 'signed-out' };
  if (r.status === 429) return { ok: false, code: 'rate-limited' };
  if (r.status === 502) return { ok: false, code: 'upstream' };
  if (r.status === 400) return { ok: false, code: 'bad-request' };
  if (r.status === 0) return { ok: false, code: 'offline', detail: r.error };
  return { ok: false, code: 'unknown', detail: `status ${r.status}` };
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

// ── ElevenLabs key gifting (#273) ───────────────────────────────────────────
// Trusted people can be pre-assigned a working ElevenLabs key on the website,
// keyed by their vibeconferencing.com account email. This is the app's half.
//
// Stateless by design — no separate "did they accept or decline" flag to get
// stuck or contradict itself (an earlier draft tracked one and it caused
// exactly that: a decline that also hid the one place left to undo it, and a
// stale accept that survived past the situation that produced it). Instead,
// two rules, both derived fresh from comparing the CURRENT key to the
// grant's key — never from history:
//   1. The current key differs from the gift (including "no key at all") →
//      an offer to use it is available. Typing your own key IS the decline;
//      there's nothing else to click, so there's no separate "not now".
//   2. The key slot is EMPTY specifically at the moment it's DISPLAYED to
//      someone (app launch, or a Settings/onboarding pane regaining focus —
//      see the fillIfEmpty callers in app-settings.js and onboarding.js) →
//      filled in automatically, announced after the fact. A LIVE clear (rule
//      1) is left empty on purpose, so clearing the field to type your own
//      key doesn't get silently fought.
//
// Last grant fetched from the server, or null. Read by Settings/onboarding so
// the offer reflects reality without a round-trip on every paint.
let ttsGrant = null;

// Apply a grant's key as the server-owned TTS key. Shared by the launch-time
// auto-fill (rule 2) and the explicit accept-tts-grant IPC (rule 1's button).
function applyGrant(grant) {
  tts.updateConfig({ apiKey: grant.apiKey });
  stt.updateConfig({ apiKey: grant.apiKey });
  store.set('ttsApiKey', grant.apiKey);
  store.set('ttsApiKeySource', 'gifted');
  verifyElevenLabsKey(grant.apiKey, { announce: true });
  broadcastToRenderers('tts-grant-changed');
}

// GET /api/tts-grant (session-auth'd). Expected shape from the website:
//   { granted: boolean, claimed: boolean, apiKey?: string }
// granted=false: no gift for this account. claimed=true: the server has
// delivered this grant to SOME client before — admin-facing bookkeeping only
// (see api/admin/tts-grants.ts on the website side), not read by the app at
// all: it goes true after the very first fetch and stays true forever, so it
// can't distinguish anything the app needs to act on.
// Best-effort: a failed check just means no offer appears, same as no grant.
async function checkTtsGrant() {
  try {
    const r = await websiteRequest('/api/tts-grant');
    ttsGrant = (r.status === 200 && r.json) ? r.json : null;
  } catch {
    ttsGrant = null;
  }
  // App launch IS a "displayed, and it's empty" moment (rule 2) — the panel
  // is the first thing shown.
  if (ttsGrant?.granted && !store?.get('ttsApiKey')) {
    console.log('[electron] Auto-applied gifted ElevenLabs key (#273, key slot was empty at launch)');
    applyGrant(ttsGrant);
  } else {
    broadcastToRenderers('tts-grant-changed');
  }
  return ttsGrant;
}

// Logout / account-switch (#273): a gifted key is per-ACCOUNT, not per-machine
// like a BYO key, so it must not survive into whoever (or however) is signed
// in next. A BYO key is left alone — only the gifted one is cleared.
function clearGiftedTtsKey() {
  try {
    if (store?.get('ttsApiKeySource') === 'gifted') {
      store.delete('ttsApiKey');
      elevenLabsKeyProblem = null;
      broadcastToRenderers('voice-status-changed');
    }
    store?.delete('ttsApiKeySource');
    ttsGrant = null;
    broadcastToRenderers('tts-grant-changed');
  } catch { /* non-fatal */ }
}

// ── Liveness heartbeat ──────────────────────────────────────────────────────
// The app runs for hours or days, so /api/auth/me (fired once at launch) can't
// tell the backend whether an install is still alive. This ping is that signal,
// and it carries the running version so a release announcement can target the
// people actually on an old build.
//
// Deliberately NOT a "user is active" signal — the backend keeps it in a
// separate column from last_seen_at for exactly that reason. A machine left on
// overnight heartbeats all night; nobody was using it.
//
// Best-effort throughout: no retries, no queueing, failures logged at most
// once per transition. Missing a heartbeat costs a data point, and the backend
// treats "online" as a heartbeat within the last hour, so a sleeping laptop or
// a flaky network doesn't need to be compensated for here.
const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;
let heartbeatTimer = null;
let _heartbeatFailing = false;

async function sendHeartbeat() {
  const baseUrl = getWebsiteUrl();
  const { net } = require('electron');

  const cookies = await session.defaultSession.cookies.get({ url: baseUrl, name: 'vc_session' });
  const token = cookies.length ? cookies[0].value : store.get('vcSessionToken');
  // Logged-out apps have nothing to report and no way to authenticate. Skip
  // silently — this is the normal state for a fresh install, not an error.
  if (!token) return;

  const payload = JSON.stringify({
    version: app.getVersion(),
    platform: process.platform,
  });

  return new Promise((resolve) => {
    const request = net.request({ method: 'POST', url: `${baseUrl}/api/app/heartbeat` });
    request.setHeader('Content-Type', 'application/json');
    request.setHeader('Cookie', `vc_session=${token}`);
    request.on('response', (response) => {
      response.on('data', () => {});
      response.on('end', () => {
        const ok = response.statusCode >= 200 && response.statusCode < 300;
        if (!ok && !_heartbeatFailing) {
          _heartbeatFailing = true;
          console.warn(ts(), `[heartbeat] failing — status ${response.statusCode}`);
        } else if (ok && _heartbeatFailing) {
          _heartbeatFailing = false;
          console.log(ts(), '[heartbeat] recovered');
        }
        resolve();
      });
    });
    request.on('error', (err) => {
      if (!_heartbeatFailing) {
        _heartbeatFailing = true;
        console.warn(ts(), '[heartbeat] failing —', err && err.message);
      }
      resolve();
    });
    request.write(payload);
    request.end();
  });
}

function startHeartbeat() {
  if (heartbeatTimer) return;
  // Jitter the first ping. #371 means one process per profile, so a machine
  // running several bots would otherwise fire every instance's heartbeat in
  // the same instant, and the nightly runner launches them together.
  const jitter = Math.floor(Math.random() * 60 * 1000);
  setTimeout(() => {
    sendHeartbeat();
    heartbeatTimer = setInterval(() => sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
  }, jitter).unref?.();
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
const { pickSharedSession } = require('./session-precedence.js');

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
      // Precedence is decided in session-precedence.js, not here. The rule that
      // used to live inline — donate the local cookie up whenever it
      // authenticates — silently discarded a LONGER-LIVED shared token, because
      // "valid" was doing the work that "lasts longer" should have. See that
      // module's header for the night it cost.
      const { action, reason } = pickSharedSession({
        local, shared, localAuthenticated: !!me?.authenticated,
      });
      if (action === 'donate-up') {
        store.set('vcSessionToken', local); // donate the (verified) login up
      } else if (action === 'seed-cookie' && shared) {
        await session.defaultSession.cookies.remove(baseUrl, 'vc_session');
        await setVcSessionCookie(baseUrl, shared);
        console.log(`[auth] Using the shared vibeconferencing.com login — ${reason} (#366)`);
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

// The page the system browser lands on at the end of the OAuth round trip.
//
// This is the ONLY thing the person signing in actually sees — the app window is
// behind the browser at that moment — so it has to state the outcome plainly and
// then stay put. It deliberately does NOT call window.close(): see the note at
// the callback handler for why self-closing made a working sign-in look broken.
//
// Self-contained (inline styles, no network) because it is served off an
// ephemeral loopback port that closes moments later — anything external would
// render after the server is already gone.
function authResultPage(ok) {
  const title = ok ? 'Signed in' : 'Sign-in did not complete';
  const detail = ok
    ? 'Vibeconferencing has your login. You can close this tab and go back to the app.'
    : 'The sign-in came back without a token, so the app is still signed out. '
      + 'Close this tab and try Sign in again from the app.';
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + title + '</title></head>'
    + '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
    + 'font:16px/1.5 -apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;'
    + 'background:#f6f7f9;color:#1a1a1a">'
    + '<main style="max-width:26rem;padding:2rem;text-align:center">'
    + '<div style="font-size:2.5rem;line-height:1">' + (ok ? '&#9989;' : '&#9888;&#65039;') + '</div>'
    + '<h1 style="margin:.75rem 0 .5rem;font-size:1.35rem">' + title + '</h1>'
    + '<p style="margin:0;color:#555">' + detail + '</p>'
    + '</main></body></html>';
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
          broadcastAuthChanged();
          // #273: a fresh sign-in may belong to a trusted email with a gift
          // waiting — check right away rather than at next launch.
          if (data?.authenticated) checkTtsGrant();
        }).catch(err => {
          console.error('[electron] Login cookie error:', err);
        });
      } else {
        console.warn('[electron] No token in auth callback');
      }

      // Success and failure used to render the SAME "Signed in!" page, and that
      // page closed itself. Both halves hid real state:
      //
      //   - A token-less callback still claimed success, so a genuinely broken
      //     sign-in was indistinguishable from a working one.
      //   - window.close() left NOTHING on screen to read. When the browser was
      //     launched fresh for this flow, the callback tab was its ONLY tab — so
      //     closing it quit the browser outright. The user saw the window vanish
      //     with no confirmation and reasonably read it as a failed login.
      //
      // Reported 2026-08-19 as "I still can't log in"; the app log showed the
      // sign-in had in fact succeeded on every attempt. Nothing was broken except
      // the feedback. So: say which outcome happened, and let the person close
      // the tab themselves.
      res.writeHead(token ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(authResultPage(Boolean(token)));
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
// The "I have no voice" notice, pre-recorded because the bot cannot synthesise
// that sentence for exactly the reason it needs to say it. Ships alongside
// test-speech.mp3 via the "*.mp3" entry in package.json's files list.
//
// Regenerate with:
//   say -v "Ava (Premium)" -o /tmp/nv.aiff "<the sentence>" \
//     && ffmpeg -y -i /tmp/nv.aiff -codec:a libmp3lame -b:a 64k -ac 1 -ar 22050 \
//        electron-app/no-voice.mp3
const noVoiceClipPath = path.join(EXT_DIR, 'no-voice.mp3');

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

// EVERY navigation of the Meet view to the idle page goes through here, and says
// who asked and what the call thought it was doing at the time.
//
// 2026-08-13, v0.8.25 nightly: a bot loaded the Meet URL, reached
// "===== AUTO-JOIN STARTING =====", and 2.1s later the view was sitting on
// /bot-view — which the landing classifier correctly reported as "landed on
// not-meet", failing the join and taking 14 downstream steps with it. The log
// could not say WHO navigated: one of the two callers logs only AFTER the fact
// ('Returned to idle state', absent here, which is how we know teardown did NOT
// run), and the other — the meetView's initial load in createMainWindow — was
// silent. That left a real intermittent regression un-attributable from a full
// night's logs. A navigation that can abandon a join in flight must name itself.
//
// Note the deliberate asymmetry with the loud paths elsewhere: this logs BEFORE
// the loadURL, because the interesting case is precisely the one where what
// follows is a surprise.
function loadIdlePage(reason) {
  if (!meetView || meetView.webContents.isDestroyed()) return;
  const status = (() => { try { return localServer?.callStatus ?? 'unknown'; } catch { return 'unknown'; } })();
  // A join in flight is the pathological case, so it's called out by name rather
  // than left for a human to infer from a status string in a 4000-line log.
  const inFlight = status === 'navigating' || status === 'joining';
  console.log(`[electron] Loading idle page (${reason}) — callStatus=${status}${inFlight ? ' ⚠️ ABANDONING A JOIN IN FLIGHT' : ''}`);
  meetView.webContents.loadURL(getIdleUrl());
}

// Discard the current embedded provider view for good — the ONLY correct way to
// throw one away. (`meetView` is the shared handle for whichever provider is
// live: a Google Meet view OR a Slack surface — see activateSlackProvider — so
// this is not Meet-specific.) `removeBrowserView(meetView); meetView = null`
// (what every discard site used to do) merely DETACHES the view from its window
// and drops our reference; the webContents keeps living and running its page
// until GC eventually reaps it. That orphaned-but-alive page is a real bug
// source, not a leak nit: a Meet view we "discarded" at call teardown finished
// loading /bot-view ~270ms later and its preload emitted a 'meet-landing'
// event, which the handler — now seeing a NEW join in flight — misread as that
// join failing and killed it (the 2026-08-14 whiteboard-e2e "could not join …
// ended up at bot-view" failure). Stopping and closing the webContents makes
// the discard immediate and total: the page can no longer navigate, run script,
// or emit into our IPC handlers.
//
// Detaches from whichever window currently hosts it (main / popout / hidden),
// since attachMeetViewForState moves the same view between all three.
function destroyProviderView() {
  if (!meetView) return;
  const wc = meetView.webContents;
  for (const win of [mainWindow, meetPopoutWindow, meetHiddenWindow]) {
    try { if (win && !win.isDestroyed()) win.removeBrowserView(meetView); } catch { /* not attached to this one */ }
  }
  try {
    if (wc && !wc.isDestroyed()) {
      wc.stop();   // cancel any in-flight navigation (e.g. the teardown /bot-view load)
      wc.close();  // destroy the webContents so its page can't run or emit anymore
    }
  } catch (err) {
    console.warn('[electron] destroyProviderView: webContents teardown failed:', err.message);
  }
  meetView = null;
}

// Write a captured page DOM next to the session log, so an unattended run can
// be post-mortemed. Shared by the #263 denial capture (renderer-pushed, from
// inside the pre-join loop) and #346's join-landed-somewhere-else capture
// (main-pulled, from before the loop ever starts) — one naming scheme and one
// log line for both, rather than two half-identical writers.
function saveCapturedDom(reason, url, html) {
  try {
    const logDir = path.dirname(getSessionLogPath());
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(logDir, `denial-capture-${stamp}.html`);
    fs.writeFileSync(file, html || '', 'utf-8');
    console.warn(`[capture-dom] Saved page DOM (${reason || '?'}) → ${file}`);
    console.warn(`[capture-dom]   url=${url || ''}`);
  } catch (err) {
    console.warn('[capture-dom] failed to save DOM:', err.message);
  }
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

// #347: a second, deliberately cookie-free partition, used ONLY as a fallback
// when Google blocks the bot's own account with an identity challenge (#346).
// A partition holds cookies and caches and nothing else — botName, voice,
// CLAUDE.md, the agent workdir, logs and prefs all live in the profile's
// userData — so joining from here is the same bot, just not signed in. That is
// precisely what a human locked out of their account would do: join as a guest
// anyway and wait for the host to admit them.
const GUEST_PARTITION = 'persist:guest';

// The partition the meetView is CURRENTLY bound to.
//
// #282 collapsed three partitions into one and argued against swapping at
// runtime, because identity is a profile property ("a profile whose partition
// has no Google cookies IS a guest") and not a toggle. That still holds, and
// this does not reopen it: SESSION_PARTITION remains the profile's identity in
// every normal case. The swap is a degraded mode, entered only once Google has
// already refused the real account, and _openMeetInFreshView resets it on every
// ordinary join so it can never become sticky.
//
// The other half of #282's objection was that the old swap dragged Slack's
// login around, which is why it needed a third box. That cannot happen here:
// every Slack call site names SESSION_PARTITION literally, never this
// variable. Keep it that way. Same for the identity IPCs (get-meet-mode,
// get-meet-account-email, meet-sign-out-bot): they report and mutate the
// PROFILE's account, so they must always read home, or a one-off guest
// fallback would make the panel claim the bot is permanently signed out.
let activeMeetPartition = SESSION_PARTITION;

// #347: the meet URL we have already retried as a guest, so one blocked join
// produces one guest attempt and not a reload loop if the guest partition
// somehow lands on a sign-in page too. Cleared by every ordinary (non-fallback)
// join, so tomorrow's instance of the same recurring room is free to try again.
let guestFallbackTriedFor = null;

// #347: one "waiting to be let in" notice per guest fallback, not one per poll
// of Meet's pre-join state.
let guestLobbyNotified = false;

// True iff the partition holds live Google master-auth cookies — i.e. the bot
// is signed in (a "guest" profile simply has none). This replaces the old
// "which partition are we on" check now that there's a single partition (#282).
// Google's domain=.google.com auth cookies are the ground truth (the same set
// the bot presents to auto-admit into invited meetings).
// Returns true (signed in), false (definitely not), or null (COULD NOT TELL).
//
// The third state is load-bearing, and it used to be missing. A failed cookie
// read returned `false`, and the only caller reads `false` as permission to run
// clearMeetIdentityCache — which deletes the very cookies the read failed to
// see. So a transient error in the CHECK performed the destructive action it was
// meant to prevent, turning "I couldn't tell" into a real, permanent sign-out
// with no notification. #250 is what that costs: the bot silently joins
// un-authenticated and can no longer be auto-admitted to invited meetings.
//
// "Unknown" and "definitely logged out" are not the same answer, and only one of
// them is safe to act on destructively.
async function isSignedInToGoogle(sess) {
  try {
    const all = await sess.cookies.get({});
    const AUTH = ['__Secure-1PSID', 'SID', '__Secure-3PSID', 'SSID', 'HSID', 'SAPISID'];
    return all.some((c) =>
      /(^|\.)google\.com$/.test((c.domain || '').replace(/^\./, '')) &&
      AUTH.includes(c.name) && c.value);
  } catch (err) {
    console.warn('[electron] isSignedInToGoogle check failed (treating as UNKNOWN, not logged-out):', err.message);
    return null;
  }
}

// The bot's Google session is gone but this profile remembers being signed in as
// someone — i.e. it EXPIRED, rather than being a guest profile by design (the
// test fleet's test-meet-guest-* profiles have no bound account and must not
// trigger this). Nothing surfaced this before: the join simply took the
// un-authenticated branch, the panel quietly read "guest", and the first anyone
// knew was a bot that couldn't be admitted to its own meetings.
function notifyMeetSignInNeeded(email) {
  const parent = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null;
  dialog.showMessageBox(parent, {
    type: 'warning',
    title: 'The bot is signed out of Google',
    message: `Sign back in as ${email}`,
    detail:
      `This profile is bound to ${email}, but that Google session is gone — expired, or signed out elsewhere.\n\n`
      + 'The bot will still try to join, but as an unauthenticated guest: it cannot be auto-admitted to '
      + 'meetings its account was invited to, and a host may have to let it in by hand.\n\n'
      + 'Open Settings and sign in to Google again to restore it.',
    buttons: ['OK'],
    noLink: true,
  }).catch(() => { /* dismissed */ });
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
//     gate, and pin Accept-Language to English (#23).
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

  // Screen-share source selection — always the whiteboard window, captured
  // via Electron's own frame capture (webContents.mainFrame). This never
  // touches desktopCapturer for the whiteboard path, so it needs no OS
  // Screen Recording permission — regardless of whether the share window
  // happens to be visible or hidden.
  sess.setDisplayMediaRequestHandler(async (request, callback) => {
    // POC (share-agent-tab): share a specific external browser window (a Chrome
    // tab the agent is browsing). externalShareRequest.source was resolved ahead
    // of time (tab activated + desktopCapturer source matched) by the
    // 'share-external-tab' handler below, so here we just hand it back.
    if (externalShareRequest && externalShareRequest.source) {
      console.log('[electron] External-tab share source:',
        externalShareRequest.source.id, `"${externalShareRequest.title}"`);
      callback({ video: externalShareRequest.source });
      return;
    }

    if (whiteboardWindow && !whiteboardWindow.isDestroyed()) {
      // Extension: a full-res side capture of the bot's own whiteboard share,
      // independent of the (lower-res) video track of Meet's own render of
      // it. This IS the moment the share actually engages.
      maybeStartShareCapture();
      try {
        // Audio for the shared board. Electron's Streams.audio takes a
        // WebFrameMain and captures that frame's audio — so anything the
        // whiteboard page plays (a <video>, a sound effect) reaches the call.
        // Cross-platform, no Chromium feature flags, unlike system loopback
        // (which is Windows-only in Electron 33).
        //
        // enableLocalEcho stays at its default false: the bot's own speakers
        // must stay silent or the board's audio would bleed back through the
        // OS mic. Meet's mic pipeline mangles music/effects (see play_audio's
        // tool description), which is exactly why this path exists.
        const wbAudio = !whiteboardWindow.webContents.isDestroyed()
          ? whiteboardWindow.webContents.mainFrame
          : null;
        callback(wbAudio
          ? { video: whiteboardWindow.webContents.mainFrame, audio: wbAudio }
          : { video: whiteboardWindow.webContents.mainFrame });
      } catch (err) {
        // callback() is one-time — if it already fired above and THEN threw,
        // calling it again raises "One-time callback was called more than
        // once" as an unhandled rejection, burying the real error.
        console.error('[electron] Display media error:', err);
        try { callback({}); } catch { /* already answered */ }
      }
    } else {
      console.log('[electron] Display media request → no whiteboard window, denying');
      callback({});
    }
  });

  // #23: pin the session's Accept-Language to English. Every Meet-DOM literal
  // in meet-selectors.js is an English string — caption region aria-label, the
  // 'You' self-speaker filter, join/leave button text, presenting regexes — so
  // a non-English Meet UI doesn't degrade, it fails scattered and silent (bot
  // joins, then can't hear or can't tell it's in the call).
  //
  // This covers the GUEST case, which is the common one: with no Google account
  // signed in, Meet's locale comes from the browser, and that's ours to set.
  // A signed-in bot account carries its own server-side language preference
  // that generally wins over this header — that case needs detection, not a
  // header (tracked in #23).
  sess.setUserAgent(CHROME_UA, 'en-US,en');
}

// ---------------------------------------------------------------------------
// CLI argument parsing — supports --meet-url, --bot-name, --sync-url,
// --website-url, --local-port, --profile, --devtools, --bot-view
// ---------------------------------------------------------------------------

// Flags that take a value; used to catch the silently-ignored space form below.
const KNOWN_VALUE_FLAGS = new Set(['profile', 'local-port', 'website-url', 'meet-url', 'bot-name', 'bot-view']);

function parseCLIArgs() {
  const args = process.argv.slice(1); // skip electron binary
  const result = {};
  for (const arg of args) {
    const match = arg.match(/^--(\w[\w-]*)=(.+)$/);
    if (match) { result[match[1]] = match[2]; continue; }
    // A known value-flag given WITHOUT '=' (the space form, e.g. `--profile foo`)
    // matches nothing above and is silently dropped — so the app opens the REAL
    // Default profile / real port / production URL while you think you passed an
    // override (#158). Silence is the whole danger, so warn LOUDLY rather than
    // fall back quietly. (We don't consume the next argv token — guessing the
    // user's intent is exactly what #158 argues against.)
    const bare = arg.match(/^--(\w[\w-]*)$/);
    if (bare && KNOWN_VALUE_FLAGS.has(bare[1])) {
      console.warn(
        `[electron] ⚠️  --${bare[1]} needs the =value form (e.g. --${bare[1]}=VALUE). `
        + `The space form is IGNORED, so this launch is using DEFAULTS (Default profile, port 7865, production URL). `
        + `Re-launch with --${bare[1]}=VALUE.`,
      );
    }
  }
  return result;
}

const cliArgs = parseCLIArgs();

// --record-calls=true is the "record every call" launch switch (used by the
// test fleet for nightly runs, scripts/spawn-test-fleet.sh). It plugs into the
// EXACT SAME trigger recordCallEnabled() already checks — VIBECONF_RECORD_CALL
// — rather than inventing a second flag namespace, so this must run before
// recordCallEnabled() is first evaluated (a bot-joined call starts recording
// almost immediately). Ad-hoc boolean flag, same style as --devtools=true /
// --no-agent-terminal=true above — NOT added to KNOWN_VALUE_FLAGS, which is
// only for flags that require a companion value.
if (cliArgs['record-calls'] === 'true') {
  process.env.VIBECONF_RECORD_CALL = '1';
}

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

// The bot's effective name when no per-call/--bot-name override is live (idle,
// discovery, pre-join). Prefers the stored panel name, then a launch --bot-name,
// then a humanized NAMED profile — but the default instance passes profileName:
// null on purpose, so a genuinely unconfigured bot stays "Unnamed bot" and a
// stray instance is visible (see bot-name.js / bot-name-default.test.mjs).
function resolvedBotName() {
  return resolveBotName({
    storedName: store?.get('botName'),
    cliName: cliArgs['bot-name'],
    profileName: isDefaultInstance ? null : explicitProfile,
  });
}
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
function sendPlayTts(base64Audio, emoji, { unmutedAt, expectMore, utt, volume } = {}) {
  return new Promise((resolve) => {
    if (!meetView || meetView.webContents.isDestroyed()) {
      console.error('[electron] Meet view not available for audio playback');
      // #253: it used to end here. The agent had already been told "Spoken",
      // and nothing downstream contradicted it — so a farewell played into an
      // empty room and the session believed it had said goodbye.
      try { localServer.notePlaybackFailure('the Meet view was gone (call ended or torn down)'); }
      catch { /* local server not up */ }
      return resolve(false);
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
      sendExtMsg({ action: CALL_COMMANDS.ACTIONS.playTts, payload: { audioData: base64Audio, emoji, expectMore: !!expectMore, utt, volume } });
      console.log('[electron] Sent play-tts to Meet view', emoji ? `(emoji: ${emoji})` : '');
      resolve();
    }, settleMs);
  });
}

// #372: sentence-chunked TTS split — pure helper, unit-tested.
const { splitForTts, splitAtWordFraction } = require('./tts-chunking.js');
const { systemVoiceLabel } = require('./system-voices.js');
// "macOS" / "Windows" — used wherever we tell the user or the agent which
// built-in voice path is in play.
const SYSTEM_VOICE_LABEL = systemVoiceLabel(process.platform);

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

// #360: the utterance currently (or most recently) being spoken, so the
// renderer's tts-stopped report — which only carries {id, chunk} tags — can be
// paired back with the chunk TEXTS to tell the agent what the room never
// heard. `sent` counts chunks actually delivered to the renderer; chunks at
// index >= sent were still synthesizing (or dropped pre-send) when the stop
// hit, so they are unspoken by definition.
let ttsUtteranceSeq = 0;
let lastTtsUtterance = null; // { id, parts, sent }

// True once this call's ack phrases have been pre-warmed into tts.js's cache
// — reset per call (not per app launch) because ack phrases and voice/provider
// are per-bot config (store.get), and prewarming at app startup risked warming
// under a stale/default config that a later-loading credential or per-bot
// setting would replace before the first real speak. Fired on the earliest
// active call status, well before the agent is ready to actually say anything.
let ackCachePrewarmedForCall = false;

function prewarmAckCache() {
  if (ackCachePrewarmedForCall) return;
  ackCachePrewarmedForCall = true;
  const prefs = require('./preferences-schema').PREFERENCES;
  const shortPhrases = store?.get('ackShortPhrases') || prefs.ackShortPhrases.default;
  const longPhrases = store?.get('ackLongPhrases') || prefs.ackLongPhrases.default;
  const ackPhrases = [...new Set([...shortPhrases, ...longPhrases])];
  console.log(ts(), `🔥 [tts] pre-warming cache for ${ackPhrases.length} ack phrases`);
  for (const phrase of ackPhrases) {
    tts.synthesize(phrase).catch((err) => {
      console.warn(ts(), '[tts] ack cache prewarm failed for', JSON.stringify(phrase), '—', err.message);
    });
  }
}

function speakText(text, voice, emoji, { volume } = {}) {
  // Sanitize markdown out of the spoken string only (#160).
  const spokenText = stripMarkdownForTts(text);
  enqueueAudio(async () => {
    // Temporarily override voice if specified (works for macOS, ElevenLabs, and
    // Voicebox). Safe under serialization — no concurrent speak can clobber it.
    // Route by identity: a name that matches an installed built-in OS voice
    // forces the built-in provider; a Voicebox profile name forces voicebox;
    // anything else is treated as an ElevenLabs voice ID. Restored in finally.
    const originalMacVoice = tts.macosVoice;
    const originalELVoice = tts.voiceId;
    const originalVoiceboxProfileId = tts.voiceboxProfileId;
    const originalVoiceboxEngine = tts.voiceboxEngine;
    const originalProvider = tts.provider;
    if (voice) {
      if (systemVoiceNameSet.has(voice)) {
        tts.updateConfig({ provider: 'macos-say', macosVoice: voice });
      } else if (voiceboxProfileNameSet.has(voice)) {
        const profile = [...voiceboxProfilesById.values()].find((p) => p.name === voice);
        tts.updateConfig({
          provider: 'voicebox',
          voiceboxProfileId: profile.id,
          voiceboxEngine: profile.preset_engine || profile.default_engine || 'kokoro',
        });
      } else {
        // A NAME or an id — resolve, because the two branches above both accept
        // names and an agent has no reason to think this one is different.
        tts.updateConfig({ provider: 'elevenlabs', voiceId: resolveElevenLabsVoice(voice) });
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
    // #360: register this utterance so a barge-in's tts-stopped report can be
    // mapped back to the chunk texts.
    const utteranceId = ++ttsUtteranceSeq;
    lastTtsUtterance = { id: utteranceId, parts, sent: 0 };
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
          await sendPlayTts(base64Audio, chunkEmoji, { unmutedAt, expectMore, utt: { id: utteranceId, chunk: i, chunks: parts.length }, volume });
          lastTtsUtterance.sent = i + 1; // #360
          // ElevenLabs is back — if we'd previously degraded to the OS voice,
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
          // mid-call): fall back to the OS's built-in voice for THIS chunk so
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
              console.log(`[electron] TTS fell back to the built-in ${SYSTEM_VOICE_LABEL} voice:`, parts[i].slice(0, 40), '→', base64Audio.length, 'bytes base64' + chunkTag);
              await sendPlayTts(base64Audio, chunkEmoji, { unmutedAt, expectMore, utt: { id: utteranceId, chunk: i, chunks: parts.length }, volume });
              lastTtsUtterance.sent = i + 1; // #360
              // Tell the agent ONCE that its voice changed, so it knows it now
              // sounds different (and can mention it / not be surprised). Rides
              // the status.errors channel the agent already reads on each lull.
              if (!ttsVoiceFallbackActive) {
                ttsVoiceFallbackActive = true;
                const why = err.code === 'quota_exceeded' ? 'ElevenLabs quota exhausted' : `ElevenLabs unavailable (${(err.message || '').slice(0, 60)})`;
                localServer.addError(`Voice changed: ${why} — now speaking in the built-in ${SYSTEM_VOICE_LABEL} fallback voice, which sounds noticeably different. Your words still play; you may briefly acknowledge the voice change if it fits.`);
              }
            }
          } catch (fbErr) {
            console.error('[electron] TTS built-in voice fallback also failed' + chunkTag + ':', fbErr.message);
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

// Installed built-in voice names (populated at startup) — `say` voices on
// macOS, SAPI voices on Windows (#18). Lets the speak() voice-override route a
// name to the right provider — a built-in voice name forces the built-in
// provider even when an ElevenLabs key is set, instead of being mis-sent to
// ElevenLabs as a (nonexistent) voice ID.
let systemVoiceNameSet = new Set();

// In-flight HTTP Basic/Digest auth challenges for the bot webview: id → Electron
// login callback, awaiting the operator's credentials from the panel dialog.
const pendingBasicAuth = new Map();
let basicAuthSeq = 0;

// Enumerate the OS's built-in voices → [{ name, locale, sample, tier }], quality
// first (Premium > Enhanced > plain), then English, then name. macOS reads them
// from `say -v '?'`; Windows from SAPI via PowerShell (#18). Shared by the
// preferences dropdown IPC and the startup name-set build. Soft-fails to [] —
// a missing voice list must never take the app down with it.
//
// Parsing lives in system-voices.js so it can be unit-tested without a machine
// of each kind; this function is only the exec half.
async function enumerateSystemVoices() {
  const { parseSayVoices, parseSapiVoices, powerShellArgs, SAPI_LIST_SCRIPT } = require('./system-voices.js');
  const { execFile } = require('child_process');
  const isWin = process.platform === 'win32';
  if (!isWin && process.platform !== 'darwin') return [];
  // PowerShell's cold start makes 5s tight on a slow/first run; give it 15s.
  const [cmd, args, opts, parse] = isWin
    ? ['powershell.exe', powerShellArgs(SAPI_LIST_SCRIPT), { timeout: 15000, maxBuffer: 1 << 20 }, parseSapiVoices]
    : ['say', ['-v', '?'], { timeout: 5000, maxBuffer: 1 << 20 }, parseSayVoices];
  return new Promise((resolve) => {
    execFile(cmd, args, opts, (err, stdout) => {
      if (err) { console.error('[electron] enumerateSystemVoices failed:', err.message); return resolve([]); }
      resolve(parse(stdout));
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
// picker (#340). Never throws: returns { voices, error }, where `error` is null
// on success and an actionable {kind, message} otherwise.
//
// It returns the REASON, not just an empty list, because ElevenLabs keys are
// scoped: a key that speaks fine can still lack `voices_read`, which 401s here.
// This previously fell into `if (!res.ok) return []`, so a user who pasted a
// working key saw no voices and no explanation — indistinguishable from "no key"
// or "no voices on the account". See elevenlabs-errors.js.
//
// `category` ('premade' / 'cloned' / 'professional' / 'generated') lets the UI
// surface custom/cloned voices distinctly if it wants.
// ElevenLabs voice NAME (lowercased) → voice_id, for speak()'s voice override.
// Empty until warmed, and empty is safe: the override falls back to treating the
// string as an id, which is the behaviour that existed before.
let elevenLabsIdByName = new Map();
// Last key-related ElevenLabs failure, or null. Read by Settings so a dead key
// is visible where it is EDITED, not only where it is used.
let elevenLabsKeyProblem = null;

// Check a key against ElevenLabs and record what is wrong with it, if anything.
// Used both at startup (for a key stored long ago) and the moment one is pasted
// or accepted as a gift. `announce`: only the "a key just became active" call
// sites (paste, gift accept) pass true — the startup re-verify of an
// already-working key must NOT re-announce on every launch.
async function verifyElevenLabsKey(apiKey, { announce = false } = {}) {
  try {
    const { error } = await listElevenLabsVoices(apiKey);
    // Only KEY problems stick. A timeout or a rate-limit says nothing about the
    // key and would be a false accusation sitting in Settings.
    const keyKinds = ['legacy_key', 'invalid_key', 'unauthorized', 'missing_permissions'];
    elevenLabsKeyProblem = (error && keyKinds.includes(error.kind)) ? error : null;
    if (elevenLabsKeyProblem) {
      console.warn(ts(), '[electron] ElevenLabs key problem:', error.kind, '-', error.message);
      try { localServer.addError(error.message); } catch { /* server not up yet */ }
    } else if (!error) {
      // A working key also refreshes the name cache, so "use George" resolves.
      warmElevenLabsVoiceNames().catch(() => {});
      if (announce) {
        // Spoken out loud AND shown in Settings — pasting a key is exactly the
        // moment someone can't tell whether anything happened, since nothing
        // in the app makes a sound until a bot is in a call. Text kept in sync
        // with the visual notice in app-settings.js/.html.
        broadcastToRenderers('elevenlabs-key-validated', {
          message: "ElevenLabs key is now active. Select a voice in your bot's preferences.",
        });
      }
    }
  } catch { elevenLabsKeyProblem = null; }
  broadcastToRenderers('voice-status-changed');
  return elevenLabsKeyProblem;
}

async function warmElevenLabsVoiceNames() {
  try {
    // A stored key that no longer authenticates used to be invisible here: the
    // warm swallowed the error, so the only way to find out was to try picking a
    // voice and read the failure — meanwhile every ElevenLabs call quietly fell
    // back to a system voice. Classified by the same helper the paste path uses,
    // so there is one copy of "what counts as a key problem".
    const { voices, error } = await listElevenLabsVoices();
    const keyKinds = ['legacy_key', 'invalid_key', 'unauthorized', 'missing_permissions'];
    if (error && keyKinds.includes(error.kind)) {
      console.warn(ts(), '[electron] ElevenLabs key problem at startup:', error.kind, '-', error.message);
      try { localServer.addError(error.message); } catch { /* server not up yet */ }
      elevenLabsKeyProblem = error;
    } else if (!error) {
      elevenLabsKeyProblem = null;
    }
    if (voices && voices.length) {
      const map = new Map();
      for (const v of voices) {
        const full = String(v.name || '').trim();
        if (!full) continue;
        map.set(full.toLowerCase(), v.id);
        // ALSO index the leading name on its own. ElevenLabs library voices are
        // named "Chris - Charming, Down-to-Earth" / "River - Relaxed, Neutral,
        // Informative" — a label, not a name. Nobody says that out loud, and an
        // agent asked to "use George" sends "George".
        //
        // This is what made the first version of this fix useless: it matched
        // exactly, which is correct against the API and wrong against every real
        // account. Four more silent utterances before it showed up.
        const short = full.split(/\s+[-–—]\s+/)[0].trim().toLowerCase();
        // First wins, so a later voice cannot steal an earlier one's short name.
        // Deterministic (API order) rather than arbitrary, and the full name
        // always still resolves for whichever one loses.
        if (short && short !== full.toLowerCase() && !map.has(short)) map.set(short, v.id);
      }
      elevenLabsIdByName = map;
      console.log('[elevenlabs] cached', voices.length, 'voices as',
        elevenLabsIdByName.size, 'names for speak(voice:…)');
    }
  } catch { /* best-effort; the id path still works */ }
}

// Resolve whatever speak() was handed into a real voice_id.
//
// A NAME wins over treating the string as an id, because ids are opaque
// 20-character tokens that cannot collide with a human-readable name — so a
// match here is unambiguous, and a miss still falls through to the old
// behaviour for anyone who passes a genuine id.
function resolveElevenLabsVoice(voice) {
  return elevenLabsIdByName.get(String(voice).toLowerCase()) || voice;
}

async function listElevenLabsVoices(apiKey) {
  const { classifyVoicesError, classifyVoicesNetworkError } = require('./elevenlabs-errors.js');
  const key = apiKey || store?.get('ttsApiKey');
  if (!key) return { voices: [], error: null };   // no key set is not an error
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': key },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      // Body may be empty or non-JSON on gateway errors — classify on the
      // status alone in that case rather than throwing here.
      let body = null;
      try { body = await res.json(); } catch { /* not JSON */ }
      const error = classifyVoicesError(res.status, body);
      console.warn('[elevenlabs] voices list failed:', error.kind, '—', error.message);
      return { voices: [], error };
    }
    const data = await res.json();
    const voices = Array.isArray(data?.voices) ? data.voices : [];
    return {
      voices: voices.map((v) => ({ id: v.voice_id, name: v.name || v.voice_id, category: v.category || '' })),
      error: null,
    };
  } catch (err) {
    const error = classifyVoicesNetworkError(err);
    console.warn('[elevenlabs] voices list failed:', error.kind, '—', error.message);
    return { voices: [], error };
  }
}

// True while we've degraded from ElevenLabs to the OS's built-in voice (e.g.
// quota exhausted). Gates the one-shot "your voice changed" notice to the agent
// so it fires once on degrade and once on recovery, not on every utterance.
let ttsVoiceFallbackActive = false;

// Track recent error notifications so a flapping condition doesn't spam the
// notification center. Same message within this window is suppressed.
const ERROR_NOTIFY_DEDUPE_MS = 30_000;
const recentErrorNotifications = new Map(); // message -> timestamp
// message -> key, so clearBroadcastError can drop the dedupe entries belonging
// to a condition that has recovered. Same lifetime as the map above.
const _errorKeyForMessage = new Map();

// Sign-in state changed — tell every window that shows it.
//
// This used to send to panelView only, so signing in from App Settings updated
// the main window's footer while the settings window you were looking at went on
// saying you were signed out. Both renderers already listened; only one was ever
// sent to. Any new window that shows auth state belongs in here.
// ---------------------------------------------------------------------------
// #229 — one place that knows which windows exist.
//
// Main-process events were addressed to a NAMED window:
//
//     panelView.webContents.send('auth-changed');
//
// so a renderer could register a perfectly correct listener and never receive
// anything. Nothing errors; the state is right and the window simply never hears
// about it, which presents as a broken FEATURE rather than a missing message.
// That is why each instance cost a debugging session to find (#190, #143, the
// App Settings sign-in state, and — the expensive one — #254, where teardown
// waited on a reply from a window that was never asked).
//
// The tell was `claude-ready`: its fix was to write the same send three times,
// one per window. Correctness depended on remembering every window at every call
// site, and adding a window meant auditing every site to decide whether it
// belonged there.
//
// So: renderer windows are enumerated HERE, once. Anything that is "state the
// app has changed" broadcasts, and each renderer decides whether it cares —
// panel.html already does exactly that, since the pop-outs load the same file
// with ?screen=<name> and guard on it.
//
// NOT included: meetView. Its ~33 sends are page-injection COMMANDS (set the
// emoji set, start a share, apply a caption language) where the destination is
// part of the meaning. Those stay addressed.
function rendererWindows() {
  return [
    panelView,            // the app's own UI
    panelPopoutWindow,    // ...when popped out, it lives here instead
    brainWindow,          // 🧠 — panel.html?screen=brain
    troubleshootingWindow, // ⓘ — panel.html?screen=troubleshooting
    appSettingsWindow,    // ⌘, — had ZERO sends and one dead listener
    onboardingWindow,     // the setup wizard
    mainWindow,           // the shell (some listeners live here)
  ];
}

// Send to every live renderer. Guarded PER TARGET: these windows are all
// user-closable, and one closed window must not stop the others — a real case,
// not a theoretical one.
function broadcastToRenderers(channel, ...args) {
  let delivered = 0;
  for (const w of rendererWindows()) {
    try {
      if (!w || w.isDestroyed?.()) continue;
      const wc = w.webContents;
      if (!wc || wc.isDestroyed()) continue;
      wc.send(channel, ...args);
      delivered += 1;
    } catch { /* window went away mid-broadcast */ }
  }
  return delivered;
}

function broadcastAuthChanged() {
  // Was a hand-kept list of three windows. It was already missing the pop-outs,
  // which load panel.html and register the same 'auth-changed' listener.
  broadcastToRenderers('auth-changed');
}

// `key` (optional) names the CONDITION this error reports, so it can be
// retracted later by whatever notices the condition has passed. Without one an
// error is permanent until the user clicks it away, which is right for a
// one-shot failure ("could not start a call") and wrong for a running state
// ("the agent has gone quiet") that stops being true on its own. See
// clearBroadcastError below and #533.
function broadcastError(message, key) {
  broadcastToRenderers('extension-message', { action: 'error', message, key });

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
  if (key) _errorKeyForMessage.set(message, key);
  // Best-effort cleanup so the map doesn't grow unbounded.
  if (recentErrorNotifications.size > 50) {
    for (const [k, t] of recentErrorNotifications) {
      if (now - t > ERROR_NOTIFY_DEDUPE_MS) { recentErrorNotifications.delete(k); _errorKeyForMessage.delete(k); }
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

// Retract an error raised with this key, iff that is still what the bar is
// showing. Deliberately NOT a general "clear the error bar": an unrelated
// failure that arrived in the meantime is still true, and wiping it because
// some other condition recovered would lose a real message. The renderer owns
// that comparison, since it is the only side that knows what is on screen.
//
// No notification and no sound on the way back. An alert for "everything is
// fine again" trains people to dismiss alerts; taking down a notice that has
// stopped being true is not an announcement.
function clearBroadcastError(key) {
  if (!key) return;
  broadcastToRenderers('extension-message', { action: 'clear-error', key });
  // Drop the dedupe entry too, so a condition that recurs after recovering
  // notifies again instead of being swallowed as a repeat. Without this a bot
  // that goes quiet, recovers, and goes quiet again inside the dedupe window
  // is silently un-warned about the second time.
  for (const m of [...recentErrorNotifications.keys()]) {
    if (_errorKeyForMessage.get(m) === key) {
      recentErrorNotifications.delete(m);
      _errorKeyForMessage.delete(m);
    }
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

// The working directory for a call that came from a calendar event, when
// `sessionPerCalendarInvitees` is on (#570). Creates it if new, and returns ''
// for every case the feature does not apply to — the flag off, no event behind
// the join, or an event with nobody on it but the bot — so the caller falls back
// to the bot's ordinary agent dir and today's behaviour is untouched.
//
// Sessions are already stored PER WORKING DIRECTORY, which is why this is the
// whole feature rather than half of it: pointing the session at a per-invitee
// folder splits the memory, the permissions file and the CLAUDE.md in one move.
// There is deliberately no second invitee component on the cache key — the key
// already contains the directory, and two mechanisms for one job is how they
// drift apart.
function ensureMeetingWorkdir(invitees) {
  if (store.get('sessionPerCalendarInvitees') !== true) return '';
  const aw = require('./agent-workdir.js');
  const dir = aw.meetingDirFor(app.getPath('userData'), invitees, { identityEmail: store.get('calendarIdentityEmail') });
  if (!dir) return '';
  try {
    const fresh = !fs.existsSync(dir);
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const settingsPath = path.join(dir, '.claude', 'settings.local.json');
    if (!fs.existsSync(settingsPath)) {
      fs.writeFileSync(settingsPath, JSON.stringify(aw.defaultBotSettings(), null, 2) + '\n');
    }
    // COPIED from the bot's own folder, not imported from it. A sibling cannot
    // read its way up the tree — that is the point of siblings — so the
    // personality has to be physically present here. It then belongs to this
    // meeting and can drift: notes about these people, gathered over weeks, is
    // most of what the feature is for.
    const claudeMdPath = path.join(dir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      const source = path.join(aw.agentDirFor(app.getPath('userData')), 'CLAUDE.md');
      let seed = '';
      try { seed = fs.readFileSync(source, 'utf-8'); } catch { seed = aw.defaultClaudeMd(); }
      fs.writeFileSync(claudeMdPath, seed);
    }
    // Trust is recorded PER DIRECTORY, so a folder created today is untrusted
    // today. Without this every first meeting with a new group launches with
    // "Ignoring N permissions.allow entries" and prompts mid-call — #305 again,
    // one level down, and invisible because it only bites on the first call.
    const home = process.env.HOME || process.env.USERPROFILE;
    const claudeJsonPath = path.join(home, '.claude.json');
    let claudeJson = {};
    try { claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8')); } catch { /* fresh */ }
    if (!aw.isProjectTrusted(claudeJson, dir)) {
      fs.writeFileSync(claudeJsonPath, JSON.stringify(aw.withTrustedProject(claudeJson, dir), null, 2) + '\n');
    }
    if (fresh) console.log('[electron] New meeting workdir (first call with this invite list):', dir);
    return dir;
  } catch (err) {
    // Falling back to the bot's own dir keeps the call working. Say so loudly:
    // the quiet version is a bot that answers normally while writing one
    // meeting's notes into another's folder.
    console.warn('[electron] ensureMeetingWorkdir failed — falling back to the shared agent dir:', err.message);
    return '';
  }
}

// ── Claude Code readiness (onboarding feedback loop) ─────────────────────────
// A launched Claude session's SessionStart hook POSTs /claude-ready once it's up — which
// only happens when Claude Code is BOTH installed and signed in. So this flag means
// "installed + authenticated + working", front-loaded during onboarding instead of
// discovered mid-call. Persisted so we only confirm once.
// #231: does the APP launch the agent on this machine?
//
// The gate is deliberately "are we responsible for launching it", not "is the
// backend claude" — they happen to coincide today, and phrasing it this way
// keeps the rule correct if Codex ever gains app-driven launch. Everything the
// app nags about (Claude Code missing, Claude Code signed out) is only our
// business when we are the one starting it. Someone driving LM Studio or a
// hand-rolled MCP client should never be told to install Claude Code.
function appLaunchesAgent() {
  try { return prefValue('agentBackend') === 'claude'; } catch { return true; }
}

// Claude Code sign-in state, cached (#137).
//
// The check costs a LOGIN SHELL — `$SHELL -lc 'claude auth status'` — because
// auth can come from environment variables and a GUI app has launchd's minimal
// env, not the user's. That sources .zprofile/.zshrc, so on a machine with
// nvm/conda/pyenv it is seconds, not milliseconds. Far too expensive to sit in
// front of a join, which is the most latency-sensitive thing the app does.
//
// So it is answered in advance and kept warm. Tri-state throughout: null means
// "couldn't tell", and callers must only act on an explicit false — a wrong
// "please sign in" shown to someone already signed in teaches people to ignore
// the warning, which is worse than never warning at all.
let claudeAuthState = { authed: null, method: null, checkedAt: 0 };
// Slow on purpose. This changes about once in a bot's lifetime — a user signs in
// and never thinks about it again — so anything faster is spending a login shell
// per interval to re-learn the same answer. The paths that matter (a join, the
// panel regaining focus) refresh on demand.
const CLAUDE_AUTH_POLL_MS = 15 * 60_000;
// EXCEPT while we know they are signed out. That state is transient — someone is
// about to fix it — and it is the one window where the answer is genuinely
// likely to change, so it is worth spending shells on. It also self-terminates:
// the moment they sign in, the poll drops back to the slow cadence.
//
// This is the alternative to putting a dismiss button on the banner. A dismiss
// hides the warning whether or not the problem was fixed, and the one user it
// helps most — someone who dismisses and then does NOT sign in — is exactly the
// user who then hits the failure it exists to prevent.
const CLAUDE_AUTH_POLL_UNAUTHED_MS = 60_000;
// Focus is user-triggered and fires in bursts when someone alt-tabs, so the
// on-demand refresh is throttled hard. 10 minutes, not 1: signing OUT is close
// to a never-event, and every transition worth catching quickly has its own
// signal already — markClaudeReady() the instant an agent connects, and a
// refresh on the join itself. This is a backstop, and a backstop that spawns a
// login shell should be stingy.
const CLAUDE_AUTH_FOCUS_MAX_AGE_MS = 10 * 60_000;

// Re-check, unless the cached answer is younger than maxAgeMs. The throttle is
// what makes this safe to call from anything user-triggered (window focus, a
// join) without risking a login shell per event.
async function refreshClaudeAuth({ maxAgeMs = 0 } = {}) {
  // Not our agent, not our question — and the check costs a login shell, so this
  // also stops us polling forever on behalf of someone who will never install it.
  if (!appLaunchesAgent()) {
    claudeAuthState = { authed: null, method: 'not-managed', checkedAt: Date.now() };
    broadcastClaudeAuth();
    return claudeAuthState;
  }
  // A session that has ever pinged /claude-ready has PROVEN auth by using it —
  // stronger evidence than the CLI's own answer, and free.
  if (claudeReady) {
    claudeAuthState = { authed: true, method: 'proven', checkedAt: Date.now() };
    broadcastClaudeAuth();
    return claudeAuthState;
  }
  if (maxAgeMs && Date.now() - claudeAuthState.checkedAt < maxAgeMs) return claudeAuthState;
  try {
    const { detectClaudeAuth } = require('./claude-install.js');
    const r = await detectClaudeAuth();
    claudeAuthState = { authed: r.authed, method: r.method, checkedAt: Date.now() };
  } catch {
    claudeAuthState = { authed: null, method: null, checkedAt: Date.now() };
  }
  broadcastClaudeAuth();
  return claudeAuthState;
}

function broadcastClaudeAuth() {
  try {
    broadcastToRenderers('claude-auth-changed', claudeAuthState);
  } catch { /* window went away */ }
}

let claudeReady = false;
try { claudeReady = !!store.get('claudeReady'); } catch { /* store not ready */ }

function markClaudeReady(source) {
  const was = claudeReady;
  claudeReady = true;
  try { store.set('claudeReady', true); } catch { /* noop */ }
  // #137: an agent that reached us has DEMONSTRATED sign-in — better evidence
  // than the CLI's own answer, and it lands the instant someone finishes the
  // login we asked for. Without this the indicator would keep saying "signed
  // out" until the next poll, right after the user fixed it.
  claudeAuthState = { authed: true, method: 'proven', checkedAt: Date.now() };
  try { broadcastClaudeAuth(); } catch { /* panel not up yet */ }
  if (!was) {
    console.log('[electron] Claude Code confirmed ready (' + (source || '?') + ')');
    // Three hand-written sends until #229. That triple was the clearest symptom
    // of the problem: correctness by remembering every window, at every site.
    broadcastToRenderers('claude-ready', true);
  }
}
ipcMain.handle('get-claude-ready', () => claudeReady);

// The user's hour-cycle preference, for renderers — they cannot read it
// themselves. macOS keeps the 24-hour choice OUTSIDE the locale
// (AppleICUForce24HourTime) and Chromium's ICU only consults the locale, so a
// panel asking for the system locale correctly still printed "4:30 PM" to
// someone with 24-hour time on. See electron-app/time-format.js.
ipcMain.handle('get-hour12', () => require('./time-format.js').resolveHour12());

// Merge a SessionStart hook into the agent dir's settings.local.json so ANY Claude session
// launched there pings /claude-ready on startup (proof it's installed + signed in).
// Idempotent — keeps existing settings/hooks; only adds ours if absent.
//
// It also forwards the hook's stdin payload, which is what carries `session_id`
// (see /claude-ready in extraRoutes). That is the ONLY session-id capture path
// that works for every hosting mode: Terminal.app and tmux own the agent's
// stdout, so there is nothing for the app to parse there — but the CLI runs this
// hook itself regardless of who is holding the pipe.
function ensureClaudeReadyHook(agentDir, port) {
  try {
    const settingsPath = path.join(agentDir, '.claude', 'settings.local.json');
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { /* fresh */ }
    settings.hooks = settings.hooks || {};
    const list = Array.isArray(settings.hooks.SessionStart) ? settings.hooks.SessionStart : [];
    // `--data-binary @-` is what forwards the hook payload; anything without it is
    // a pre-session-id hook left over in an existing workdir. Matching on the flag
    // rather than just the URL is what makes those upgrade instead of sitting
    // there silently never reporting a session id.
    const cmd = `curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${port}/claude-ready >/dev/null 2>&1 || true`;
    const isOurs = (h) => typeof h.command === 'string' && h.command.includes('/claude-ready');
    const current = list.filter((g) => (g.hooks || []).some(isOurs));
    if (current.length === 1 && current[0].hooks.length === 1 && current[0].hooks[0].command === cmd) return;
    // Drop every previous version of ours, then add exactly one current one. A
    // filter-then-push rather than an in-place edit, so a workdir that collected
    // hooks from several app versions/ports converges on one.
    const kept = list.filter((g) => !(g.hooks || []).some(isOurs));
    kept.push({ hooks: [{ type: 'command', command: cmd }] });
    settings.hooks.SessionStart = kept;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    console.log('[electron] Wrote Claude-ready SessionStart hook → 127.0.0.1:' + port);
  } catch (err) { console.warn('[electron] ensureClaudeReadyHook failed:', err.message); }
}

// How this launch should reach its session: { resumeSessionId, sessionName }.
//
// The bot keeps ONE session per name per working directory. There is no separate
// "create" mode to get wrong — resume the session if we can find it, otherwise
// start one and name it, and the hook below records the id so the next launch
// finds it.
//
// Resolution goes through an id we cached, never through `--resume <title>`.
// The CLI does accept a title, but it hard-errors ("matches 2 sessions") as soon
// as a directory holds two by that name, and that is unrecoverable without an
// id. Resolving ourselves keeps the readable name and cannot hit it. It also
// avoids reading transcript files to map a title back to an id — the format of
// what is inside them is undocumented and has broken before; a filename is not.
// Nothing here knows about calendar invitees (#570), and deliberately so: a
// per-meeting session is produced by handing this a different `claudeDir` (see
// ensureMeetingWorkdir), because sessions are ALREADY stored per working
// directory and the key already contains it. A second invitee component on the
// key would be a second mechanism for the same job, and two mechanisms for one
// job is how they drift apart.
function planAgentSession(claudeDir, botName) {
  const { resolveSessionRef, sessionExists, sessionCacheKey, resolveSessionId, resolveSessionName,
    renameSessionCacheEntries } = require('./agent-session.js');
  const ref = resolveSessionRef(store.get('agentSession'), botName);

  // An explicit id in the field is the user pinning this bot to one session.
  if (ref.kind === 'id') {
    if (sessionExists(ref.id, claudeDir)) return { resumeSessionId: ref.id, sessionName: ref.name };
    // NOT cleared: they typed it. Silently replacing a pin with a fresh session
    // would be the app overruling an explicit instruction.
    console.warn('[electron] Pinned session', ref.id, 'is not resumable from', claudeDir,
      '— starting a fresh session. Clear the Session name/id field to stop pinning it.');
    return { resumeSessionId: '', sessionName: ref.name };
  }

  // The field TRACKS the bot's name unless someone has deliberately taken it
  // over (agentSessionAuto). Almost nobody edits this, so the behaviour that has
  // to be right is the automatic one: rename the bot and its session should
  // follow, keeping the history rather than starting over.
  //
  // The name is still written into the field rather than left blank, because a
  // visible "Jimmy" is what shows the session HAS a name — otherwise
  // `claude --resume Jimmy` in the bot's folder reads as impossible when it works.
  let name = ref.name;
  const auto = store.get('agentSessionAuto') !== false;
  if (auto) {
    const botLabel = resolveSessionName(botName);
    if (botLabel) name = botLabel;
  }
  if (name !== ref.name || ref.implicit) {
    try {
      store.set('agentSession', name);
      notifyConfigChanged('agentSession', name);
    } catch { /* not fatal — the launch below still uses `name` */ }
  }

  // Name-keyed: the id is an implementation detail we look up. A miss is not an
  // error — it is simply the first launch under this name (or in this
  // directory), so we create and let the hook fill the cache in.
  const cache = { ...(store.get('agentSessionCache') || {}) };
  const key = sessionCacheKey(claudeDir, name);

  // Carry the session across a rename instead of orphaning it.
  //
  // Renaming the bot changes the key, which on its own would miss and start an
  // empty session — the bot losing its memory because someone corrected a
  // typo. Since `--name` RENAMES a session in place (verified: resuming with a
  // different --name makes the old title stop resolving and the new one start),
  // moving our cache entry and passing the new name keeps one session that
  // simply changes what it is called.
  //
  // Only when the new name has no session of its own — that case is a switch to
  // an existing session, and must not drag this one on top of it.
  //
  // EVERY session under the old name moves, across every directory, not just the
  // one this launch wants (#570): with per-meeting working directories a bot
  // holds one entry per group it has met, and carrying only the current
  // directory's entry would strand all the others.
  if (!cache[key] && ref.name && ref.name !== name) {
    const renamed = renameSessionCacheEntries(cache, ref.name, name);
    if (renamed) {
      Object.keys(cache).forEach((k) => delete cache[k]);
      Object.assign(cache, renamed.cache);
      try { store.set('agentSessionCache', cache); } catch { /* best effort */ }
      console.log('[electron] Bot renamed', JSON.stringify(ref.name), '→', JSON.stringify(name),
        `— carrying ${renamed.moved.length} session(s) over rather than starting new ones`);
    }
  }

  const cached = resolveSessionId(cache[key]);
  if (cached && sessionExists(cached, claudeDir)) {
    return { resumeSessionId: cached, sessionName: name };
  }
  if (cached) {
    console.log('[electron] Cached session', cached, 'for', name, 'is gone — starting a fresh one');
  }
  // Remember what the next SessionStart hook is reporting about, since the hook
  // payload says which session started but not which name we asked for.
  pendingSessionCacheKey = key;
  return { resumeSessionId: '', sessionName: name };
}

// The session id cached for (claudeDir, name), the same lookup planAgentSession
// makes before every bot launch — reused here so a copied `claude --resume`
// command gets the same guarantee: an id, not a name that stops being unique
// the moment this working directory has collected a second session with that
// title. '' means nothing usable is cached, so the caller falls back to name.
function cachedResumeSessionId(claudeDir, name) {
  const { sessionCacheKey, resolveSessionId, sessionExists } = require('./agent-session.js');
  const id = resolveSessionId((store.get('agentSessionCache') || {})[sessionCacheKey(claudeDir, name)]);
  return id && sessionExists(id, claudeDir) ? id : '';
}

// The (working dir, session name) pair in effect right now — what
// planAgentSession would key the cache on if it ran this instant. Returns null
// when the field pins an explicit id, since a pin has no name-keyed entry.
// Deliberately does NOT call ensureAgentWorkdir: this runs on every panel write,
// and reading a preference should not create a directory as a side effect.
function agentSessionPair() {
  try {
    const { resolveSessionRef } = require('./agent-session.js');
    const cwd = store.get('claudeWorkDir') || require('./agent-workdir.js').agentDirFor(app.getPath('userData'));
    const ref = resolveSessionRef(store.get('agentSession'), resolvedBotName());
    if (ref.kind !== 'name') return null;
    // Mirrors planAgentSession: with the field on auto, the name FOLLOWS the
    // bot, so that is the pair a launch would actually use.
    const auto = store.get('agentSessionAuto') !== false;
    const name = auto ? (require('./agent-session.js').resolveSessionName(resolvedBotName()) || ref.name) : ref.name;
    return { cwd, name };
  } catch { return null; }
}

// Drop the cache entry a manual edit orphaned. The decision of WHETHER there is
// one is staleSessionCacheKey's (agent-session.js, and tested there); this only
// does the write.
function forgetStaleAgentSession(before, after) {
  try {
    const { staleSessionCacheKey } = require('./agent-session.js');
    const key = staleSessionCacheKey(before, after);
    if (!key) return;
    const cache = { ...(store.get('agentSessionCache') || {}) };
    // The key AND its invitee-suffixed children (#570). One orphan under a bot's
    // name is the cosmetic version of this bug; one orphan per group of people
    // the bot has met is how it becomes resuming the wrong meeting's session.
    const dead = Object.keys(cache).filter((k) => k === key || k.startsWith(`${key}\n`));
    if (!dead.length) return;
    dead.forEach((k) => delete cache[k]);
    store.set('agentSessionCache', cache);
    console.log('[electron] Session settings edited by hand — forgetting', dead.length,
      'cached session(s) under', JSON.stringify(key), 'so they cannot be resumed by accident later');
  } catch (err) { console.warn('[electron] forgetStaleAgentSession failed:', err.message); }
}

// Set at launch, consumed by the next hook ping. One agent at a time is already
// enforced by the launchers, so there is no second launch racing for this.
let pendingSessionCacheKey = null;

// Record the session id the CLI chose, so the next launch resumes it by name.
//
// Only for a session WE just started fresh (pendingSessionCacheKey). A resumed
// session reports the id it was already given, so there is nothing to learn from
// it, and a session someone started by hand in the bot's folder must not
// quietly become the bot's session.
function recordAgentSessionId(sessionId) {
  const { resolveSessionId } = require('./agent-session.js');
  const id = resolveSessionId(sessionId);
  const key = pendingSessionCacheKey;
  pendingSessionCacheKey = null;
  if (!id || !key) return;
  try {
    const cache = { ...(store.get('agentSessionCache') || {}), [key]: id };
    store.set('agentSessionCache', cache);
    console.log('[electron] Bot session', JSON.stringify(key), '→', id);
  } catch (err) { console.warn('[electron] recordAgentSessionId failed:', err.message); }
}

// What the panel shows under the field: the name in use, and whether there is a
// session behind it yet. Read-only — the id is not something to type.
ipcMain.handle('get-agent-session', () => {
  try {
    const { resolveSessionRef, sessionCacheKey, sessionExists, resolveSessionId, resolveSessionName } = require('./agent-session.js');
    const claudeDir = store.get('claudeWorkDir') || require('./agent-workdir.js').agentDirFor(app.getPath('userData'));
    const ref = resolveSessionRef(store.get('agentSession'), resolvedBotName());
    if (ref.kind === 'id') {
      return { name: ref.name, id: ref.id, pinned: true, auto: false, exists: sessionExists(ref.id, claudeDir) };
    }
    // Show what the NEXT launch would use, which under auto-tracking is the
    // bot's current name even if the stored field still says the old one.
    const auto = store.get('agentSessionAuto') !== false;
    const name = (auto && resolveSessionName(resolvedBotName())) || ref.name;
    const id = resolveSessionId((store.get('agentSessionCache') || {})[sessionCacheKey(claudeDir, name)]);
    return { name, id: id || '', pinned: false, auto, exists: !!id && sessionExists(id, claudeDir) };
  } catch { return null; }
});

// Claude Code isn't installed → offer a CONSENTED one-click install (visible Terminal
// running the official installer) with a copy-the-command fallback. Never runs anything
// without an explicit button press. Windows can't auto-run yet (the Terminal launcher is
// macOS-only — #468), so there it's copy-only.
function promptInstallClaude() {
  const { clipboard } = require('electron');
  const { execFile } = require('child_process');
  const { installCommandFor } = require('./claude-install.js');
  const cmd = installCommandFor();
  const parent = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null;
  const canAutoRun = process.platform === 'darwin';

  const buttons = canAutoRun ? ['Install Claude Code', 'Copy command', 'Cancel'] : ['Copy command', 'Cancel'];
  dialog.showMessageBox(parent, {
    type: 'info',
    title: 'Install Claude Code',
    message: "Claude Code isn't installed",
    detail:
      "Vibeconferencing runs the bot through Claude Code (the `claude` command). You have a "
      + "Claude subscription, so you just need the CLI — it's a self-contained installer, no Node.js required.\n\n"
      + (canAutoRun
          ? '"Install Claude Code" runs the official installer from claude.ai in a Terminal window (you\'ll see it run). Or "Copy command" to run it yourself:\n\n'
          : 'Copy this command and run it in your terminal:\n\n')
      + cmd
      + "\n\nWhen it finishes, the first run asks you to log in with your Claude subscription. Then click Join again.",
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true,
  }).then(({ response }) => {
    const choice = buttons[response];
    if (choice === 'Copy command') {
      clipboard.writeText(cmd);
      dialog.showMessageBox(parent, { type: 'info', title: 'Copied', message: 'Install command copied', detail: `Paste it into a terminal and run it:\n\n${cmd}\n\nThen click Join again.`, buttons: ['OK'], noLink: true });
    } else if (choice === 'Install Claude Code') {
      // Reuse the Terminal `do script` path so the user WATCHES the official installer run.
      const script = `tell application "Terminal"\n  activate\n  do script "${cmd.replace(/"/g, '\\"')}"\nend tell`;
      execFile('osascript', ['-e', script], (err) => {
        if (err) { console.error('[electron] install launch failed:', err.message); clipboard.writeText(cmd); }
      });
      dialog.showMessageBox(parent, { type: 'info', title: 'Installing Claude Code', message: 'Installing in Terminal', detail: 'A Terminal window is running the official installer. When it finishes, log in with your Claude subscription, then click Join again.', buttons: ['OK'], noLink: true });
    }
  }).catch(() => { /* dialog dismissed */ });
}

// Claude Code is installed but signed out (#137). We still spawn the Terminal — that
// window IS where you sign in — but say so, because the alternative is a bot tile that
// appears and then does nothing while the room debugs the wrong thing. Non-blocking on
// purpose: the dialog and the Terminal come up together, and the message names the
// window to look at rather than describing an error.
function notifyClaudeSignInNeeded() {
  const parent = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null;
  dialog.showMessageBox(parent, {
    type: 'info',
    title: 'Claude Code needs a one-time sign-in',
    message: 'Sign in to Claude Code in the Terminal window',
    detail:
      "Your bot will join the call, but nothing will drive it until Claude Code is signed in.\n\n"
      + "A Terminal window is opening now. If it asks you to log in, do that first — then the "
      + "bot starts responding. This is a one-time step.\n\n"
      + "Until you sign in, the bot looks like it's in the meeting but ignoring everyone.",
    buttons: ['OK'],
    noLink: true,
  }).catch(() => { /* dismissed */ });
}

async function launchClaudeTerminal(meetCode, { onboardingCall = false, calendarEvent = null } = {}) {
  const { execFile } = require('child_process');
  // Test fleets drive the bot from the harness over MCP — they have no use for a
  // spawned agent, and every start_call left another Terminal window on the
  // machine that nothing reaped (the MCP leave_call path doesn't call
  // closeClaudeTerminal; only window-all-closed and the panel's leave-meet do).
  // spawn-test-fleet.sh sets this. Prevention, not cleanup — the fleet teardown
  // also sweeps, but not spawning them is the honest fix.
  // Flag, not env: the fleet launches with `open -n --args`, which does NOT pass
  // the parent environment through. Env is still honoured for `pnpm dev` runs.
  if (cliArgs['no-agent-terminal'] === 'true' || process.env.VIBECONF_NO_AGENT_TERMINAL === '1') {
    console.log('[electron] agent terminal suppressed (--no-agent-terminal)');
    return;
  }
  // #231: on a machine we don't launch the agent for, launching `claude` is not
  // a degraded experience, it is the wrong agent — the user runs Codex (or
  // whatever else) themselves. Return, don't fall through: this used to be a
  // throw caught by the detection catch below, which skipped the install/auth
  // nag but still spawned a Claude Terminal on every join.
  if (!appLaunchesAgent()) {
    console.log('[electron] agent terminal not launched (agentBackend is not claude)');
    return;
  }
  // Claude Code drives the bot. If the `claude` CLI isn't installed, offer to install it
  // (or copy the command) instead of launching a Terminal into "command not found".
  // Detection failure is non-fatal — we still launch (don't block a user who has it).
  // Resolved absolute path to the CLI, for the headless path below. A
  // GUI-launched Electron app inherits launchd's minimal PATH, not the user's,
  // so a bare `claude` in spawn() is an ENOENT waiting to happen — the Terminal
  // path never had this problem because the shell it typed into sources a
  // profile. detectClaude already knows the answer; keep it.
  let claudeBin = 'claude';
  try {
    const { detectClaude } = require('./claude-install.js');
    const det = await detectClaude();
    if (!det.installed) { promptInstallClaude(); return; }
    if (det.path) claudeBin = det.path;
    // Installed ≠ signed in (#137). Read the CACHED answer — warming it happens
    // at startup and on a timer, so this costs nothing on the join path.
    //
    // Deliberately not awaited: the check is a login shell, and making the user
    // wait seconds for their Terminal to appear in order to tell them about a
    // once-ever setup step is a bad trade. The dialog is non-blocking anyway, so
    // a refresh started now surfaces a moment later if the cache was stale.
    if (!claudeReady) {
      // ONLY on an explicit false. null means "couldn't tell" — never nag on a guess.
      if (claudeAuthState.authed === false) notifyClaudeSignInNeeded();
      // Re-check in the background. Auth changes mid-session in exactly the
      // direction that matters: the dialog's whole purpose is to get someone to
      // sign in, and a stale false would nag them again next join for doing what
      // we asked.
      refreshClaudeAuth().then((a) => {
        if (a.authed === false && claudeAuthState.authed !== false) notifyClaudeSignInNeeded();
      }).catch(() => {});
    }
  } catch (e) {
    console.error('[electron] claude detection failed (continuing to launch):', e && e.message);
  }
  // #305: default to this profile's trusted agent dir instead of the untrusted
  // /tmp. An explicit Settings → "Claude Working Directory" still wins.
  const invitees = calendarEvent && Array.isArray(calendarEvent.attendees) ? calendarEvent.attendees : null;
  // #570: with the flag on, a join that came from a calendar event runs in a
  // per-invitee sibling folder instead — its own session, permissions and
  // CLAUDE.md. '' for every case the feature doesn't apply to.
  const meetingDir = ensureMeetingWorkdir(invitees);
  // An explicit Settings → "Claude Working Directory" still wins, even over the
  // flag. Someone who typed a path meant that path, and quietly running
  // somewhere else would be the app overruling an instruction — the same rule
  // planAgentSession follows for a pinned session id. Said out loud rather than
  // silently, because from the outside "the flag did nothing" and "the flag is
  // broken" look identical.
  const overrideDir = store.get('claudeWorkDir');
  if (meetingDir && overrideDir) {
    console.warn('[electron] sessionPerCalendarInvitees is on, but Claude Working Directory is set to',
      overrideDir, '— using that. Clear it to get per-meeting folders.');
  }
  const claudeDir = overrideDir || meetingDir || ensureAgentWorkdir();
  // Ensure this dir's session pings /claude-ready on start (feedback loop for readiness).
  ensureClaudeReadyHook(claudeDir, localServer.port);
  // Use the bot's name (getActiveBotName) so the spawned /join-call <code> <name>
  // + MCP env align with the call we're in. (Slack's real account name is read
  // separately — #283; until then this is the Meet/Bot Name.)
  const botName = resolvedBotName();

  // Named profile instances (second bot, e.g. Samantha): the auto-launch runs
  // `claude` which would otherwise pick up the USER-SCOPED ~/.claude.json
  // vibeconferencing server (the fallback port = the PRIMARY app) and talk to the
  // wrong bot. Write a profile-specific MCP config pointing at THIS app's port and
  // pass --mcp-config + --strict-mcp-config so the spawned session targets this
  // app only. The default instance keeps using the global config.
  let mcpFlags = '';
  // The same path, unescaped. The Terminal launcher needs it wrapped for two
  // quoting layers; the headless launcher passes argv directly and must NOT get
  // the escaped form.
  let mcpConfigPath = '';
  if (!isDefaultInstance) {
    try {
      const mcpServerPath = app.isPackaged
        ? path.join(process.resourcesPath, 'mcp-server', 'server.js')
        : path.join(__dirname, '..', 'mcp-server', 'server.js');
      // Start from the servers the user already has, rather than from nothing.
      //
      // --strict-mcp-config (below) makes this file the ONLY source of MCP
      // servers for the spawned session — that is what guarantees the port pin,
      // but built from scratch it also silently stripped every other tool the
      // user normally has. An agent launched for a named profile could reach
      // its bot and nothing else: no image generation, no search, no issue
      // tracker. Same agent, same machine, mysteriously fewer tools.
      //
      // USER scope only (~/.claude.json's top-level mcpServers). Project-scoped
      // servers are deliberately tied to a directory the bot isn't working in —
      // inheriting one scoped to the user's home into a bot's session would be
      // surprising, and in a shared-machine case, wrong.
      const inherited = {};
      try {
        const home = process.env.HOME || process.env.USERPROFILE;
        const userCfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8'));
        Object.assign(inherited, userCfg.mcpServers || {});
      } catch { /* no user config, or unreadable — the pin below still works */ }

      // A per-bot extension point. Without this, --strict leaves no way to give
      // ONE bot a server the others don't have: .mcp.json in the workdir is a
      // source strict mode ignores, so it would be silently inert. Uses the dir the
      // session actually starts in (claudeDir), which honours a claudeWorkDir
      // override rather than assuming the default agent dir.
      try {
        const botMcp = JSON.parse(fs.readFileSync(path.join(claudeDir, '.mcp.json'), 'utf-8'));
        Object.assign(inherited, botMcp.mcpServers || {});
      } catch { /* none — the common case */ }

      const cfg = {
        mcpServers: {
          ...inherited,
          // LAST, so it always wins. This entry is the entire reason the file
          // exists: the user-scoped one carries a fallback port pointing at the
          // PRIMARY app, so an unpinned session would drive the wrong bot.
          vibeconferencing: {
            command: mcpNodeLauncher().command,
            args: [mcpServerPath],
            env: {
              ...mcpNodeLauncher().env,
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
      mcpConfigPath = cfgPath;
      console.log('[electron] Profile', appProfile, '— launching Claude pinned to port', localServer.port,
        'with', Object.keys(cfg.mcpServers).length, 'MCP server(s):', Object.keys(cfg.mcpServers).join(', '));
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
  // opus rather than "no flag, let the CLI pick" — an implicit default that can
  // shift under us is worse than an explicit one, and opus is statistically
  // tied with sonnet on latency (#responsiveness audit) so it's a fine pick.
  // Accepts an alias (sonnet / opus / haiku) or a full model id; sanitized in
  // claude-model.js, since this is interpolated into an AppleScript-wrapped
  // shell command. See tests/claude-model.test.mjs.
  const { claudeModelFlag } = require('./claude-model.js');
  const modelFlag = claudeModelFlag(store.get('claudeModel'));
  // Settings → "Session name/id". Empty = start fresh; the SessionStart hook then
  // records the new id so the next launch resumes this same conversation.
  // Sanitized in agent-session.js — like the model, this is interpolated into an
  // AppleScript-wrapped shell command.
  const { claudeResumeFlag, claudeNameFlag } = require('./agent-session.js');
  // Resume the bot's own session, and name it after the bot so it reads as
  // "Jimmy" in the prompt box and /resume rather than a UUID.
  const plan = planAgentSession(claudeDir, botName);
  const resumeFlag = claudeResumeFlag(plan.resumeSessionId);
  const nameFlag = claudeNameFlag(plan.sessionName);
  const slashCmd = onboardingCall ? 'onboarding-call' : 'join-call';
  const claudeCmd = `claude${resumeFlag}${nameFlag}${dangerousFlag}${modelFlag}${mcpFlags} \\"/${slashCmd} ${meetCode} ${botName.replace(/"/g, '')}\\"`;

  // #242: run the agent as our own child instead, when asked to. Everything
  // above (detection, auth nag, workdir, MCP config, bot name) is shared — the
  // only difference is who owns the process and therefore who can see it work.
  if (store.get('agentHosting') === 'headless') {
    const launched = launchClaudeHeadless({
      meetCode, botName, claudeDir, dangerousMode, claudeBin, mcpConfigPath, onboardingCall,
    });
    // Falling through to the Terminal path on refusal is deliberate. The
    // alternative is joining a call with an agent that never starts, which
    // presents as a bot sitting silently in the room — the failure this whole
    // issue exists to stop being invisible.
    if (launched) return;
    console.log('[electron] falling back to the Terminal launcher');
  }

  // #329: Linux gets a real terminal instead of falling through to osascript.
  //
  // Everything below this point is AppleScript. On Linux it is not "degraded",
  // it does NOTHING — execFile('osascript') fails ENOENT, the error is logged
  // and swallowed, and the user sees a bot that joined with "no agent activity"
  // while Claude was never started (#317). So this branch must RETURN on every
  // path; falling through is the bug.
  //
  // Fallback order is inverted relative to macOS, per #329: terminal first,
  // then headless, then a loud failure — never a silent no-agent.
  if (process.platform === 'linux') {
    const launched = launchClaudeLinuxTerminal({
      meetCode, botName, claudeDir, dangerousMode, claudeBin, mcpConfigPath, onboardingCall,
    });
    if (launched) return;
    // No terminal emulator AND no tmux. Headless is the last automatic option,
    // and it can still refuse (it requires dangerousMode — see #330, which adds
    // the allowlist mode that would make this refusal much rarer).
    console.log('[electron] no Linux terminal available — trying headless');
    const headless = launchClaudeHeadless({
      meetCode, botName, claudeDir, dangerousMode, claudeBin, mcpConfigPath, onboardingCall,
    });
    if (headless) return;
    // Loud, because the alternative is the failure this whole issue exists to
    // stop being invisible: a bot sitting silently in a room.
    const msg = 'Could not start the agent: no terminal emulator (xterm, konsole, …) '
      + 'and no tmux on PATH, and headless hosting refused. Install xterm or tmux, '
      + 'or enable "dangerous" mode for headless hosting.';
    console.error('[electron]', msg);
    try {
      dialog.showMessageBox({ type: 'error', title: 'Agent could not start', message: msg });
    } catch { /* no window yet — the log line above is still the record */ }
    return;
  }

  // Windows falls through to the AppleScript path below and silently does
  // nothing, exactly as Linux did before this. Out of scope for #329 (which is
  // Linux-only by design), but say so rather than pretending it worked — #317
  // notes the generic "no agent activity" banner cost real debugging time
  // because a missing spawn looks identical to a hung agent.
  if (process.platform !== 'darwin') {
    console.error(`[electron] agent terminal hosting is not implemented on ${process.platform} `
      + '— the agent was NOT started. Use headless hosting, or start the agent manually.');
    return;
  }

  // Open a Terminal window running the command. Reusing a just-launched
  // Terminal's window (rather than adding a second) is handled inside
  // buildTerminalLaunchScript — see there for the -1728 failure that made the
  // old inline version spawn no agent at all.
  // Set VIBECONF_LOCAL_PORT for the spawned session so the agent-activity hook
  // (a child process of claude) reports this bot's transcript to THIS app's
  // local server — not the default 7865 (correct for profile bots on 7866+).
  // Quote the working dir — the #305 agent dir lives under "Application Support",
  // which has spaces (the old /tmp default didn't, so this never mattered before).
  // See launch-command.js for the AppleScript+shell double-quoting.
  const { buildTerminalCommand, buildTerminalLaunchScript } = require('./launch-command.js');
  const cmd = buildTerminalCommand({ workdir: claudeDir, port: localServer.port, innerCmd: claudeCmd });
  const script = buildTerminalLaunchScript(cmd);

  execFile('osascript', ['-e', script], (err, stdout, stderr) => {
    if (err) {
      console.error('[electron] Failed to launch Claude:', err.message, stderr);
      // Do NOT stop at that log line. By this point the bot has already joined
      // the call, so a swallowed error is the silent no-agent failure the Linux
      // path at the top of this function goes out of its way to prevent
      // (#317, #329) — a face in the room, a brain pane stuck on "Waiting for
      // the agent…", and nothing anywhere saying the spawn died. macOS had no
      // such guard until an osascript failure actually happened on 2026-08-17.
      //
      // WARN, don't silently fall back to headless. Headless is gated on
      // Dangerous Mode, so an automatic fallback would only ever fire for users
      // who have already enabled it — and quietly moving those users from a
      // session they can watch and Ctrl-C into an invisible one, because of an
      // unrelated window-server failure, is not a decision this error path gets
      // to make. Headless remains available as an explicit choice
      // (agentHosting), which is where that decision belongs.
      const { asShellCommand } = require('./launch-command.js');
      const shellCmd = asShellCommand(cmd);
      const parent = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null;
      const buttons = ['Copy command', 'OK'];
      try {
        dialog.showMessageBox(parent, {
          type: 'error',
          title: 'Agent could not start',
          message: `${botName} joined the call, but nothing is driving it`,
          detail:
            'Opening a Terminal window for the agent failed, so the bot is sitting in the '
            + 'call with no agent behind it — it will not speak, listen or react.\n\n'
            + `${err.message.trim()}\n\n`
            + 'To recover: open a Terminal window yourself and run this, or leave the call '
            + 'and click Join again.\n\n'
            + shellCmd,
          buttons,
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        }).then(({ response }) => {
          if (buttons[response] === 'Copy command') {
            const { clipboard } = require('electron');
            clipboard.writeText(shellCmd);
          }
        }).catch(() => { /* dialog dismissed */ });
      } catch { /* no window yet — the log line above is still the record */ }
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

// The Linux agent session (#329). Module-level for the same reason
// claudeTerminalWindowIds is: leaving the call has to end it.
//
// Two shapes, so two handles, and only one is ever set:
//   linuxTmuxSession  — a tmux session name we own; teardown is kill-session.
//   linuxTerminalChild— the emulator process itself, when running WITHOUT tmux;
//                       teardown is killing that pid.
let linuxTmuxSession = null;
let linuxTerminalChild = null;
// The tmux viewport window, when there is one. Separate from the two above
// because closing it must NOT end the agent — that separation is the whole
// point of the tmux shape.
let linuxViewportChild = null;

// Is `bin` runnable? Used both to choose the shape and, implicitly, to promise
// the spawn below will work.
//
// PATH is patched the same way the headless spawn patches it, and for the same
// reason: a desktop-launched Electron app inherits a minimal environment, so
// probing the bare PATH would report "no tmux" on a box that has one.
function linuxAgentPath() {
  return [process.env.PATH || '', '/usr/bin', '/usr/local/bin', '/bin',
    path.join(process.env.HOME || '', '.local/bin')].filter(Boolean).join(':');
}
function binaryExists(bin) {
  const { execFileSync } = require('child_process');
  try {
    execFileSync('command', ['-v', bin], { stdio: 'ignore', shell: '/bin/sh', env: { ...process.env, PATH: linuxAgentPath() } });
    return true;
  } catch {
    // `command -v` needs a shell; if that route fails for any reason, fall back
    // to walking PATH ourselves rather than reporting a false negative.
    for (const dir of linuxAgentPath().split(':')) {
      try { fs.accessSync(path.join(dir, bin), fs.constants.X_OK); return true; } catch { /* keep looking */ }
    }
    return false;
  }
}

// Returns true if the agent is now running in a Linux terminal, false to fall
// back to headless. See linux-terminal.js for the shapes and why tmux is an
// upgrade rather than a requirement.
function launchClaudeLinuxTerminal({ meetCode, botName, claudeDir, dangerousMode, claudeBin, mcpConfigPath, onboardingCall = false }) {
  const { spawn, execFileSync } = require('child_process');
  const {
    detectTerminalEmulator, chooseAgentTerminalPlan, tmuxSessionName,
    buildDirectCommand, buildTmuxNewSessionArgs, buildViewportCommand,
  } = require('./linux-terminal.js');
  const { buildInteractiveAgentArgs, cleanAgentEnv } = require('./agent-spawn.js');
  const { resolveClaudeModel } = require('./claude-model.js');

  // One agent at a time, mirroring the headless guard: two agents on one bot
  // both drive the same local server.
  if (linuxTmuxSession || linuxTerminalChild) {
    console.log('[electron] Linux agent terminal already running — reusing it');
    return true;
  }

  const emulator = detectTerminalEmulator({ exists: binaryExists });
  const hasTmux = binaryExists('tmux');
  // linuxAgentTmux, default OFF: a plain terminal unless someone opts in. It
  // gates only the viewport shape — with no emulator, a detached session is the
  // only way to have an agent anyone can type at, so that case ignores it.
  const allowTmux = store.get('linuxAgentTmux') === true;
  const plan = chooseAgentTerminalPlan({ emulator, hasTmux, allowTmux });
  if (!plan) return false; // caller falls back to headless, then errors loudly

  const argv = [claudeBin, ...buildInteractiveAgentArgs({
    meetCode,
    botName,
    dangerous: dangerousMode,
    model: resolveClaudeModel(store.get('claudeModel')),
    mcpConfigPath,
    ...planAgentSession(claudeDir, botName),
    onboardingCall,
  })];

  // Same env contract as the headless spawn: strip the parent Claude session's
  // identity (a bot agent is a session in its own right), point the activity
  // hook and MCP server at THIS app's port, and restore a usable PATH.
  const env = cleanAgentEnv({
    ...process.env,
    VIBECONF_LOCAL_PORT: String(localServer.port),
    PATH: linuxAgentPath(),
  });

  console.log('[electron] Linux agent terminal plan:', plan,
    emulator ? `(emulator: ${emulator.bin})` : '(no emulator)', hasTmux ? '(tmux)' : '(no tmux)');

  try {
    if (plan === 'direct') {
      // The emulator hosts the agent directly. cwd carries the working
      // directory, so no `cd` and no quoting.
      //
      // Some emulators fork and return, so the pid we hold is not the terminal
      // and SIGTERM on it does nothing (measured: xfce4-terminal does this even
      // with --disable-server). Without tmux there is nothing else to kill, so
      // the agent can outlive the call still holding its MCP connection. Say so
      // rather than discovering it as a mystery second bot.
      if (emulator.reapable === false) {
        console.warn(`[electron] ${emulator.bin} forks and returns, so this agent cannot be `
          + 'stopped automatically when the call ends. Install tmux for a session we can '
          + 'reap, or use xterm.');
      }
      const { command, args } = buildDirectCommand({ emulator, argv });
      const child = spawn(command, args, { cwd: claudeDir, env, detached: false, stdio: 'ignore' });
      child.on('error', (err) => {
        console.error('[electron] Linux agent terminal failed to spawn:', err.message);
        linuxTerminalChild = null;
      });
      child.on('exit', (code) => {
        console.log('[electron] Linux agent terminal exited, code', code);
        linuxTerminalChild = null;
      });
      linuxTerminalChild = child;
      return true;
    }

    // tmux shapes. Create the session detached FIRST so the agent is running
    // whether or not a viewport ever opens — that ordering is what makes the
    // no-emulator (#324) case work at all.
    const session = tmuxSessionName({ profile: appProfile, port: localServer.port });
    execFileSync('tmux', buildTmuxNewSessionArgs({ session, workdir: claudeDir, argv }),
      { env, stdio: 'ignore' });
    linuxTmuxSession = session;
    console.log('[electron] agent running in tmux session', session,
      `— attach with: tmux attach -t ${session}`);

    const viewport = buildViewportCommand({ emulator, session });
    if (viewport) {
      const vc = spawn(viewport.command, viewport.args, { env, stdio: 'ignore' });
      // A viewport that dies is not an agent that died. Log and move on; the
      // session is still there and still reattachable.
      vc.on('error', (err) => {
        console.error('[electron] tmux viewport failed (agent still running):', err.message);
        linuxViewportChild = null;
      });
      vc.on('exit', () => { linuxViewportChild = null; });
      linuxViewportChild = vc;
    } else {
      console.log('[electron] no terminal emulator — session is detached; attach over SSH');
    }
    return true;
  } catch (err) {
    console.error('[electron] Linux agent terminal launch failed:', err.message);
    linuxTmuxSession = null;
    linuxTerminalChild = null;
    return false; // let the caller try headless rather than joining agent-less
  }
}

// The headless agent, when there is one. Module-level for the same reason
// claudeTerminalWindowIds is: leaving the call has to be able to end it, and an
// orphaned agent still holding an MCP connection to this app is worse than an
// orphaned Terminal window — it keeps acting.
let headlessAgentChild = null;
// Which call the live agent was launched for, and a generation counter so a
// replaced agent's exit handler cannot tear down its successor. See the
// lame-duck check in launchClaudeHeadless.
let headlessAgentCall = null;
// Set the moment the agent's call ends. The agent outlives its call on purpose
// (after-call work), so "alive" and "serving a live call" are different things,
// and only the second one is a reason to reuse it.
let headlessAgentCallOver = false;
let headlessAgentGeneration = 0;

// Returns true if the agent is now running headlessly, false to fall back.
function launchClaudeHeadless({ meetCode, botName, claudeDir, dangerousMode, claudeBin, mcpConfigPath, onboardingCall = false }) {
  const { buildAgentArgs, headlessBlockedReason, spawnHeadlessAgent } = require('./agent-spawn.js');

  const blocked = headlessBlockedReason({ dangerous: dangerousMode });
  if (blocked) {
    console.log('[electron] headless agent refused —', blocked);
    return false;
  }

  // One agent at a time. A second join while one is live would put two agents on
  // one bot, both driving the same local server — and both writing into one
  // activity buffer, which is the interleaving the source abstraction is built
  // to avoid rather than merge.
  //
  // But "an agent is alive" is NOT the same as "an agent is serving this call".
  // leave_call deliberately does not kill the agent: it stays up to write its
  // summary and memory files, which took 87s on the 2026-08-23 test call. Call
  // back inside that window and this guard used to say "reusing it" about an
  // agent that was already winding down — it then exited, and the new call was
  // left with no agent at all. A bot that joins and never speaks, which is the
  // worst failure shape this app has.
  //
  // So reuse only an agent launched for THIS call. Anything else is a lame duck
  // finishing the last one.
  if (headlessAgentChild && !headlessAgentCallOver) {
    console.log('[electron] headless agent already running for this call — reusing it');
    return true;
  }
  if (headlessAgentChild) {
    // Ending it costs the tail of its after-call write-up. That is the right
    // trade: the previous call's summary is worth less than the live call
    // having a bot that talks, and it has already had from leave_call until
    // now. It costs less than it looks, too — the replacement resumes the SAME
    // session, so the interrupted work is still in the agent's own history
    // rather than thrown away.
    console.log('[electron] previous agent is still writing up'
      + (headlessAgentCall ? ` ${headlessAgentCall}` : '')
      + ' — ending it so this call gets its own'
      + (headlessAgentCall === meetCode ? ' (same room, new call)' : ''));
    const stale = headlessAgentChild;
    // Remember WHAT we interrupted. The replacement resumes the same session,
    // so the work itself is still in the agent's history — it just needs to be
    // told it stopped early, which afterCallWorkPlan does at the end of this
    // call. Without this the summary is simply lost, silently.
    try {
      store.set('agentUnfinishedWrapUp', {
        call: headlessAgentCall || null,
        interruptedAt: new Date().toISOString(),
        interruptedBy: meetCode,
      });
    } catch { /* best effort */ }
    // Cleared and bumped FIRST so a late exit from this one cannot null out its
    // successor or hand the successor's activity feed back to the transcript.
    headlessAgentChild = null;
    headlessAgentGeneration++;

    // Wait for it to be GONE before starting the replacement. The new agent
    // resumes the same session id, and two processes on one session file is a
    // race we should not run — the CLI already refuses an in-use session for
    // --session-id, and there is no reason to find out how --resume handles it.
    let started = false;
    const startOnce = () => { if (!started) { started = true; startAgent(); } };
    stale.once('exit', startOnce);
    // A wrap-up that will not die must not strand the live call.
    const hardStop = setTimeout(() => {
      console.warn('[electron] previous agent did not exit in 5s — killing it');
      try { stale.kill('SIGKILL'); } catch { /* already gone */ }
      startOnce();
    }, 5000);
    if (typeof hardStop.unref === 'function') hardStop.unref();
    stale.once('exit', () => clearTimeout(hardStop));
    try { stale.kill('SIGTERM'); } catch { startOnce(); }
    return true;
  }

  startAgent();
  return true;

  // Hoisted so the lame-duck path above can call it once the old agent is gone.
  function startAgent() {
  const { resolveClaudeModel } = require('./claude-model.js');
  const args = buildAgentArgs({
    meetCode,
    botName,
    dangerous: dangerousMode,
    model: resolveClaudeModel(store.get('claudeModel')),
    mcpConfigPath,
    ...planAgentSession(claudeDir, botName),
    onboardingCall,
  });

  // The stream becomes the activity source BEFORE the spawn, so the very first
  // event has somewhere to land. It also makes setAgentSession a no-op from here
  // on — this agent fires the PostToolUse hook itself, and letting that rebind us
  // to a transcript would wipe the feed one tool call in.
  const source = localServer.useStreamAgentSource();

  const env = {
    ...process.env,
    // Same reason as the Terminal path: the agent-activity hook and the MCP
    // server must report to THIS app's port, not the default 7865.
    VIBECONF_LOCAL_PORT: String(localServer.port),
    // Restore a usable PATH. Electron's is launchd's, and the agent shells out
    // (git, node, the MCP launcher) far more than the app does.
    PATH: [process.env.PATH || '', '/opt/homebrew/bin', '/usr/local/bin',
      path.join(process.env.HOME || '', '.local/bin')].filter(Boolean).join(':'),
  };

  console.log('[electron] launching headless agent:', claudeBin, args.join(' '));
  // This agent's identity, so a superseded one's exit cannot tear this one down.
  const gen = ++headlessAgentGeneration;
  headlessAgentCall = meetCode;
  headlessAgentCallOver = false;
  headlessAgentChild = spawnHeadlessAgent({
    claudePath: claudeBin,
    args,
    cwd: claudeDir,
    env,
    source,
    onExit: ({ code, error }) => {
      // A retired agent exiting late must not null out its replacement, nor
      // hand the replacement's live feed back to the transcript tail.
      if (gen !== headlessAgentGeneration) return;
      headlessAgentChild = null;
      headlessAgentCall = null;
      // A dead agent's last words must not sit in the pane looking live. The
      // brain pane has no other way to tell — it renders a buffer, and a buffer
      // that simply stops updating is indistinguishable from a quiet call.
      if (error) source.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `[agent failed to launch: ${error.code || error.message}]` }] } }) + '\n');
      else if (code) source.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `[agent exited with code ${code}]` }] } }) + '\n');
      // Hand the activity feed back to the transcript tail. A dead stream
      // source otherwise blocks setAgentSession for the rest of the app's
      // life, and the next terminal-driven session's model/context markers
      // silently vanish (observed on the 2026-08-10 Seth call).
      localServer.releaseStreamAgentSource();
    },
  });
  }
}

function closeClaudeTerminal() {
  // Headless agents have no window to close — end the process instead. SIGTERM
  // so the session can finish its current turn; the call is already over by the
  // time this runs, so there is nothing to wait for beyond that.
  if (headlessAgentChild) {
    console.log('[electron] ending headless agent');
    // Killing it mid-write-up loses that work unless we say so. The lame-duck
    // path in launchClaudeHeadless already records this; teardown did not, so
    // the one kill the user never asked for was also the one that went
    // unreported. Same hand-over: the agent resumes this session next call, so
    // the work is still in its history and only needs flagging.
    if (headlessAgentCallOver) {
      try {
        store.set('agentUnfinishedWrapUp', {
          call: headlessAgentCall || null,
          interruptedAt: new Date().toISOString(),
          interruptedBy: 'call teardown',
        });
        console.log('[electron] agent was still writing up', headlessAgentCall,
          '— recorded so the next call can finish it');
      } catch { /* best effort */ }
    }
    try { headlessAgentChild.kill('SIGTERM'); } catch { /* already gone */ }
    headlessAgentChild = null;
    headlessAgentCall = null;
    headlessAgentCallOver = false;
  }

  // #329: the Linux shapes. Killing the tmux SESSION is what ends the agent —
  // the viewport is only a window onto it, so closing that alone would leave an
  // agent running and still holding an MCP connection. That is the orphan
  // hazard the macOS window-ID teardown has always carried; here the session
  // name is ours, so the kill is direct and cannot miss.
  if (linuxTmuxSession) {
    const { execFile } = require('child_process');
    const { buildKillSessionArgs } = require('./linux-terminal.js');
    const session = linuxTmuxSession;
    linuxTmuxSession = null;
    console.log('[electron] killing tmux session', session);
    execFile('tmux', buildKillSessionArgs({ session }),
      { env: { ...process.env, PATH: linuxAgentPath() } },
      (err, _out, stderr) => {
        // An agent that already exited on its own is the NORMAL end-of-call
        // case, and tmux exits non-zero for it ("can't find session", or "no
        // server running" once the last session goes). Logging that as a
        // failure would cry wolf on every clean call.
        if (!err) return;
        const gone = /can't find session|no server running/i.test(String(stderr || err.message));
        if (gone) console.log('[electron] tmux session', session, 'had already exited');
        else console.error('[electron] tmux kill-session failed:', err.message);
      });
  }
  if (linuxViewportChild) {
    try { linuxViewportChild.kill('SIGTERM'); } catch { /* already gone */ }
    linuxViewportChild = null;
  }
  // The no-tmux shape: the emulator IS the agent's host, so ending it ends the
  // agent. SIGTERM for the same reason as headless — let the turn finish.
  if (linuxTerminalChild) {
    console.log('[electron] ending Linux agent terminal');
    try { linuxTerminalChild.kill('SIGTERM'); } catch { /* already gone */ }
    linuxTerminalChild = null;
  }

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

// The role this instance claims about ITSELF, on anything that reaches the
// server carrying identity.
//
// `announceAsBot` (#471) used to gate only _registerPresence, which turned out
// to be one of four doors. The website's POST /api/sync also upserts presence
// from the sender's role — so a whiteboard update, a style change, or a sharing
// announcement re-declared this instance a bot, no matter what it had decided
// about announcing.
//
// Caught by the row's own shape: a voice that logged "not announcing as a bot",
// registered zero times, and still appeared in presence as
//   {"name":"Jimmy","role":"bot",...,"sharing":false,"screenShareUrl":null}
// — and `sharing`/`screenShareUrl` are written by exactly one caller, the
// sharing announcement.
//
// Returns undefined when this instance is presenting as a person, so the field
// is omitted rather than set to something. An absent role now leaves the
// existing value alone server-side, so omitting is genuinely neutral.
function selfRole() {
  try {
    if (localServer._pref('announceAsBot') === false) return undefined;
  } catch { /* no store yet — behave as before */ }
  return 'bot';
}

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
    // Carry the role, because this POST cannot avoid asserting one.
    //
    // The presence endpoint assigns role on EVERY write, and a body without one
    // resolves to 'member'. This fires on every speaking edge, for every
    // participant the tracker sees — so each bot was demoting every other bot it
    // heard talk, several times a minute, purely as a side effect of announcing
    // who was speaking. Each bot's own 60s registration heartbeat promoted it
    // back, and the room's roles oscillated: measured on paz-sqoa-npe, a bot
    // read as `member` 56s after it had announced itself as `bot`.
    //
    // That matters because role IS the bot/human answer everywhere downstream —
    // _botNameSet() feeds ranked speaking order (#443) and the human-vs-bot
    // split in _evaluateBargeIn (#154), where "unknown ⇒ human" is deliberate
    // because talking over a person is the worse mistake. A bot misread as a
    // human gets yielded to instantly and loses its own turn slot.
    //
    // Only for names we already KNOW are bots. An unknown name still resolves to
    // 'member', which is right for the humans in the room and avoids this code
    // asserting an identity it is only guessing at — the mistake that caused
    // this in the first place. A bot we have not learned yet self-heals on its
    // own next heartbeat.
    let role;
    try {
      if (localServer._botNameSet().has(String(name).toLowerCase())) role = 'bot';
      // …unless this is US and we have been told not to announce ourselves as a
      // bot (#471). Otherwise announceAsBot is only half a disguise: the
      // instance correctly declines to REGISTER, then re-asserts `role: 'bot'`
      // about itself on its very next speaking edge, and the room learns it
      // anyway. Observed exactly that — a voice logging "not announcing as a
      // bot" with zero registrations, while presence still listed it as one.
      //
      // Only about ourselves. What this instance believes about OTHER
      // participants is unaffected: declining to claim bot status is not the
      // same as lying about everyone else.
      const self = (localServer.getEffectiveBotName() || '').toLowerCase();
      if (role && self && String(name).toLowerCase() === self && !selfRole()) role = undefined;
    } catch { /* roster unavailable — fall through unroled, as before */ }
    fetch(`${baseUrl}/api/room/${sync.roomId}/presence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, speaking, ...(role ? { role } : {}) }),
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
    // Reinstalling/updating the app does NOT kill an already-running process —
    // it just overwrites the .app bundle. That old process keeps the lock and
    // keeps serving on DEFAULT_PORT, so a "fresh" relaunch silently quits here
    // while the old process answers every MCP call with whatever stale state
    // it was last in (this is exactly how a truly-just-launched app can be
    // reported as `callStatus: 'joining'` — it's not this process at all).
    // Best-effort diagnostics before quitting so that class of confusion is
    // visible in the log instead of silent; never block quitting on it.
    (async () => {
      let detail = 'no response';
      try {
        const resp = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/api/sync/no-room`,
          { signal: AbortSignal.timeout(1500) });
        const data = await resp.json();
        detail = `roomId=${data.roomId || '(none)'} callStatus=${data.status?.callStatus || '(unknown)'}`;
      } catch (err) {
        detail = `port ${DEFAULT_PORT} did not answer diagnostics: ${err.message}`;
      }
      console.log('[electron] Another instance already holds the single-instance lock —', detail, '— quitting this one.');
      app.quit();
    })();
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
//
// It also warns in-terminal when a bot joins a call on Fable (#responsiveness
// audit: Fable averages ~17s stop→audio vs ~8s for Sonnet/Opus, almost entirely
// think time) — via the join_call tool call itself, so it fires exactly once
// per join, for whoever's actually watching that terminal.
const AGENT_HOOK_CONTENT = `#!/usr/bin/env node
// Auto-installed by Vibeconferencing — reports the Claude session's transcript
// path to the local bot server for the debug-overlay agent-activity tail, and
// warns (once per join_call) when the joining model is Fable.
// Never blocks or breaks the agent: swallows all errors, exits 0 fast.
const http = require('http');
const fs = require('fs');
// process.exit() can truncate a stdout write to a pipe that hasn't flushed yet
// — a real Node gotcha, not hypothetical. Every exit path funnels through
// done(), which waits on this if maybeWarnSlowModel started a write.
let pendingWrite = null;
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let d = {};
  try { d = JSON.parse(raw); } catch (e) {}
  maybeWarnSlowModel(d);
  const transcriptPath = d.transcript_path;
  if (!transcriptPath) return done();
  const port = process.env.VIBECONF_LOCAL_PORT || '7865';
  const body = JSON.stringify({ sessionId: d.session_id, transcriptPath });
  // #201 made the control API require a bearer token, and this hook was not
  // updated — so every POST here 401'd from Aug 1 and the agent session was
  // never bound. Nothing surfaced it: the hook swallows all errors by design,
  // and a hook that silently stops working looks exactly like a hook that has
  // nothing to report. The visible symptom was the avatar never reaching
  // 🧑‍💻 working (#339), because that state is driven entirely by this feed.
  //
  // Same 0600 file the MCP server reads, keyed by port.
  let token = '';
  try {
    token = fs.readFileSync(
      require('path').join(require('os').homedir(), '.vibeconferencing', 'local-tokens', port + '.token'),
      'utf8').trim();
  } catch (e) { /* no token file — server may be running with auth off */ }
  const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
  if (token) headers.authorization = 'Bearer ' + token;
  const req = http.request({
    host: '127.0.0.1', port, path: '/api/agent-session', method: 'POST',
    headers,
    timeout: 500,
  }, (res) => { res.resume(); res.on('end', done); });
  req.on('error', done);
  req.on('timeout', () => { req.destroy(); done(); });
  req.write(body); req.end();
});

// A PostToolUse hook's stdout JSON can carry a systemMessage shown to the user
// in-terminal (not fed to the model, and non-blocking — the tool already ran).
// Only checked on join_call itself, so this fires once per join, not once per
// tool call.
function maybeWarnSlowModel(d) {
  try {
    if (d.tool_name !== 'mcp__vibeconferencing__join_call') return;
    const model = lastRealModel(d.transcript_path);
    if (model && model.toLowerCase().includes('fable')) {
      pendingWrite = new Promise((resolve) => {
        process.stdout.write(JSON.stringify({
          systemMessage: '⚠️ Joining on ' + model + ' — response latency tends to run much higher than Sonnet/Opus (~17s vs ~8s avg in our audits), almost entirely model think time. Switch with /model if responsiveness matters here.',
        }), resolve);
      });
    }
  } catch (e) { /* never let a warning attempt block the join */ }
}

// The model on the most recent real (non-<synthetic>) assistant turn, read
// from the tail of the transcript. The turn that IS this join_call call is
// always the last one at this point, so a small tail read is enough.
function lastRealModel(transcriptPath) {
  if (!transcriptPath) return null;
  const size = fs.statSync(transcriptPath).size;
  const tailBytes = Math.min(size, 65536);
  const fd = fs.openSync(transcriptPath, 'r');
  const buf = Buffer.alloc(tailBytes);
  fs.readSync(fd, buf, 0, tailBytes, size - tailBytes);
  fs.closeSync(fd);
  const lines = buf.toString('utf-8').split('\\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let entry; try { entry = JSON.parse(lines[i]); } catch (e) { continue; }
    const model = entry && entry.type === 'assistant' && entry.message && entry.message.model;
    if (model && model !== '<synthetic>') return model;
  }
  return null;
}

function done() {
  if (pendingWrite) { pendingWrite.then(() => process.exit(0)); return; }
  process.exit(0);
}
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
  const mcpServerRoot = bundledMcpServerRoot();
  const mcpServerPath = bundledMcpServerPath();
  const appLaunchCmd = isPackaged
    ? 'open -a Vibeconferencing'
    : `cd ${__dirname} && npx electron .`;

  // ~/.claude.json is durable config; only point it at a server that can
  // actually start. Packaged builds get prod deps via beforePack; a fresh
  // source checkout has none until someone installs them in mcp-server/.
  const serverEntryExists = fs.existsSync(mcpServerPath);
  // The server needs BOTH the MCP SDK and zod to boot — check both, not just the SDK.
  const serverDepsPresent = mcpServerDepsPresent(mcpServerRoot);

  // A linked git worktree (`.git` is a file, not a dir) is a removable
  // checkout — repointing durable config at one strands the entry when the
  // worktree goes away.
  const isTempWorktree = runningFromGitWorktree();

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
  const configuredBotName = resolvedBotName();
  const currentMcp = claudeJson.mcpServers.vibeconferencing;
  const nodeLauncher = mcpNodeLauncher();
  // `command` is compared too, so installs written by an older build (which
  // hardcoded 'node') get repaired on next launch instead of staying broken for
  // exactly the users who can't diagnose it.
  const needsUpdate = !currentMcp ||
    currentMcp.command !== nodeLauncher.command ||
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
      command: nodeLauncher.command,
      args: [mcpServerPath],
      env: {
        ...nodeLauncher.env,
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
  const SKILL_VERSION = '60';  // Bump this when updating the skill content below
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
    console.log(`[electron] Installed/updated skill v${SKILL_VERSION} at ${skillPath}`);
    changed = true;
  } else {
    console.log('[electron] Skill v%s already installed', SKILL_VERSION);
  }

  // --- Ensure global skill in ~/.claude/skills/call/ ---
  // /call starts a BRAND-NEW call (the command form of the panel's "Call <bot>
  // now"); /join-call puts the bot into one that already exists. Same version
  // gate, its own directory — Claude Code takes one skill per directory.
  try {
    const callSkillDir = path.join(claudeDir, 'skills', 'call');
    const callVersionFile = path.join(callSkillDir, '.version');
    let callInstalled = '';
    try { callInstalled = fs.readFileSync(callVersionFile, 'utf-8').trim(); } catch { /* not yet */ }
    if (callInstalled !== SKILL_VERSION) {
      fs.mkdirSync(callSkillDir, { recursive: true });
      fs.writeFileSync(path.join(callSkillDir, 'SKILL.md'), fs.readFileSync(
        isPackaged
          ? path.join(process.resourcesPath, 'mcp-server', 'call-skill.md')
          : path.join(__dirname, '..', 'mcp-server', 'call-skill.md'),
        'utf-8',
      ));
      fs.writeFileSync(callVersionFile, SKILL_VERSION);
      console.log(`[electron] Installed/updated /call skill v${SKILL_VERSION}`);
      changed = true;
    }
  } catch (err) {
    console.warn('[electron] /call skill install failed:', err.message);
  }

  // --- Ensure global skill in ~/.claude/skills/call-new-bot/ ---
  // /call-new-bot turns the CALLER's own Claude session into a bot: it creates a
  // profile seeded with that session's workdir + name, so the new bot resumes it
  // rather than starting fresh. The inverse of every other path here — normally a
  // bot gets a session; this gives a session a bot. Same version gate, own
  // directory (Claude Code takes one skill per directory).
  try {
    const newBotSkillDir = path.join(claudeDir, 'skills', 'call-new-bot');
    const newBotVersionFile = path.join(newBotSkillDir, '.version');
    let newBotInstalled = '';
    try { newBotInstalled = fs.readFileSync(newBotVersionFile, 'utf-8').trim(); } catch { /* not yet */ }
    if (newBotInstalled !== SKILL_VERSION) {
      fs.mkdirSync(newBotSkillDir, { recursive: true });
      fs.writeFileSync(path.join(newBotSkillDir, 'SKILL.md'), fs.readFileSync(
        isPackaged
          ? path.join(process.resourcesPath, 'mcp-server', 'call-new-bot-skill.md')
          : path.join(__dirname, '..', 'mcp-server', 'call-new-bot-skill.md'),
        'utf-8',
      ));
      fs.writeFileSync(newBotVersionFile, SKILL_VERSION);
      console.log(`[electron] Installed/updated /call-new-bot skill v${SKILL_VERSION}`);
      changed = true;
    }
  } catch (err) {
    console.warn('[electron] /call-new-bot skill install failed:', err.message);
  }

  // --- Ensure global skill in ~/.claude/skills/onboarding-call/ ---
  // /onboarding-call is /call's guided-setup sibling: same "start a brand-new
  // call" mechanics, but the agent runs a scripted walkthrough (name, voice,
  // emoji, whiteboard style, skills, after-call routine) instead of a normal
  // conversation. Triggered by the panel's "Setup" button (setupCallBtn),
  // which passes onboardingCall through createAndJoinMeet → launchClaudeTerminal
  // / launchClaudeHeadless → buildAgentArgs, picking this slash command over
  // /join-call. Same version gate as the other two, own directory.
  try {
    const onboardingSkillDir = path.join(claudeDir, 'skills', 'onboarding-call');
    const onboardingVersionFile = path.join(onboardingSkillDir, '.version');
    let onboardingInstalled = '';
    try { onboardingInstalled = fs.readFileSync(onboardingVersionFile, 'utf-8').trim(); } catch { /* not yet */ }
    if (onboardingInstalled !== SKILL_VERSION) {
      fs.mkdirSync(onboardingSkillDir, { recursive: true });
      fs.writeFileSync(path.join(onboardingSkillDir, 'SKILL.md'), fs.readFileSync(
        isPackaged
          ? path.join(process.resourcesPath, 'mcp-server', 'onboarding-call-skill.md')
          : path.join(__dirname, '..', 'mcp-server', 'onboarding-call-skill.md'),
        'utf-8',
      ));
      fs.writeFileSync(onboardingVersionFile, SKILL_VERSION);
      console.log(`[electron] Installed/updated /onboarding-call skill v${SKILL_VERSION}`);
      changed = true;
    }
  } catch (err) {
    console.warn('[electron] /onboarding-call skill install failed:', err.message);
  }

  // --- Ensure global skill in ~/.claude/skills/emoji-set/ ---
  // /emoji-set generates a themed avatar image set (nanobanana) plus a matching
  // call background, and points a running bot at it via the `dir:`/`file:`
  // preference forms. Same version gate as the other skills, own directory.
  try {
    const emojiSetSkillDir = path.join(claudeDir, 'skills', 'emoji-set');
    const emojiSetVersionFile = path.join(emojiSetSkillDir, '.version');
    let emojiSetInstalled = '';
    try { emojiSetInstalled = fs.readFileSync(emojiSetVersionFile, 'utf-8').trim(); } catch { /* not yet */ }
    if (emojiSetInstalled !== SKILL_VERSION) {
      fs.mkdirSync(emojiSetSkillDir, { recursive: true });
      fs.writeFileSync(path.join(emojiSetSkillDir, 'SKILL.md'), fs.readFileSync(
        isPackaged
          ? path.join(process.resourcesPath, 'mcp-server', 'emoji-set-skill.md')
          : path.join(__dirname, '..', 'mcp-server', 'emoji-set-skill.md'),
        'utf-8',
      ));
      fs.writeFileSync(emojiSetVersionFile, SKILL_VERSION);
      console.log(`[electron] Installed/updated /emoji-set skill v${SKILL_VERSION}`);
      changed = true;
    }
  } catch (err) {
    console.warn('[electron] /emoji-set skill install failed:', err.message);
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

// ---------------------------------------------------------------------------
// Codex integration (MCP config only)
// ---------------------------------------------------------------------------

function ensureCodexIntegration() {
  const home = process.env.HOME || process.env.USERPROFILE;
  const configPath = codexConfigPath(home);
  const mcpServerRoot = bundledMcpServerRoot();
  const mcpServerPath = bundledMcpServerPath();
  const serverEntryExists = fs.existsSync(mcpServerPath);
  const serverDepsPresent = mcpServerDepsPresent(mcpServerRoot);

  if (!serverEntryExists) {
    console.warn('[electron] Codex MCP server entrypoint missing at', mcpServerPath,
      '- leaving Codex config untouched');
    return false;
  }
  if (!serverDepsPresent) {
    console.warn('[electron] mcp-server deps not installed (no node_modules/@modelcontextprotocol/sdk).',
      'Run `npm install` (or pnpm) in', mcpServerRoot, '- leaving Codex config untouched');
    return false;
  }

  const { content: existingCodexConfig, readable } = readCodexConfigSafe(configPath);
  if (!readable) {
    console.warn('[electron] ~/.codex/config.toml exists but is unreadable -',
      'leaving Codex MCP config untouched to avoid clobbering other servers');
    return false;
  }

  const currentServerPath = currentCodexMcpServerPath(existingCodexConfig);
  const existingServerOk = !!currentServerPath && fs.existsSync(currentServerPath);
  if (runningFromGitWorktree() && existingServerOk && currentServerPath !== mcpServerPath) {
    console.warn('[electron] running from a git worktree - keeping existing Codex MCP server path',
      currentServerPath, 'instead of repointing durable config at', mcpServerPath);
    return false;
  }

  const localBaseUrl = `http://127.0.0.1:${DEFAULT_PORT}`;
  const configuredBotName = resolvedBotName();
  const nodeLauncher = mcpNodeLauncher();
  const result = installCodexMcpConfig({
    configPath,
    command: nodeLauncher.command,
    args: [mcpServerPath],
    env: {
      ...nodeLauncher.env,
      VIBECONF_ROOM_ID: '',
      VIBECONF_BOT_NAME: configuredBotName,
      VIBECONF_BASE_URL: localBaseUrl,
    },
  });

  if (!result.ok) {
    console.warn('[electron] Codex MCP config not updated:', result.reason || 'unknown error');
    return false;
  }
  if (result.changed) {
    console.log('[electron] Updated Codex MCP config -> local server at', localBaseUrl, 'botName:', configuredBotName);
    if (result.backupPath) console.log('[electron] Backed up previous Codex config:', result.backupPath);
    console.log('[electron] Codex integration installed. Restart Codex to pick up MCP changes.');
    return true;
  }
  console.log('[electron] Codex MCP config already pointing to local server');
  return false;
}

function removeCodexIntegration() {
  const home = process.env.HOME || process.env.USERPROFILE;
  const result = uninstallCodexMcpConfig({ configPath: codexConfigPath(home) });
  if (!result.ok) {
    console.warn('[electron] Codex MCP config not removed:', result.reason || 'unknown error');
    return false;
  }
  if (result.changed) {
    console.log('[electron] Removed Codex MCP config from ~/.codex/config.toml');
    if (result.backupPath) console.log('[electron] Backed up previous Codex config:', result.backupPath);
  }
  console.log('[electron] Codex integration uninstalled.');
  return result.changed;
}

// Live "is it actually there" checks for the menu — deliberately independent
// of the leave-no-trace store flags (those only gate re-install at boot; they
// drift from ground truth if the user hand-edits the config files).
function isClaudeIntegrationInstalled() {
  const home = process.env.HOME || process.env.USERPROFILE;
  const claudeJsonPath = path.join(home, '.claude.json');
  const { readClaudeConfigSafe } = require('./claude-config.js');
  const { config, readable } = readClaudeConfigSafe(claudeJsonPath);
  return readable && !!config.mcpServers?.vibeconferencing;
}

function isCodexIntegrationInstalled() {
  const home = process.env.HOME || process.env.USERPROFILE;
  const configPath = codexConfigPath(home);
  const { content, readable } = readCodexConfigSafe(configPath);
  return readable && !!currentCodexMcpServerPath(content);
}

app.whenReady().then(async () => {
  // P2: force plain system DNS (no DoH). Chromium's built-in resolver does Secure DNS by
  // default, which can't resolve LiveKit's dynamic media/TURN hosts (*.host/.turn.livekit.cloud)
  // → -105 in WebRTC → the Runway avatar video never connects. The OS resolver handles them, so
  // route host resolution through it. Harmless for Meet/everything else.
  try { app.configureHostResolver({ secureDnsMode: 'off' }); console.log('[runway] host resolver → secureDnsMode off (plain system DNS)'); } catch (e) { console.warn('[runway] configureHostResolver failed:', e && e.message); }

  // Defensive startup reset: a fresh process already constructs `localServer`
  // with callStatus 'idle' (it's never persisted to disk), so this is
  // normally a no-op. But it closes off an entire class of "stale status
  // survives a restart" bug for free — belt-and-suspenders against any future
  // persistence path, and against a `localServer` singleton that outlives a
  // single boot for reasons that aren't true today. Real fresh boots pay
  // nothing for it since setCallStatus() is a no-op when the value hasn't
  // changed. Must run before any --meet-url auto-join logic below, which is
  // what actually moves callStatus off 'idle'.
  localServer.setCallStatus('idle');

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
    // Captured BEFORE the migration below can create newCfgPath — otherwise
    // a profile with only a legacy loose config would look brand new by the
    // time onboardingCallComplete is decided further down.
    const isBrandNewProfile = !fs.existsSync(newCfgPath) && !fs.existsSync(oldCfgPath);
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

    // `onboardingCallComplete`'s schema default is true — see
    // preferences-schema.js — so every profile that predates this preference
    // (or that this code simply never touches) reads as already onboarded,
    // with no migration needed. A profile only needs to be told OTHERWISE at
    // the one moment it's genuinely brand new: no config.json anywhere for
    // it yet, meaning nothing (not even a "New bot" pre-seed — see
    // seedNewBotName, which stamps this explicitly for that path) has ever
    // run for this profile before.
    if (isBrandNewProfile && profileStore.get('onboardingCallComplete') === undefined) {
      profileStore.set('onboardingCallComplete', false);
    }

    // A brand-new bot otherwise ships with the plain animated gradient — the
    // SAME one every other unconfigured bot has, which makes the switcher
    // useless for telling several fresh bots apart at a glance. Seed one of
    // the bundled presets at random instead, right here at the one moment a
    // profile is genuinely new — covers every path that creates a bot ("New
    // bot…", /call-new-bot, and the very first default-profile launch), since
    // they all funnel through this same per-process startup.
    if (isBrandNewProfile && !profileStore.get('avatarBackgroundSvg')) {
      try {
        const bgDir = __dirname.includes('.asar')
          ? path.join(process.resourcesPath, 'backgrounds', 'presets')
          : path.join(__dirname, 'backgrounds', 'presets');
        const BG_EXTS = /\.(svg|png|jpe?g|webp|gif)$/i;
        const files = fs.readdirSync(bgDir).filter((f) => BG_EXTS.test(f));
        if (files.length) {
          const chosen = files[Math.floor(Math.random() * files.length)];
          const svg = await buildBackgroundSvgFromImage(path.join(bgDir, chosen));
          profileStore.set('avatarBackgroundSvg', svg);
          profileStore.set('avatarBackgroundCaption', chosen.replace(BG_EXTS, ''));
        }
      } catch (err) {
        console.warn('[config] could not seed a random background for new bot:', err.message);
      }
    }
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
        // running from source (an un-bumped package.json reads e.g. "0.8.9" even
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
    // Default OFF (#255). Only an explicit `true` ships. The test used to be
    // `!== false`, matching a default of on — left unchanged after the flip it
    // would have kept every unset install shipping, which is precisely the
    // population the new default is for.
    const remoteLoggingOn = store?.get('remoteLogging') === true;
    configureRemoteLog({
      enabled: remoteLoggingOn,
      endpointBase: () => getWebsiteUrl(),
      instanceId,
      token: process.env.VIBECONF_LOGS_TOKEN || '',
      // #386: send the vibeconferencing.com login (app-level vcSessionToken, the
      // vc_session JWT mirror) so the backend authorizes log writes by USER — no
      // bundled secret. Read fresh each flush so login/logout takes effect live.
      sessionToken: () => (store && store.get('vcSessionToken')) || '',
      // #230: ship promptly while a call is in ANY phase — including joining and
      // waiting-to-be-admitted, which is precisely when someone is tailing the
      // log to find out why a join is failing. Idle is the one state where
      // nobody is waiting on a line, and it was producing most of the volume.
      isActive: () => String(localServer.callStatus || 'idle') !== 'idle',
      meta: () => ({
        version: app.getVersion(),
        platform: process.platform,
        profile: appProfile || 'default',
        host: hostShort,
        port: localServer.port,
        room: localServer.roomId || null,
        // #255: which CALL these lines belong to, so a slice shared from the
        // feedback row can be found later. room alone is ambiguous — the same
        // room can be joined twice.
        callId: localServer.callId || null,
        callStatus: localServer.callStatus || null,
      }),
    });
    console.log('[electron] Remote logging', remoteLoggingOn ? 'ENABLED' : 'available (off)', '— instance:', instanceId);
  } catch (err) {
    console.warn('[electron] Failed to configure remote logging:', err.message);
  }

  // Check/install the machine-global agent integration. This content is app-level,
  // not profile-level — it always points bare-terminal agents at the fallback port
  // (DEFAULT_PORT). We run it from the single default instance purely as a
  // single-writer election so N running profiles don't race on the same global
  // files; named instances skip it (and self-pin their own --mcp-config instead).
  if (!isDefaultInstance) {
    console.log('[electron] Skipping global agent integration for named profile:', appProfile);
  } else if (prefValue('agentBackend') === 'codex') {
    if (store.get('codexIntegrationRemoved') === true) {
      console.log('[electron] Codex integration NOT installed (user uninstalled it - leave-no-trace flag set)');
    } else {
      ensureCodexIntegration();
    }
  } else if (prefValue('agentBackend') === 'claude' && store.get('claudeIntegrationRemoved') === true) {
    // "Leave no trace": the user explicitly uninstalled the Claude integration
    // (menu → Uninstall Claude Integration). Without this gate the next launch
    // would silently re-write ~/.claude.json / the skill / the hook, undoing
    // the uninstall. Re-enable via menu → Install Claude Integration.
    console.log('[electron] Claude integration NOT installed (user uninstalled it — leave-no-trace flag set)');
  } else if (prefValue('agentBackend') === 'claude') {
    ensureClaudeIntegration();
  }

  // Keep the app up to date on its own. Gated inside: dev builds, .deb installs
  // and named profiles all opt out, and nothing installs during a call.
  startUpdateChecks();

  // #137: answer "is Claude Code signed in?" now, while nobody is waiting, so
  // the join path can read it instantly instead of paying for a login shell.
  //
  // Startup CHECKS but does not warn: a dialog at launch is a nag about a
  // problem the user does not have yet — they may have opened the app to change
  // a setting. The warning belongs where it is actionable, on the join. The
  // panel indicator carries the state in the meantime.
  // Self-scheduling rather than setInterval, so the cadence can follow the state:
  // brisk while signed out (transient, about to change), slow otherwise.
  let claudeAuthTimer = null;
  const scheduleClaudeAuthPoll = () => {
    const delay = claudeAuthState.authed === false ? CLAUDE_AUTH_POLL_UNAUTHED_MS : CLAUDE_AUTH_POLL_MS;
    claudeAuthTimer = setTimeout(() => {
      refreshClaudeAuth().catch(() => {}).finally(scheduleClaudeAuthPoll);
    }, delay);
    if (claudeAuthTimer.unref) claudeAuthTimer.unref();
  };
  refreshClaudeAuth().catch(() => {}).finally(scheduleClaudeAuthPoll);

  // First-run setup wizard: shown once for the default instance (guarded by the
  // per-profile onboardingComplete flag); re-runnable from the app menu. The
  // isDefaultInstance gate is what actually keeps --profile instances from
  // auto-showing it — the flag is not in APP_LEVEL_KEYS, so each profile has
  // its own copy and would otherwise re-run the wizard on first launch.
  // Anything below that triggers a macOS TCC prompt is deferred while the wizard
  // is up. First launch used to fire the microphone ask, a screen-capture probe
  // and browser-automation AppleScript within the same tick — three or four
  // system dialogs stacked on the wizard before the user had read a word about
  // what any of them were for. The wizard has a Permissions step that names each
  // one and its reason; that step should be where they're asked. See
  // startPermissionPrompts(), called from onboarding:finish.
  const onboardingPending = isDefaultInstance && !store.get('onboardingComplete');
  if (onboardingPending) {
    createOnboardingWindow();
  }

  // No microphone ask. The comment here used to claim it was "needed for the audio
  // pipeline even with virtual mic"; it wasn't. The bot's mic is an AudioContext
  // (VirtualMic in page-inject.js) and getUserMedia is intercepted before it ever
  // reaches Chromium, so no capture device is opened. Verified on a signed build
  // with Microphone DENIED: the bot joined a Meet and was heard speaking.
  // Deferring this prompt to the wizard was the first fix; deleting it is the
  // right one, and the wizard no longer offers the row either.

  // Screen Recording permission is no longer needed: the whiteboard share
  // captures via Electron's own frame capture (webContents.mainFrame), never
  // desktopCapturer, so there is nothing to probe or prompt for here.

  // Load saved config
  const savedConfig = store.getMultiple(['ttsApiKey', 'ttsVoiceId', 'botName', 'syncBaseUrl', 'macosVoice', 'ttsProvider', 'voiceboxUrl', 'voiceboxProfileId', 'voiceboxEngine', ...VOICE_SETTING_KEYS]);
  if (savedConfig.ttsApiKey) {
    tts.updateConfig({ apiKey: savedConfig.ttsApiKey });
    stt.updateConfig({ apiKey: savedConfig.ttsApiKey });
  }
  if (savedConfig.ttsVoiceId) tts.updateConfig({ voiceId: savedConfig.ttsVoiceId });
  if (savedConfig.macosVoice) tts.updateConfig({ macosVoice: savedConfig.macosVoice });
  if (savedConfig.voiceboxUrl) tts.updateConfig({ voiceboxUrl: savedConfig.voiceboxUrl });
  if (savedConfig.voiceboxProfileId) tts.updateConfig({ voiceboxProfileId: savedConfig.voiceboxProfileId });
  if (savedConfig.voiceboxEngine) tts.updateConfig({ voiceboxEngine: savedConfig.voiceboxEngine });
  // `!== undefined`, not truthiness: 0 for stability/style and false for speaker
  // boost are all legal saved values that `if (x)` would silently skip.
  for (const k of VOICE_SETTING_KEYS) {
    if (savedConfig[k] !== undefined) tts.updateConfig({ [k]: savedConfig[k] });
  }
  // Explicit provider override (e.g. bot chose a built-in voice as primary).
  if (savedConfig.ttsProvider) tts.updateConfig({ provider: savedConfig.ttsProvider });
  // Prime the built-in voice-name set so speak()'s voice-override can route a
  // name to the right provider from the first utterance (refreshed on each list
  // call). On Windows we also seed the stored voice with a real SAPI name the
  // first time: tts.js defaults to '' (= SAPI's own default) so nothing is ever
  // guessed, but leaving it blank would show the picker a selection it can't
  // match. macOS keeps its long-standing 'Daniel' default.
  enumerateSystemVoices().then((vs) => {
    systemVoiceNameSet = new Set(vs.map((v) => v.name));
    if (process.platform === 'win32' && !savedConfig.macosVoice && vs.length) {
      store.set('macosVoice', vs[0].name);
      tts.updateConfig({ macosVoice: vs[0].name });
    }
  }).catch(() => {});
  // Same idea for Voicebox profile names — lets speak()'s voice override route
  // a profile name to the voicebox provider (best-effort: silently empty if
  // Voicebox isn't running).
  listVoiceboxProfiles().then((ps) => { voiceboxProfileNameSet = new Set(ps.map((p) => p.name)); voiceboxProfilesById = new Map(ps.map((p) => [p.id, p])); }).catch(() => {});
  // …and for ElevenLabs voice NAMES. Without this, speak(voice: 'George') sent
  // "George" to the API as a voice_id and 404'd — the bot simply went silent,
  // which is how this surfaced (three dead utterances in a guided setup call:
  // Chris, River, George).
  //
  // Names are what an agent has to work with: list_voices returns both, but a
  // conversation is about "the British one", not nPczCjzI2devNBz1zQrb. The
  // other two providers already accept names; ElevenLabs was the odd one out.
  warmElevenLabsVoiceNames();

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

  // (A startup sweep retired a room persisted from a previous run. Removed: it
  // only ever unblocked a button that no longer gets blocked, and it could hang
  // up a call you were still in — crash the app mid-call, relaunch, and it would
  // retire the room out from under you.)
  try { store.delete('liveMeetSpace'); } catch { /* nothing to clean up */ }

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
      // #273: an already-logged-in launch is exactly when a grant made since
      // the last run needs to surface — nothing else re-checks it.
      checkTtsGrant();
    } else {
      console.log('[electron] Not logged in — user can click Log in button');
    }
  });

  // Liveness heartbeat. Started unconditionally: sendHeartbeat no-ops while
  // logged out, so an app that gets logged in later starts reporting on its
  // next tick without needing to be told.
  startHeartbeat();

  // A sleeping machine fires no timers, so a laptop closed overnight would
  // look offline for up to 15 minutes after waking. Ping immediately on resume
  // so the dashboard reflects reality as soon as the app can talk again.
  require('electron').powerMonitor.on('resume', () => { sendHeartbeat(); });

  // --- Meet/Slack detection: poll Chrome/Safari/Brave tabs for active Meet
  // calls and Slack huddles ---
  let detectedMeetUrl = null;
  let detectedSlackHuddle = null;
  let meetDetectionInterval = null;
  let currentMeetUrl = null; // Track what we've joined
  let automationPromptShown = false; // only nag about Automation permission once
  // Last Meet-poll failure message, so an identical one isn't logged every tick.
  // null = nothing failing right now; a success clears it, so a recurrence is
  // reported again rather than swallowed forever.
  let lastMeetPollFailure = null;

  function startMeetDetection() {
    if (meetDetectionInterval) return;
    // This whole feature is AppleScript — `osascript` scanning Chrome/Safari/
    // Brave tabs. Off macOS there is no osascript, so every tick failed with
    // ENOENT and logged a line, forever: 12 lines a minute, 17k a day, on a
    // box where the poll CANNOT succeed by construction. On the always-on
    // Linux TA box that buried the calendar-poll lines (the ones you actually
    // need when a scheduled join misbehaves) at roughly 12:1.
    //
    // Don't start it at all rather than start it and swallow the errors: a
    // subsystem that cannot work should be off, not quietly failing. Say so
    // once, so "why is auto-detect missing on Linux" has an answer in the log.
    if (process.platform !== 'darwin') {
      console.log(`[electron] Meet/Slack auto-detection is macOS-only (needs AppleScript); not polling on ${process.platform}. Paste a Meet link or use /join-call.`);
      return;
    }
    // Polling sends the same Apple Events the wizard's Grant button does, so
    // once this runs the Automation decision has been put to the user either
    // way, and the wizard can read the real status instead of assuming unknown.
    if (process.platform === 'darwin') { try { store.set('automationProbed', true); } catch { /* ignore */ } }
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
          // Log a given failure ONCE, not every 5 seconds. These conditions are
          // persistent by nature — a denied Automation permission, a missing
          // binary, a browser that hangs the scan — so repeating the same line
          // at 12/min adds no information after the first and drowns the log it
          // shares. Keyed by message so a DIFFERENT failure still gets through,
          // and re-armed on the next success below, so a recurrence after a
          // recovery is still reported.
          const failKey = stderrMsg || (err.killed ? 'timeout' : err.message?.slice(0, 80)) || 'unknown';
          if (failKey !== lastMeetPollFailure) {
            lastMeetPollFailure = failKey;
            console.log(`[electron] Meet poll failed (${elapsed}s):`, failKey, '— further identical failures suppressed');
          }
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
        // #230: a successful poll that found nothing is not information, and at
        // one line every 5s it was the single biggest source of log volume — on
        // an IDLE app, since this poll stops once the bot is in a call. Remote
        // shipping flushes whenever the queue is non-empty, so that one line
        // kept an idle instance POSTing every 3s indefinitely.
        //
        // Log a SLOW poll (the AppleScript can hang on permissions or a busy
        // browser, and that is worth seeing), and let the detection changes
        // below speak for the rest. The failure paths above already log.
        if (elapsed >= 2) console.log(`[electron] Meet poll slow (${elapsed}s)`);
        // Recovered — re-arm the failure log so the NEXT failure is reported
        // rather than suppressed as a duplicate of one that has since cleared.
        if (lastMeetPollFailure !== null) {
          console.log('[electron] Meet poll recovered');
          lastMeetPollFailure = null;
        }

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
          broadcastToRenderers('slack-huddle-detected', { url: slackHuddleUrl });
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
          broadcastToRenderers('slack-huddle-detected', null);
        }

        if (meetUrl && meetUrl !== detectedMeetUrl) {
          detectedMeetUrl = meetUrl;
          const meetCode = meetUrl.match(/meet\.google\.com\/([a-z]+-[a-z]+-[a-z]+)/)?.[1] || '';
          console.log('[electron] Meet detected:', meetCode);
          broadcastToRenderers('meet-detected', { url: meetUrl, meetCode });
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
          broadcastToRenderers('meet-detected', null);
        }
      });
    }

    // Poll immediately, then every 5 seconds
    pollForMeet();
    meetDetectionInterval = setInterval(pollForMeet, 5000);
  }

  // Not while the wizard is up: the first poll fires immediately and sends Apple
  // Events to System Events, Chrome, Brave and Safari, which is a TCC prompt per
  // browser — the bulk of the first-run pile-up. onboarding:finish starts it.
  if (!onboardingPending) startMeetDetection();
  else deferredStarts.push(startMeetDetection);

  // --- Calendar auto-join (#299): poll vibeconferencing.com for this user's
  // upcoming Google Calendar events and auto-join any where this bot profile
  // has been "invited" — a placeholder guest email (calendarIdentityEmail
  // pref) or a `#vibeconf:<botName>` tag in the event title or description.
  // See calendar-auto-join.js for the pure matching/selection/eviction logic
  // this glues together with IO.
  let calendarPollInterval = null;
  let calendarPollInFlight = false;
  // Tracks the last-seen poll outcome so state-change transitions (e.g.
  // connected → not-connected) log once instead of every ~60s tick — same
  // idle-log-suppression spirit as startMeetDetection's "poll found nothing"
  // silence.
  let lastCalendarPollState = null;

  // eventDedupeKey -> Timeout handle for a join scheduled to fire at the event's
  // actual start time (see scheduleCalendarJoin below). Deliberately IN
  // MEMORY ONLY, not persisted: on an app restart, any event that hasn't
  // actually joined yet (only actually-joined events go into the persisted
  // joinedCalendarEventIds store, at the moment the timer fires — not here,
  // at scheduling time) should be re-detected and re-scheduled from
  // scratch, not silently skipped because a schedule "happened" in a
  // process that no longer exists.
  const scheduledCalendarJoins = new Map();

  // Recomputes the module-scope latestUpcomingCalendarEvents (declared near
  // the other cross-closure state, ~line 2723 — setupIPC's
  // get-upcoming-calendar-events handler reads it from there, and is a
  // separate top-level function that can't see this closure's locals) every
  // poll tick, and pushes proactively to the panel so its "upcoming
  // meeting" notice updates without a refresh.
  function pushUpcomingCalendarEvents(events) {
    latestUpcomingCalendarEvents = events;
    // A successful poll produced these events, so any prior poll error is over.
    latestCalendarPollError = null;
    if (panelView && !panelView.webContents.isDestroyed()) {
      panelView.webContents.send('calendar-upcoming', { events, error: null });
    }
  }

  // Companion to pushUpcomingCalendarEvents for the poll's failure side:
  // records the error (or clears it with null) and pushes the combined state
  // so the panel can warn that calendar auto-join has silently stopped
  // working. Only the google-api-error state ever sets this — signed-out,
  // not-connected and offline are expected/transient and stay banner-silent.
  function pushCalendarPollError(error) {
    latestCalendarPollError = error;
    if (panelView && !panelView.webContents.isDestroyed()) {
      panelView.webContents.send('calendar-upcoming', { events: latestUpcomingCalendarEvents, error });
    }
  }

  // Fires at (or a hair past) the event's real start time — see
  // scheduleCalendarJoin. This is the ONLY place joinedCalendarEventIds gets
  // written, and it writes right before actually attempting the join, not
  // at scheduling time — a failed join shouldn't retry-loop every poll cycle
  // for the same event, but a join that was merely SCHEDULED and never fired
  // (e.g. the app quit first) should be reconsidered on the next run, not
  // treated as handled.
  function performScheduledCalendarJoin(event, meetUrl) {
    scheduledCalendarJoins.delete(eventDedupeKey(event));
    const joinedIds = evictStaleEventIds(store.get('joinedCalendarEventIds') || {}, Date.now());
    store.set('joinedCalendarEventIds', { ...joinedIds, [eventDedupeKey(event)]: Date.now() });
    console.log(`[calendar] Auto-joining calendar event "${event.summary || event.id}"`);
    activateMeetProvider(); // no-op if already on a live Meet view
    joinMeetUrl(meetUrl, { spawnAgent: true, calendarEvent: event });
  }

  // Schedules (rather than immediately performing) the join for a just-
  // matched event, timed to fire at its actual start — not up to 5 minutes
  // early just because that's when it first entered the lookahead window.
  // Idempotent: a later poll tick re-seeing the same still-pending event is
  // a no-op (scheduledCalendarJoins already has it), so this is safe to call
  // every time selectEventToJoin picks the same event across polls.
  function scheduleCalendarJoin(event, meetUrl) {
    const key = eventDedupeKey(event);
    if (scheduledCalendarJoins.has(key)) return;
    const delayMs = Math.max(0, msUntilStart(event, Date.now()) || 0);
    console.log(`[calendar] Scheduling auto-join for "${event.summary || event.id}" in ${Math.round(delayMs / 1000)}s`);
    const timer = setTimeout(() => performScheduledCalendarJoin(event, meetUrl), delayMs);
    scheduledCalendarJoins.set(key, timer);
  }

  // Near-term fix for "the bot that should join isn't even running": ANY
  // currently-running profile sees the SAME upcoming-events list (all
  // profiles on this machine share one vibeconferencing.com login, so the
  // event data isn't per-bot) — so on every poll tick, this profile also
  // checks events against every OTHER locally-configured profile's identity/
  // tag, not just its own, and launches (or focuses, if already running —
  // launchOrFocusProfile handles both) whichever one actually matches.
  //
  // Deliberately does NOT hand off the specific event/timer across the
  // process boundary — the newly-launched (or focused) profile's own
  // startCalendarPolling() re-fetches, re-matches, and re-schedules on its
  // own very first poll, a few seconds later, well inside the 5-minute
  // window. Reuses that profile's entire already-built pipeline instead of
  // inventing a cross-process handoff protocol.
  //
  // Real gap this does NOT close (see the tracked "parent process" issue):
  // if literally no profile is running at all, nothing is executing to
  // notice anything, for any profile, including this cross-check. This is
  // only a fix for "at least one bot happens to be open".
  function checkOtherProfilesForCalendarMatch(events) {
    if (!events.length) return;
    let otherNames;
    try {
      otherNames = profileManager.listProfileNames(PROFILES_ROOT).filter((n) => n !== appProfile);
    } catch { return; }
    if (!otherNames.length) return;

    const now = Date.now();
    // Separate dedupe namespace from joinedCalendarEventIds (that one means
    // "I actually joined this"; this one means "I already launched/focused
    // another profile for this event") — keyed by
    // `<eventDedupeKey>:profileName` so two different other-profiles matching
    // the same event don't collide, and (same reason as joinedCalendarEventIds
    // — see eventDedupeKey) so yesterday's occurrence of a recurring meeting
    // can't suppress today's launch.
    const launched = evictStaleEventIds(store.get('launchedForOtherProfileEventIds') || {}, now);
    let launchedChanged = false;

    for (const name of otherNames) {
      let fields;
      try { fields = profileManager.readConfigFields(path.join(PROFILES_ROOT, name)); } catch { continue; }
      if (!fields.calendarIdentityEmail && !fields.botName) continue; // nothing to match against
      for (const e of events) {
        if (!e || !e.id || !isEventUpcoming(e, now)) continue;
        if (!matchesCalendarEvent(e, { calendarIdentityEmail: fields.calendarIdentityEmail, botName: fields.botName })) continue;
        // Same owner-RSVP gate the local join path applies (selectEventToJoin):
        // don't launch a whole other profile for a meeting the calendar owner
        // hasn't confirmed they're attending — if they accept later, a
        // subsequent tick launches it then.
        if (!ownerHasConfirmed(e)) continue;
        const dedupeKey = `${eventDedupeKey(e)}:${name}`;
        if (Object.prototype.hasOwnProperty.call(launched, dedupeKey)) continue;
        launched[dedupeKey] = now;
        launchedChanged = true;
        console.log(`[calendar] Event "${e.summary || e.id}" matches profile "${name}" (not this one) — launching/focusing it.`);
        if (launchOrFocusProfileRef) {
          launchOrFocusProfileRef(name).catch((err) => {
            console.warn(`[calendar] Failed to launch/focus profile "${name}" for calendar match:`, err.message);
          });
        }
      }
    }
    if (launchedChanged) store.set('launchedForOtherProfileEventIds', launched);
  }

  // Schedule, at most, one matching event's join per tick — a persisted
  // dedupe entry only exists once a join has actually fired (see
  // performScheduledCalendarJoin); scheduledCalendarJoins covers the "already
  // has a pending timer" case in between.
  function handleCalendarEvents(events) {
    checkOtherProfilesForCalendarMatch(events);

    const calendarIdentityEmail = store.get('calendarIdentityEmail') || '';
    const botName = resolvedBotName();
    const joinedIds = evictStaleEventIds(store.get('joinedCalendarEventIds') || {}, Date.now());
    // Persist the evicted map even if nothing matches this tick, so the
    // store doesn't grow unbounded while the app sits idle.
    store.set('joinedCalendarEventIds', joinedIds);
    // Selection must also skip events already scheduled (but not yet
    // actually joined) — merge that in-memory set with the persisted one
    // purely for this lookup; the two stay otherwise independent.
    // Both maps are keyed by eventDedupeKey (id + occurrence start), never the
    // bare event id — see eventDedupeKey for why a recurring series' id alone
    // would make "joined once" mean "never join again".
    const excludeIds = { ...joinedIds };
    for (const key of scheduledCalendarJoins.keys()) excludeIds[key] = true;

    // Visibility for testing/debugging: only when the poll actually returned
    // something, so this stays silent during normal idle stretches (the
    // common case) but shows exactly why an event a user is watching for
    // didn't fire — too far outside the lookahead window, doesn't match the
    // identity/tag, or already handled — rather than a poll that "saw" the
    // event but said nothing at all.
    if (events.length > 0) {
      const now = Date.now();
      const summaries = events.map((e) => {
        const delta = e ? msUntilStart(e, now) : null;
        const minutesUntil = delta === null ? null : Math.round(delta / 60000);
        const matched = matchesCalendarEvent(e, { calendarIdentityEmail, botName });
        const upcoming = isEventUpcoming(e, now);
        const already = !!(e && e.id && Object.prototype.hasOwnProperty.call(excludeIds, eventDedupeKey(e)));
        const confirmed = ownerHasConfirmed(e);
        const reason = already ? 'already handled/scheduled' : !upcoming ? 'outside 5m window' : !matched ? 'no identity/tag match' : !confirmed ? `owner has not accepted (selfResponseStatus=${e && e.selfResponseStatus})` : 'MATCH';
        return `"${(e && e.summary) || (e && e.id) || '(untitled)'}" (raw start="${e && e.start}", starts ${minutesUntil == null ? '?' : minutesUntil + 'm'} from now, ${reason})`;
      });
      console.log(`[calendar] Poll saw ${events.length} event(s): ${summaries.join('; ')}`);
    }

    // Display-only: everything matching within the next 24h, independent of
    // the 5-minute join-scheduling gate below — this is what the panel's
    // "upcoming meeting" notice shows, and it deliberately includes events
    // the 5-minute logic hasn't (and won't yet) act on — including ones the
    // calendar owner hasn't RSVP'd to, annotated so the panel can show its
    // "waiting to see if you're attending" disclaimer instead of implying a
    // join is coming.
    pushUpcomingCalendarEvents(selectUpcomingMatches(events, { calendarIdentityEmail, botName, now: Date.now() })
      .map((e) => ({ ...e, ownerConfirmed: ownerHasConfirmed(e) })));

    // THIS is where being in a call matters, and the only place (#550). The
    // poll itself now runs regardless, so everything above — the sibling-profile
    // launcher, the "poll saw" log, and the panel's upcoming-meeting notice —
    // stays current while the bot is busy. What must not happen is yanking it
    // out of a live call into a different one.
    //
    // Deliberately AFTER pushUpcomingCalendarEvents: the panel (and, next, the
    // agent) should be able to say "there's another meeting at three" precisely
    // while the bot is in the 2 o'clock. Returning any earlier would restore
    // the blind spot this issue is about.
    //
    // Not marked as handled, so it is reconsidered on the next tick — once the
    // call ends, the ordinary path picks it up if it is still in the window.
    if (localServer.callStatus === 'in-call') return;

    const { event, extraMatchCount } = selectEventToJoin(events, {
      calendarIdentityEmail,
      botName,
      joinedIds: excludeIds,
      now: Date.now(),
    });
    if (!event) return;

    if (extraMatchCount > 0) {
      console.warn(`[calendar] ${extraMatchCount} additional matching event(s) this tick — `
        + 'only scheduling one, the rest will be reconsidered next poll.');
    }

    const meetUrl = resolveCalendarMeetUrl(event.hangoutLink);
    if (!meetUrl) {
      console.warn(`[calendar] Matched event "${event.summary || event.id}" but its hangoutLink `
        + `("${event.hangoutLink}") isn't a recognizable Meet URL — skipping, still marking as handled.`);
      store.set('joinedCalendarEventIds', { ...joinedIds, [eventDedupeKey(event)]: Date.now() });
      return;
    }

    scheduleCalendarJoin(event, meetUrl);
  }

  function startCalendarPolling() {
    if (calendarPollInterval) return;

    async function pollCalendar() {
      if (calendarPollInFlight) return;
      // NOT gated on being in a call any more (#550). This used to
      // `return` outright whenever callStatus was 'in-call', borrowed from
      // startMeetDetection's guard — "no reason to poll or auto-join while
      // already in a call". The auto-JOIN half of that is right and still
      // applies (see handleCalendarEvents); the "don't even look" half was too
      // broad, and cost three things:
      //
      //   1. Back-to-backs never fire. A bot in a 2:00 call cannot join the
      //      3:00, because it never sees it. That is exactly the shape of the
      //      per-student studio sessions — one bot, consecutive 1:1s.
      //   2. Sibling profiles are stranded: checkOtherProfilesForCalendarMatch
      //      lives inside handleCalendarEvents, so an app sitting in a call
      //      also could not launch OTHER bots for THEIR meetings.
      //   3. Nobody could be told a meeting was coming — not the panel, not
      //      the agent, so a bot could never excuse itself before dropping.
      //
      // Found 2026-08-26: a laptop in a call was 25 minutes stale on a meeting
      // whose time had changed. Its last [calendar] line was 10:57:03; the call
      // it was in started at 10:57:32. A cloud box looked healthy purely
      // because it happened to be idle.
      calendarPollInFlight = true;
      try {
        const r = await websiteRequest('/api/calendar/upcoming');

        if (r.status === 200 && r.json && r.json.ok) {
          if (lastCalendarPollState !== 'ok') {
            console.log('[calendar] Connected — polling for auto-join events');
            lastCalendarPollState = 'ok';
          }
          handleCalendarEvents(r.json.events || []);
          return;
        }

        // Every path below is expected/transient (not signed in, Calendar not
        // connected yet, offline, upstream hiccup) — skip this poll quietly,
        // and log only on a STATE CHANGE so an idle app isn't shipping a log
        // line every ~60s tick.
        let state = 'unknown';
        let message = `unexpected response (status ${r.status})`;
        if (r.status === 401) {
          state = 'signed-out';
          message = 'not signed in';
        } else if (r.json && r.json.code === 'calendar-not-connected') {
          state = 'not-connected';
          message = 'signed in, but Calendar access not yet connected';
        } else if (r.json && r.json.code === 'google-api-error') {
          state = 'google-api-error';
          message = `Google API error: ${r.json.detail || 'unknown'}`;
        } else if (r.status === 0) {
          state = 'offline';
          message = `offline/network error: ${r.error || 'unknown'}`;
        }
        if (state !== lastCalendarPollState) {
          console.log(`[calendar] Poll skipped (${message})`);
          lastCalendarPollState = state;
          // google-api-error means the user HAD calendar working and the
          // backend can no longer reach Google for them (dead refresh token,
          // revoked access, ...) — the one failure worth a panel warning,
          // because nothing else in the UI distinguishes it from "no
          // meetings today" (vibeconferencing#512: a 7-day token expiry
          // silently killed auto-join for everyone). The other states clear
          // the warning: they describe a different situation (signed out,
          // never connected, offline), and their guidance would be wrong.
          if (state === 'google-api-error') {
            pushCalendarPollError({ code: state, message });
          } else if (latestCalendarPollError) {
            pushCalendarPollError(null);
          }
        }
      } catch (err) {
        if (lastCalendarPollState !== 'error') {
          console.error('[calendar] Poll failed:', err && err.message);
          lastCalendarPollState = 'error';
        }
      } finally {
        calendarPollInFlight = false;
      }
    }

    console.log('[electron] Calendar auto-join polling started');
    pollCalendar();
    calendarPollInterval = setInterval(pollCalendar, 60000);
  }

  // Same onboarding-deferral reasoning as startMeetDetection: don't let a
  // background poll (and a possible surprise auto-join) interrupt the wizard.
  if (!onboardingPending) startCalendarPolling();
  else deferredStarts.push(startCalendarPolling);

  // IPC: join detected meet and launch Claude
  // #422: raw speaking-detection events from the renderer, appended to the
  // call's own folder as JSONL. Batched by the sender (1s), appended
  // synchronously here — the rows are small and the write is the only place
  // this data can be lost.
  //
  // Lands beside call-recording-tracks/ deliberately: scoring needs the DOM
  // event stream and the per-participant audio on ONE timeline, and sharing a
  // directory is what makes that alignment obvious rather than reconstructed.
  ipcMain.on('speaking-events', (_event, rows) => {
    if (!Array.isArray(rows) || !rows.length) return;
    try {
      const agentDir = require('./agent-workdir.js').agentDirFor(app.getPath('userData'));
      const callId = (localServer && localServer.callId) || 'no-call';
      const safeCallId = String(callId).replace(/[^a-zA-Z0-9._-]/g, '_');
      const dir = path.join(agentDir, 'calls', safeCallId);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'speaking-events.jsonl'),
        rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    } catch (err) {
      // Never let diagnostics break a call. One warning, then stay quiet.
      if (!global.__warnedSpeakingCapture) {
        global.__warnedSpeakingCapture = true;
        console.warn('[speaking-capture] could not write events:', err.message);
      }
    }
  });

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

// Closing the main window quits the app, and the red ✕ sits a few pixels from
// controls people use constantly. Mid-call that costs the bot the call and kills
// its agent — an expensive outcome for a slightly-off click, and one with no undo.
//
// Set once the user has confirmed (or asked not to be asked), so the second
// close() below doesn't re-prompt itself forever.
let quitConfirmed = false;

// True once something OTHER than a click on ✕ has decided the app is going away:
// Cmd-Q, a SIGTERM, macOS logout or shutdown, or the updater installing on quit.
//
// This flag is what stops the confirmation from being a hostage. app.quit()
// closes every window, which fires the same 'close' this handler cancels — so
// without it the app could not be terminated by a signal at all, and it would
// sit holding a modal dialog through a system shutdown or block the updater's
// install-on-quit. Found because SIGTERM stopped working: the old instance
// survived, the new one hit the single-instance lock and quit, and the port
// check still said "running" because the OLD app answered it.
//
// Confirming is for the ambiguous case — a stray click on a button that sits
// beside controls you use constantly. Every path below is unambiguous, and a
// dialog on shutdown is a bug, not a safety net.
// Set in the existing before-quit handler below rather than by registering a
// second one — two registrations for the same event are two things to find.
let appIsQuitting = false;

function confirmQuitBeforeClose(e) {
  if (quitConfirmed || appIsQuitting) return;
  if (store.get('confirmQuit') === false) return;
  e.preventDefault();

  // The stakes differ enormously, so the wording should too. Out of a call this
  // is a mild "are you sure"; in one it is destructive and the dialog says what
  // is actually lost.
  const inCall = localServer.callStatus === 'in-call';
  const name = botWindowName() || 'The bot';
  dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Quit', 'Cancel'],
    // Cancel is the default: a stray Return on an unexpected dialog should be
    // the harmless answer, not the irreversible one.
    defaultId: 1,
    cancelId: 1,
    message: inCall ? `${name} is in a call. Quit anyway?` : 'Quit Vibeconferencing?',
    detail: inCall
      ? 'The bot will leave the call and its agent will be stopped.'
      : 'Closing this window quits the app.',
    checkboxLabel: "Don't ask again",
  }).then(({ response, checkboxChecked }) => {
    if (response !== 0) return; // Cancel — including the checkbox, which only
    // takes effect alongside an actual quit. Ticking "don't ask again" and then
    // cancelling means "stop nagging me", not "quit now".
    if (checkboxChecked) store.set('confirmQuit', false);
    quitConfirmed = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  }).catch(() => { quitConfirmed = true; if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close(); });
}

app.on('window-all-closed', () => {
  closeClaudeTerminal();
  localServer.stop();
  app.quit();
});

// Close any terminal windows we opened, synchronously, before the process
// exits — covers Cmd-Q and other quit paths the async close would miss.
app.on('before-quit', () => {
  // Every quit that is NOT a click on ✕ passes through here first, so this is
  // where the confirmation learns to stand down (see confirmQuitBeforeClose).
  appIsQuitting = true;
  // Nothing below is guaranteed to finish — a wedged ffmpeg wait, a terminal
  // that won't close, some future addition to this handler — and if any of it
  // hangs, quit intent was already committed with no way back to the UI (see
  // confirmQuitBeforeClose above). Once the user has asked to quit, quitting
  // has to actually happen; unref'd so it can't itself hold the process open.
  setTimeout(() => {
    console.warn('[electron] quit did not complete within 10s — forcing exit');
    app.exit(0);
  }, 10_000).unref();
  stopAllRunwayFaces('before-quit'); // P2: best-effort end of Runway sessions on quit (fire-and-forget)
  // #343: sync, and deliberately NOT the full stopCallRecording() — see
  // finalizeRecordingSync. Quitting must not wait on an ffmpeg merge, but it
  // costs nothing to leave the tracks closed and the manifest written, which is
  // the difference between a recoverable recording and an unrecoverable one.
  finalizeRecordingSync('quit');
  // #388: a detached post-recording merge may still be running here (it no
  // longer holds up stop_recording, so quits can now land mid-merge). ffmpeg
  // dies with the app; the raw tracks and RECOVERY.md are already safe on
  // disk (they're only removed after a merge SUCCEEDS), so just say so.
  if (mergesInFlight > 0) {
    console.log(`[call-record] quit: ${mergesInFlight} background merge(s) still running — the combined mp4(s) won't finish, but the raw tracks are safe (see RECOVERY.md in each call-recording-tracks/ folder)`);
  }
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

  // #346: log every URL this view actually ends up on. We used to log which
  // account we pinned but never where we landed, so when a join was silently
  // bounced to a Google password challenge the session log had no way to show
  // it — the redirect was invisible and the resulting page was mislabelled as
  // "Meet home". Redirects are logged separately from the final landing
  // because the interesting hop (meeting → accounts.google.com) is exactly the
  // one that is gone by the time anything else looks.
  view.webContents.on('did-redirect-navigation', (_e, url, _isInPlace, isMainFrame) => {
    if (isMainFrame) console.log('[electron] Meet view redirected →', url);
  });
  view.webContents.on('did-navigate', (_e, url) => {
    console.log('[electron] Meet view navigated →', url);
  });

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
// Re-assert the Meet zoom for the current state. setZoomFactor is per-webContents
// and survives Meet's SPA routing, but a REAL document reload resets it — so this
// is also called from createMeetView's dom-ready hook, not just on state change.
function applyMeetZoom() {
  if (!meetView || meetView.webContents.isDestroyed()) return;
  const l = botViewLayout.computeLayout(botViewState, { width: WINDOW_WIDTH, height: 0 }, { windowWidth: WINDOW_WIDTH });
  try { meetView.webContents.setZoomFactor(l.meetZoom); } catch { /* view gone */ }
}

// Open a URL in the user's external default browser — so the operator can join
// a meet as a human, separate from the bot's Electron Meet view. https only.
function openExternalUrl(url) {
  if (typeof url === 'string' && /^https:\/\//i.test(url)) shell.openExternal(url);
}

// The bot's view only occupies the window during a call. `joining` and
// `waiting-to-be-admitted` count as "in a call" so the green room and the
// admission prompt are on screen — hiding those would leave the user staring at
// a panel while the bot silently waited for entry.
let botViewInCall = false;
function callStatusMeansInCall(status) {
  return isInCall(status);
}
function setBotViewInCall(status) {
  const active = callStatusMeansInCall(status);
  if (active === botViewInCall) return;
  botViewInCall = active;
  applyWindowHeight(); // grow to make room for the region, or shrink back
  layoutViews();
  broadcastBotViewVisible();
}

// --- Window height: fit the panel, plus the bot's view only during a call ----
// The window used to be a fixed 820px tall regardless of content, which left a
// large empty rectangle under the panel out of a call. Now the panel measures
// itself (renderer → 'panel-content-height') and we add the 16:9 region on top
// only while there IS a call to show in it.
const MIN_WINDOW_HEIGHT = 260;
const WINDOW_HEIGHT_MARGIN = 40; // leave a little breathing room under the dock
let panelContentHeight = 0;

// The window is created hidden and revealed here, once the panel has measured
// itself and we've sized to fit. Otherwise every launch showed the provisional
// 820px column for a beat and then visibly snapped to its real height.
//
// A fallback timer arms alongside it: if the panel never reports (a renderer
// that failed to load, a measurement that throws), a window that stays hidden
// forever is far worse than one that flashes. The timer shows it regardless,
// at whatever size it happens to be.
let mainWindowShown = false;
let _showMainWindowFallback = null;
function showMainWindowOnce() {
  if (mainWindowShown) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindowShown = true;
  clearTimeout(_showMainWindowFallback);
  // On first run the setup wizard is created BEFORE this window and wins its
  // z-order race by showing + moveTop + focus. Deferring our show moved us
  // after it, so a plain show() would now cover the wizard it was written to
  // stay in front of. Come up without stealing focus, then put it back on top.
  const wizardUp = onboardingWindow && !onboardingWindow.isDestroyed();
  if (wizardUp) {
    mainWindow.showInactive();
    try { onboardingWindow.moveTop(); onboardingWindow.focus(); } catch { /* gone */ }
  } else {
    mainWindow.show();
  }
}
function armShowMainWindowFallback(ms = 2000) {
  clearTimeout(_showMainWindowFallback);
  _showMainWindowFallback = setTimeout(showMainWindowOnce, ms);
}

function applyWindowHeight() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (panelPopoutWindow) return;      // panel lives elsewhere; its height isn't ours
  if (!panelContentHeight) return;    // nothing measured yet
  const region = botViewInCall ? botViewLayout.regionHeightFor(WINDOW_WIDTH, botViewState) : 0;
  let want = panelContentHeight + region;
  try {
    const { screen } = require('electron');
    const area = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
    want = Math.min(want, Math.max(MIN_WINDOW_HEIGHT, area.height - WINDOW_HEIGHT_MARGIN));
  } catch { /* no screen info — just use the content height */ }
  const height = Math.max(MIN_WINDOW_HEIGHT, Math.round(want));
  const [w, h] = mainWindow.getContentSize();
  if (Math.abs(h - height) > 1) { // otherwise already there; don't churn
    console.log(`[electron] window height → ${height} (panel ${panelContentHeight} + region ${region})`);
    mainWindow.setContentSize(w, height);  // 'resize' → layoutViews
  }
  // Measured AND sized — the window is finally worth looking at. Deliberately
  // outside the resize branch above: if the provisional height happened to match
  // the measurement, there is no resize to do and the window would never show.
  showMainWindowOnce();
}

// The panel's "🤖 Bot's view" bar labels the region, so it lives and dies with
// it. Driven from HERE rather than the panel's own data-call-state, because that
// flag deliberately stays "idle" through joining/waiting-to-be-admitted (the
// pre-call controls stay up) — which would strand the region without its bar.
function broadcastBotViewVisible() {
  broadcastToRenderers('bot-view-visible', { visible: botViewInCall });
}

// The window title names the BOT, not just the app — with several bots open at
// once, "Vibeconferencing" three times over in the window menu and app switcher
// tells you nothing. Falls back to the profile name, then the app name.
// The bot's name for a title, or '' if we can't work one out.
//
// Split out of applyWindowTitle because the SATELLITE windows — 🧠 Brain, the
// bot's view, troubleshooting — are the case the comment above is really about.
// Someone running two bots and comparing their brains had two windows both
// called "Vibeconferencing — Brain", which is precisely the "tells you nothing"
// problem, just one level out from where it was first fixed.
function botWindowName() {
  let name = null;
  try {
    name = botNameForAppUI({
      storedName: store.get('botName'),
      cliName: cliArgs['bot-name'],
      profileName: isDefaultInstance ? null : explicitProfile,
    });
  } catch { /* store/schema not ready */ }
  return String(name || appProfile || '').trim();
}

// "Jimmy — Brain", falling back to "Vibeconferencing — Brain" when unnamed.
// Name FIRST, matching the main window, so the app switcher sorts and truncates
// by bot rather than showing a column of identical prefixes.
function windowTitle(suffix) {
  const n = botWindowName();
  return n ? `${n} — ${suffix}` : `Vibeconferencing — ${suffix}`;
}

// Retitle every open window. Called on rename, so a bot renamed mid-session
// doesn't leave its satellites labelled with the old name.
function applyAllWindowTitles() {
  applyWindowTitle();
  for (const [win, suffix] of [
    [brainWindow, 'Brain'],
    [troubleshootingWindow, 'Troubleshooting'],
    [meetPopoutWindow, "Bot's view"],
    [panelPopoutWindow, "Bot's-eye view"],
  ]) {
    try { if (win && !win.isDestroyed()) win.setTitle(windowTitle(suffix)); } catch { /* gone */ }
  }
}

function applyWindowTitle() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  let name = null;
  try {
    // The window title distinguishes bots, so it wants provenance the plain name
    // hides: a launched or named-profile bot is titled "Alice [launch name]" /
    // "Test Meet Guest 1 [profile]", while a real (stored) bot is just its name
    // and an unconfigured default is "Unnamed bot". This is the ONE place the tag
    // shows — the Meet display name stays plain (get-meet-bot-name).
    name = botNameForAppUI({
      storedName: store.get('botName'),
      cliName: cliArgs['bot-name'],
      profileName: isDefaultInstance ? null : explicitProfile,
    });
  } catch { /* store/schema not ready */ }
  name = String(name || appProfile || '').trim();
  try { mainWindow.setTitle(name ? `${name} — Vibeconferencing` : 'Vibeconferencing'); } catch { /* gone */ }
}

let warnedZoomClamped = false;

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

  const l = botViewLayout.computeLayout(
    botViewState,
    { width, height },
    { windowWidth: WINDOW_WIDTH, inCall: botViewInCall },
  );
  // computeLayout reports `clamped` when the panel got too narrow for the zoom
  // trick to hold Meet's virtual viewport steady — Chromium's page zoom bottoms
  // out at 0.25, so below ~294px Meet gets a genuinely narrower viewport and
  // REFLOWS, which breaks caption scraping and every DOM selector. That failure
  // is silent and mid-call, so say something. Once per process; it can only
  // change if WINDOW_WIDTH does.
  if (l.clamped && !warnedZoomClamped) {
    warnedZoomClamped = true;
    console.warn(`[electron] WINDOW_WIDTH ${WINDOW_WIDTH} is below the ~294px floor: `
      + 'Meet zoom is clamped at its minimum, so Meet will reflow and caption '
      + 'scraping/selectors may break.');
  }
  if (l.panelBounds && panelView && !panelView.webContents.isDestroyed()) {
    panelView.setBounds(l.panelBounds);
  }
  // Out of a call the region doesn't exist, so the docked Meet view must stop
  // painting over the now-full-height panel. PARK IT OFFSCREEN rather than
  // detaching it: removeBrowserView leaves Electron's own 'resize' listener
  // bound to the window (it never reaches _BrowserView_removeResizeListener), so
  // the next resize runs #autoResize with a null ownerWindow and throws
  // "Electron bug: #autoResize called without owner window" — an
  // uncaughtException, which the app then shows the user as a real error.
  //
  // applyWindowHeight() resizes the window on this very same transition, and on
  // macOS that 'resize' arrives asynchronously — i.e. reliably AFTER the detach.
  // Staying attached keeps ownerWindow non-null and sidesteps it entirely.
  // #103: 'hidden' parks meetView in its own never-shown host, so the main
  // window must not try to dock, park or resize it — same exclusion as 'popped'.
  const meetElsewhere = !!meetPopoutWindow || !!meetHiddenWindow;
  const meetDockable = meetView && !meetView.webContents.isDestroyed() && !meetElsewhere;
  const meetAttached = meetDockable && mainWindow.getBrowserViews
    && mainWindow.getBrowserViews().includes(meetView);
  if (l.regionHidden) {
    // Just below the window's bottom edge: a valid, non-zero rect that Chromium
    // clips away entirely. Its webContents keeps running, so idle.html (and any
    // state it holds) survives to the next call.
    if (meetAttached) {
      meetView.setBounds({ x: 0, y: height, width, height: botViewLayout.regionHeightFor(WINDOW_WIDTH) });
    }
  } else if (meetDockable && !meetAttached) {
    mainWindow.addBrowserView(meetView); // re-dock (e.g. after a provider swap)
  }
  if (l.meetBounds && meetView && !meetView.webContents.isDestroyed()) {
    meetView.setBounds(l.meetBounds);
    // The zoom is stateful (per-webContents), so set it here too — a resize while
    // in 'thumbnail' keeps the same 380px column, so the zoom is stable, but this
    // keeps it correct if WINDOW_WIDTH ever changes.
    applyMeetZoom();
  }

}

// Toggle the Meet view between the docked thumbnail and its own large window.
// Mirrors setPanelPoppedOut: the SAME meetView BrowserView is reparented, so its
// webContents — the live call, caption scraper, virtual camera — survives the move
// untouched.
// #103: the resting state — where the bot's view sits when not popped out.
// 'hidden' keeps Meet in a never-shown window at full size so screenshots are
// legible; 'thumbnail' is the legacy narrow preview. Read live so the panel can
// switch it, but the host window is only rebuilt on the next setBotViewState.
function restingBotViewState() {
  return store.get('botViewMode') === 'thumbnail' ? 'thumbnail' : 'hidden';
}

// The 'hidden' host: a window that exists purely to give meetView a large
// compositing surface. It is NEVER shown to the user.
//
// Two constraints learned the hard way, both measured (#103):
//   • The view must stay ATTACHED to a window. Detached, Chromium stops
//     scheduling it — rAF fell from 180 frames/1.5s to 2. A frozen Meet view is
//     the #424 failure (bot goes silently deaf) with extra steps.
//   • The window must be SHOWN ONCE before it can be captured. A never-shown
//     window has no display surface and capturePage() throws
//     "Current display surface not available for capture". So: show, let a
//     frame land, hide. It is on screen for a few hundred ms at startup.
//
// document.visibilityState stays "visible" while hidden (verified), so Meet
// never thinks it's backgrounded and keeps decoding remote video — which is the
// whole point, since those tiles are what the bot needs to read.
// Give the hidden host a real display surface: show it, wait for meetView to
// actually produce a frame, then hide it again. Must run whenever a FRESH
// meetView is attached, not only when the host is created — a view attached to
// an already-hidden window never gets a surface, and capturePage then THROWS
// "Current display surface not available for capture" (seen live on a join,
// which recreates the view).
let hiddenHostSettling = false;
async function settleHiddenMeetHost() {
  const win = meetHiddenWindow;
  if (!win || win.isDestroyed() || hiddenHostSettling) return;
  hiddenHostSettling = true;
  try {
    win.showInactive();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      if (win.isDestroyed()) return;
      if (!meetView || meetView.webContents.isDestroyed()) continue;
      try {
        const img = await meetView.webContents.capturePage();
        if (!img.isEmpty()) break; // a frame landed — safe to hide
      } catch { /* surface not ready yet */ }
    }
  } catch { /* headless / no display — capture reports its own error */ }
  finally {
    try { if (!win.isDestroyed()) win.hide(); } catch { /* gone */ }
    hiddenHostSettling = false;
  }
}

function ensureHiddenMeetHost() {
  if (meetHiddenWindow && !meetHiddenWindow.isDestroyed()) return meetHiddenWindow;
  const { width, height } = botViewLayout.HIDDEN_SIZE;
  const win = new BrowserWindow({
    // opacity 0, not just off-screen coordinates: macOS clamps a window
    // positioned entirely outside every display back on-screen, so an x/y
    // hack alone still lets settleHiddenMeetHost's showInactive() below paint
    // a real, nearly full-screen (HIDDEN_SIZE is 1600x900) window right where
    // the user's eye already is — e.g. immediately after closing the Bot's
    // View popout, it reads as the app flashing full-screen before vanishing.
    // Opacity is a compositor property, not a renderer one, so the page still
    // renders (and still captures via capturePage) while genuinely invisible.
    opacity: 0,
    width, height,
    useContentSize: true,
    show: false,
    skipTaskbar: true,
    title: windowTitle("Bot's view (hidden)"),
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  meetHiddenWindow = win;
  win.on('closed', () => { if (meetHiddenWindow === win) meetHiddenWindow = null; });

  // Establish the display surface, then get it off screen. showInactive avoids
  // stealing focus from whatever the user is doing.
  //
  // Hiding on a fixed timer is NOT reliable: the first real run hid the window
  // while Meet was still loading, no frame ever landed, and every capture came
  // back 0x0. So poll for an actual non-empty frame and only hide once we have
  // one — with a ceiling so a headless/no-display machine doesn't leave the
  // window up forever. onCaptureScreenshot self-heals if this still loses a
  // race.
  settleHiddenMeetHost();
  return win;
}

// #103: attach the CURRENT meetView to whichever window the current state says
// owns it. Every path that (re)creates meetView — first launch, activateMeetProvider,
// a partition/provider swap — must go through this instead of
// `mainWindow.addBrowserView(meetView)`.
//
// Why this exists: those call sites used to hard-code the main window. With the
// 'hidden' resting state that put the fresh view in the main window while
// meetHiddenWindow still existed, so layoutViews treated it as "elsewhere" and
// never set its bounds — leaving it at 0x0, never painting. The bot reported
// itself in the call while the avatar sat on the 🫥 "not on the line yet" face
// and nothing ever rendered. Caught on the second live test, not by any unit test.
function attachMeetViewForState() {
  if (!meetView || meetView.webContents.isDestroyed()) return;
  if (botViewState === 'hidden') {
    const win = ensureHiddenMeetHost();
    try { win.addBrowserView(meetView); } catch { /* already attached */ }
    const { width, height } = botViewLayout.HIDDEN_SIZE;
    meetView.setBounds({ x: 0, y: 0, width, height });
    try { meetView.webContents.setZoomFactor(botViewLayout.HIDDEN_ZOOM); } catch { /* gone */ }
    settleHiddenMeetHost(); // a fresh view in an already-hidden window has no surface
    return;
  }
  if (botViewState === 'popped' && meetPopoutWindow && !meetPopoutWindow.isDestroyed()) {
    try { meetPopoutWindow.addBrowserView(meetView); } catch { /* already attached */ }
    const [w, h] = meetPopoutWindow.getContentSize();
    meetView.setBounds({ x: 0, y: 0, width: w, height: h });
    try { meetView.webContents.setZoomFactor(botViewLayout.POPPED_ZOOM); } catch { /* gone */ }
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.addBrowserView(meetView);
}

function setBotViewState(state) {
  if (!botViewLayout.STATES.includes(state)) state = restingBotViewState();
  botViewState = state;

  if (state === 'hidden') {
    // Move meetView into the hidden host at full size, zoom 1.
    const win = ensureHiddenMeetHost();
    if (meetPopoutWindow && !meetPopoutWindow.isDestroyed()) {
      try { meetPopoutWindow.removeBrowserView(meetView); } catch { /* gone */ }
      meetPopoutWindow.destroy();
      meetPopoutWindow = null;
    }
    if (meetView && !meetView.webContents.isDestroyed()) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.removeBrowserView(meetView); } catch { /* not attached */ }
      }
      try { win.addBrowserView(meetView); } catch { /* already there */ }
      const { width, height } = botViewLayout.HIDDEN_SIZE;
      meetView.setBounds({ x: 0, y: 0, width, height });
      try { meetView.webContents.setZoomFactor(botViewLayout.HIDDEN_ZOOM); } catch { /* gone */ }
    }
    layoutViews();
    broadcastBotViewState();
    return true;
  }

  // Leaving 'hidden' — tear the host down so we don't leak a window per toggle.
  if (meetHiddenWindow && !meetHiddenWindow.isDestroyed()) {
    try { meetHiddenWindow.removeBrowserView(meetView); } catch { /* gone */ }
    meetHiddenWindow.destroy();
    meetHiddenWindow = null;
  }

  if (state === 'popped' && !meetPopoutWindow) {
    if (meetView && !meetView.webContents.isDestroyed() && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.removeBrowserView(meetView);
    }
    const win = new BrowserWindow({
      // 16:9, and LOCKED to it below. This window is a capture surface as well
      // as a viewing one: call-recording-window.js records meetView's frame,
      // and in 'popped' state meetView is sized to exactly this window's
      // content box (see `fit` below, bound to every resize). So whatever
      // shape the user drags this into is the shape of call-recording.mp4.
      //
      // It used to be 900x620 — 1.45:1, not a video ratio at all — and then
      // free-resizing on top of that. Recordings came out at whatever the user
      // happened to leave it: 3024x1700 (DAR 756:425) in the wild, close
      // enough to 16:9 to look like a bug and far enough to letterbox in
      // anything that assumes 16:9. Meanwhile the 'hidden' state has always
      // recorded cleanly, purely because botViewLayout.HIDDEN_SIZE is a fixed
      // 1600x900. This gives 'popped' the same guarantee.
      //
      // setAspectRatio rather than a fixed size, and rather than resizing the
      // window when recording starts: the user keeps full control of how big
      // their view is, they just can't make it a shape that ruins the
      // recording. Nothing moves under them mid-call.
      //
      // NOTE this is necessary but NOT sufficient — these are LOGICAL pixels,
      // so on a Retina display the captured frame is 2x this. The capture
      // constraint in renderer/call-recording-window.js is what bounds the
      // actual encoded resolution; this only fixes the SHAPE.
      width: 960, height: 540,
      title: windowTitle("Bot's view"),
      icon: path.join(__dirname, 'icon.png'),
      // Deliberately NOT `parent: mainWindow`. A child window is dragged around
      // by its parent on macOS, so every nudge of the app window yanked the
      // bot's view along with it — maddening when you have parked it somewhere
      // and want to move the app out of the way. It is a normal top-level
      // window now: independent position, and free to sit behind the app.
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    // extraSize {0,0} because meetView fills the whole content box — there is
    // no in-content chrome to subtract — so the ratio applies to exactly what
    // getContentSize() reports, which is what `fit` hands to setBounds.
    //
    // Best-effort: this is macOS/Windows in Electron 33, and it constrains
    // USER drags only (the docs are explicit that programmatic setSize skips
    // it — nothing here calls setSize on this window). Where it's unavailable
    // it no-ops, and the capture constraint still bounds the encode; the
    // recording is then merely the old arbitrary shape, not broken.
    try { win.setAspectRatio(16 / 9, { width: 0, height: 0 }); } catch { /* not supported here */ }
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
    // The resize listener comes off FIRST — otherwise a resize event fired
    // during the window's teardown (however unlikely) would still call fit()
    // against a torn-down BrowserView.
    win.on('close', () => {
      win.removeListener('resize', fit);
      try { win.removeBrowserView(meetView); } catch { /* gone */ }
    });
    win.on('closed', () => {
      meetPopoutWindow = null;
      const resting = restingBotViewState();
      if (resting === 'hidden') {
        // Straight back into the hidden host — do NOT dock it into the main
        // window on the way, or the view spends a frame at thumbnail size and
        // any capture racing this gets the small image.
        setBotViewState('hidden');
        focusMainWindow();
        return;
      }
      botViewState = 'thumbnail';
      if (meetView && !meetView.webContents.isDestroyed() && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.addBrowserView(meetView);
      }
      applyMeetZoom();
      layoutViews(); // re-docks the thumbnail into the region
      broadcastBotViewState();
      focusMainWindow();
    });
    layoutViews(); // panel reclaims the whole column — no region while popped
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
  // #103: the panel labels its toggle by what a click WILL do, so it needs to
  // know which resting state we'd return to — 'hidden' or the legacy thumbnail.
  broadcastToRenderers('bot-view-changed', { state: botViewState, resting: restingBotViewState() });
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
      width: WINDOW_WIDTH + 80,
      height: 820,
      title: windowTitle("Bot's-eye view"),
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
      broadcastToRenderers('panel-popout-changed', { poppedOut: false });
      focusMainWindow();
    });
    layoutViews();
    broadcastToRenderers('panel-popout-changed', { poppedOut: true });
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
  broadcastToRenderers('meet-mode-changed', { partition: SESSION_PARTITION });
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
  destroyProviderView();
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
  destroyProviderView();
  slackProviderMode = false;
  slackSurface = null;
  // #347: follows the active partition, so a provider switch mid-fallback
  // doesn't silently drop the bot back onto the blocked account.
  ensureMeetSessionConfigured(activeMeetPartition);
  meetView = createMeetView(activeMeetPartition);
  attachMeetViewForState(); // #103: hidden host / popout / main window, per state
  layoutViews();
}

// Let the avatar banner run to the very top of the window, behind the window
// controls — on macOS only. Support is uneven, and the two platforms want
// genuinely different things:
//
//   macOS   — 'hiddenInset' floats the traffic lights over our content. The good
//             one, and the only value that does this on mac. Mac's menu bar
//             lives at the top of the SCREEN, so hiding the window's title bar
//             costs nothing.
//   Windows — a standard frame, deliberately. Windows draws the app menu bar
//             INSIDE the window, and 'hidden' + titleBarOverlay takes the whole
//             caption strip with it — so the File/Edit/Window menus had nowhere
//             to render and simply vanished. The overlay also sat on top of the
//             panel header (see docs/media). A traditional title bar is what a
//             Windows app is supposed to look like anyway: the menu bar appears
//             under it, and the banner starts below both.
//   Linux   — standard frame too. 'hidden' there removes the caption buttons
//             entirely, and frameless drag/resize behaviour varies across
//             GNOME/KDE, so this wants testing on a real desktop before we ship
//             it rather than a guess from here.
//
// Everywhere it's off, the window keeps its normal title bar and the banner
// starts below it — nothing broken, just conventional.
function titleBarOptions() {
  if (process.platform === 'darwin') return { titleBarStyle: 'hiddenInset' };
  return {};
}

// Does the window lack a normal title bar? Then the panel makes its top strip
// draggable, since there's no OS bar left to grab. macOS only — see above.
function hasHiddenTitleBar() {
  return process.platform === 'darwin';
}

function createMainWindow() {
  // Optional explicit window placement from CLI (--window-x/-y/-w/-h), used by
  // the multi-bot test launcher to tile windows in a grid. Setting x/y at
  // creation is reliable (System Events moves from outside get reverted by the
  // window server for some instances). Omitted → Electron centers as usual.
  const winX = cliArgs['window-x'] != null ? parseInt(cliArgs['window-x'], 10) : null;
  const winY = cliArgs['window-y'] != null ? parseInt(cliArgs['window-y'], 10) : null;
  // NOTE: --window-w/-h are deliberately NOT honoured. The window is exactly the
  // size its content needs — a fixed-width column, height derived from the panel
  // — so an external size is something to fight, not respect. The test launcher
  // already passes position only (it found that sizing "made each app fill its
  // whole grid cell"), and honouring a height silently disabled auto-sizing:
  // after a bot switch, which forwarded the old window's bounds, the new window
  // froze at that height and stopped growing for the bot's view during a call.
  mainWindow = new BrowserWindow({
    ...titleBarOptions(),
    // The app launches as a NARROW COLUMN (panel on top, shrunk Meet thumbnail
    // below) so it never looks like the user's own Meet window — Seth and new
    // users kept confusing the two. The Meet view is a scaled-down thumbnail (see
    // bot-view-layout.js); a button pops it out to its own large window. The
    // size is the app's to decide (see the note above) — only --window-x/-y are
    // honoured, which is all the test launcher passes.
    width: WINDOW_WIDTH,
    // A provisional height: the panel reports its real content height as soon as
    // it lays out, and applyWindowHeight shrinks this to fit.
    height: 820,
    // Stay hidden until that first measurement lands — see showMainWindowOnce.
    // Shown at 820 the app opened as a tall column and visibly snapped to its
    // real (roughly square) height a moment later, every single launch.
    show: false,
    // Paint the panel's own surface colour rather than white while the window
    // is empty, so revealing it can't flash white first.
    backgroundColor: '#202124',
    // Content-sized, so there is nothing for a user resize to mean: dragging the
    // edge would just be undone by the next content change. The width is a fixed
    // column the layout assumes (bot-view-layout is built around WINDOW_WIDTH),
    // and the height is derived — so let the app own both.
    resizable: false,
    ...(Number.isFinite(winX) ? { x: winX } : {}),
    ...(Number.isFinite(winY) ? { y: winY } : {}),
    minWidth: WINDOW_WIDTH,
    // Low, because out of a call the window is only as tall as the avatar banner
    // + footer. The real floor is MIN_WINDOW_HEIGHT in applyWindowHeight.
    minHeight: MIN_WINDOW_HEIGHT,
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
      // Same reason as createMeetView (#424): Chromium throttles timers and
      // STOPS rAF for an occluded view. The panel now measures itself and
      // reports its height so main can size the window — if that measurement is
      // frozen while the window sits behind the user's editor, a call starts
      // with a stale (pre-call) height and the bot's-view region lands on top of
      // the panel's own content.
      backgroundThrottling: false,
    },
  });
  mainWindow.addBrowserView(panelView);
  // --open-settings: a brand-new bot opens straight on its Settings screen.
  // Creating a bot and landing on "Call now" is backwards — a fresh bot has no
  // name, voice or face yet, and the first thing anyone wants is to give it one
  // (or press the guided-setup call that now lives at the top of that page).
  //
  // NOT the 'screen' param: that one marks a POP-OUT window (IS_POPOUT_WINDOW),
  // which would suppress this panel's height reporting and leave the main window
  // stuck at its startup size.
  panelView.webContents.loadFile(path.join(__dirname, 'renderer', 'panel.html'),
    cliArgs['open-settings'] === 'true' ? { search: 'startScreen=settings' } : undefined);
  // The window is hidden until the panel reports its height (showMainWindowOnce).
  // Arm the safety net now, so a renderer that never loads can't leave the app
  // running with no window at all.
  armShowMainWindowFallback();

  // Every button the user has (including Quit and New Window) is an IPC call
  // through this view — if its renderer wedges, every click looks like it does
  // nothing and there is no menu-bar fallback, because 'New Window' is itself a
  // panel button, not a native menu item (see open-next-available-window). A
  // native dialog is independent of the hung renderer, so it's the only way out
  // that's guaranteed to still work. Debounced by wasUnresponsive so a single
  // slow tick (GC pause, a big IPC payload) doesn't pop a dialog every time.
  let wasUnresponsive = false;
  panelView.webContents.on('unresponsive', () => {
    if (wasUnresponsive) return;
    wasUnresponsive = true;
    console.warn('[electron] panel view unresponsive — offering force-quit');
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Force Quit', 'Wait'],
      defaultId: 1,
      cancelId: 1,
      message: 'Vibeconferencing isn’t responding.',
      detail: 'Clicks and menu actions may do nothing until it recovers. You can force quit and relaunch, or keep waiting.',
    }).then(({ response }) => { if (response === 0) app.exit(0); });
  });
  panelView.webContents.on('responsive', () => { wasUnresponsive = false; });
  applyWindowTitle();

  // --- macOS menu bar ---
  // A function, not a one-shot array, because the Claude/Codex integration
  // items reflect live install state (isClaudeIntegrationInstalled /
  // isCodexIntegrationInstalled) and need to be rebuilt after the user
  // toggles either one — see the two click handlers below.
  // One entry per configured profile, newest-usable name first. Falls back to
  // the profile's directory name when it has no botName yet — an unnamed bot is
  // still a window you might want to open, and hiding it would make the menu
  // disagree with the switcher.
  function botProfileMenuItems() {
    let profiles = [];
    try { profiles = profileManager.listProfiles(PROFILES_ROOT) || []; } catch { /* unreadable — show nothing rather than throw */ }
    if (!profiles.length) return [{ label: 'No other bots', enabled: false }];
    return profiles.map((prof) => ({
      label: prof.botName || prof.name,
      click: () => {
        if (!launchOrFocusProfileRef) return;
        launchOrFocusProfileRef(prof.name).catch((err) =>
          console.warn('[electron] Open Bot Window failed for', prof.name, '-', err.message));
      },
    }));
  }

  function buildAppMenuTemplate() {
    const claudeInstalled = isClaudeIntegrationInstalled();
    const codexInstalled = isCodexIntegrationInstalled();
    return [
    {
      label: app.name,
      submenu: [
        // Our own About window, not { role: 'about' } — see openAboutWindow.
        { label: 'About ' + app.name, click: () => openAboutWindow() },
        {
          label: 'Check for Updates…',
          click: () => checkForUpdates({ silentWhenCurrent: false }),
        },
        { type: 'separator' },
        {
          // #381: ⌘, opens machine-wide Settings (macOS-native Preferences→Settings
          // convention). Per-profile settings are NOT here: they belong to a bot,
          // so they live under Bot (⇧⌘,) and on the panel's gear button.
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => openAppSettings(),
        },
        {
          label: 'Setup Assistant…',
          click: () => createOnboardingWindow(),
        },
        { type: 'separator' },
        claudeInstalled ? {
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
                refreshAppMenu();
                dialog.showMessageBox(mainWindow, {
                  type: 'info',
                  message: 'Claude integration removed. No trace left. Restart Claude Code to apply.',
                });
              }
            });
          },
        } : {
          label: 'Install Claude Integration',
          click: () => {
            const { dialog } = require('electron');
            try { store?.delete('claudeIntegrationRemoved'); } catch { /* non-fatal */ }
            ensureClaudeIntegration();
            refreshAppMenu();
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              message: 'Claude integration installed. Restart Claude Code to pick it up.',
            });
          },
        },
        codexInstalled ? {
          label: 'Uninstall Codex Integration...',
          click: () => {
            const { dialog } = require('electron');
            dialog.showMessageBox(mainWindow, {
              type: 'question',
              buttons: ['Cancel', 'Uninstall'],
              defaultId: 0,
              title: 'Uninstall Codex Integration',
              message: 'Remove the Vibeconferencing MCP server from Codex?',
              detail:
                'Removes only the vibeconferencing MCP server block from ~/.codex/config.toml.\n\n' +
                'It will NOT be reinstalled on the next launch. The app itself keeps working; ' +
                'use "Install Codex Integration" to bring it back.',
            }).then(({ response }) => {
              if (response === 1) {
                removeCodexIntegration();
                try { store?.set('codexIntegrationRemoved', true); } catch { /* non-fatal */ }
                refreshAppMenu();
                dialog.showMessageBox(mainWindow, {
                  type: 'info',
                  message: 'Codex integration removed. Restart Codex to apply.',
                });
              }
            });
          },
        } : {
          label: 'Install Codex Integration',
          click: () => {
            const { dialog } = require('electron');
            try { store?.delete('codexIntegrationRemoved'); } catch { /* non-fatal */ }
            ensureCodexIntegration();
            refreshAppMenu();
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              message: 'Codex integration installed. Restart Codex to pick it up.',
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
          // #379: create a brand-new bot and open it in its own window, on its
          // Settings screen. No ellipsis and no prompt — same one-click path as
          // the switcher's "＋ New bot", which is the point: two entries that
          // create a bot should not disagree about how.
          //
          // The name it used to ask for was the profile DIRECTORY, from when
          // that doubled as the bot's name. Now the directory is picked
          // automatically (botN) and the bot gets a real name from the same pool
          // the spinner draws from, editable on the page it lands on.
          //
          // Routed through the panel because the create/launch helpers live in
          // setupIPC's scope; the panel just invokes the same handler.
          label: 'New Bot',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            if (panelView && !panelView.webContents.isDestroyed()) {
              // ADDRESSED, not broadcast (#229): a COMMAND. The handler calls
              // create-new-bot, so broadcasting would create three bots.
              panelView.webContents.send('new-bot');
            }
          },
        },
        { type: 'separator' },
        {
          // Opening a window is a File verb, so the profile list lives here
          // rather than under Bot. It also subsumes the old "New Window", which
          // opened the first profile that wasn't already running — naming them
          // is strictly better: you pick the bot you want instead of guessing
          // which one ⌘N will land on.
          //
          // The most valuable item in the menu, per #502: profiles are how one
          // machine runs several bots, but while you are in a call there is no
          // good way to open a window for a different one — which makes them
          // close to theoretical in exactly the situation they were built for.
          //
          // Rebuilt from disk on every refreshAppMenu(), so a profile created
          // mid-session appears without a relaunch. listProfiles reads
          // agent/config.json off disk, no running instance required.
          label: 'Open Bot',
          submenu: botProfileMenuItems(),
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
      // #502: the menu bar is where macOS users expect to FIND OUT what an app
      // can do, and almost everything here was reachable only by clicking
      // something in the panel. Two items already existed and were simply in
      // places nobody would look: Show Bot's View was under File, and Copy Chat
      // Command was parked in Edit by fb6f07aa — a spot fix for one command
      // rather than a plan. They move here unchanged, accelerators included.
      //
      // The dividing line is the bot versus the window: anything about THIS bot
      // belongs here, anything about the window stays in Window.
      label: 'Bot',
      submenu: [
        {
          // Moved out of the app menu, where it sat directly under the
          // machine-wide "Settings…" and read as a second helping of the same
          // thing. It configures THIS bot — name, voice, avatar — which is the
          // line this menu is drawn on. First item because it is the one you
          // open before a bot is any good, and it keeps ⇧⌘, either way.
          label: 'Bot Settings…',
          accelerator: 'CmdOrCtrl+Shift+,',
          click: () => {
            if (panelView && !panelView.webContents.isDestroyed()) {
              // ADDRESSED, not broadcast (#229): a COMMAND to navigate the MAIN
              // panel to its settings screen. A pop-out jumping to settings is
              // not what the menu item means.
              panelView.webContents.send('show-settings');
            }
          },
        },
        { type: 'separator' },
        {
          // Three ways to look inside the same bot, so they read as one group:
          // one verb (Show), one subject (this bot), no separators between them.
          // "Brain Pane" and "Troubleshooting…" named the window rather than the
          // act, and the ellipsis promised a modal that never existed — these
          // all open a window and none of them ask a question first.
          //
          // Force the bot's-view window OPEN (popped out). It's hidden by default
          // (the 👀 button toggles it), so a screen recording of an automated run
          // films the desktop, not the call. DETERMINISTIC (always 'popped', not a
          // toggle) so it's safe to trigger from AppleScript for testing —
          // `tell app "System Events" to click menu item "Show Bot's View"…` — and
          // the resulting window has a stable title ("<name> — Bot's view").
          label: "Show Bot's View",
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => { try { setBotViewState('popped'); } catch (err) { console.warn('[electron] Show Bot\'s View failed:', err.message); } },
        },
        {
          label: "Show Bot's Brain",
          click: () => { try { openBrainWindowRef && openBrainWindowRef(); } catch (err) { console.warn('[electron] Show Bot\'s Brain from menu failed:', err.message); } },
        },
        {
          // Not "Show Call Details": the window carries Test TTS, Test Curl and
          // the debug overrides alongside the live call state, and a name that
          // covered only the call half would hide the other one.
          label: 'Show Troubleshooting',
          click: () => { try { openTroubleshootingWindowRef && openTroubleshootingWindowRef(); } catch (err) { console.warn('[electron] Show Troubleshooting from menu failed:', err.message); } },
        },
        { type: 'separator' },
        {
          // Advanced (#282 follow-up): drive the bot's own browser to any URL to
          // set up Slack/Google account state inside its partition. Pre-fills the
          // prompt with the window's CURRENT URL so you can see where it landed
          // (redirects/blank pages) and edit from there.
          //
          // The target is the SHARE window, which sits on the same partition as
          // meetView — one cookie jar, so a login done there is live for the bot
          // — and, unlike meetView, is not the call. See the navigate-webview
          // handler for why that swap happened.
          label: 'Navigate Webview…',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => {
            if (panelView && !panelView.webContents.isDestroyed()) {
              // (Showing the window happens in the navigate-webview handler,
              // AFTER the URL is entered — raising it here would put a child
              // window over the panel that's asking for the URL.)
              let currentUrl = '';
              try {
                if (whiteboardWindow && !whiteboardWindow.isDestroyed()) {
                  currentUrl = whiteboardWindow.webContents.getURL();
                }
              } catch { /* ignore */ }
              // Presenting means this window is ON SCREEN to everyone in the
              // call, so whatever is typed here — a login page, a half-loaded
              // site — is watched live. Worth a warning; not worth refusing,
              // since fixing a broken share is a real reason to do it.
              const sharing = !!(localServer && localServer.sharing);
              // Raise the app window so the URL prompt is actually on screen —
              // it may be behind an already-open pop-out, or minimised.
              try {
                if (mainWindow && !mainWindow.isDestroyed()) {
                  if (mainWindow.isMinimized()) mainWindow.restore();
                  mainWindow.show();
                  mainWindow.moveTop();
                }
              } catch { /* ignore */ }
              // Focus the panel view first — otherwise the prompt input's .focus()
              // in the renderer doesn't grab the keyboard (the panel BrowserView
              // isn't the focused frame), so you'd have to click it before typing.
              try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus(); } catch { /* ignore */ }
              try { panelView.webContents.focus(); } catch { /* ignore */ }
              // ADDRESSED, not broadcast (#229): a COMMAND that opens a prompt.
              // Three windows would ask three times for one menu click.
              panelView.webContents.send('navigate-webview-prompt', { currentUrl, sharing });
            }
          },
        },
        {
          // The pair to Copy Chat Command below: PRESSES the panel's Call
          // button as if Option were held, rather than reimplementing the
          // terminal launch here — same reasoning as Call Now above it. Useful
          // from the app-wide accelerator, or when the panel doesn't have
          // keyboard focus so Option-click isn't an option.
          label: 'Open Terminal with Bot',
          click: () => {
            if (panelView && !panelView.webContents.isDestroyed()) {
              // ADDRESSED, not broadcast (#229): a COMMAND. Broadcasting would
              // open three terminals.
              panelView.webContents.send('menu-chat-with-bot');
            }
          },
        },
        {
          // The bot keeps ONE Claude session named after itself, so the session
          // it uses on calls is the same one a person can open at a prompt. The
          // panel's Call button held under Option does that; this copies the
          // command instead, on the Finder shortcut it borrows from (⌘C takes
          // the thing, ⌥⌘C takes its address).
          //
          // A permanent item rather than the true Finder behaviour of Copy
          // SWAPPING while Option is held: that needs AppKit alternate menu
          // items, which Electron does not expose. Visible-always is the better
          // trade anyway — you find it without knowing to hold a key.
          //
          // It also closes a real gap. The renderer's ⌥⌘C only fires when the
          // panel has keyboard focus, and the panel usually does not (see the
          // Option-label lag fix). A menu accelerator works app-wide.
          label: 'Copy Chat Command',
          accelerator: 'Alt+CmdOrCtrl+C',
          click: () => {
            try {
              const claudeDir = store.get('claudeWorkDir') || ensureAgentWorkdir();
              const sessionField = store.get('agentSession');
              const botName = resolvedBotName();
              const { resolveSessionRef } = require('./agent-session.js');
              const ref = resolveSessionRef(sessionField, botName);
              const command = require('./chat-command.js').buildChatCommand({
                workdir: claudeDir,
                sessionField,
                botName,
                cachedSessionId: ref.kind === 'name' ? cachedResumeSessionId(claudeDir, ref.name) : '',
              });
              require('electron').clipboard.writeText(command);
              console.log('[chat-session] copied chat command from the Edit menu');
            } catch (err) {
              console.warn('[chat-session] copy from menu failed:', err.message);
            }
          },
        },
        { type: 'separator' },
        {
          // The pair to Hang Up, which used to stand alone because a menu item
          // cannot carry the URL field the panel's button sits beside. It does
          // not need to: it PRESSES that button rather than reimplementing it,
          // so it means whatever the button means at that moment — "Call <bot>
          // now" with nothing detected, "Add <bot> to call" with a URL in hand.
          // A second opinion in the menu is what could have joined the wrong
          // thing; deferring to the one control cannot.
          label: 'Call Now',
          // Live, not frozen: refreshAppMenuRef() now runs on every call-status
          // change, so exactly one of this pair is enabled at any moment.
          enabled: !localServer || localServer.callStatus === 'idle',
          click: () => {
            if (panelView && !panelView.webContents.isDestroyed()) {
              // ADDRESSED, not broadcast (#229): a COMMAND. Broadcasting would
              // start three calls.
              panelView.webContents.send('menu-call-now');
            }
          },
        },
        {
          // Guarded in the handler AS WELL as by `enabled:`. The menu is rebuilt
          // from the call-status change, so there is a window of a few
          // milliseconds where it can be stale, and requestCleanLeave does real
          // teardown — it must not run when there is no call to leave.
          label: 'Hang Up',
          enabled: !!localServer && localServer.callStatus !== 'idle',
          click: () => {
            if (!localServer || localServer.callStatus === 'idle') return;
            try { requestCleanLeave('menu'); } catch (err) { console.warn('[electron] Hang Up from menu failed:', err.message); }
          },
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
        { type: 'separator' },
        {
          // Escape hatch for an orphaned share window: the normal close paths
          // (onStopSharing, showIdle) require the app to believe a call/share
          // is ending, which a crashed or abnormally-dropped call can skip
          // entirely. The window itself may be frameless (shareTitleBar=false),
          // so there is otherwise no click target to get rid of it — only
          // quitting the whole app. This works regardless of call/share state.
          label: 'Close Share Window',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: () => closeWhiteboardWindow('menu'),
        },
      ],
    },
    ];
  }
  function refreshAppMenu() {
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate()));
  }
  refreshAppMenuRef = refreshAppMenu;
  refreshAppMenu();

  // --- Call view (right) ---
  // Single partition (#282) — no "restore previous mode" anymore. Sign-in
  // stickiness now comes from the cookies persisting in this one partition,
  // not from remembering which partition to swap to.
  ensureMeetSessionConfigured(SESSION_PARTITION);

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
    meetView = createMeetView(SESSION_PARTITION);
  }
  attachMeetViewForState(); // #103: hidden host / popout / main window, per state

  // Open DevTools on demand from panel — registered once, references the
  // current module-level meetView so it always targets the live one after
  // a partition swap.
  // Call feedback from the troubleshooting window: a human saying "that was
  // wrong" at the moment it happened.
  //
  // The timestamp is the whole point. Bot misbehaviour is hard to report after
  // the fact — "it kept interrupting" doesn't locate anything — but a marker in
  // the session log sits next to the captions, the turn state and the agent
  // activity for that second, which is enough to reconstruct what happened.
  //
  // Deliberately ONE handler, and deliberately structured: the same signal is
  // meant to reach the agent later so it can adjust mid-call, and that should be
  // an addition here rather than a second route with its own format.
  //
  // Never throws: this is clicked during a live call, and a logging failure must
  // not surface as an error in front of the room.
  // What the agent is told when a human flags something, per kind.
  //
  // Written as instructions, not as reports. "The user flagged interrupting" is
  // a fact the agent can acknowledge and then ignore; "let people finish, and
  // score your urgency lower" is something it can act on this turn.
  //
  // Four of the seven get nothing. That is deliberate rather than unfinished:
  //   frozen        — if it were reading this it would not be frozen
  //   wrong-answer  — it does not tell the agent WHAT was wrong, and a vague
  //                   "you were wrong" mid-call invites flailing over a turn it
  //                   cannot identify
  //   voice / other — nothing the agent controls
  // A message the agent cannot act on is context spent to make the human feel
  // heard, and it is the human's own call log that does that job.
  // Live state for the troubleshooting window: a share that keeps streaming
  // should show a growing count, not a frozen one beside "still sharing".
  ipcMain.handle('get-call-log-share-state', () => {
    const { getSentCount } = require('./session-log.js');
    return {
      sharedCallId: _sharedCallId,
      active: !!_sharedCallId && localServer.callId === _sharedCallId,
      streaming: _sharingWeEnabled,
      // Shared this call, but currently stopped — the button offers to resume.
      paused: !!_sharedCallId && localServer.callId === _sharedCallId && !_sharingWeEnabled,
      sent: getSentCount(),
      // With this on there is nothing for the button to do — the panel says so
      // rather than offering an action that would be a no-op.
      globalLogging: store?.get('remoteLogging') === true,
      inCall: !!localServer.callId,
    };
  });

  ipcMain.handle('share-call-log', async () => {
    const { sliceCallLines, sendLinesNow, setRemoteLoggingEnabled } = require('./session-log.js');
    const callId = localServer.callId;
    if (!callId) return { ok: false, error: 'not in a call' };
    const { setRemoteLoggingEnabled: setLog, getSentCount: count } = require('./session-log.js');

    // Second press STOPS sharing, so someone can pause before something they
    // would rather not send. It cannot unsend — what has gone has gone — but it
    // does create a real GAP: the streamer drops lines while disabled rather
    // than buffering them, so the paused stretch is never uploaded at all.
    if (_sharedCallId === callId && _sharingWeEnabled) {
      setLog(false);
      _sharingWeEnabled = false;
      console.log('[electron] call-log share PAUSED by user —', count(), 'lines sent so far');
      return { ok: true, stopped: true, sent: count() };
    }

    // Third press resumes. No backfill: this call's earlier lines already went,
    // and re-sending them would duplicate. More to the point, the paused stretch
    // must STAY unsent — excluding it is the entire reason the pause exists.
    if (_sharedCallId === callId && !_sharingWeEnabled) {
      setLog(true);
      _sharingWeEnabled = true;
      console.log('[electron] call-log share RESUMED — the paused stretch stays unsent');
      return { ok: true, resumed: true, sent: count() };
    }
    // Global logging on means every line of this call has already been shipped
    // by the streamer. Backfilling would upload the same lines a second time,
    // and "share this call" would be a promise about something already done.
    if (store?.get('remoteLogging') === true) {
      return { ok: true, alreadyGlobal: true, sent: 0 };
    }

    // Backfill FIRST, then stream. The alternative — flag it and send at call
    // end — loses the log exactly when it is most wanted: someone tailing a bot
    // misbehaving right now, and any call where the app crashes before it ends.
    const { resetSentCount } = require('./session-log.js');
    resetSentCount();   // count this share, not the whole session
    const lines = sliceCallLines(callId);
    const res = await sendLinesNow(lines, { callId, shared: true, sharedAt: new Date().toISOString() });
    if (!res.ok) {
      console.warn('[electron] call-log share failed:', res.error);
      return { ok: false, error: res.error, sent: res.sent };
    }

    _sharedCallId = callId;
    // Only claim the enable if it was actually off — otherwise the user's
    // standing preference is on and is not ours to turn off later.
    if (store?.get('remoteLogging') !== true) {
      setRemoteLoggingEnabled(true);
      _sharingWeEnabled = true;
    }
    console.log('[electron] Shared', res.sent, 'log lines for call', callId,
      _sharingWeEnabled ? '— and streaming the rest of this call' : '(streaming was already on)');
    return { ok: true, sent: res.sent, streaming: _sharingWeEnabled };
  });

  const FEEDBACK_TO_AGENT = {
    interrupting:
      'A person in the call just flagged that you TALKED OVER them. Stop speaking if you are mid-utterance, '
      + 'let them finish, and for the next few turns score your urgency lower so you yield the floor sooner. '
      + 'A brief spoken apology is fine; do not explain at length.',
    'not-yielding':
      'A person in the call just flagged that you DID NOT YIELD when they tried to speak. When you hear someone '
      + 'start, stop — even mid-sentence. Keep replies shorter for the next few turns so there are more gaps.',
    // Two different bugs wear this label, and the agent is the only one who can
    // tell them apart in the moment. Either it is choosing not to speak, or the
    // FLOOR GATE believes someone is always talking so it never gets an opening
    // — measured levels say a transient (a keystroke, a cough) is enough to arm
    // that, because the rising edge is immediate. Telling it only to "speak up"
    // would be useless in the second case, so it is pointed at the check and the
    // levers instead.
    'too-timid':
      'A person in the call just flagged that you are TOO QUIET. Two things cause this, so check which. '
      + '(1) If you have been holding back: speak up on the next opening rather than waiting to be named. '
      + '(2) If you keep deciding the floor is busy, the audio gate may be firing on background noise — '
      + 'call get_room_info and look at whether anyone is really speaking. If it is stuck busy, say so out loud '
      + 'and offer to fix it: set_preference fastFloorDetection false turns the gate off (read live, takes effect '
      + 'immediately), or lower bargeInGraceMs so you yield for less time when it does fire. '
      + 'Ask before changing a preference — it is the human\'s call.',
  };

  // Used when a kind has no canned notice of its own but the human typed
  // something. Their words are the actionable part; this just frames them.
  const FEEDBACK_FREEFORM =
    'A person in the call just flagged something about how you are behaving, in their own words below. '
    + 'Take it as a live correction: adjust now if you can, and acknowledge it briefly out loud if it warrants that.';

  // One agent notice per kind per window. A frustrated human clicks the same
  // button several times in a row — a real run of this produced three
  // "Interrupted" clicks inside one second — and each one would otherwise
  // become a separate line in the agent's context, all saying the same thing at
  // the moment it can least afford the noise.
  const FEEDBACK_AGENT_COOLDOWN_MS = 20_000;
  const feedbackNotifiedAt = new Map();

  ipcMain.handle('call-feedback', (_e, { kind, label, note } = {}) => {
    try {
      const k = String(kind || 'unspecified').slice(0, 40);
      // Bounded and single-lined: this lands in a line-oriented log, so a
      // pasted stack trace would otherwise break every downstream grep.
      const n = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 280);
      const room = localServer.roomId || '-';
      const callId = localServer.callId || '-';
      const status = localServer.callStatus || 'idle';
      // What the bot was DOING at that instant, captured here rather than left
      // to be inferred from neighbouring lines. Verified against a real call:
      // the surrounding log does reconstruct the moment, but only if you read
      // ten lines either side. These two fields are what separate the reports
      // from each other — "interrupted" while bot=speaking is a different bug
      // from "interrupted" while bot=listening, and "frozen" is only meaningful
      // next to whether anyone was actually talking.
      const bot = localServer.botState || 'unknown';
      const speaking = localServer.anyoneSpeaking ? 'yes' : 'no';
      // Prefixed and single-line so it greps cleanly out of a busy session log.
      console.log(`[feedback] kind=${k} status=${status} bot=${bot} othersSpeaking=${speaking} room=${room} call=${callId}`
        + ` label=${JSON.stringify(String(label || k))}`
        + (n ? ` note=${JSON.stringify(n)}` : ''));

      // Tell the agent, when there is something it can do and it hasn't just
      // been told. addError is the existing channel for app-to-agent notices
      // (it is how the voice-fallback message reaches it), so this rides a path
      // the agent already reads rather than inventing a second one.
      // A note makes 'other' actionable, and it is the only way the agent learns
      // WHAT was wrong — which is exactly why "wrong answer" sends nothing on its
      // own. With the human's own words attached, the agent has something to act
      // on rather than a category to flail at.
      const notice = FEEDBACK_TO_AGENT[k] || (n ? FEEDBACK_FREEFORM : null);
      let toldAgent = false;
      if (notice && localServer.roomId) {
        const last = feedbackNotifiedAt.get(k) || 0;
        if (Date.now() - last >= FEEDBACK_AGENT_COOLDOWN_MS) {
          feedbackNotifiedAt.set(k, Date.now());
          localServer.addError(n ? `${notice}\n\nWhat they typed: "${n}"` : notice);
          toldAgent = true;
          console.log(`[feedback] told the agent: ${k}`);
        } else {
          console.log(`[feedback] agent already told about ${k} recently — log only`);
        }
      }
      return { ok: true, toldAgent };
    } catch (err) {
      console.warn('[feedback] failed to record:', err && err.message);
      return { ok: false, error: err && err.message };
    }
  });

  // #557: a renderer telling us one of its own calls failed. The panel is a
  // separate process, so a failure there is invisible to the session log — and
  // devtools cannot be opened on that pane (the handler below only serves
  // meetView, and --devtools needs a relaunch). On a headless box that means a
  // silently-failing settings pane leaves NO trace anywhere a human can reach.
  // One line here puts it in the session log and, with remoteLogging on, in the
  // remote logs — which is the only channel that reaches someone who isn't
  // sitting in front of the machine.
  ipcMain.on('renderer-error', (_event, info) => {
    const { where = 'renderer', key, detail } = info || {};
    console.warn(`[renderer-error] ${where}${key ? ` key=${key}` : ''}: ${detail || 'unknown'}`);
  });

  ipcMain.on('open-devtools', () => {
    if (meetView && meetView.webContents) {
      meetView.webContents.openDevTools({ mode: 'detach' });
    }
  });

  // #103: put the bot's view into its resting state. Under the default
  // ('hidden') this moves meetView straight into the never-shown host at
  // 1600x900 / zoom 1, so screenshots are legible from the first capture.
  // Deferred a tick so the main window has finished its own first layout —
  // ensureHiddenMeetHost briefly shows its window to establish a display
  // surface, and doing that mid-construction fights the main window for focus.
  setTimeout(() => {
    // --bot-view=<popped|thumbnail|hidden> forces the INITIAL state. The view is
    // hidden by default (👀 toggles it), so a screen recording of an unattended
    // test run films the desktop, not the call — launching with --bot-view=popped
    // pops the bot's-view window (titled "<name> — Bot's view") out so it's
    // filmable/positionable. Invalid/absent → the normal resting state.
    const launchView = botViewLayout.STATES.includes(cliArgs['bot-view']) ? cliArgs['bot-view'] : restingBotViewState();
    try { setBotViewState(launchView); }
    catch (err) { console.warn('[electron] initial bot-view state failed:', err.message); }
  }, 0);

  layoutViews();
  mainWindow.on('resize', layoutViews);

  // Load idle placeholder in the Meet view. In Slack mode the surface already
  // loaded app.slack.com (or the channel deep-link) in createSlackSurface.
  if (!slackMode) loadIdlePage('main-window created');

  // 'close' (cancellable) before 'closed' (already gone).
  mainWindow.on('close', confirmQuitBeforeClose);

  mainWindow.on('closed', () => {
    mainWindow = null;
    panelView = null;
    meetView = null;
    // The bot's-view popout is no longer a CHILD of this window (so the app can
    // be dragged without towing it), which means macOS no longer closes it for
    // us. Left alone it would outlive the app window and keep
    // 'window-all-closed' — and so the quit — from ever firing.
    if (meetPopoutWindow && !meetPopoutWindow.isDestroyed()) meetPopoutWindow.destroy();
    meetPopoutWindow = null;
    sync.stopPolling();
  });
}

function showIdle() {
  if (!meetView || meetView.webContents.isDestroyed()) return;
  loadIdlePage('showIdle — call teardown');
  sync.stopPolling();
  closeWhiteboardWindow('call teardown');
  setImpaired(false); // #424: don't carry a 🥴 into the next call
  console.log('[electron] Returned to idle state');
}

// #254: every caller invokes this fire-and-forget, so before this wrapper a
// rejection anywhere inside was an unhandled promise rejection — the join had
// already reported ok, and the failure went nowhere the agent or the user could
// see it. The navigation genuinely can throw: it clears caches, reads cookies
// and rebuilds the BrowserView. Same honesty class as #243/#253 — report the
// outcome, not the attempt.
async function loadMeetURL(meetUrl, opts = {}) {
  try {
    await _openMeetInFreshView(meetUrl, opts);
  } catch (err) {
    const msg = 'Failed to open the Meet page: ' + (err && err.message ? err.message : String(err));
    console.error(ts(), '[electron] #254:', msg);
    try { localServer.addError(msg + ' — the bot is not in the call.'); } catch { /* best-effort */ }
    try { localServer.setCallStatus('idle'); } catch { /* best-effort */ }
  }
}

// Tear down whatever Meet view exists and open `meetUrl` in a brand-new one.
// This is NOT a plain navigation: it destroys the outgoing BrowserView
// (destroyProviderView), reads Google sign-in state, may clear the identity cache,
// pins the authuser, builds a fresh BrowserView on the active partition, and
// only then loads the URL. The old `_loadMeetURL` name hid all of that behind
// "load a URL"; the work here is "replace the view and join", hence the rename.
async function _openMeetInFreshView(meetUrl, { guestFallback = false } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  chatSpaceWarned = false; // fresh call — allow one Chat-space warning again

  // #347: the partition for THIS join. Set here, on every join, rather than
  // toggled and remembered — so the guest fallback can never become sticky no
  // matter how the previous call ended (host-ended, crash, forced idle). The
  // only way onto the guest partition is an explicit guestFallback:true, which
  // only the #346 sign-in handler passes.
  activeMeetPartition = guestFallback ? GUEST_PARTITION : SESSION_PARTITION;
  guestLobbyNotified = false;
  if (guestFallback) {
    console.warn('[electron] #347: joining as a GUEST — the bot account is blocked by a Google identity challenge.');
  } else {
    // A fresh, ordinary join: forget any earlier fallback so the same recurring
    // room is free to retry as a guest again tomorrow.
    guestFallbackTriedFor = null;
  }
  // The guest partition needs the same CSP stripping, permission handling and
  // getDisplayMedia wiring as the home one. Cheap and idempotent (it keeps its
  // own configured-partitions set), so it's safe to call on every join.
  ensureMeetSessionConfigured(activeMeetPartition);

  // Record what we're pointing at so the panel's URL field reflects it (covers
  // --meet-url CLI launches and any programmatic join), and notify the panel now.
  try {
    localServer.setCurrentUrl(meetUrl);
    const meetCode = (meetUrl.match(/meet\.google\.com\/([a-z]+-[a-z]+-[a-z]+)/) || [])[1] || '';
    broadcastToRenderers('meet-detected', { url: meetUrl, meetCode });
  } catch { /* non-fatal */ }

  // Destroy and recreate the meetView before every join. Clearing storage
  // alone is insufficient: Meet caches the green-room identity *in-memory*
  // at the BrowserView level, so a webContents.loadURL into the same view
  // leaves the previous Meet SPA's state alive (visible in logs as
  // duplicated [electron-meet] / [bots-in-calls] lines from two live
  // preload contexts). Tearing down the view is the only thing that
  // matches what "quit and relaunch the app" does. destroyProviderView STOPS the
  // outgoing view (not just detaches it), so a page we're throwing away — e.g.
  // a teardown /bot-view load still in flight — can't finish loading and emit a
  // 'meet-landing' that this very join would then misread as its own failure.
  destroyProviderView();

  // Is this profile signed into Google? Drives both the cache-clear decision
  // and the authuser pin below. With a single partition (#282) we can't infer
  // it from "which partition" anymore — read the live cookies.
  //
  // #347: reads the ACTIVE partition, which is the whole mechanism. On a guest
  // fallback that partition has no Google cookies, so this comes back false and
  // every downstream branch does the right thing on its own: no authuser pin,
  // the identity-cache clear becomes safe (its #250 danger is removing the
  // master-auth cookies, and there are none here), and Meet serves the guest
  // pre-join where autoJoin types the bot's own name from the profile config.
  // The guest join needs no new join logic.
  const sess = session.fromPartition(activeMeetPartition);
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
  //
  // Only `false` — a POSITIVE "there is no session here" — earns the clear.
  // `null` means the cookie read failed, and clearing on a failed read is how a
  // check meant to protect the session ends up destroying it. Skipping when
  // unknown costs nothing: the worst case is a stale cached guest name.
  if (signedIn === false) {
    await clearMeetIdentityCache(activeMeetPartition);
  } else {
    console.log(`[electron] ${signedIn === null ? 'Sign-in state UNKNOWN' : 'Signed in'} — skipping Meet identity-cache clear to preserve Google sign-in`);
  }

  // A profile that remembers an account but has no session has EXPIRED. Say so
  // — loudly, once per join — instead of silently degrading to a guest join that
  // no one can explain later. Suppressed on the #347 guest fallback, which is a
  // deliberate downgrade after Google blocked the account and already reports
  // its own lobby notice; and silent for profiles with no bound account, which
  // is what the guest test fleet is.
  const rememberedAccount = store ? store.get('meetAccountEmail') : null;
  if (!guestFallback && signedIn === false && rememberedAccount) {
    console.error(`[electron] #250: signed OUT of Google, but this profile is bound to ${rememberedAccount} — the session expired. Joining as an unauthenticated guest.`);
    notifyMeetSignInNeeded(rememberedAccount);
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // #282: pin the Google account. When signed in, append ?authuser=<email> so
  // Meet uses the bot's bound account instead of whatever Google considers the
  // partition default (authuser=0) — which could be a stray second account that
  // crept in. The bound email comes from --meet-account-email or is captured at
  // sign-in (get-meet-account-email). No pin when guest or when unknown.
  // `=== true`: only pin authuser when we KNOW there's a session. Pinning on an
  // unknown read would put an account on the URL we can't vouch for.
  const boundEmail = signedIn === true && store ? store.get('meetAccountEmail') : null;
  const urlToLoad = boundEmail ? pinAuthUser(meetUrl, boundEmail) : meetUrl;
  if (boundEmail) console.log('[electron] Pinning Meet account via authuser:', boundEmail);

  meetView = createMeetView(activeMeetPartition);
  attachMeetViewForState(); // #103: hidden host / popout / main window, per state
  layoutViews();

  // #346: the URL we ASKED for. createMeetView logs where we actually land, so
  // the pair together shows any redirect that took us somewhere else.
  console.log('[electron] Loading Meet URL:', urlToLoad);
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
        body.startsWith('[speaker-meter]') || body.startsWith('[meter-latency]') ||
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
      broadcastToRenderers('meet-status', { url, ready: true });
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
// guard as the old single toggle). All sections default OFF — the overlay is a
// debugging tool, not something to show a call by default. The on-camera
// overlay draws iff any is on.
const OVERLAY_DEFAULTS = {
  overlayHealth: false,       // CALL + LOOP + response-time
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
      .filter(([k, def]) => isAppLevel(k) && def && typeof def === 'object' && 'type' in def
        && !def.hiddenInSettingsUI)
      .map(([k, def]) => ({
        key: k,
        type: def.type,
        enum: def.enum || null,
        // #231: optional presentation hints. Absent for every existing pref, so
        // the renderer must fall back to the raw key/value it used before.
        label: def.label || null,
        enumLabels: def.enumLabels || null,
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

  // The Name field shows blank + a generic "Unnamed bot" placeholder when
  // botName is unset, even though the rest of the app (title bar, tray, ...)
  // already falls back to resolvedBotName()'s storedName -> cliName ->
  // profileName chain and shows something real (e.g. a "test-calendar"
  // profile displays as "Test Calendar"). Exposes that same resolved name so
  // the panel can use it as the placeholder — informative without pretending
  // the name was actually set.
  ipcMain.handle('get-resolved-bot-name', () => resolvedBotName());

  // Calendar auto-join (#299): the panel calls this on load to paint the
  // "upcoming meeting" notice immediately, without waiting for the next
  // ~60s poll tick — pushUpcomingCalendarEvents (via 'calendar-upcoming')
  // keeps it live after that.
  ipcMain.handle('get-upcoming-calendar-events', () => (
    { events: latestUpcomingCalendarEvents, error: latestCalendarPollError }
  ));

  // (The switcher thumbnail used to be stolen from the live camera feed here —
  // an edge-triggered capture plus a poll ladder plus 4h staleness gating, all to
  // catch the avatar mid-rest. The panel now rasterises the same picture from the
  // background + emoji prefs directly, so a bot has a thumbnail before it has
  // ever been in a call. See refreshAvatarThumb in renderer/panel.js.)

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
    return localServer.getEffectiveBotName() || resolvedBotName();
  });

  // For the panel: the resolved name (`name`, used verbatim in the "Call X now"
  // button and the copy-paste curl examples) plus a provenance-tagged `display`
  // for the big headline — so a launched/named test bot shows "Alice [CLI name]"
  // at a glance while its real name stays "Alice" everywhere it must match.
  ipcMain.handle('get-bot-name-info', () => {
    const inputs = {
      storedName: store?.get('botName'),
      cliName: cliArgs['bot-name'],
      profileName: isDefaultInstance ? null : explicitProfile,
    };
    return { name: resolveBotName(inputs), display: botNameForAppUI(inputs) };
  });

  ipcMain.handle('set-config', (_event, key, value) => {
    // #546: these two feed the session cache key, so read the pair BEFORE the
    // write and drop whatever the edit moved off (forgetStaleAgentSession).
    const sessionKeyed = key === 'claudeWorkDir' || key === 'agentSession';
    const beforePair = sessionKeyed ? agentSessionPair() : null;
    store.set(key, value);
    if (sessionKeyed) forgetStaleAgentSession(beforePair, agentSessionPair());
    // Every key, not only the ones with a live-apply hook below — the panel shows
    // more prefs than this function specially handles, and the wizard writes
    // several of them.
    notifyConfigChanged(key, value);
    // Live-apply the visual prefs the panel can set here (the agent path goes
    // through applyPref, which already pushes these). #316.
    if (key === 'emojiSet') pushEmojiSet(value);
    if (key === 'botName') applyAllWindowTitles();
    // The background is settable from Bot Settings now, not just by the agent.
    // Without this the in-call avatar kept the OLD background until the next
    // launch, while the panel preview showed the new one.
    if (key === 'avatarBackgroundSvg') pushAvatarBackground(value);
  });

  // Bot Settings → "Choose image…". The agent can already set a background
  // mid-call via set_preference, but that means authoring SVG; this is the
  // by-hand path for people who just want to point at a file.
  ipcMain.handle('choose-avatar-background-image', async () => {
    const parent = BrowserWindow.getFocusedWindow() || mainWindow;
    const { canceled, filePaths } = await dialog.showOpenDialog(parent, {
      title: 'Choose a background image',
      message: 'Shown behind the bot\'s face on its camera (16:9, centre-cropped).',
      properties: ['openFile'],
      // SVG first: it is the native format for this preference and the only one
      // that stays sharp at any size, so it leads the list.
      filters: [{ name: 'Images', extensions: ['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    });
    if (canceled || !filePaths || !filePaths.length) return { canceled: true };
    const filePath = filePaths[0];
    try {
      const svg = await buildBackgroundSvgFromImage(filePath);
      store.set('avatarBackgroundSvg', svg);
      // Caption is purely for recall — it's what get_room_info shows the agent
      // when asked "what's my background?", so the filename beats nothing.
      store.set('avatarBackgroundCaption', path.basename(filePath));
      pushAvatarBackground(svg);
      return { ok: true, svg, name: path.basename(filePath) };
    } catch (err) {
      console.warn('[electron] Background image import failed:', err.message);
      return { ok: false, error: err.message };
    }
  });

  // Emoji graphics (#316) for the PANEL's avatar. Read here rather than in
  // preload-panel: that preload is sandboxed, so its `require` can't reach a
  // local module. Returns a data URI, or null for the 'native' set / an emoji
  // the set doesn't ship — the panel then draws the OS glyph.
  ipcMain.handle('emoji-data-uri', (_event, setName, emoji) => {
    try { return require('./emoji-assets.js').dataUriFor(setName, emoji, __dirname); } catch { return null; }
  });

  // The panel draws its own avatar, so it needs the same font bytes the Meet
  // page gets. Returned as a Buffer; the preload hands the renderer an
  // ArrayBuffer for FontFace.
  ipcMain.handle('emoji-font-bytes', (_event, setName) => {
    try { return require('./emoji-assets.js').fontBytesFor(setName, __dirname); } catch { return null; }
  });

  ipcMain.handle('emoji-dir-uri', (_event, dir, emoji) => {
    try { return require('./emoji-assets.js').externalDataUri(dir, emoji); } catch { return null; }
  });

  // The panel measured itself → resize the window to fit (plus the bot's-view
  // region while in a call). See applyWindowHeight.
  ipcMain.on('panel-content-height', (event, h) => {
    // Only the panel inside the main window may size that window. Every pop-out
    // (troubleshooting, 🧠 brain) loads the SAME panel.html, so each one has this
    // channel and reports its own content height — and the brain window, being
    // tall, resized the main window and left a large empty band under the avatar.
    //
    // The renderer guards this too, but the guard has to be repeated in every new
    // pop-out and was missed once already. Checking the SENDER here cannot be
    // forgotten by a future window, because the check does not live in it.
    if (!panelView || panelView.webContents.isDestroyed()
      || event.sender !== panelView.webContents) return;
    const n = Math.round(Number(h) || 0);
    if (!n || n === panelContentHeight) return;
    panelContentHeight = n;
    applyWindowHeight();
  });

  // Troubleshooting in its OWN window. Deliberately not setPanelPoppedOut: that
  // re-parents the one and only panelView, so the main window is left with no
  // panel and falls back to a full-size Meet view. A BrowserView can't be in two
  // windows, so the only way to keep the panel put is a second webContents —
  // this window loads the SAME panel.html with ?screen=troubleshooting, and
  // panel.js shows just that screen.
  //
  // Being a separate webContents is also what keeps it quiet: every
  // panelView.webContents.send(...) broadcast goes to the panel, not here, so
  // there are no duplicate prompts or state handlers. Only this window's own
  // OUTBOUND calls need suppressing — see IS_TROUBLESHOOTING_WINDOW.
  // #242: the brain pane — a read-only window onto the agent's activity feed.
  //
  // Its own window, like the troubleshooting one and for the same reason: you
  // watch it WHILE a call runs, so it has to sit beside the Meet window rather
  // than replacing the panel. Same panel.html with ?screen=brain, so it is a
  // second webContents — which also means the panel's broadcasts do not reach
  // it, and it polls get-call-state instead (see the curl-helper bug, #…, for
  // what happens when something in one of these windows relies on a broadcast).
  function openBrainWindow() {
    if (brainWindow && !brainWindow.isDestroyed()) {
      brainWindow.show();
      brainWindow.focus();
      return { ok: true };
    }
    const win = new BrowserWindow({
      width: 620,
      height: 780,
      title: windowTitle('Brain'),
      icon: path.join(__dirname, 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload-panel.js'),
        contextIsolation: true,
        backgroundThrottling: false, // a live feed must not freeze when unfocused
      },
    });
    brainWindow = win;
    win.on('closed', () => { brainWindow = null; focusMainWindow(); });
    win.loadFile(path.join(__dirname, 'renderer', 'panel.html'), { search: 'screen=brain' });
    return { ok: true };
  }
  ipcMain.handle('open-brain-window', () => openBrainWindow());
  openBrainWindowRef = openBrainWindow;

  function openTroubleshootingWindow() {
    if (troubleshootingWindow && !troubleshootingWindow.isDestroyed()) {
      troubleshootingWindow.show();
      troubleshootingWindow.focus();
      return { ok: true };
    }
    const win = new BrowserWindow({
      // Two columns (#…): wide enough for both without either being a slot.
      // The CSS collapses back to one column below 720px, so a user who resizes
      // this narrow gets a single readable column rather than clipped content.
      width: 980,
      height: 860,
      minWidth: 420,
      title: windowTitle('Troubleshooting'),
      icon: path.join(__dirname, 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload-panel.js'),
        contextIsolation: true,
        backgroundThrottling: false, // a live call-state view must not freeze
      },
    });
    troubleshootingWindow = win;
    win.on('closed', () => { troubleshootingWindow = null; focusMainWindow(); });
    win.loadFile(path.join(__dirname, 'renderer', 'panel.html'), { search: 'screen=troubleshooting' });
    return { ok: true };
  }
  ipcMain.handle('open-troubleshooting-window', () => openTroubleshootingWindow());
  openTroubleshootingWindowRef = openTroubleshootingWindow;

  // The bot's live face, straight from the virtual camera's render loop, relayed
  // to the panel so its avatar shows the SAME expression the call sees.
  ipcMain.on('avatar-emoji-changed', (_event, emoji) => {
    if (typeof emoji !== 'string' || !emoji) return;
    broadcastToRenderers('avatar-emoji', { emoji });
  });

  // The panel needs to know whether it must provide its own drag handle.
  ipcMain.handle('get-window-chrome', () => ({
    // 'mac' | null. Still carries the platform rather than a boolean because
    // the panel's CSS keys off it, and because Windows wore a 'win' variant
    // until it went back to a standard frame (titleBarOptions) — the shape is
    // ready if another platform ever needs floating controls again.
    hiddenTitleBar: hasHiddenTitleBar() ? 'mac' : null,
    // The raw platform, for UI that is OS-specific rather than chrome-specific
    // (the "Download more macOS voices…" link). hiddenTitleBar can't stand in
    // for this: it is null whenever the window wears a normal frame, on every
    // platform, so it says nothing about which OS we're on.
    platform: process.platform,
  }));

  // Can this bot actually make a sound, and with what? The panel's warning
  // banner keys off this rather than off the presence of an ElevenLabs key,
  // which is a different question — see electron-app/voice-status.js.
  ipcMain.handle('get-voice-status', () => currentVoiceStatus());

  // #273: last grant fetched from the server, for Settings/onboarding to
  // compare against the current key (see the note above applyGrant — the
  // decision is derived fresh from that comparison, not from stored history).
  ipcMain.handle('get-tts-grant', () => ({ grant: ttsGrant }));

  // Apply it as the server-owned key. Used both for the manual "use it"/
  // "switch" button (rule 1) and the fillIfEmpty auto-apply on pane display
  // (rule 2) — same action either way, just a different trigger.
  ipcMain.handle('accept-tts-grant', () => {
    if (!ttsGrant?.granted || !ttsGrant?.apiKey) return { ok: false };
    applyGrant(ttsGrant);
    return { ok: true };
  });

  // #137: the panel's sign-in indicator. Returns the CACHE immediately and, when
  // asked, refreshes behind it — so the panel paints instantly and corrects
  // itself a moment later rather than blocking on a login shell.
  ipcMain.handle('get-claude-auth-status', (_e, { refresh = false } = {}) => {
    if (refresh) {
      refreshClaudeAuth({ maxAgeMs: CLAUDE_AUTH_FOCUS_MAX_AGE_MS }).catch(() => {});
    }
    return claudeAuthState;
  });

  ipcMain.handle('create-and-join-meet', async (_e, opts) => createAndJoinMeet(opts || {}));

  // `description` is served from package.json so the About window renders the
  // product line rather than carrying its own copy of it. One source of truth:
  // editing the manifest updates the About box, and there is no second string
  // to forget. (Electron has no app.getDescription(), hence the require.)
  ipcMain.handle('get-app-version', () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    description: require('./package.json').description || '',
  }));

  // ── First-run setup wizard IPC (onboarding:*) ─────────────────────────────
  ipcMain.handle('onboarding:get-permissions', async () => {
    const flow = require('./onboarding-flow.js');
    // Only ask the OS about permissions this OS can actually answer — querying
    // the rest fails outright (osascript on Windows), which would render as a
    // row the user can't act on.
    const wanted = new Set(flow.permissionsFor(process.platform).map((p) => p.key));
    const statusMap = {};
    // Automation is the odd one out: there is no way to READ its status without
    // sending an Apple Event, and sending one is what raises the prompt. So
    // merely opening this step used to prompt, before the user pressed anything.
    // Until the first probe, report it unknown — that renders the Grant button,
    // and pressing Grant does the probe. Afterwards the status is free to read.
    if (wanted.has('automation')) {
      statusMap.automation = store.get('automationProbed') ? await probeBrowserAutomation() : undefined;
    }
    return flow.permissionsSummary(statusMap);
  });

  // Leaving the Claude step without Claude Code. Returns true to proceed.
  // Deliberately NOT a blocker: someone may be driving the bot with a different
  // agent, and this wizard has no way to know that. It states the consequence
  // and defaults to the safe button; it doesn't refuse.
  ipcMain.handle('onboarding:confirm-skip-claude', async (_e, { installed = false } = {}) => {
    const { dialog } = require('electron');
    const detail = installed
      ? 'Claude Code is installed but not signed in yet, so it can\'t drive the bot. '
        + 'You can sign in later — the app won\'t be able to join a call until you do.'
      : 'The app hosts a bot; an agent is what actually drives it. Without Claude Code '
        + '(or another agent you plan to point at it), nothing will happen when you try '
        + 'to start a call.';
    const parent = onboardingWindow && !onboardingWindow.isDestroyed() ? onboardingWindow : mainWindow;
    const { response } = await dialog.showMessageBox(parent, {
      type: 'warning',
      message: 'Continue without Claude Code?',
      detail: `${detail}\n\nYou can re-run this setup any time from the app menu.`,
      buttons: ['Go Back', 'Continue Anyway'],
      defaultId: 0,
      cancelId: 0,
    });
    return response === 1;
  });

  ipcMain.handle('onboarding:request-permission', async (_e, key) => {
    try {
      if (key === 'automation') {
        try { store.set('automationProbed', true); } catch { /* ignore */ }
        await probeBrowserAutomation();
      }
    } catch (err) { console.warn('[onboarding] request-permission', key, err && err.message); }
    return { ok: true };
  });

  ipcMain.handle('onboarding:open-system-settings', (_e, key) => {
    const pane = {
      automation: 'Privacy_Automation',
    }[key] || 'Privacy';
    shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
    return { ok: true };
  });

  ipcMain.handle('onboarding:open-url', (_e, url) => {
    if (/^https?:\/\//.test(String(url || ''))) shell.openExternal(String(url));
    return { ok: true };
  });

  // A name to pre-fill the wizard's field with (#187). Generated HERE rather than
  // in the renderer so two profiles being set up at once can't be handed the same
  // one — and so the "already taken" list is the real one.
  ipcMain.handle('onboarding:suggest-bot-name', (_event, { exclude = [], count = 1 } = {}) => {
    const { randomBotName } = require('./bot-names.js');
    let taken = [];
    try {
      taken = profileManager.listProfiles(PROFILES_ROOT)
        .map((p) => p && (p.botName || p.name))
        .filter(Boolean);
    } catch { /* first run, or unreadable — a possible duplicate beats no name */ }
    // `exclude` carries what is already in the field. Without it a fresh
    // suggestion could hand back the name it was just asked to replace, which
    // reads as a broken control rather than a 1-in-345 coincidence.
    const avoid = [...taken, ...(Array.isArray(exclude) ? exclude : [])];

    // `count` feeds the wizard's spinner: it cycles names locally at ~10/sec, and
    // asking main for each one would mean an IPC round trip per frame. One batch
    // is fetched per spin instead.
    const n = Math.max(1, Math.min(200, Number(count) || 1));
    const names = [];
    for (let i = 0; i < n; i++) {
      // Avoid what's already showing AND what this batch has used, so a spin
      // never stutters by repeating a name back-to-back.
      names.push(randomBotName({ taken: [...avoid, ...names] }));
    }
    return { name: names[0], names };
  });

  ipcMain.handle('onboarding:finish', () => {
    try { store.set('onboardingComplete', true); } catch { /* ignore */ }
    if (onboardingWindow && !onboardingWindow.isDestroyed()) onboardingWindow.close();
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
    runDeferredStarts();
    return { ok: true };
  });

  // ── Claude Code step (install + sign-in via the /claude-ready feedback loop) ──
  ipcMain.handle('onboarding:claude-status', async () => {
    let installed = false;
    try { installed = (await require('./claude-install.js').detectClaude()).installed; } catch { /* noop */ }
    return { installed, ready: claudeReady };
  });
  ipcMain.handle('onboarding:install-claude', () => {
    // Open Terminal running the official installer (visible — the wizard is the consent).
    const cmd = require('./claude-install.js').installCommandFor();
    const script = `tell application "Terminal"\n  activate\n  do script "${cmd}"\nend tell`;
    require('child_process').execFile('osascript', ['-e', script], () => {});
    return { ok: true };
  });
  ipcMain.handle('onboarding:copy-install-command', () => {
    require('electron').clipboard.writeText(require('./claude-install.js').installCommandFor());
    return { ok: true };
  });
  // ── Chat with the bot in a terminal (#500 follow-up) ──
  //
  // The bot keeps ONE Claude session named after itself, so the session it uses
  // on calls is the same one a person can open at a prompt. All that stands
  // between them is knowing to cd into a directory buried under Application
  // Support and that --resume takes the bot's name. These two handlers remove
  // that, from the panel's Call button held under Option.
  //
  // Both build the SAME string, so what the button runs and what the clipboard
  // hands you cannot drift.
  function chatCommandForBot() {
    const claudeDir = store.get('claudeWorkDir') || ensureAgentWorkdir();
    const sessionField = store.get('agentSession');
    const botName = resolvedBotName();
    const { resolveSessionRef } = require('./agent-session.js');
    const ref = resolveSessionRef(sessionField, botName);
    return require('./chat-command.js').buildChatCommand({
      workdir: claudeDir,
      sessionField,
      botName,
      cachedSessionId: ref.kind === 'name' ? cachedResumeSessionId(claudeDir, ref.name) : '',
    });
  }

  ipcMain.handle('chat-session:command', () => ({ ok: true, command: chatCommandForBot() }));

  ipcMain.handle('chat-session:copy', () => {
    const command = chatCommandForBot();
    require('electron').clipboard.writeText(command);
    return { ok: true, command };
  });

  ipcMain.handle('chat-session:open', () => {
    const command = chatCommandForBot();
    // Linux has no osascript. #329 already solved "which of the dozen terminal
    // emulators is installed" (and tmux) for hosting the agent; reuse it rather
    // than growing a second, worse copy of that logic here.
    if (process.platform === 'linux') {
      try {
        const lt = require('./linux-terminal.js');
        const exists = (bin) => {
          try {
            require('child_process').execFileSync('which', [bin], { stdio: 'ignore' });
            return true;
          } catch { return false; }
        };
        const emulator = lt.detectTerminalEmulator({ exists });
        if (emulator) {
          // The whole thing goes through a login shell: `command` is a compound
          // `cd … && claude`, not a single argv, and -lc also gives it the PATH
          // a GUI-launched process does not inherit.
          const plan = lt.buildDirectCommand({ emulator, argv: ['sh', '-lc', command] });
          require('child_process').spawn(plan.command, plan.args, { detached: true, stdio: 'ignore' }).unref();
          return { ok: true, command };
        }
      } catch (err) {
        console.warn('[chat-session] linux terminal launch failed:', err.message);
      }
      // Fall through to the clipboard, which is the honest outcome when we
      // cannot find a terminal to drive.
      require('electron').clipboard.writeText(command);
      return { ok: false, copied: true, command, reason: 'no-terminal' };
    }
    if (process.platform !== 'darwin') {
      // Windows: PowerShell vs the old console vs WSL are genuinely different
      // commands, and a wrong guess opens a terminal that immediately fails in
      // front of the user. Copying is the honest thing until someone asks.
      require('electron').clipboard.writeText(command);
      return { ok: false, copied: true, command, reason: 'unsupported-platform' };
    }
    // The command is in SHELL form (chat-command.js), so it needs the
    // AppleScript quoting layer put back on for `do script "…"`.
    const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = require('./launch-command.js').buildTerminalLaunchScript(escaped);
    require('child_process').execFile('osascript', ['-e', script], (err) => {
      if (err) {
        // Same recovery as the agent launcher: if Terminal will not play, the
        // user still gets the command rather than nothing.
        console.warn('[chat-session] osascript failed:', err.message);
        try { require('electron').clipboard.writeText(command); } catch { /* noop */ }
      }
    });
    return { ok: true, command };
  });

  ipcMain.handle('onboarding:verify-claude', () => {
    // Launch a Claude session in the agent dir (which carries the /claude-ready SessionStart
    // hook), so signing in + starting a session flips readiness. Same Terminal path as a call.
    const claudeDir = store.get('claudeWorkDir') || ensureAgentWorkdir();
    ensureClaudeReadyHook(claudeDir, localServer.port);
    const cmd = require('./launch-command.js').buildTerminalCommand({ workdir: claudeDir, innerCmd: 'claude' });
    const script = `tell application "Terminal"\n  activate\n  do script "${cmd}"\nend tell`;
    require('child_process').execFile('osascript', ['-e', script], () => {});
    return { ok: true };
  });
  // Silent auto-verify: when the user lands on the Claude step and `claude` is installed
  // but not yet confirmed, run a headless `claude -p "ok"` and judge by its RESULT — a
  // non-empty reply with exit 0 proves it's installed AND signed in, so we markClaudeReady
  // and the step turns green with no click and no visible Terminal. If they're not signed
  // in (or it hangs), it errors / times out, stays amber, and "Sign in & verify" remains
  // for the interactive /login.
  //
  // Deliberately NOT run in the agent dir: that dir carries the SessionStart hook, which
  // fires on session *start* — possibly before the auth check — so it could false-green a
  // signed-out user. A throwaway probe dir (no hook) makes the command's exit code the sole
  // signal. The login shell (`-lc`) gives it the user's real PATH (the GUI app's is minimal).
  // Runs at most once per app launch.
  let claudeAutoVerifyRan = false;
  ipcMain.handle('onboarding:auto-verify-claude', async () => {
    if (claudeReady || claudeAutoVerifyRan) return { started: false, ready: claudeReady };
    let installed = false;
    try { installed = (await require('./claude-install.js').detectClaude()).installed; } catch { /* noop */ }
    if (!installed) return { started: false, ready: false };
    claudeAutoVerifyRan = true;
    const os = require('os');
    let probeDir;
    try { probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-claude-probe-')); }
    catch { probeDir = os.tmpdir(); }
    const shell = process.env.SHELL || '/bin/zsh';
    try {
      require('child_process').execFile(
        shell, ['-lc', 'claude -p "ok" < /dev/null'],
        { cwd: probeDir, timeout: 30000, maxBuffer: 1 << 20 },
        (err, stdout) => {
          try { if (probeDir !== os.tmpdir()) fs.rmSync(probeDir, { recursive: true, force: true }); } catch { /* noop */ }
          if (!err && String(stdout || '').trim()) markClaudeReady('auto-verify');
          else console.log('[electron] auto-verify: claude not confirmed signed in (leaving amber)');
        },
      );
    } catch (err) { console.warn('[electron] auto-verify-claude spawn failed:', err.message); }
    return { started: true, ready: false };
  });

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
  // bot2, bot3, … — the first free one.
  //
  // Numbered rather than "Untitled": these are directory names, so they must
  // survive [A-Za-z0-9._-] and be short enough to read in a window title. The
  // default profile keeps its own name, so counting starts at 2 the way Chrome's
  // "Person 2" does.
  //
  // Picks the first GAP, not max+1: deleting bot3 and adding a bot should reuse
  // bot3 rather than creep to bot4 forever. Bounded so a pathological profile
  // list cannot spin.
  function nextBotProfileName() {
    const taken = new Set(profileManager.listProfiles(PROFILES_ROOT).map((p) => String(p.name).toLowerCase()));
    for (let i = 2; i < 1000; i++) {
      const candidate = `bot${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `bot${Date.now()}`; // absurd, but never collides
  }

  // Give the new bot an actual NAME, not just a directory.
  //
  // "bot3" is a folder, and without this the bot would introduce itself as
  // "Unnamed bot" — a worse first impression than any random name, and one the
  // user then has to fix before the thing is usable. Drawn from the same pool
  // the spinner uses, so a new bot arrives as Pepper or Twiki and can be renamed
  // on the Settings page it opens on, or in the guided setup call.
  //
  // Written to the profile's config BEFORE launch rather than passed as
  // --bot-name: a launch flag is an override with its own provenance tag
  // ("Alice [launch name]") that does not persist, and this needs to be the
  // bot's real, stored name.
  //
  // Names already in use are excluded, so two bots on one machine don't collide
  // — which would make MCP routing by name ambiguous, not just confusing.
  //
  // `adopt` (optional) turns this into ADOPTING AN EXISTING SESSION rather than
  // creating a blank bot: { workdir, session, botName }. A power user may have a
  // Claude session with months of accumulated context, and the interesting move
  // is to give THAT a face rather than start a bot from nothing. Seeding
  // claudeWorkDir + agentSession here is what makes the new profile resume that
  // session instead of opening a fresh one in its own agent dir.
  //
  // Seeded at creation for the same reason the name is: these have to be the
  // bot's real stored settings before its first launch, not launch-time
  // overrides. The bot's very first act is resuming the session, so there is no
  // later moment to apply them.
  function seedNewBotName(profileName, adopt = null) {
    try {
      const { randomBotName } = require('./bot-names.js');
      const taken = takenBotNames();
      // The AGENT dir, not the profile dir. The per-profile store has lived at
      // <profile>/agent/config.json since #305 (the agent's working directory
      // has to be a trusted Claude workspace, and the config moved in with it).
      // Seeding the pre-#305 loose path still WORKED — verified — but only
      // because the legacy migration copies it across on first launch, and that
      // migration exists to rescue old installs, not to be load-bearing for new
      // ones. Someone will delete it one day and new bots would quietly go back
      // to "Unnamed bot".
      //
      // It also left a second config.json that LOOKS authoritative and holds the
      // original name forever: bot8 read "Diego" long after being renamed
      // Taylor, which cost a real debugging detour.
      const dir = require('./agent-workdir.js').agentDirFor(path.join(PROFILES_ROOT, profileName));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'config.json');
      // Never clobber: a reused directory name (first-gap allocation) might
      // still hold a config the user cares about.
      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { /* new */ }
      if (existing.botName) return;
      // An adopted session names itself where it can. The session's own name is
      // the user's word for this thing already, so it beats a random one — but
      // only if it can survive a call, which is a real constraint and not a
      // stylistic one: the bot has to notice its name through Meet's captions.
      // "pr-482-refactor" fails that badly (digits nobody says aloud), so it
      // falls back to the random pool rather than shipping a name that cannot
      // be addressed.
      const { isAddressableBotName } = require('./addressable-name.js');
      const adopted = adopt && isAddressableBotName(adopt.botName) ? adopt.botName.trim() : null;
      const botName = adopted || randomBotName({ taken });
      // onboardingCallComplete defaults to true (preferences-schema.js) so
      // pre-existing profiles read as already onboarded with no migration
      // needed — which means a genuinely NEW bot has to say otherwise
      // explicitly, right here, at the one moment it's actually created.
      const seeded = { ...existing, botName, onboardingCallComplete: false };
      if (adopt && adopt.workdir) seeded.claudeWorkDir = adopt.workdir;
      if (adopt && adopt.session) seeded.agentSession = adopt.session;
      fs.writeFileSync(file, JSON.stringify(seeded, null, 2));
      console.log('[electron] New bot', profileName, 'named', botName,
        adopt ? `(adopting session ${JSON.stringify(adopt.session)} in ${adopt.workdir})` : '');
    } catch (err) {
      // Non-fatal: an unnamed bot is still a working bot, and the Settings page
      // it opens on is exactly where that gets fixed.
      console.warn('[electron] could not seed a name for', profileName, '—', err.message);
    }
  }

  async function launchOrFocusProfile(name, { openSettings = false } = {}) {
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
    // A newly created bot lands on Settings rather than "Call now" — it has no
    // name, voice or face yet, so that page IS its next step.
    if (openSettings) args = [...args, '--open-settings=true'];

    // #379: open the new profile window where THIS one is, not centered. The main
    // window honors --window-x/y (createMainWindow, as the test launcher uses),
    // so forward just the current window's position. Default + named.
    //
    // POSITION ONLY. Size isn't ours to hand over: the window is a fixed-width
    // column with a content-derived height, and createMainWindow ignores
    // --window-w/-h for exactly that reason.
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const b = mainWindow.getBounds();
        args = [...args, `--window-x=${b.x}`, `--window-y=${b.y}`];
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
  launchOrFocusProfileRef = launchOrFocusProfile;

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

  // "New bot" — no prompt. Chrome's model: creating a profile is one click, and
  // naming it comes later (or never).
  //
  // The prompt this replaces dates from when the profile DIRECTORY was the bot's
  // name, so it had to be chosen up front. It isn't any more: the bot's name is
  // the botName preference, set on the Settings page or in the guided setup call.
  // Asking for a directory name and calling it "New bot name" made people name
  // the bot twice, the first time in a field that only accepts [A-Za-z0-9._-].
  //
  // Opens the new bot in its OWN window on its Settings screen, so the next step
  // is right there: name it, or press the guided-setup call at the top.
  ipcMain.handle('create-new-bot', async () => {
    const name = nextBotProfileName();
    seedNewBotName(name);
    return await launchOrFocusProfile(name, { openSettings: true });
  });

  // Turn an EXISTING Claude session into a bot.
  //
  // The ordinary path creates a blank bot which then starts a fresh session. A
  // power user may already have a session carrying months of context on some
  // piece of work, and the far more interesting move is to give THAT a face —
  // it can already answer questions about the thing it has been doing.
  //
  // Mechanically this is create-new-bot with two settings seeded before first
  // launch, so the new profile resumes that session in that directory instead
  // of opening its own. It has to happen at creation: the bot's first act IS
  // resuming, so there is no later moment to apply them.
  //
  // The session's own name becomes the bot's name when it can survive being
  // said out loud (see addressable-name.js) — it is the user's existing word
  // for this thing, so it beats a random one. When it cannot, the random pool
  // takes over rather than shipping a bot that never answers to itself.
  adoptSessionAsBot = async ({ workdir, session, botName } = {}) => {
    const dir = String(workdir || '').trim();
    if (!dir) return { ok: false, error: 'A working directory is required — that is where the session lives.' };
    if (!fs.existsSync(dir)) return { ok: false, error: `No such directory: ${dir}` };
    // Sessions are stored PER WORKING DIRECTORY, so the pair is the identity —
    // a session name means nothing without the directory it was recorded in.
    const { resolveSessionName } = require('./agent-session.js');
    const sessionRef = resolveSessionName(session) || '';
    const name = nextBotProfileName();
    seedNewBotName(name, { workdir: dir, session: sessionRef, botName });
    const result = await launchOrFocusProfile(name, { openSettings: true });
    return { ...result, profile: name, adopted: { workdir: dir, session: sessionRef } };
  };
  ipcMain.handle('adopt-session-as-bot', async (_event, args) => adoptSessionAsBot(args));

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
    setBotViewState(botViewLayout.nextState(botViewState, { restingState: restingBotViewState() }));
    return { state: botViewState, resting: restingBotViewState() };
  });
  ipcMain.handle('get-bot-view', () => ({ state: botViewState, visible: botViewInCall, resting: restingBotViewState() }));

  // --- Share window visibility ---
  // Hidden by default; the panel offers a toggle for when you need to drive the
  // board by hand (or just see what the room is seeing).
  ipcMain.handle('get-share-window', () => {
    const exists = !!(whiteboardWindow && !whiteboardWindow.isDestroyed());
    return {
      exists,
      visible: exists && shareWindowVisible,
      // Capture is always frame-based, so hiding the window never blacks out
      // a live share.
      lockedVisible: false,
    };
  });

  ipcMain.handle('toggle-share-window', () => {
    if (!whiteboardWindow || whiteboardWindow.isDestroyed()) {
      return { ok: false, error: 'Nothing is being shared' };
    }
    const want = !shareWindowVisible;
    shareWindowVisible = want;
    try { store.set('shareWindowVisible', want); } catch { /* non-fatal */ }
    try {
      if (want) whiteboardWindow.showInactive();
      else whiteboardWindow.hide();
    } catch (err) {
      return { ok: false, error: err.message };
    }
    console.log('[electron] Share window', want ? 'shown' : 'hidden');
    broadcastShareWindowState();
    return { ok: true, visible: want };
  });


  // --- Auth check ---
  ipcMain.handle('check-auth', () => {
    return checkAuth();
  });

  // --- Meet window management ---
  // opts.onboardingCall runs the spawned agent through /onboarding-call instead
  // of /join-call — the guided setup, joining a call that already exists rather
  // than creating one.
  ipcMain.on('join-meet', (_event, meetUrl, opts) => {
    joinMeetUrl(meetUrl, { onboardingCall: !!(opts && opts.onboardingCall) });
  });

  ipcMain.on('open-external-url', (_event, url) => { openExternalUrl(url); });

  // Reply-to-teardown-command channel: finishCall() sends 'leave-requested' to
  // the panel, expecting this back, once the Meet-side leave has already
  // happened. NOT what the Leave Call button should send directly — see
  // 'leave-call-requested' below, which is the actual button-initiated leave.
  ipcMain.on('leave-meet', () => performLeaveTeardown('panel'));

  // The Leave Call button's own request to leave. Goes through the same
  // clean-leave sequence as the agent's leave_call tool (click Meet's real
  // Leave button, then teardown) instead of skipping straight to local
  // teardown — the bug where the panel showed "left" while the bot's view
  // stayed in the live Meet.
  ipcMain.on('leave-call-requested', () => requestCleanLeave('leave-call'));

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
    clearGiftedTtsKey(); // #273: a gift belongs to the account that's leaving
    broadcastAuthChanged();
    return { loggedOut: true };
  });

  // --- Meet identity (#170 / #282) ---
  // These IPCs let the panel sign the *bot* in to Google. Distinct from the
  // user's vibeconferencing.com login above — this is the Meet display
  // identity. Single partition now (#282): "guest vs signed-in" is decided by
  // whether the partition holds Google cookies, not by which partition is active.

  ipcMain.handle('get-meet-mode', async () => {
    // Tri-state collapses to a boolean here on purpose: this only REPORTS, so an
    // unknown read showing "guest" is a cosmetic under-claim, not a destructive
    // act. The tri-state matters at the one call site that deletes cookies.
    const signedIn = await isSignedInToGoogle(session.fromPartition(SESSION_PARTITION));
    return { partition: SESSION_PARTITION, mode: signedIn === true ? 'account' : 'guest' };
  });

  // Is this profile signed into Slack? Cookie-authoritative (the `d` session
  // cookie). We don't know WHICH workspace/user without the huddle DOM (#283),
  // so this is just connected-vs-not for the Slack row on the main panel.
  ipcMain.handle('get-slack-mode', async () => {
    const signedIn = await isSignedInToSlack(session.fromPartition(SESSION_PARTITION));
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
    const sess = session.fromPartition(SESSION_PARTITION);

    // AUTHORITATIVE signed-in check: the live cookie jar. Google's master-auth
    // cookies (domain=.google.com) are the ground truth — the bot auto-admitting
    // as a member proves they're present even when ListAccounts parsing fails.
    const signedIn = await isSignedInToGoogle(sess);
    // Reporting path — an unknown read reports "not signed in" (as it always
    // has). Nothing is deleted on this branch.
    if (signedIn !== true) return { signedIn: false, email: null };

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

    // The live DOM scan only works while the meetView is actually showing a
    // google.com page — most of the time (idle panel, not mid-call) it isn't,
    // so `email` comes back null even for a bot that's been signed in and
    // bound for weeks. Fall back to the persisted binding (chip-sourced when
    // it was set, see above) rather than reporting "signed in, but which
    // account?" every time the panel just happens to load off a Meet page.
    if (!email && store) {
      const bound = store.get('meetAccountEmail');
      if (bound) email = bound;
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

  // Advanced/power-user: point a browser surface at an arbitrary URL so the
  // operator can drive Slack or Google into a needed state (accept an invite,
  // switch workspace, finish a sign-in) inside the bot's OWN partition — the
  // same cookies the bot uses. Triggered by the "Navigate Webview…" menu item
  // (⌘⇧L) → panel prompt. Not exposed to the agent (operator-only).
  //
  // It navigates the SHARE window, not meetView. It used to be meetView, and
  // that made the command unusable during the only time anyone needs it: the
  // Meet view IS the call, so navigating it away hangs up. Someone reaching for
  // this mid-call to fix a Slack login would end the meeting instead.
  //
  // The share window works because it is created on SESSION_PARTITION — the
  // same partition as meetView, deliberately, so the shared surface inherits
  // the bot's credentials (see createWhiteboardWindow). One cookie jar: a login
  // completed here is live in the Meet view, which is the whole point of the
  // command. Nothing about the call is touched.
  ipcMain.handle('navigate-webview', (_event, rawUrl) => {
    // Prepend https:// when the user typed a bare host (a different explicit
    // scheme is still refused). See nav-url.js.
    const { normalizeNavUrl } = require('./nav-url.js');
    const norm = normalizeNavUrl(rawUrl);
    if (!norm.ok) return { ok: false, error: norm.error };
    const url = norm.url;
    if (!whiteboardWindow || whiteboardWindow.isDestroyed()) {
      // Same construction path onLoadUrl uses — createWhiteboardWindow loads
      // the URL itself, so there is no second loadURL below for this branch.
      whiteboardWindow = createWhiteboardWindow(url);
    } else {
      whiteboardWindow.loadURL(url);
    }
    if (!whiteboardWindow || whiteboardWindow.isDestroyed()) {
      return { ok: false, error: 'could not open the share window' };
    }
    console.log('[electron] navigate-webview →', url,
      localServer.sharing ? '(WHILE PRESENTING — visible to the room)' : '');
    // Show the result. The share window is normally hidden, so without this you
    // would drive it somewhere and have nothing to look at — seeing where the
    // browser landed IS the point of this command. showInactive, not show: it
    // must not steal focus from the URL prompt or, worse, from Meet mid-call.
    try { whiteboardWindow.showInactive(); } catch { /* ignore */ }
    return { ok: true, url, sharing: !!localServer.sharing };
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
    // ADDRESSED, not broadcast (#229): a COMMAND expecting exactly ONE reply.
    // Each recipient prompts and posts back a result for the same request id.
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
      const sess = session.fromPartition(SESSION_PARTITION);
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
      const sess = session.fromPartition(SESSION_PARTITION);
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
    // #209: begin call audio recording once the page is live (page-inject is
    // active by the time this fires) — a no-op unless recordCallAudio is on.
    startCallRecording(meetCode, botName);
  });

  // #209: audio chunks streamed from the page-world CallRecorder. Decode and
  // append to the active session's per-track file; drop silently if none.
  ipcMain.on('call-record-chunk', (_event, payload) => {
    if (!activeRecording || !payload) return;
    try {
      const buf = Buffer.from(payload.dataBase64 || '', 'base64');
      activeRecording.chunk(payload.track, payload.seq, buf, payload.mime, payload.startWallClock);
    } catch { /* skip a malformed chunk rather than kill the stream */ }
  });

  ipcMain.on('call-record-stopped', () => {
    stopCallRecording().catch((err) => console.warn('[call-record] stop via IPC failed:', err.message));
  });

  // The video control window's own Stop button — routes through the exact
  // same stopCallRecording() as start_recording/stop_recording
  // and the call-end teardown path, so everything (audio + video + any live
  // share capture) finalizes and merges together, not just this one window's
  // own capture. (The 'share' capture window has no UI/Stop button — it never
  // sends this; its lifecycle is entirely driven by the share itself.)
  ipcMain.on('frame-capture-stop-requested', () => {
    stopCallRecording().catch((err) => console.warn('[call-record] stop via control window failed:', err.message));
  });

  // The "Preparing recording…" merge-progress window's Cancel button (see
  // call-recording-merge-window.js). Registered once here rather than
  // per-call — activeMergeAbortController always reflects whichever merge
  // (if any) is currently running, so this just aborts that. A cancel click
  // arriving after the merge already finished (window closing races the
  // click) finds activeMergeAbortController already null — harmless no-op.
  ipcMain.on('merge-cancel-requested', () => {
    console.log('[call-record] merge cancelled by user');
    activeMergeAbortController?.abort();
  });

  // Chunks streamed from EITHER frame-capture window's renderer (the visible
  // 'video' one or the hidden 'share' one — see call-recording-window.js) —
  // same shape as call-record-chunk (below), tagged with which track they
  // belong to (and kind, matching the track name) so
  // CallRecordingSession/call-media-merge.js can tell video/share apart from
  // the audio tracks without guessing from the name.
  ipcMain.on('frame-capture-chunk', (_event, payload) => {
    if (!activeRecording || !payload || !payload.track) return;
    try {
      const buf = Buffer.from(payload.dataBase64 || '', 'base64');
      activeRecording.chunk(payload.track, payload.seq, buf, payload.mime, payload.startWallClock, payload.track);
    } catch { /* skip a malformed chunk rather than kill the stream */ }
  });

  ipcMain.on('frame-capture-error', (_event, payload) => {
    console.warn(`[call-record] frame capture window (${payload && payload.track}) reported an error:`, payload && payload.message);
  });

  // #209: track -> participant name, attributed live in the renderer.
  ipcMain.on('call-record-name', (_event, { track, name } = {}) => {
    if (activeRecording && track && name) activeRecording.setName(track, name);
  });

  // #209: speaker timeline (name + speaking + wall-clock) → speaker-events.jsonl,
  // the "who spoke when" source merge-call-audio.mjs annotates the audio with.
  ipcMain.on('call-record-speaker', (_event, { name, speaking, at } = {}) => {
    if (activeRecording && name) activeRecording.speakerEvent(name, speaking, at);
  });

  // --- Meet status updates (logged, DOM updated by preload) ---
  ipcMain.on(CALL_EVENTS.statusUpdate, (_event, status) => handleMeetStatusUpdate(status));

  // Named (not inline) so main-process code paths can raise a call-flow status
  // the same way the renderer does — #346's join-landed-somewhere-else needs
  // the whole 'Error:' fan-out (broadcastError, waiter resolution, room clear),
  // and re-deriving any of that at a second call site is how the two drift.
  function handleMeetStatusUpdate(status) {
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
        broadcastToRenderers('call-failed', { message: status });
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
        // #347: a guest is normally NOT auto-admitted, so this is the expected
        // resting place of a fallback join rather than a fault. Tell the
        // operator, because unlike "could not join" this is actionable by
        // somebody else: the host can admit the bot from their own client
        // without anyone touching its password. Only on the guest partition, or
        // this would fire on every ordinary lobby wait and become noise.
        if (activeMeetPartition === GUEST_PARTITION && !guestLobbyNotified) {
          guestLobbyNotified = true;
          const waiting = `${resolvedBotName() || 'The bot'} is waiting to be let into the call as a guest. `
            + 'Admit it from the meeting, or sign it back in to Google to fix this properly.';
          broadcastError(waiting);
          localServer.addError(waiting);
        }
      } else if (status.includes('Participating') || status.includes('In call')) {
        localServer.setCallStatus('in-call');
      } else if (status.includes('Joining')) {
        localServer.setCallStatus('joining');
      }
    }
  }

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
    broadcastShareWindowState();
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
    applyCaptionLanguagePref();
  });

  // #360: the renderer reports how far playback got when a stop-tts hit. Pair
  // the {id, chunk} tags with the registered chunk texts to compute exactly
  // which words the room heard and which it never did, and hand that to
  // local-server — the only component with a channel back to the agent.
  ipcMain.on('tts-stopped', (_event, p) => {
    const u = lastTtsUtterance;
    if (!u || !p) return;
    // The playing clip wasn't part of this utterance (e.g. a play_audio sound
    // clip) — no words were cut, nothing to report about the utterance.
    if (p.wasPlaying && (!p.tag || p.tag.id !== u.id)) return;
    const dropped = new Set((p.droppedTags || [])
      .filter((t) => t && t.id === u.id)
      .map((t) => t.chunk));
    const playingIdx = p.wasPlaying ? p.tag.chunk : null;
    const spokenParts = [];
    let cutTail = '';        // unheard remainder of the chunk that was playing (what a #350 resume would replay)
    const unspokenRest = []; // chunks the renderer never got to (never recoverable by a resume)
    let cutSeconds = null;
    for (let i = 0; i < u.parts.length; i++) {
      if (i === playingIdx) {
        const frac = p.duration > 0 ? p.playedTo / p.duration : 0;
        const { head, tail } = splitAtWordFraction(u.parts[i], frac);
        if (head) spokenParts.push(head);
        cutTail = tail;
        cutSeconds = Math.round(p.playedTo * 10) / 10;
      } else if (i >= u.sent || dropped.has(i)) {
        unspokenRest.push(u.parts[i]);
      } else {
        spokenParts.push(u.parts[i]);
      }
    }
    if (!cutTail && unspokenRest.length === 0) return; // everything had played — not a truncation
    try {
      localServer.noteSpeechTruncation({
        spoken: spokenParts.join(' '),
        unspokenTail: cutTail,
        unspokenRest: unspokenRest.join(' '),
        cutSeconds,
      });
    } catch (err) {
      console.warn('[electron] noteSpeechTruncation failed:', err.message);
    }
  });

  ipcMain.on(CALL_EVENTS.ttsEnded, () => {
    // #368: tts-ended = the audio queue fully drained, i.e. the bot is no longer
    // speaking aloud. This is the authoritative release for the speaking-aloud
    // latch — clear it FIRST, before any early-return below, so botState can
    // never get trapped in 'speaking' if the audio ends via an unusual path.
    localServer.speakingAloud = false;
    // #360: if a resumed utterance just played out, fold its recovered tail
    // back into the truncation record (or clear it entirely).
    localServer.noteSpeechPlaybackDrained();
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
    broadcastToRenderers('caption-feed', { turns });
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
    broadcastToRenderers('caption-state', { on: !!on });
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
    broadcastToRenderers('caption-state', { on: false });
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
    saveCapturedDom(info?.reason, info?.url, info?.html);
  });

  // #346: a join that ends up somewhere other than the meeting page. The
  // renderer classifies the landing (it is the only side that can see
  // window.location) and main decides whether it MATTERS, because only main
  // knows whether a join was in flight. Landing on Meet home or the bot-view
  // idle page is completely normal at rest and only means something went wrong
  // if we were mid-join — so the same event is silence in one state and a
  // hard failure in the other.
  ipcMain.on('meet-landing', async (_event, { landing, url } = {}) => {
    // 'navigating' is set the instant a join is requested; 'joining' once the
    // page starts driving Meet's pre-join. Anything else (idle, in-call,
    // after-call-work) means nobody was trying to join, so this is routine.
    const joinInFlight = localServer.callStatus === 'navigating' || localServer.callStatus === 'joining';
    if (!joinInFlight) {
      console.log(`[meet-landing] ${landing} at ${url} (no join in flight — ignoring)`);
      return;
    }

    // Grab the page for the record. This is the state we could never capture
    // before: captureDenialDom only ever fired from inside the pre-join loop,
    // which is downstream of the bail-out, so the one page most worth seeing
    // was invisible by construction.
    try {
      if (meetView && !meetView.webContents.isDestroyed()) {
        const html = await meetView.webContents.executeJavaScript('document.documentElement.outerHTML');
        saveCapturedDom(`join-landed-on-${landing}`, url, html);
      }
    } catch (err) {
      console.warn('[meet-landing] DOM capture failed:', err.message);
    }

    // The bot cannot announce any of this itself — it is not in the meeting, so
    // it has no voice and no chat. The app is the only one who can speak here.
    const botLabel = resolvedBotName() || 'the bot';
    console.error(`[meet-landing] join blocked: landed on ${landing} at ${url}`);

    if (landing === 'sign-in') {
      // Deliberately NOT torn down. A human can type the password and Google's
      // own `continue=` redirect carries this very view into the meeting, which
      // is exactly how the 2026-08-12 call was rescued. That recovery works
      // because the app is still holding the room with the agent alive behind
      // it, so running the full 'Error:' path here (clearRoom + resolve every
      // waiter) would break the one path that already works.
      //
      // broadcastError is the operator channel: panel error plus an OS
      // notification when the app isn't in the foreground. addError is the
      // agent channel, so it shows up in get_room_info / get_call_log too.

      // #347: don't just wait for a human who may not be there. Retry the same
      // meeting on the cookie-free guest partition, which is what a person
      // locked out of their account would do: join anyway as a guest and let
      // the host admit them. Showing up in the lobby is showing up.
      //
      // Once per join, keyed on the URL: if the guest attempt ALSO lands on a
      // sign-in page (it shouldn't, having no cookies to challenge) this must
      // not become a reload loop.
      if (currentMeetUrl && guestFallbackTriedFor !== currentMeetUrl) {
        guestFallbackTriedFor = currentMeetUrl;
        const message = `Google is asking ${botLabel} to confirm its identity, so it is joining as a guest instead. `
          + 'It may be waiting to be let in, so admit it from the meeting if you see it. '
          + "To fix this properly, open the bot's view and sign it back in to Google.";
        broadcastError(message);
        localServer.addError(message);
        loadMeetURL(currentMeetUrl, { guestFallback: true });
        return;
      }

      const message = `Google is asking ${botLabel} to confirm its identity, so it could not join the call. `
        + "Open the bot's view and sign it back in to Google, and it will join automatically once you do.";
      broadcastError(message);
      localServer.addError(message);
      return;
    }

    // Anything else is not going to fix itself, and leaving it is what produced
    // the original symptom: wedged at 'navigating' forever, looking like the
    // bot never tried. 'Error:' fans out to broadcastError, resolves the
    // agent's waiters so wait_for_speech doesn't hang to timeout, and clears
    // the room so the UI stops offering "leave call" for a call we never made.
    handleMeetStatusUpdate(`Error: ${botLabel} could not join the call. `
      + `The page ended up at ${url} instead of the meeting.`);
  });

  // --- Speaking state ---
  ipcMain.on(CALL_EVENTS.speakingChanged, (_event, { name, speaking }) => {
    if (name && sync.roomId) {
      updateSpeakingState(name, speaking);
    }
  });

  // --- Participant list + presenting state from preload-meet.js ---
  // #115: the analyser-based floor signal. Always recorded (so a real call
  // produces the DOM-vs-audio comparison the issue asks for); only consumed by
  // the turn-taking gates when fastFloorDetection is enabled.
  // #467: our own TTS envelope, forwarded from the Meet view. See
  // LocalServer.setSelfAudioLoud.
  ipcMain.on('self-audio', (_event, { loud, at }) => {
    localServer.setSelfAudioLoud(!!loud, at);
  });

  ipcMain.on('audio-floor', (_event, { speaking, at }) => {
    localServer.setAudioFloor(!!speaking, at);
  });

  ipcMain.on(CALL_EVENTS.participantsUpdated, (_event, participants) => {
    localServer.setParticipants(participants || []);
  });

  ipcMain.on(CALL_EVENTS.screenSharesUpdated, (_event, shares) => {
    localServer.setScreenShares(shares || []);
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
  ipcMain.on(CALL_EVENTS.selfPresenting, (_event, { presenting, reconcile }) => {
    const wasSharing = localServer.sharing;

    // #68: a reconcile tick carries no news — it re-states what is on screen so a
    // divergence introduced by another writer gets corrected. Meet's DOM is the
    // only thing that actually knows whether the room can see us, so it wins.
    //
    // Logged when it actually corrects something, because a silent correction
    // hides the bug it is papering over: a run of these means the stop click is
    // failing (#141's dialog is the known cause), and that is worth seeing.
    if (reconcile) {
      if (wasSharing !== !!presenting) {
        console.warn(`[share] state disagreed with Meet — app said sharing=${wasSharing}, `
          + `Meet says ${presenting}. Correcting to Meet.`);
        localServer.setSharing(!!presenting);
        announceSharing(!!presenting);
      }
      return;   // never run the edge-only side effects below
    }

    localServer.setSharing(presenting);
    announceSharing(!!presenting);
    if (!presenting) {
      externalShareRequest = null; // POC (share-agent-tab)
    }
  });

  // --- TTS config ---
  ipcMain.on('update-tts-config', (_event, config) => {
    tts.updateConfig(config);
    if ('apiKey' in config) {
      stt.updateConfig({ apiKey: config.apiKey });
      if (config.apiKey) {
        store.set('ttsApiKey', config.apiKey);
        // #273: typing/pasting here is always the person's OWN key — the gifted
        // path sets ttsApiKey through accept-tts-grant, not this handler. Mark
        // provenance so a later logout knows not to touch it.
        store.set('ttsApiKeySource', 'byo');
        // Test it NOW, not at the next startup. A key is pasted once and then
        // trusted forever, so a bad one is discovered later and somewhere else
        // entirely — "it won't let me pick an ElevenLabs voice", with nothing
        // pointing back at the key. Checking here puts the answer next to the
        // field the person is still looking at.
        //
        // Both failure modes matter and they need DIFFERENT advice:
        //   · the key is rejected outright (wrong/old format) — nothing works
        //   · the key is fine but lacks voices_read — speaking still works, only
        //     the voice LIST is unavailable, so a voice id must be set by hand
        verifyElevenLabsKey(config.apiKey, { announce: true });
      } else {
        store.delete('ttsApiKey');
        store.delete('ttsApiKeySource');
        elevenLabsKeyProblem = null;
        broadcastToRenderers('voice-status-changed');
      }
      // #273: whatever just happened to the key (pasted, cleared), tell any
      // open Settings/onboarding pane so its "use gifted key" offer reflects
      // the new value right away — a LIVE clear stays empty rather than
      // auto-refilling (see the note above applyGrant), it just becomes
      // offerable again immediately instead of waiting for the pane to
      // regain focus.
      broadcastToRenderers('tts-grant-changed');
    }
    if (config.voiceId) {
      store.set('ttsVoiceId', config.voiceId);
    }
    // The OS's built-in voice name (`say` on macOS, SAPI on Windows) — used
    // when no ElevenLabs key is set, and as the fallback voice when ElevenLabs
    // is unavailable (e.g. quota exhausted). The key kept its `macosVoice` name
    // so saved configs from before Windows support still load.
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

  // List the OS's built-in voices for the preferences dropdown — the exact
  // voices our built-in TTS path (tts._systemSay → `say -v Name` on macOS,
  // SAPI SelectVoice on Windows) can use. Returns { platform, voices }, where
  // voices is [{ name, locale, sample, tier }] quality-sorted (Premium >
  // Enhanced > plain), English first. The platform rides along so the picker
  // can name the group honestly ("Built-in (macOS)" vs "(Windows)") without a
  // second IPC round trip. Also refreshes the name set used by speak() routing.
  ipcMain.handle('list-system-voices', async () => {
    const voices = await enumerateSystemVoices();
    systemVoiceNameSet = new Set(voices.map((v) => v.name));
    return { platform: process.platform, voices };
  });

  // List the account's ElevenLabs voices for the unified voice picker (#340).
  // Optional apiKey arg lets the panel fetch with a just-typed key before it's
  // saved; falls back to the stored key.
  // Returns { voices: [{ id, name, category }], error: null | { kind, message } }
  // — the error is what lets the picker explain a key that's valid but lacks
  // the `voices_read` scope, instead of silently showing nothing.
  ipcMain.handle('list-elevenlabs-voices', async (_event, apiKey) => {
    return listElevenLabsVoices(apiKey);
  });

  // Audition a voice when it's picked in the preferences dropdown — ONE path for
  // every provider (the built-in OS voice, ElevenLabs, Voicebox). Synthesize a short sample
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
      // ElevenLabs returns mp3; the built-in voices (afconvert / SAPI) and Voicebox return WAV.
      const mime = opts.provider === 'elevenlabs' ? 'audio/mpeg' : 'audio/wav';
      return { ok: true, dataUrl: `data:${mime};base64,${Buffer.from(buf).toString('base64')}` };
    } catch (e) {
      console.warn('[voice-preview] synth failed:', e && e.message);
      return { ok: false, error: e && e.message };
    }
  });

  // Open the OS pane where users download additional system voices:
  // macOS   → System Settings → Accessibility → Spoken Content → System Voice
  // Windows → Settings → Time & Language → Speech (Manage voices)
  ipcMain.handle('open-voice-settings', () => {
    if (process.platform === 'darwin') {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.universalaccess?SpeechContent');
      return true;
    }
    if (process.platform === 'win32') {
      shell.openExternal('ms-settings:speech');
      return true;
    }
    return false;
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
    broadcastToRenderers('extension-message', message);
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
    const roomUrl = whiteboardShareUrl(baseUrl, meetCode);

    // Bump shareGeneration even when REUSING the existing window: it's the
    // signal onStopSharing's deferred close (see there) uses to detect "a
    // re-share landed while I was still finishing the previous stop" and
    // back off rather than closing the window out from under it.
    shareGeneration++;
    if (!whiteboardWindow || whiteboardWindow.isDestroyed()) {
      whiteboardWindow = createWhiteboardWindow(roomUrl);
    }

    console.log('[electron] Whiteboard window opened:', roomUrl);
  });

  // Combined: open whiteboard + trigger screen share in Meet
  ipcMain.handle('share-whiteboard', async (_event, { meetCode }) => {
    const baseUrl = getWebsiteUrl();
    const roomUrl = whiteboardShareUrl(baseUrl, meetCode);

    // Same reasoning as start-whiteboard-share above.
    shareGeneration++;
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

  // POC (share-agent-tab): share a specific external Chrome tab by URL. The
  // agent (which drives that tab via claude-in-chrome) passes the URL; we
  // activate the tab, resolve its window as a desktopCapturer source, stash it
  // in externalShareRequest, and trigger Meet's Present-now — the display-media
  // handler above then hands back that source. See share-external-tab.js.
  //
  // Still TODO for a real feature (see docs/share-agent-tab-poc.md): route the
  // 'share-tab' /api/sync action + list_windows through local-server to here,
  // and reuse the whiteboard-share Present-now retry loop.
  ipcMain.handle('share-external-tab', (_event, opts) => startExternalTabShare(opts));
}
