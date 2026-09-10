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

// The smallest crop worth taking. An absolute floor, not a fraction of the
// view: once the share is identified by id there is no reason a SMALL share
// should be refused, and refusing means watching nothing at all rather than
// watching something hard to read. A share too small to read is #694's problem
// — coach the human to share a window instead — not a reason to go blind.
const MIN_CROP_W = 160;
const MIN_CROP_H = 120;

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

// The presented rectangle, or null when it cannot be identified.
//
// BY IDENTITY, NOT BY SIZE. The first version of this picked the largest video
// that was clearly larger than the rest, which cannot work and was measured
// failing: record-region collects every <video>, and a face and a screen share
// are the same element type, so nothing in the geometry says which is which. A
// pinned participant, a spotlight layout, or the second between the toolbar
// announcing a share and the tile mounting all handed back a confident face.
// Live on 2026-09-09 that produced 75 samples and 0 settles, because the
// detector was watching a moving face that never goes quiet.
//
// The route that does work was already recorded in meet-selectors.js from a
// live measurement on 2026-09-03, for this very issue:
//
//   "grid tiles have no such status row ... the People pane's own presentation
//    listitem gives the sharer's data-participant-id, and the grid tile with
//    that id is the share"
//
// So the measurement now carries per-tile ids and the pane's presenting ids,
// and this matches them. That note also warns against guessing a grid-side
// selector because it "silently reports every share as a camera" — which is
// exactly the failure the size heuristic reproduced.
//
// Returning null is a real answer and the caller MUST refuse to sample on it:
// watching the uncropped view instead does not degrade the detector, it defeats
// it, since a moving face never settles.
function pickPresentationRect(m, { minW = MIN_CROP_W, minH = MIN_CROP_H } = {}) {
  if (!m || !(m.vw > 0) || !(m.vh > 0)) return null;

  const presenting = new Set((Array.isArray(m.presenting) ? m.presenting : []).filter(Boolean));
  if (!presenting.size) return null;          // the pane does not say anyone is sharing

  const videos = (Array.isArray(m.videos) ? m.videos : []).filter((r) => area(r) > 0);
  const shares = videos.filter((v) => v.id && presenting.has(v.id));
  if (!shares.length) return null;            // sharing, but its tile is not on screen

  // Several shares at once: take the largest, which is the one being looked at.
  const best = shares.sort((a, b) => area(b) - area(a))[0];
  const r = clampToView(best, m.vw, m.vh);
  return (r.w >= minW && r.h >= minH) ? r : null;
}

module.exports = { pickPresentationRect, clampToView, MIN_CROP_W, MIN_CROP_H };
