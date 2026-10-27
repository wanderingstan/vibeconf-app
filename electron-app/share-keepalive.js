// share-keepalive.js: keep the shared whiteboard sending frames while it sits
// still.
//
// The whiteboard share is a capture of the share window's web contents
// (setDisplayMediaRequestHandler hands Chromium `webContents.mainFrame`). That
// capture is DAMAGE-DRIVEN: Chromium only emits a video frame when the page
// repaints. A static board (a Mermaid diagram, a list) therefore sends one
// burst of frames when it is drawn and then nothing at all, while the track
// stays live and the share never "stops".
//
// Meet copes with that. WhatsApp mobile does not: a video track with no
// incoming frames is treated as stalled, and after a few seconds the tile is
// replaced by WhatsApp's no-video placeholder (the bot's profile photo and
// number, labelled "<number>'s screen"). It comes back for a moment each time
// the board changes. Live, 2026-10-27: a movie played through the same share
// stayed up the whole call; a static family tree dropped to the placeholder;
// and a spinner the bot added to the board kept it up. So a steady trickle of
// repaints is what the receiver needs.
//
// The fix is that spinner, made invisible and content-independent: a 1px
// pseudo-element in the bottom-right corner whose colour steps between two
// near-identical, nearly transparent greys a few times a second. Each step is
// a style change, so Blink repaints that pixel and the capturer emits a frame.
// Nobody can see a 1px change of 2% alpha, and it costs one pixel of raster.
//
// Why this and not re-emitting frames from a canvas / MediaStreamTrackGenerator
// in page-inject: those replace the track every provider receives. The
// replacement loses getSettings().displaySurface, applyConstraints, and the
// source's own `ended`, and a canvas pins the resolution the share-size logic
// controls. Repainting the page changes nothing about the track; it just gives
// the capturer something to capture. It also helps every provider at once
// (Telegram, Teams, Zoom) without changing what Meet shows.
//
// Why CSS and not a timer: the animation needs no script in the page (so a
// page's CSP or a reload cannot break it), and it lives in a USER-origin stylesheet (webContents.insertCSS), so
// it is outside the document the agent writes. update_whiteboard can replace
// the whole body and the pixel keeps ticking; a page loaded with load_url
// cannot override it (user !important beats author !important). Navigation
// drops inserted CSS, so it is re-inserted on every load.
//
// Lifetime: the share window exists only for a share (created when one starts,
// closed by closeWhiteboardWindow when it stops), so the stylesheet lives and
// dies with it. No timers, nothing to leak. If the CALL side stops sharing
// first (WhatsApp's own "Stop sharing screen"), the window lingers until the
// app closes it, repainting one invisible pixel a few times a second, which
// costs nothing worth measuring.
//
// Measured in Electron 33 (a static page captured through mainFrame, frames
// counted with MediaStreamTrackProcessor): 0.00 frames/s without this, 5.00
// with it, still 5.00 after the page body was replaced.

'use strict';

// Repaints per second while the board is static. A few is enough to keep a
// receiver from calling the track stalled; content changes still go out at the
// capture's full rate on top of these.
const KEEPALIVE_FPS = 5;

// A name no page will collide with.
const KEYFRAMES_NAME = 'vibeconf-share-keepalive';

// Two greys, both at a few percent alpha: invisible on any background, but
// different values, so every step is a real style change Blink must repaint.
const COLOR_A = 'rgba(128, 128, 128, 0.02)';
const COLOR_B = 'rgba(128, 128, 128, 0.04)';

// The stylesheet. `steps(fps)` over a 1s cycle gives exactly `fps` distinct
// colours a second (no interpolation in between, so no repaint at the display
// rate); `infinite` keeps it going for as long as the window lives.
function keepaliveCss(fps = KEEPALIVE_FPS) {
  const n = Math.max(1, Math.round(Number(fps) || KEEPALIVE_FPS));
  return [
    'html::after {',
    '  content: "" !important;',
    '  display: block !important;',
    '  position: fixed !important;',
    '  right: 0 !important;',
    '  bottom: 0 !important;',
    '  width: 1px !important;',
    '  height: 1px !important;',
    '  margin: 0 !important;',
    '  padding: 0 !important;',
    '  border: 0 !important;',
    '  opacity: 1 !important;',
    '  visibility: visible !important;',
    '  pointer-events: none !important;',
    '  z-index: 2147483647 !important;',
    `  animation: ${KEYFRAMES_NAME} 1s steps(${n}, end) infinite !important;`,
    '}',
    `@keyframes ${KEYFRAMES_NAME} {`,
    `  from { background-color: ${COLOR_A}; }`,
    `  to { background-color: ${COLOR_B}; }`,
    '}',
  ].join('\n');
}

// Keep `webContents` repainting for the rest of its life. Inserts the
// stylesheet into whatever is loaded now (if anything) and again on every
// navigation, since a new document starts without it.
//
// Deliberately no "stop": removeInsertedCSS does not remove a user-origin
// sheet in Electron 33 (measured: the pseudo-element kept animating after it),
// so a stop function would only pretend. The window's lifetime is the off
// switch. Idempotent per webContents, so a share that re-asks getDisplayMedia
// (the Present-now retry loop) does not stack listeners. Returns whether it
// installed.
function installShareKeepalive(webContents, { fps = KEEPALIVE_FPS, log = () => {} } = {}) {
  if (!webContents || typeof webContents.insertCSS !== 'function') return false;
  if (webContents.__vibeconfShareKeepalive) return false;
  webContents.__vibeconfShareKeepalive = true;
  const css = keepaliveCss(fps);
  const insert = () => {
    if (webContents.isDestroyed?.()) return;
    Promise.resolve(webContents.insertCSS(css, { cssOrigin: 'user' }))
      .catch((err) => log(`[share-keepalive] could not insert keepalive CSS: ${err.message}`));
  };
  // dom-ready, not did-finish-load: the board should start ticking as soon as
  // there is a document, not after its last image arrives.
  webContents.on('dom-ready', insert);
  if (typeof webContents.getURL === 'function' && webContents.getURL()) insert();
  return true;
}

module.exports = { KEEPALIVE_FPS, KEYFRAMES_NAME, COLOR_A, COLOR_B, keepaliveCss, installShareKeepalive };
