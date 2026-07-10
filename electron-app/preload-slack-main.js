// preload-slack-main.js — media preload for the MAIN app.slack.com window.
//
// Slack splits a huddle across two surfaces (#264). The MAIN window owns
// getUserMedia / RTCPeerConnection (Stan confirmed 2026-06-24 via the OS mic/cam
// in-use indicators), so the virtual-mic/cam + TTS-audio patch (page-inject.js)
// injects HERE — exactly as preload-meet.js does for Meet's single surface. The
// huddle popup (about:blank) is a separate scrape surface handled by
// preload-slack-huddle.js (injected via the main window's setWindowOpenHandler).
//
// contextIsolation:false so the media patch lands in the page world before
// Slack's scripts call getUserMedia.

const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

// Shim navigator.userAgentData (UA Client Hints) to match the spoofed Chrome UA
// BEFORE Slack's scripts run, so its sign-in browser gate doesn't see the real
// Chromium version (Electron leaks it via Client Hints even with setUserAgent).
require('./slack-ua').installClientHintsShim();

// Timestamp console lines so [slack-main] / page-inject logs interleave cleanly
// in the main-process stdout (same wrapper preload-meet.js uses).
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

// Disable the vestigial audio-capture path (the RTCPeerConnection hook) BEFORE
// page-inject installs it — it's unused (we read the transcript from Slack's DOM
// captions) and the Meet-shaped wrapper breaks Slack/Chime's WebRTC. Keeps the
// getUserMedia virtual-mic + play-tts (speak) path. Must be set before the eval.
window.__vibeconf_disableAudioCapture = true;

// Inject the media patch BEFORE Slack's scripts run (the getUserMedia virtual-mic
// + play-tts path is host-page-agnostic; the RTCPeerConnection hook is gated off
// above for Slack/Chime).
try {
  const code = fs.readFileSync(path.join(__dirname, 'page-inject.js'), 'utf-8');
  (0, eval)(code);
  console.log('[slack-main] page-inject.js loaded (media patch, before page scripts)');
} catch (err) {
  console.error('[slack-main] Failed to load page-inject.js:', err.message);
}

// page-inject's getDisplayMedia override calls this to pick a screen-share
// source (same contract as the Meet shell).
window.__vibeconf_getScreenShareSource = async function () {
  return ipcRenderer.invoke('get-screen-share-source');
};

// Bridge main → page-inject (same generic forward as google-meet-provider's
// inbound handler). The VirtualMic AND the virtual-camera avatar both live HERE
// in the main window, so page-inject needs the avatar-state messages too —
// set-bot-state / set-call-status / set-anyone-speaking / set-mode /
// set-avatar-* — not just the audio-out (play-tts / play-speech-test). main.js
// sends those to meetView, which in Slack mode IS this view. Forwarding only the
// two audio actions (the old behavior) left the avatar inert: it never learned
// callStatus or botState, so it sat on 🫥 forever. Mic/camera/chat extension-
// messages are routed to the huddle POPUP (SLACK_POPUP_CMDS), so they don't reach
// this window — a generic forward is safe (page-inject ignores unknown actions).
ipcRenderer.on('extension-message', (_event, message) => {
  if (!message) return;
  window.postMessage({ __botsInCalls: true, __fromExtension: true, ...message }, '*');
});

// Bridge page-inject → main: forward its 'log' lines (e.g. "Avatar → 🫥 ·
// callStatus=… hasEngaged=…") to the main-process stdout/session log, exactly as
// google-meet-provider does, so the Slack avatar's transitions are observable in
// session logs like Meet's. ('page-inject-log' is consumed in main.js.)
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data?.__botsInCalls) return;
  if (event.data.action === 'log' && event.data.payload?.line) {
    ipcRenderer.send('page-inject-log', event.data.payload.line);
  }
});
