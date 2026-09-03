// record-region.js — WHICH part of the bot's Meet view the call recording
// keeps, measured from the live page rather than guessed as fractions.
//
// WHY MEASURE: the recorded frame is the whole Meet view: the app's own
// status banner along the top, Meet's captions strip along the bottom, a
// People/chat panel when one is open, and dead space either side of the
// video grid. #676 cropped that with fixed fractions of the frame, and every
// one of them was wrong somewhere in the first real recordings: the banner
// survived the top margin, captions ran through the bottom one, and the
// right margin cut into the bot's own tile whenever no panel was open. The
// video grid moves with every layout change, so no fixed fraction can be
// right; the page knows exactly where it is.
//
// WHY AT CAPTURE TIME: the merge stream-copies the H.264 video (see
// call-media-merge.js), and there is no way to crop a copied stream that
// QuickTime honours — the H.264 SPS frame-cropping fields are applied by
// VideoToolbox as a size reduction anchored at the top-left (right/bottom
// trimmed, top/left NOT), so a top crop written that way shows up in
// QuickTime as the full frame with the banner still on it. Measured 2026-09-03
// on a real recording; ffmpeg and Chromium honour all four sides, Apple's
// decoder does not. Cropping in ffmpeg means decoding and re-encoding the
// whole call again, which is the cost the copy path exists to remove. So the
// crop is applied to the pixels BEFORE they reach the encoder:
// renderer/call-recording-window.js draws the captured frame into a canvas
// of the region's size and records THAT. This module supplies the region.
//
// Three pieces, kept Electron-free so the pure parts are unit-testable:
//   MEASURE_SCRIPT   — JS source for meetView.webContents.executeJavaScript:
//                      returns the viewport size and the rects of everything
//                      that matters (CSS px).
//   computeCropRect  — turns a measurement into the region as FRACTIONS of
//                      the viewport ({ x, y, w, h } in 0..1), plus which
//                      strategy produced it. Fractions, because the capture
//                      is the same frame at a different pixel size (bounded
//                      to 1080p by the capture constraints) and the renderer
//                      multiplies by its own videoWidth/videoHeight.
//   outlineScript    — JS source that draws (or removes) the region as an
//                      outline in the Meet page, so a human looking at the
//                      bot's view (the 👀 window) sees what is being kept.
//                      The outline is drawn OUTSIDE the box (CSS `outline`
//                      with a positive offset), so it is never in the
//                      recording itself.

// Extra CSS px kept around the union of the tiles, so a tile's rounded
// corner or a 1px border is never shaved. Small on purpose: every pixel of
// slack on the top edge is a pixel of the banner's drop shadow.
const PAD_CSS_PX = 4;

// Below this, a change in the measured region is treated as jitter and not
// re-sent to the capture window (which would otherwise redraw its letterbox
// for a sub-pixel wobble every tick). Fraction of the viewport per edge.
const CHANGE_EPSILON = 0.004;

// Runs inside the Meet page. Returns plain data only (structured-cloneable),
// never DOM nodes.
//
// Tiles: Meet marks every participant tile in the video grid with
// `data-participant-id` (the same attribute meet-selectors.js keys the
// People pane on — the pane's listitems carry it too, which is why anything
// inside a side panel / region / dialog is excluded here). Their union is the
// video area, chrome-free, whatever layout Meet is in: it grows when a panel
// closes, shrinks when captions push the grid up, and includes the bot's own
// floating self tile. Fallback: the `<video>` elements themselves (a
// camera-off participant has no <video>, so this under-counts, but it beats a
// guess). The status banner's rect is measured too, but only to REPORT how
// far it overlaps the region: the banner overlays Meet rather than pushing
// it, so it must never move the region — a long status message wraps the
// banner to several lines, and treating its bottom edge as a floor cropped
// the top off the tiles (seen live 2026-09-03). While a recording runs the
// banner is clamped to one line (google-meet-provider.js), so the overlap
// is at most Meet's own top margin.
const MEASURE_SCRIPT = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const rect = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
  const inChrome = (el) => !!el.closest('[role="complementary"], [role="region"], [role="dialog"], nav, header');
  const onScreen = (b) => b.w >= 80 && b.h >= 60 && b.x + b.w > 0 && b.y + b.h > 0 && b.x < vw && b.y < vh;
  const tiles = [];
  for (const el of document.querySelectorAll('[data-participant-id]')) {
    if (inChrome(el)) continue;
    const b = rect(el);
    if (onScreen(b)) tiles.push(b);
  }
  const videos = [];
  for (const el of document.querySelectorAll('video')) {
    if (inChrome(el)) continue;
    const b = rect(el);
    if (onScreen(b)) videos.push(b);
  }
  const banner = document.getElementById('vibeconf-status-bar');
  const captions = document.querySelector('div[role="region"][aria-label="Captions"]');
  return {
    vw, vh,
    banner: banner ? rect(banner) : null,
    captions: captions ? rect(captions) : null,
    tiles, videos,
  };
})()`;

function union(rects) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// The whole frame, for when the page gave us nothing to measure: Meet still
// loading, the bot between leaving and rejoining (no tiles, no chrome), a
// layout this doesn't recognise, the probe itself failing. Recording
// everything in those moments is the honest choice — a guessed fraction
// would crop real content on a page we can't see the shape of — and the
// caller keeps re-measuring every tick, so the region snaps back to the
// tiles as soon as there are tiles.
function fallbackRect() {
  return { x: 0, y: 0, w: 1, h: 1, strategy: 'fallback' };
}

// measurement -> { x, y, w, h, strategy } as fractions of the viewport.
// Never throws; a malformed/absent measurement yields the fallback.
function computeCropRect(m, { pad = PAD_CSS_PX } = {}) {
  if (!m || !(m.vw > 0) || !(m.vh > 0)) return fallbackRect();
  const tiles = Array.isArray(m.tiles) ? m.tiles.filter(validRect) : [];
  const videos = Array.isArray(m.videos) ? m.videos.filter(validRect) : [];
  let strategy;
  let r;
  if (tiles.length) { r = union(tiles); strategy = 'tiles'; }
  else if (videos.length) { r = union(videos); strategy = 'videos'; }
  else return fallbackRect();

  let x0 = r.x - pad, y0 = r.y - pad, x1 = r.x + r.w + pad, y1 = r.y + r.h + pad;
  x0 = Math.max(0, x0); y0 = Math.max(0, y0);
  x1 = Math.min(m.vw, x1); y1 = Math.min(m.vh, y1);
  if (!(x1 - x0 >= 40) || !(y1 - y0 >= 30)) return fallbackRect();
  // How many CSS px of the app's own banner lie inside the region (0 when it
  // sits entirely above the tiles). Informational — logged, never applied.
  const bannerOverlapPx = (m.banner && validRect(m.banner))
    ? Math.max(0, Math.round(Math.min(y1, m.banner.y + m.banner.h) - Math.max(y0, m.banner.y)))
    : 0;
  return {
    x: x0 / m.vw,
    y: y0 / m.vh,
    w: (x1 - x0) / m.vw,
    h: (y1 - y0) / m.vh,
    strategy,
    bannerOverlapPx,
  };
}

function validRect(r) {
  return !!r && Number.isFinite(r.x) && Number.isFinite(r.y) && r.w > 0 && r.h > 0;
}

// Has the region moved enough to be worth telling the capture window about?
function cropRectChanged(prev, next) {
  if (!prev || !next) return !!next;
  return ['x', 'y', 'w', 'h'].some((k) => Math.abs((prev[k] || 0) - (next[k] || 0)) > CHANGE_EPSILON);
}

// JS source that draws the region in the Meet page (rect in fractions), or
// removes it when rect is null. Idempotent: updates the existing element.
// The box itself is transparent and click-through; only the `outline`
// (outside the box, see the file comment) and a small label ABOVE the box
// are painted, so nothing this adds can appear in the recording.
const OUTLINE_ID = 'vibeconf-record-outline';
function outlineScript(rect) {
  if (!rect) {
    return `(() => { const el = document.getElementById(${JSON.stringify(OUTLINE_ID)}); if (el) el.remove(); return false; })()`;
  }
  const r = { x: +rect.x || 0, y: +rect.y || 0, w: +rect.w || 0, h: +rect.h || 0 };
  return `(() => {
    const id = ${JSON.stringify(OUTLINE_ID)};
    const r = ${JSON.stringify(r)};
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.style.cssText = 'position:fixed;pointer-events:none;z-index:999998;box-sizing:border-box;outline:3px solid #ea4335;outline-offset:3px;';
      const tag = document.createElement('div');
      tag.style.cssText = 'position:absolute;left:0;bottom:100%;margin-bottom:8px;padding:2px 8px;background:#ea4335;color:#fff;font:600 12px/1.4 Roboto,sans-serif;border-radius:3px;white-space:nowrap;';
      tag.textContent = 'REC · recorded region';
      el.appendChild(tag);
      document.body.appendChild(el);
    }
    el.style.left = (r.x * 100) + 'vw';
    el.style.top = (r.y * 100) + 'vh';
    el.style.width = (r.w * 100) + 'vw';
    el.style.height = (r.h * 100) + 'vh';
    return true;
  })()`;
}

module.exports = {
  MEASURE_SCRIPT,
  computeCropRect,
  cropRectChanged,
  outlineScript,
  fallbackRect,
  PAD_CSS_PX,
  CHANGE_EPSILON,
  OUTLINE_ID,
};
