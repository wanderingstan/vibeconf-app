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

// The aspect ratio the region is grown out to, so recordings are ordinary
// video. See expandToAspect() for why growing (rather than cropping or
// letterboxing) is the right move.
const TARGET_ASPECT = 16 / 9;

// How much clear space to leave above Meet's control bar when growing
// downward, in CSS px. The `controls` measurement is the Leave call BUTTON,
// and the strip it sits in is a little taller than the button plus its hover
// halo, so stopping exactly at the button's top edge would occasionally
// catch the strip's upper pixels.
const CONTROLS_KEEPOUT_CSS_PX = 12;

// Same idea for the caption strip, which sits much closer to the tiles than
// the control bar does and is therefore usually the real floor.
const CAPTIONS_KEEPOUT_CSS_PX = 8;

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
    if (onScreen(b)) tiles.push({ ...b, id: el.getAttribute('data-participant-id') || null });
  }
  const videos = [];
  for (const el of document.querySelectorAll('video')) {
    if (inChrome(el)) continue;
    const b = rect(el);
    // The id of the TILE this video sits in, so a caller can tell whose stream
    // it is. Grid tiles carry no marker saying "this one is the presentation"
    // (measured live 2026-09-03, #673) — the only route is to match this id
    // against the sharer's, which the People pane does report.
    if (onScreen(b)) {
      const owner = el.closest('[data-participant-id]');
      videos.push({ ...b, id: owner ? owner.getAttribute('data-participant-id') : null });
    }
  }

  // WHO IS SHARING, from the People pane, which is the one place Meet says so.
  // The pane marks a share with the literal word in the tile's status row; the
  // class is a minified token that changes between builds, the word does not.
  // Mirrors isPresentationTile() in google-meet-provider.js deliberately: this
  // script is injected as a self-contained string and cannot import it.
  const presenting = [];
  for (const item of document.querySelectorAll('[role="listitem"]')) {
    const id = item.getAttribute('data-participant-id');
    if (!id) continue;
    const row = item.querySelector('.d93U2d');
    if (row && (row.textContent || '').toLowerCase().includes('presentation')) presenting.push(id);
  }
  const banner = document.getElementById('vibeconf-status-bar');
  const captions = document.querySelector('div[role="region"][aria-label="Captions"]');
  // Meet's bottom control bar, measured so expandToAspect() has a real floor to
  // stop at rather than a guessed fraction. The Leave call button is the one
  // stable handle on that band (meet-selectors.js keys on the same tooltip);
  // the other controls sit in the same vertical strip, so the button's top edge
  // is the top of the strip for our purposes.
  const leave = document.querySelector('[data-tooltip="Leave call"]');
  return {
    vw, vh,
    banner: banner ? rect(banner) : null,
    captions: captions ? rect(captions) : null,
    controls: leave ? rect(leave) : null,
    tiles, videos, presenting,
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

// Grow a region out to `aspect`, in CSS px, staying inside `limits`.
//
// WHY GROW, rather than crop to fit or letterbox in the encoder: the union of
// Meet's tiles is almost never 16:9, and there is no formula that says what it
// will be. Meet sizes tile BOXES to fill whatever grid area it has and
// letterboxes each video inside its box, so the box aspect moves with the
// participant count, the window, whether a panel is open and whether anyone is
// sharing. Measured over 310 samples on this machine: 1.36:1 to 3.68:1, median
// 2.22:1, 89% of them wider than 16:9.
//
// (Do not be tempted by "tiles are 16:9, so a c-by-r grid unions to (c/r)*16/9".
// Measured 2026-09-10, tile boxes in a 2-up grid were about 1.35:1. The 16:9
// element inside a tile is the video wrapper, not the box.)
//
// The bot's own floating self tile adds to it, hanging off the side of the grid:
// live on 2026-09-10 a 960x540 main tile plus 153px of self-tile overhang gave
// 1113x540, i.e. 2.06:1 rather than 1.78:1. Moving that tile into the grid does
// NOT help, and measured worse (2.58:1), because it promotes the overhang to a
// whole extra column: see #737. Hence measuring rather than assuming.
//
// Three ways to square that up, and only one is any good:
//   crop in       — throws away tiles. Never.
//   letterbox     — black bars baked into the file. Works, looks like a
//                   mistake, and the canvas already does it as a fallback.
//   grow out      — take in more of Meet's own background around the grid.
//                   The pixels are real, the result reads as intentional
//                   padding around the tiles, and nothing is lost.
//
// There is room for it. Measured at three view sizes, Meet's top inset is a
// fixed 60 CSS px and the space below the tiles a fixed 300 (so the region
// height is view height minus 360, in pixels, at any size), while the height
// this needs to add is 86 to 116 px. A screen share shortens the tiles and
// grows that space at the same time (300 -> 395 px against a need of 192), so
// the headroom scales with the demand. Across all 310 crop samples recorded on
// this machine, 90% reach 16:9 by growing alone; the rest are layouts already
// spanning ~98% of the view width, where there is no width to balance against
// and the encoder's letterbox has to finish the job.
//
// Height is taken from BELOW first: the strip above the tiles is Meet's header
// and, over it, the app's own status banner, and pulling either into the
// recording is exactly the bug #676 left behind.
function expandToAspect(box, limits, aspect = TARGET_ASPECT) {
  let { x0, y0, x1, y1 } = box;
  const w = x1 - x0, h = y1 - y0;
  if (!(w > 0) || !(h > 0) || !(aspect > 0)) return { x0, y0, x1, y1 };
  const current = w / h;
  if (Math.abs(current - aspect) < 1e-6) return { x0, y0, x1, y1 };

  if (current > aspect) {
    // Too wide: add height, downward first, then upward with what is left.
    let need = w / aspect - h;
    const down = Math.max(0, Math.min(need, limits.bottom - y1));
    y1 += down; need -= down;
    if (need > 0) {
      const up = Math.max(0, Math.min(need, y0 - limits.top));
      y0 -= up;
    }
  } else {
    // Too tall (a portrait grid, e.g. 1x2): add width, split either side so
    // the tiles stay centred.
    let need = h * aspect - w;
    const right = Math.max(0, Math.min(need / 2, limits.right - x1));
    const left = Math.max(0, Math.min(need - right, x0 - limits.left));
    x0 -= left; x1 += right; need -= (left + right);
    // One side may have had less room than the other; spend the remainder on
    // whichever side still has any.
    if (need > 0) {
      const more = Math.max(0, Math.min(need, limits.right - x1));
      x1 += more; need -= more;
    }
    if (need > 0) x0 -= Math.max(0, Math.min(need, x0 - limits.left));
  }
  return { x0, y0, x1, y1 };
}

// measurement -> { x, y, w, h, strategy } as fractions of the viewport.
// Never throws; a malformed/absent measurement yields the fallback.
function computeCropRect(m, { pad = PAD_CSS_PX, aspect = TARGET_ASPECT } = {}) {
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
  // Grow the union out to 16:9 within the clear space around it. The floor is
  // Meet's control bar when we can see it, the ceiling the app's own status
  // banner when it is up (growing into either would put chrome in the file).
  const tiles0 = { x0, y0, x1, y1 };
  if (aspect > 0) {
    // The floor is whichever piece of chrome comes first below the tiles.
    // CAPTIONS ARE THE BINDING ONE in practice: Meet renders the caption strip
    // directly under the grid, a few px below the tiles, so a growth clamped
    // only to the control bar grows straight through the subtitles (spotted
    // 2026-09-10 before it shipped). The strip is only present when captions
    // are on, which for this bot is nearly always.
    const controlsTop = (m.controls && validRect(m.controls))
      ? m.controls.y - CONTROLS_KEEPOUT_CSS_PX
      : m.vh;
    const captionsTop = (m.captions && validRect(m.captions))
      ? m.captions.y - CAPTIONS_KEEPOUT_CSS_PX
      : m.vh;
    const floor = Math.min(controlsTop, captionsTop);
    const bannerBottom = (m.banner && validRect(m.banner)) ? m.banner.y + m.banner.h : 0;
    const grown = expandToAspect(tiles0, {
      top: Math.max(0, Math.min(bannerBottom, y0)),
      bottom: Math.min(m.vh, Math.max(floor, y1)),
      left: 0,
      right: m.vw,
    }, aspect);
    x0 = grown.x0; y0 = grown.y0; x1 = grown.x1; y1 = grown.y1;
  }
  // How many CSS px of the app's own banner lie inside the region (0 when it
  // sits entirely above the tiles). Informational — logged, never applied.
  const bannerOverlapPx = (m.banner && validRect(m.banner))
    ? Math.max(0, Math.round(Math.min(y1, m.banner.y + m.banner.h) - Math.max(y0, m.banner.y)))
    : 0;
  // How far the growth fell short of 16:9, so the log says when the encoder's
  // letterbox had to finish the job (0 whenever there was room).
  const achieved = (x1 - x0) / (y1 - y0);
  const shortOfAspectPx = aspect > 0
    ? Math.max(0, Math.round((x1 - x0) / aspect - (y1 - y0)))
    : 0;
  return {
    x: x0 / m.vw,
    y: y0 / m.vh,
    w: (x1 - x0) / m.vw,
    h: (y1 - y0) / m.vh,
    strategy,
    bannerOverlapPx,
    aspect: Math.round(achieved * 1000) / 1000,
    shortOfAspectPx,
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
  expandToAspect,
  cropRectChanged,
  outlineScript,
  fallbackRect,
  PAD_CSS_PX,
  TARGET_ASPECT,
  CONTROLS_KEEPOUT_CSS_PX,
  CAPTIONS_KEEPOUT_CSS_PX,
  CHANGE_EPSILON,
  OUTLINE_ID,
};
