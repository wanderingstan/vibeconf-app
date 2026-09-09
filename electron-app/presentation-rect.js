// presentation-rect.js — which rectangle of the Meet view is the shared screen?
//
// The settle detector (#673) samples the whole Meet view: participant tiles,
// Meet's chrome, and the shared screen as one tile among them. That is wasteful
// in two ways and wrong in a third.
//
//   • Most of the frame is faces and furniture, so most of the work — and, once
//     the picture is sent to the agent, most of the tokens — is spent on pixels
//     nobody asked about.
//   • The shared content lands at a fraction of the frame. #694 measured it: at
//     a 2560x1440 view a 1920-wide share renders ~1550px, and 13px terminal
//     text arrives as ~10.5px, which that issue calls "marginal". Cropping does
//     not shrink the token bill much (the long-edge cap dominates) but it does
//     hand the model 0.83x of the source pixels instead of 0.49x.
//   • A live face changes every single frame. screen-settle.js carries a churn
//     map specifically to exclude webcam tiles from the counting — machinery
//     that exists only because faces are in the frame at all. Crop them out and
//     the hardest noise source is gone by construction rather than by filter.
//
// Pure on purpose: it takes the measurement record record-region.js already
// collects (tiles, videos, viewport) and returns a rect or null. No DOM, no
// Electron, no capture — so the choice can be argued with in tests.

'use strict';

// A share must be a decent chunk of the view. Below this it is a thumbnail in
// somebody's grid layout, not the thing being presented, and cropping to it
// would hand the agent a postage stamp.
const MIN_VIEW_FRACTION = 0.15;

// ...and it must be clearly bigger than the next-largest video. Two similar
// rectangles mean a grid of equals — several webcams, or a layout where the
// share is not dominant — and picking one of them is a coin flip. Refusing is
// the honest answer; the caller falls back to the whole view.
const DOMINANCE = 1.5;

const area = (r) => (r && r.w > 0 && r.h > 0) ? r.w * r.h : 0;

// Clamp to the viewport. Meet lays tiles out with negative offsets during
// transitions, and a crop rect that starts off-screen throws in the capture
// path rather than merely looking wrong.
function clampToView(r, vw, vh) {
  const x = Math.max(0, Math.min(r.x, vw));
  const y = Math.max(0, Math.min(r.y, vh));
  const w = Math.max(0, Math.min(r.w + Math.min(0, r.x), vw - x));
  const h = Math.max(0, Math.min(r.h + Math.min(0, r.y), vh - y));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

// The presented rectangle, or null when it cannot be told apart.
//
// Returning null is a real answer and the caller must handle it: "I cannot see
// which tile is the share" is different from "there is no share", and the
// second question is answered by Meet's own presenting signal, not by geometry.
function pickPresentationRect(m, { minFraction = MIN_VIEW_FRACTION, dominance = DOMINANCE } = {}) {
  if (!m || !(m.vw > 0) || !(m.vh > 0)) return null;
  const videos = (Array.isArray(m.videos) ? m.videos : []).filter((r) => area(r) > 0);
  if (!videos.length) return null;

  const sorted = [...videos].sort((a, b) => area(b) - area(a));
  const best = sorted[0];
  const viewArea = m.vw * m.vh;

  if (area(best) < viewArea * minFraction) return null;
  // Sole video: nothing to be dominant over, and it passed the size bar.
  if (sorted.length > 1 && area(best) < area(sorted[1]) * dominance) return null;

  const r = clampToView(best, m.vw, m.vh);
  // A clamp can leave nothing usable if the tile was almost entirely off-screen.
  return (r.w >= 80 && r.h >= 60) ? r : null;
}

module.exports = { pickPresentationRect, clampToView, MIN_VIEW_FRACTION, DOMINANCE };
