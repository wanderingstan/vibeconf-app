// presentation-rect.test.mjs — which rectangle of the Meet view is the share?
//
// The first version of this picked the largest <video> that was clearly larger
// than the rest. That cannot work, and these tests could not see it: the input
// has no notion of which video is which, so "the picker returns a face with full
// confidence" was untestable by construction. It was caught by a live call —
// 75 samples, 0 settles, because the detector was cropped to a moving face that
// never goes quiet.
//
// The picker now matches the sharer's data-participant-id, reported by the
// People pane, against the grid tile carrying that id. That route was recorded
// in meet-selectors.js from a live measurement on 2026-09-03, for this issue,
// along with a warning against guessing a grid-side selector because it
// "silently reports every share as a camera".
//
// So these tests are mostly about identity beating geometry, and about refusing
// when identity is unavailable — because the caller skips sampling entirely on
// null, and watching the uncropped view instead DEFEATS the detector.
//
// Run: node --test tests/presentation-rect.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pickPresentationRect, clampToView } = require('../electron-app/presentation-rect.js');

const VW = 2560, VH = 1440;
const view = (videos, presenting = []) => ({ vw: VW, vh: VH, videos, tiles: [], presenting });
const vid = (id, x, y, w, h) => ({ id, x, y, w, h });

// --- identity beats geometry ------------------------------------------------

test('the tile whose id is presenting is the share, whatever its size', () => {
  const share = vid('share-1', 0, 0, 1900, 1050);
  const face = vid('stan', 1950, 0, 560, 315);
  assert.deepEqual(pickPresentationRect(view([face, share], ['share-1'])),
    { x: 0, y: 0, w: 1900, h: 1050 });
});

test('a pinned face LARGER than the share does not win', () => {
  // The exact failure the size heuristic produced, and the reason this module
  // was rewritten: a pinned participant takes the main stage, so "largest video"
  // is a face while a real share sits in the side strip.
  const bigFace = vid('stan', 0, 0, 2000, 1100);
  const share = vid('share-1', 2000, 0, 550, 310);
  const got = pickPresentationRect(view([bigFace, share], ['share-1']));
  assert.equal(got.w, 550, 'the SHARE is picked, not the bigger face');
});

test('a small share is still the share', () => {
  // Refusing on size would mean watching nothing at all, which is worse than
  // watching something hard to read — that is #694's problem, not this one's.
  const share = vid('share-1', 0, 0, 640, 360);
  assert.ok(pickPresentationRect(view([share], ['share-1'])), 'a 640x360 share is accepted');
});

test('several shares at once: the largest is the one being looked at', () => {
  const a = vid('s1', 0, 0, 1200, 700);
  const b = vid('s2', 1200, 0, 1300, 760);
  assert.equal(pickPresentationRect(view([a, b], ['s1', 's2'])).w, 1300);
});

// --- the refusals, which the caller turns into "watch nothing" --------------

test('nobody presenting means no rect, however big the videos are', () => {
  const bigFace = vid('stan', 0, 0, 2400, 1300);
  assert.equal(pickPresentationRect(view([bigFace], [])), null);
  assert.equal(pickPresentationRect(view([bigFace])), null, 'and a missing list is not an empty one');
});

test('presenting, but the share tile is not on screen', () => {
  // The second between the pane announcing a share and the grid tile mounting.
  assert.equal(pickPresentationRect(view([vid('stan', 0, 0, 2000, 1100)], ['share-1'])), null);
});

test('a video with no id cannot be matched, so it is refused', () => {
  assert.equal(pickPresentationRect(view([{ x: 0, y: 0, w: 1900, h: 1050 }], ['share-1'])), null);
});

test('a share too small to crop usefully is refused', () => {
  assert.equal(pickPresentationRect(view([vid('share-1', 0, 0, 100, 60)], ['share-1'])), null);
});

test('a malformed measurement is refused rather than throwing', () => {
  for (const bad of [null, undefined, {}, { vw: 0, vh: 0, videos: [], presenting: ['x'] },
                     { vw: VW, vh: VH, videos: [vid('x', 0, 0, 0, 0)], presenting: ['x'] }]) {
    assert.equal(pickPresentationRect(bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
});

// --- geometry ---------------------------------------------------------------

test('a tile hanging off-screen is clamped, not passed through', () => {
  const got = pickPresentationRect(view([vid('s1', -200, -100, 2200, 1300)], ['s1']));
  assert.ok(got, 'still a share');
  assert.ok(got.x >= 0 && got.y >= 0 && got.x + got.w <= VW && got.y + got.h <= VH);
});

test('clampToView never returns a negative or overflowing rect', () => {
  for (const c of [{ x: -50, y: -50, w: 100, h: 100 }, { x: 2550, y: 1430, w: 500, h: 500 },
                   { x: 0, y: 0, w: 9999, h: 9999 }]) {
    const g = clampToView(c, VW, VH);
    assert.ok(g.x >= 0 && g.y >= 0 && g.w >= 0 && g.h >= 0);
    assert.ok(g.x + g.w <= VW && g.y + g.h <= VH);
  }
});
