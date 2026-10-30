// preload-meet.js — Preload script for the Meet BrowserWindow.
// Runs with contextIsolation: false so it shares the page's world.
// This lets us patch getUserMedia BEFORE Meet's scripts run.

const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
// Present as current Chrome in navigator.userAgentData too, matching the
// string and headers main sets (#499: Google sign-in checks all three).
require('@vibeconferencing/calls/hosts/electron/slack-ua').installClientHintsShim();
// Research (dom-probe.js): --dom-probe=1 watches every participant tile. Off by
// default. Tagged [bots-in-calls] so the Meet view's console forwarder keeps it.
require('@vibeconferencing/calls/core/dom-probe').installDomProbe({ tag: '[bots-in-calls]', defaultSelector: '[data-participant-id]' });

// meetView runs with contextIsolation:false, so the preload and page share one
// window. Expose a tiny helper the idle screen uses to open a URL in the user's
// external browser (the "Start default testing meet" link).
try { window.vibeconfOpenExternal = (url) => ipcRenderer.send('open-external-url', url); } catch { /* window not ready */ }

// Auto-stamp every console line with HH:MM:SS.mmm BEFORE any other code runs,
// so [electron-meet] / [speaker-tracker] / [CC] / [bots-in-calls] lines all
// flow into the main process timeline with a wall-clock prefix. main.js's own
// console wrapper sees the prefix and skips re-stamping. Page-inject is eval'd
// into this same context (contextIsolation: false), so this single wrap
// covers both preload-meet AND page-inject log sites.
(function installTimestampedConsole() {
  const _ts = () => {
    const d = new Date();
    return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  };
  const TS_RE = /^\d{2}:\d{2}:\d{2}\.\d{3}$/;
  const wrap = (fn) => (...args) => {
    if (args.length && typeof args[0] === 'string' && TS_RE.test(args[0])) fn(...args);
    else fn(_ts(), ...args);
  };
  console.log = wrap(console.log.bind(console));
  console.warn = wrap(console.warn.bind(console));
  console.error = wrap(console.error.bind(console));
})();

// ---------------------------------------------------------------------------
// Inject page-inject.js IMMEDIATELY — before any page scripts execute.
// With contextIsolation: false, this runs in the page's JS context,
// so our getUserMedia override is in place when Meet's code loads.
// ---------------------------------------------------------------------------

// Inject page-inject.js IMMEDIATELY in preload — before any page scripts run.
// This ensures our getUserMedia override is in place when Meet requests media.
// With contextIsolation: false, this preload only runs in the Meet BrowserView,
// so no URL check is needed. Injecting at DOMContentLoaded was too late — Meet's
// scripts could call getUserMedia before that, getting a real mic stream instead
// of our VirtualMic, causing TTS audio to silently fail.
require('./page-scripts').injectPageScripts({ tag: '[electron-meet]' });

// P2 (Runway faces): load livekit-client (→ window.LivekitClient) + runway-avatar.js from
// ../extension. OPT-IN — runway-avatar.js stays idle until a {source:'runway-avatar'} message,
// so this never affects the default emoji bots. Wrapped so a failure can't disturb page-inject.
try {
  // Packaged: extension/ is bundled via extraResources → Resources/extension
  // (preload runs from inside app.asar, so __dirname/../extension wouldn't be a
  // real path). Source: it's the repo-root extension/ dir next to electron-app/.
  const extDir = __dirname.includes('.asar')
    ? path.join(process.resourcesPath, 'extension')
    : path.join(__dirname, '..', 'extension');
  (0, eval)(fs.readFileSync(path.join(extDir, 'livekit-client.umd.js'), 'utf-8'));
  (0, eval)(fs.readFileSync(path.join(extDir, 'runway-avatar.js'), 'utf-8'));
  console.log('[electron-meet] P2 runway-avatar.js + livekit-client loaded (idle until connect)');
} catch (err) {
  console.error('[electron-meet] P2 runway-avatar/livekit-client load failed (emoji bots unaffected):', err.message);
}


// P2: forward Runway-face control to runway-avatar.js (which listens for source:'runway-avatar').
ipcRenderer.on('runway-avatar', (_event, payload) => {
  window.postMessage({ source: 'runway-avatar', ...payload }, '*');
});

// P2 loss-recovery: runway-avatar.js posts {source:'runway-avatar-status', type:'lost'} on an
// unexpected room drop → tell main to re-establish the face for this seat.
window.addEventListener('message', (ev) => {
  const m = ev && ev.data;
  if (m && m.source === 'runway-avatar-status' && m.type === 'lost') ipcRenderer.send('runway-avatar-lost');
});

// ---------------------------------------------------------------------------
// Expose screen share helper to page context (for getDisplayMedia override)
// ---------------------------------------------------------------------------

window.__vibeconf_getScreenShareSource = async function () {
  return ipcRenderer.invoke('get-screen-share-source');
};

window.__vibeconf_startWhiteboardShare = function (meetCode) {
  ipcRenderer.send('start-whiteboard-share', { meetCode });
};

// ---------------------------------------------------------------------------
// All Meet automation lives in GoogleMeetProvider (the DOM trackers and the
// auto-join flow install when it's required). This preload is its host, as
// preload-zoom.js is ZoomProvider's: main's commands come in over IPC and
// become provider calls, and the provider's events go back out over IPC.
// ---------------------------------------------------------------------------
const { startGoogleMeet } = require('@vibeconferencing/calls/providers/google-meet-provider');
const { CALL_EVENTS, CALL_COMMANDS, CALL_BOOTSTRAP } = require('@vibeconferencing/calls/core/call-provider');

let statusIconUri = null; // the bot's own face (the Fluent 3D 🙂 the app and site use)
try { statusIconUri = require('./emoji-assets.js').dataUriForRelPath('fluent3d/1f642.png'); } catch { /* the plain glyph */ }

const meetProvider = startGoogleMeet({
  getBotName: () => ipcRenderer.invoke(CALL_BOOTSTRAP.getBotName),
  getMode: () => ipcRenderer.invoke(CALL_BOOTSTRAP.getMode),
  getConfig: (keys) => ipcRenderer.invoke(CALL_BOOTSTRAP.getConfig, keys),
  statusIconUri,
});
try { window.meetProvider = meetProvider; } catch { /* window not ready */ }

function emit(channel, ...args) {
  try { ipcRenderer.send(channel, ...args); } catch { /* main not listening */ }
}

// Provider → main: every event, on the channel of the same name.
for (const channel of Object.values(CALL_EVENTS)) {
  meetProvider.on(channel, (...args) => emit(channel, ...args));
}
// main starts the transcript sync when the bot is in (same payload).
meetProvider.on(CALL_EVENTS.botJoinedCall, (info) => emit('start-sync', info));

// ---------------------------------------------------------------------------
// main → provider. The call's own actions go to the provider; everything else
// on extension-message (realtime voice, the speech test, avatar state) is the
// page scripts', so it's forwarded into the page as on every platform.
// ---------------------------------------------------------------------------
const A = CALL_COMMANDS.ACTIONS;
function toPage(message) {
  window.postMessage({ __botsInCalls: true, __fromExtension: true, ...message }, '*');
}
ipcRenderer.on(CALL_COMMANDS.extensionMessage, (_event, message) => {
  if (!message) return;
  switch (message.action) {
    case A.playTts: meetProvider.speak(message.payload); break;
    case A.unmuteMic: meetProvider.setMicMuted(false); break;
    case A.muteMic: meetProvider.setMicMuted(true); break;
    case A.cameraOn: meetProvider.setCameraOn(true); break;
    case A.cameraOff: meetProvider.setCameraOn(false); break;
    case 'set-banner-prefix-visible':
      meetProvider.setBannerPrefixVisible(!!(message.payload && message.payload.visible));
      break;
    case 'start-realtime':
    case 'stop-realtime':
      // EXPERIMENT: realtime speech-to-speech. Only the short-lived ephemeral
      // secret crosses into the page; the API key stays in main.
      meetProvider.setRealtimeVoice(message.action === 'start-realtime', message.botName);
      toPage(message);
      break;
    default: toPage(message);
  }
});

ipcRenderer.on(CALL_COMMANDS.readChat, async (_event, { requestId }) => {
  let result;
  try { result = { ok: true, messages: await meetProvider.readChat() }; }
  catch (err) { result = { ok: false, error: err.message, reason: err.reason }; }
  emit(CALL_EVENTS.chatResult, { requestId, ...result });
});
ipcRenderer.on(CALL_COMMANDS.sendChat, async (_event, { requestId, text }) => {
  let result;
  try {
    const sent = await meetProvider.sendChat(text);
    result = sent ? { ok: true } : { ok: false, error: 'Message may not have sent (input not cleared)' };
  } catch (err) { result = { ok: false, error: err.message, reason: err.reason }; }
  emit(CALL_EVENTS.chatResult, { requestId, ...result });
});

ipcRenderer.on(CALL_COMMANDS.setStudioSound, (_event, payload) => { meetProvider.setStudioSound(!!(payload && payload.enabled)); });
// Reports the OUTCOME back, not just fire-and-forget: the agent needs to know
// whether the bot's hearing actually changed, and which tag Meet settled on.
ipcRenderer.on(CALL_COMMANDS.setCaptionLanguage, async (_event, payload) => {
  const requestId = payload && payload.requestId;
  let result;
  try {
    result = await meetProvider.setCaptionLanguage((payload && payload.language) || '');
  } catch (e) {
    result = { ok: false, error: e.message };
  }
  emit(CALL_EVENTS.captionLanguageResult, { requestId, ...(result || {}) });
});
// Main confirmed real deafness (caption stall WHILE a remote is speaking) and
// asks us to self-heal by rebuilding the caption region (#259).
ipcRenderer.on(CALL_COMMANDS.recoverCaptions, () => {
  try { meetProvider.recoverCaptions(); } catch (e) { console.warn('[caption-stall] recover handler failed: ' + e.message); }
});
ipcRenderer.on(CALL_COMMANDS.triggerScreenShare, (_event, options) => {
  meetProvider.startShare(options?.shareType || 'window');
});
ipcRenderer.on(CALL_COMMANDS.triggerStopSharing, () => { meetProvider.stopShare(); });
// Fired by main on hang-up, before it navigates the view away.
ipcRenderer.on('trigger-leave-call', () => { meetProvider.leave(); });

// Call recording (#209): the shared bridge carries start/stop and the tracks;
// Meet also clamps its banner to one line while a recording runs.
require('@vibeconferencing/calls/recording/preload-recording-bridge').installRecordingBridge(ipcRenderer, { tag: '[electron-meet]' });
ipcRenderer.on('trigger-record', (_event, { recording } = {}) => { meetProvider.setRecording(!!recording); });
// Speech-to-text tap → main, for hearing a call by transcribing its audio (#850).
// On Meet this runs alongside the captions, which makes it the test bed (#836).
require('@vibeconferencing/calls/hearing/preload-stt-bridge').installSttBridge(ipcRenderer);

// ---------------------------------------------------------------------------
// page scripts → main: the same relays every platform's preload makes.
// ---------------------------------------------------------------------------
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data?.__botsInCalls) return;
  const { action, payload } = event.data;
  if (action === 'tts-ended') {
    // After speaking, main puts the mic back in the mode's state.
    emit(CALL_EVENTS.ttsEnded);
  } else if (action === 'self-audio') {
    // #467: the barge-in grace runs in local-server, and without knowing when
    // our own audio was loud it cannot tell a room that went quiet from one it
    // merely stopped being able to hear.
    emit('self-audio', { loud: !!payload?.loud, at: payload?.at || Date.now() });
  } else if (action === 'audio-floor') {
    // #115: fast floor signal from the Web Audio analyser (~16ms), published
    // alongside the DOM path. Consumed only when fastFloorDetection is on.
    emit('audio-floor', { speaking: !!payload?.speaking, at: payload?.at || Date.now() });
  } else if (action === 'tts-stopped') {
    // #360: how far playback got when a barge-in stopped it.
    emit('tts-stopped', payload || {});
  } else if (action === 'log' && payload?.line) {
    emit('page-inject-log', payload.line);
  } else if (action === 'avatar-emoji' && payload?.emoji) {
    emit('avatar-emoji-changed', payload.emoji);
  } else if (action === 'transcript' && payload?.text && payload?.speaker) {
    emit('post-transcripts', [payload]);
  }
});

// EXPERIMENT: the realtime voice (RealtimeVoice in page-realtime-voice.js)
// asking to run a tool (main answers on realtime-tool-result), and its status,
// which is otherwise invisible: nobody has a bot's page console open.
window.addEventListener('message', (ev) => {
  const m = ev && ev.data;
  if (m && m.source === 'vibeconf-realtime-tool') emit('realtime-tool', { callId: m.callId, name: m.name, args: m.args });
  else if (m && m.source === 'vibeconf-realtime-status') emit('realtime-status', { type: m.type, detail: m.detail });
});
