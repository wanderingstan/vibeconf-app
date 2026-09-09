// presentation-rect.test.mjs — picking the shared screen out of the Meet view.
//
// The interesting cases are the ones where it must REFUSE. Cropping to the
// wrong tile is worse than not cropping: the agent gets a confident picture of
// somebody's face and is told it is the shared screen. So "I cannot tell" has
// to be a real answer, and these tests are mostly about when it is given.
//
// Run: node --test tests/presentation-rect.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pickPresentationRect, clampToView } = require('../electron-app/presentation-rect.js');

const VW = 2560, VH = 1440;
const view = (videos) => ({ vw: VW, vh: VH, videos, tiles: [] });
const r = (x, y, w, h) => ({ x, y, w, h });

test('a dominant share is picked out of a row of webcams', () => {
  const share = r(0, 0, 1900, 1050);
  const got = pickPresentationRect(view([
    r(1950, 0, 300, 170), share, r(1950, 200, 300, 170),
  ]));
  assert.deepEqual(got, share);
});

test('a lone video that fills much of the view is the share', () => {
  const share = r(100, 60, 2200, 1200);
  assert.deepEqual(pickPresentationRect(view([share])), share);
});

// --- the refusals ----------------------------------------------------------

test('a grid of similar tiles is refused — picking one would be a coin flip', () => {
  // Four webcams in a 2x2. The largest is barely larger than the next, which is
  // what "no one is presenting, this is just the gallery" looks like.
  const got = pickPresentationRect(view([
    r(0, 0, 1280, 720), r(1280, 0, 1275, 720),
    r(0, 720, 1280, 715), r(1280, 720, 1275, 715),
  ]));
  assert.equal(got, null);
});

test('a tile too small to be a presentation is refused', () => {
  // A thumbnail in somebody's layout. Cropping to it hands the agent a postage
  // stamp and calls it the shared screen.
  assert.equal(pickPresentationRect(view([r(10, 10, 320, 180)])), null);
});

test('no videos at all is refused, not guessed from the tiles', () => {
  assert.equal(pickPresentationRect({ vw: VW, vh: VH, videos: [], tiles: [r(0, 0, 2000, 1000)] }), null);
});

test('a malformed measurement is refused rather than throwing', () => {
  for (const bad of [null, undefined, {}, { vw: 0, vh: 0, videos: [r(0, 0, 100, 100)] },
                     { vw: VW, vh: VH, videos: [r(0, 0, 0, 0)] }]) {
    assert.equal(pickPresentationRect(bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
});

// --- geometry --------------------------------------------------------------

test('a tile hanging off-screen is clamped, not passed through', () => {
  // Meet lays tiles out with negative offsets mid-transition, and a crop rect
  // starting off-screen throws in the capture path rather than looking wrong.
  const got = pickPresentationRect(view([r(-200, -100, 2200, 1300)]));
  assert.ok(got, 'still a share');
  assert.ok(got.x >= 0 && got.y >= 0, 'origin clamped into the view');
  assert.ok(got.x + got.w <= VW && got.y + got.h <= VH, 'stays inside the view');
});

test('a tile almost entirely off-screen is refused, not clamped to a sliver', () => {
  assert.equal(pickPresentationRect(view([r(2500, 1400, 1900, 1050)])), null);
});

test('clampToView never returns a negative or overflowing rect', () => {
  const cases = [r(-50, -50, 100, 100), r(2550, 1430, 500, 500), r(0, 0, 9999, 9999)];
  for (const c of cases) {
    const g = clampToView(c, VW, VH);
    assert.ok(g.x >= 0 && g.y >= 0 && g.w >= 0 && g.h >= 0, `non-negative for ${JSON.stringify(c)}`);
    assert.ok(g.x + g.w <= VW && g.y + g.h <= VH, `inside the view for ${JSON.stringify(c)}`);
  }
});

test('the thresholds are the knobs, and they actually move the answer', () => {
  // Guards against the constants being decorative. A grid refused at the
  // default dominance is accepted when the bar is lowered.
  const grid = view([r(0, 0, 1300, 720), r(1300, 0, 1250, 720)]);
  assert.equal(pickPresentationRect(grid), null);
  assert.ok(pickPresentationRect(grid, { dominance: 1.0 }), 'accepted once dominance is relaxed');
});
