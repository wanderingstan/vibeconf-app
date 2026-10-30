// preload-teams.js — the preload for the Microsoft Teams web client view.
//
// Same shape as preload-zoom.js: Teams renders the meeting top-level, so one
// preload carries both page-inject (virtual mic/camera, TTS) and TeamsProvider,
// and main.js's commands reach it the way they reach preload-meet.
//
// Drive it live from this view's DevTools (contextIsolation:false):
//   teamsProvider.scrapeCaptions()   teamsProvider.enableCaptions()
//   teamsProvider.sendChat('hello')  teamsProvider.readChat()
//   teamsProvider.setMicMuted(false) teamsProvider.leave()

const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const { startTeams } = require('@vibeconferencing/calls/providers/teams-session');
const { CALL_EVENTS, CALL_COMMANDS, CALL_BOOTSTRAP } = require('@vibeconferencing/calls/core/call-provider');
const { TEAMS } = require('@vibeconferencing/calls/providers/teams-selectors');

// Present as current Chrome (main sets the UA string; this matches
// navigator.userAgentData to it) before Teams' scripts run.
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

// Recon (#814): log where Teams' call audio lives. Off unless
// VIBECONF_AUDIO_PROBE=1. Installed before page-inject and Teams' scripts.
if (process.env.VIBECONF_AUDIO_PROBE === '1') require('@vibeconferencing/calls/core/audio-probe').installAudioProbe('[teams]');
// Research (dom-probe.js): --dom-probe=1 watches every video tile. Off by default.
// Installed here, before the `delete window.process` below, which it needs.
require('@vibeconferencing/calls/core/dom-probe').installDomProbe({ tag: '[teams]', defaultSelector: '[data-tid^="video-item-container-"]' });

// The Meet-shaped RTCPeerConnection audio hook is unused here; keep the
// getUserMedia virtual mic + play-tts path (as Slack and Zoom do).
window.__vibeconf_disableAudioCapture = true;

// The media scripts (page-inject's core, then the app's avatar and realtime
// voice plugins), before any page script can ask for media. page-scripts.js.
require('./page-scripts').injectPageScripts({ tag: '[teams]' });

window.__vibeconf_getScreenShareSource = async function () {
  return ipcRenderer.invoke('get-screen-share-source');
};

// Call recording: start/stop the page recorder and carry its tracks to main
// (#814). Without this a Teams recording was silent video.
require('@vibeconferencing/calls/recording/preload-recording-bridge').installRecordingBridge(ipcRenderer, { tag: '[teams]' });
// Speech-to-text tap → main, for hearing calls by transcribing their audio (#850).
require('@vibeconferencing/calls/hearing/preload-stt-bridge').installSttBridge(ipcRenderer);

// The call itself runs in the library (teams-session.js): launcher, pre-join,
// lobby, the heartbeat and the speaking poll. This preload is its host.
const provider = startTeams({ getBotName: () => ipcRenderer.invoke(CALL_BOOTSTRAP.getBotName) });
// NOT window.TEAMS: Teams' own app may read globals by that name, and a stray
// one is exactly the kind of thing that flips its desktop-client detection.
try { window.teamsProvider = provider; window.__vibeTeamsSelectors = TEAMS; } catch { /* window not ready */ }

// Recon: what Teams can see of this environment. It redirected the bot to
// /error/eoa ("Classic Teams is no longer available"), i.e. it decided this is
// the old Electron desktop client. Log the usual tells once per page.
try {
  const brands = (navigator.userAgentData && navigator.userAgentData.brands || []).map((b) => b.brand + '/' + b.version).join(', ');
  console.log('[teams] env:', JSON.stringify({
    ua: navigator.userAgent,
    brands,
    process: typeof window.process,
    require: typeof window.require,
    module: typeof window.module,
    electron: typeof window.electron,
    path: location.pathname,
  }));
} catch { /* recon only */ }

function emit(channel, ...args) {
  try { ipcRenderer.send(channel, ...args); } catch { /* main not listening */ }
}
for (const channel of Object.values(CALL_EVENTS)) {
  provider.on(channel, (...args) => emit(channel, ...args));
}

ipcRenderer.on(CALL_COMMANDS.extensionMessage, (_e, message) => {
  if (!message) return;
  switch (message.action) {
    case CALL_COMMANDS.ACTIONS.unmuteMic: provider.setMicMuted(false); break;
    case CALL_COMMANDS.ACTIONS.muteMic: provider.setMicMuted(true); break;
    case CALL_COMMANDS.ACTIONS.cameraOn: provider.setCameraOn(true); break;
    case CALL_COMMANDS.ACTIONS.cameraOff: provider.setCameraOn(false); break;
    default:
      window.postMessage({ __botsInCalls: true, __fromExtension: true, ...message }, '*');
  }
});

ipcRenderer.on(CALL_COMMANDS.readChat, async (_e, { requestId }) => {
  let result;
  try {
    result = { ok: true, messages: await provider.readChat() };
  } catch (err) { result = { ok: false, error: err.message }; }
  emit(CALL_EVENTS.chatResult, { requestId, ...result });
});

ipcRenderer.on(CALL_COMMANDS.sendChat, async (_e, { requestId, text }) => {
  let result;
  try {
    const sent = await provider.sendChat(text);
    result = sent ? { ok: true } : { ok: false, error: 'Message may not have sent (see [teams] log)' };
  } catch (err) { result = { ok: false, error: err.message }; }
  emit(CALL_EVENTS.chatResult, { requestId, ...result });
});

ipcRenderer.on(CALL_COMMANDS.triggerScreenShare, (_e, opts) => { provider.startShare(opts && opts.shareType); });
ipcRenderer.on(CALL_COMMANDS.triggerStopSharing, () => { provider.stopShare(); });
ipcRenderer.on(CALL_COMMANDS.setStudioSound, () => { /* no Teams analog */ });
ipcRenderer.on(CALL_COMMANDS.recoverCaptions, () => { provider.recoverCaptions(); });
ipcRenderer.on(CALL_COMMANDS.setCaptionLanguage, async (_e, { requestId } = {}) => {
  emit(CALL_EVENTS.captionLanguageResult, { requestId, ...(await provider.setCaptionLanguage()) });
});
ipcRenderer.on('trigger-leave-call', () => { provider.leave(); });

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data?.__botsInCalls) return;
  const { action, payload } = event.data;
  if (action === 'tts-ended') emit(CALL_EVENTS.ttsEnded);
  else if (action === 'tts-stopped') emit('tts-stopped', payload || {});
  else if (action === 'self-audio') emit('self-audio', { loud: !!payload?.loud, at: payload?.at || Date.now() });
  else if (action === 'log' && payload?.line) emit('page-inject-log', payload.line);
  else if (action === 'avatar-emoji' && payload?.emoji) emit('avatar-emoji-changed', payload.emoji);
});

// Hide Node's `process` from Teams. With contextIsolation:false it is a page
// global, and Teams v2 reads it as "this is the Classic Teams Electron desktop
// client" and redirects to /error/eoa ("Classic Teams is no longer available")
// — seen live 2026-10-15 (env log: process:"object"). Everything above holds its
// own references, so removing the global after setup is safe. Last line on
// purpose: nothing below may need it.
try { delete window.process; } catch { /* non-configurable: fall through */ }
if (typeof window.process !== 'undefined') {
  try { Object.defineProperty(window, 'process', { value: undefined, configurable: true, writable: true }); } catch { /* best effort */ }
}
