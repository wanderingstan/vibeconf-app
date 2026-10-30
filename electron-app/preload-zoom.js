// preload-zoom.js — the preload for the Zoom web client view (#318).
//
// Zoom is a single surface like Meet: the bot loads app.zoom.us/wc/join/<n>
// directly, which renders the meeting top-level. So this one preload does what
// Slack splits across two: the media patch (page-inject.js: virtual mic + camera,
// TTS) AND the call (the library's zoom-session.js: ZoomProvider and its heartbeat).
// main.js's commands reach it as they reach preload-meet: meetView IS this view.
//
// Drive it live from this view's DevTools (contextIsolation:false):
//   zoomProvider.getParticipants()   zoomProvider.openParticipants()
//   zoomProvider.sendChat('hello')   zoomProvider.readChat()
//   zoomProvider.setMicMuted(false)  zoomProvider.setCameraOn(true)
//   zoomProvider.enableCaptions()    zoomProvider.leave()
//   zoomProvider.micLevel()          // footer VU meter, px (0 = silent)
//
// Hearing: the caption overlay (Show Captions), one ephemeral line attributed
// by the speaker's avatar → participants-list name. zoom-captions.js turns it
// into the caption-turns snapshots the app already ingests from Meet.

const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const { startZoom } = require('@vibeconferencing/calls/providers/zoom-session');
const { CALL_EVENTS, CALL_COMMANDS, CALL_BOOTSTRAP } = require('@vibeconferencing/calls/core/call-provider');
const { ZOOM } = require('@vibeconferencing/calls/providers/zoom-selectors');

// Match navigator.userAgentData to the spoofed Chrome UA (zoom-surface sets the
// UA string) before Zoom's scripts run, so its browser check sees Chrome.
require('@vibeconferencing/calls/hosts/electron/slack-ua').installClientHintsShim();

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

// Recon (#814): log where Zoom's call audio lives. Off unless
// VIBECONF_AUDIO_PROBE=1. Installed before page-inject and Zoom's scripts.
if (process.env.VIBECONF_AUDIO_PROBE === '1') require('@vibeconferencing/calls/core/audio-probe').installAudioProbe('[zoom]');
// Research (dom-probe.js): --dom-probe=1 watches participant rows and video
// tiles, where Zoom's speaking indicator is still unverified. Off by default.
require('@vibeconferencing/calls/core/dom-probe').installDomProbe({ tag: '[zoom]', defaultSelector: '.participants-li, .video-avatar__avatar, .speaker-active-container__wrap' });

// The RTCPeerConnection audio-capture hook is Meet-shaped and unused here (we
// don't read call audio); keep the getUserMedia virtual mic + play-tts path.
// Same call Slack made for Chime. Must be set before the eval below.
window.__vibeconf_disableAudioCapture = true;

// The media scripts (page-inject's core, then the app's avatar and realtime
// voice plugins), before any page script can ask for media. page-scripts.js.
require('./page-scripts').injectPageScripts({ tag: '[zoom]' });

window.__vibeconf_getScreenShareSource = async function () {
  return ipcRenderer.invoke('get-screen-share-source');
};

// Call recording: start/stop the page recorder and carry its tracks to main
// (#814). Without this a Zoom recording was silent video.
require('@vibeconferencing/calls/recording/preload-recording-bridge').installRecordingBridge(ipcRenderer, { tag: '[zoom]' });
// Speech-to-text tap → main, for hearing calls by transcribing their audio (#850).
require('@vibeconferencing/calls/hearing/preload-stt-bridge').installSttBridge(ipcRenderer);

// The call itself runs in the library (zoom-session.js): the pre-join, the
// heartbeat and the speaking poll. This preload is its host: main's commands
// become provider calls, and the provider's events go out over IPC.
const provider = startZoom({ getBotName: () => ipcRenderer.invoke(CALL_BOOTSTRAP.getBotName) });
try { window.zoomProvider = provider; window.ZOOM = ZOOM; } catch { /* window not ready */ }

function emit(channel, ...args) {
  try { ipcRenderer.send(channel, ...args); } catch { /* main not listening */ }
}
for (const channel of Object.values(CALL_EVENTS)) {
  provider.on(channel, (...args) => emit(channel, ...args));
}

// ---------------------------------------------------------------------------
// Commands main → this view. Mic/camera go to the provider; everything else
// (play-tts, play-speech-test, avatar state, chime) is a page-inject op, so
// forward it into the page, as preload-slack-main does.
// ---------------------------------------------------------------------------
ipcRenderer.on(CALL_COMMANDS.extensionMessage, (_e, message) => {
  if (!message) return;
  switch (message.action) {
    case CALL_COMMANDS.ACTIONS.unmuteMic: provider.setMicMuted(false); break;
    case CALL_COMMANDS.ACTIONS.muteMic: provider.setMicMuted(true); break;
    case CALL_COMMANDS.ACTIONS.cameraOn: provider.setCameraOn(true); break;
    case CALL_COMMANDS.ACTIONS.cameraOff: provider.setCameraOn(false); break;
    case CALL_COMMANDS.ACTIONS.setShareAudio:
      // set_share_audio: the room hearing the shared surface costs the bot its
      // mic on Zoom, so "audio on" is an explicit choice, off by default.
      provider.setShareAudioPaused(!!(message.payload && message.payload.muted));
      window.postMessage({ __botsInCalls: true, __fromExtension: true, ...message }, '*');
      break;
    default:
      window.postMessage({ __botsInCalls: true, __fromExtension: true, ...message }, '*');
  }
});

ipcRenderer.on(CALL_COMMANDS.readChat, async (_e, { requestId }) => {
  let result;
  try { result = { ok: true, messages: await provider.readChat() }; }
  catch (err) { result = { ok: false, error: err.message }; }
  emit(CALL_EVENTS.chatResult, { requestId, ...result });
});

ipcRenderer.on(CALL_COMMANDS.sendChat, async (_e, { requestId, text }) => {
  let result;
  try {
    const sent = await provider.sendChat(text);
    result = sent ? { ok: true } : { ok: false, error: 'Message may not have sent (see [zoom] log)' };
  } catch (err) { result = { ok: false, error: err.message }; }
  emit(CALL_EVENTS.chatResult, { requestId, ...result });
});

ipcRenderer.on(CALL_COMMANDS.triggerScreenShare, (_e, opts) => { provider.startShare(opts && opts.shareType); });
ipcRenderer.on(CALL_COMMANDS.triggerStopSharing, () => { provider.stopShare(); });
ipcRenderer.on(CALL_COMMANDS.setStudioSound, () => { /* no Zoom analog */ });
ipcRenderer.on(CALL_COMMANDS.recoverCaptions, () => { provider.recoverCaptions(); });
ipcRenderer.on(CALL_COMMANDS.setCaptionLanguage, async (_e, { requestId } = {}) => {
  emit(CALL_EVENTS.captionLanguageResult, { requestId, ...(await provider.setCaptionLanguage()) });
});
// requestCleanLeave sends this to meetView (which is this view) before teardown.
ipcRenderer.on('trigger-leave-call', () => { provider.leave(); });

// ---------------------------------------------------------------------------
// page-inject → main: the same forwards preload-meet makes. tts-ended
// matters most: main uses it to put the mic back in the mode's state.
// ---------------------------------------------------------------------------
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data?.__botsInCalls) return;
  const { action, payload } = event.data;
  if (action === 'tts-ended') emit(CALL_EVENTS.ttsEnded);
  else if (action === 'tts-stopped') emit('tts-stopped', payload || {});
  else if (action === 'self-audio') emit('self-audio', { loud: !!payload?.loud, at: payload?.at || Date.now() });
  else if (action === 'log' && payload?.line) emit('page-inject-log', payload.line);
  else if (action === 'avatar-emoji' && payload?.emoji) emit('avatar-emoji-changed', payload.emoji);
});
