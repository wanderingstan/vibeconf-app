// preload-meet.js — Preload script for the Meet BrowserWindow.
// Runs with contextIsolation: false so it shares the page's world.
// This lets us patch getUserMedia BEFORE Meet's scripts run.

const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
try {
  const pageInjectPath = path.join(__dirname, 'page-inject.js');
  const pageInjectCode = fs.readFileSync(pageInjectPath, 'utf-8');
  (0, eval)(pageInjectCode);
  console.log('[electron-meet] page-inject.js loaded (preload, before page scripts)');
} catch (err) {
  console.error('[electron-meet] Failed to load page-inject.js:', err.message);
}

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
// All Meet automation lives in GoogleMeetProvider. Requiring the module
// registers the IPC command handlers, the page-message forwarder, the DOM
// trackers, and the auto-join flow (module side effects). preload-meet.js is
// now just the page-world bootstrap shell — console timestamps, page-inject,
// and the screen-share helpers — none of it Meet-specific beyond loading the
// provider. Swap this require to load a different CallProvider backend.
// ---------------------------------------------------------------------------
require('./google-meet-provider');
