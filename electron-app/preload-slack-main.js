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

// Inject the media patch BEFORE Slack's scripts run (same file Meet uses — the
// getUserMedia / RTCPeerConnection override is host-page-agnostic).
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
