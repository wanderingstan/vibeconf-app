// record-region.test.mjs — the measured crop region for call recordings
// (electron-app/record-region.js): a page measurement in, fractions of the
// viewport out. Pure, no Electron.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  MEASURE_SCRIPT,
  computeCropRect,
  cropRectChanged,
  outlineScript,
  fallbackRect,
  PAD_CSS_PX,
  TARGET_ASPECT,
  expandToAspect,
  OUTLINE_ID,
} = require('../electron-app/record-region.js');

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const VIEW = { vw: 1173, vh: 660 };

test('the union of the participant tiles becomes the region, padded, as fractions of the viewport', () => {
  const m = {
    ...VIEW,
    banner: { x: 0, y: 0, w: 1173, h: 56 },
    tiles: [
      { x: 100, y: 80, w: 600, h: 400 },
      { x: 720, y: 300, w: 200, h: 120 }, // the bot's own floating tile, lower right
    ],
    videos: [],
  };
  // aspect: null asks for the raw union, before the grow-to-16:9 pass.
  const r = computeCropRect(m, { aspect: null });
  assert.equal(r.strategy, 'tiles');
  assert.ok(close(r.x, (100 - PAD_CSS_PX) / 1173));
  assert.ok(close(r.y, (80 - PAD_CSS_PX) / 660));
  assert.ok(close(r.w, (920 + PAD_CSS_PX - (100 - PAD_CSS_PX)) / 1173));
  assert.ok(close(r.h, (480 + PAD_CSS_PX - (80 - PAD_CSS_PX)) / 660));
});

test('the status banner never moves the region — it overlays Meet — but its overlap is reported', () => {
  // A long status message wraps the banner to several lines; treating its
  // bottom as a floor cropped the top off the tiles (live, 2026-09-03).
  const m = {
    ...VIEW,
    banner: { x: 0, y: 0, w: 1173, h: 120 },
    tiles: [{ x: 0, y: 30, w: 1173, h: 600 }],
    videos: [],
  };
  const r = computeCropRect(m, { pad: 0, aspect: null });
  assert.ok(close(r.y, 30 / 660), `top must stay on the tile, got ${r.y * 660}px`);
  assert.equal(r.bannerOverlapPx, 90);
  assert.equal(r.strategy, 'tiles');
  const clear = computeCropRect({ ...m, banner: { x: 0, y: 0, w: 1173, h: 20 } }, { pad: 0, aspect: null });
  assert.equal(clear.bannerOverlapPx, 0);
});

test('the region is clamped to the viewport', () => {
  const m = { ...VIEW, banner: null, tiles: [{ x: -20, y: -10, w: 1300, h: 700 }], videos: [] };
  const r = computeCropRect(m);
  assert.equal(r.x, 0);
  assert.equal(r.y, 0);
  assert.equal(r.w, 1);
  assert.equal(r.h, 1);
});

test('with no tiles, <video> elements are the region; with neither, the whole frame is recorded', () => {
  const videosOnly = { ...VIEW, banner: null, tiles: [], videos: [{ x: 200, y: 100, w: 500, h: 300 }] };
  assert.equal(computeCropRect(videosOnly).strategy, 'videos');

  const nothing = { ...VIEW, banner: null, tiles: [], videos: [] };
  const fb = computeCropRect(nothing);
  assert.equal(fb.strategy, 'fallback');
  assert.deepEqual(fb, fallbackRect());
  assert.deepEqual([fb.x, fb.y, fb.w, fb.h], [0, 0, 1, 1], 'no tiles (e.g. between leave and rejoin) means record everything');
});

test('a missing, malformed, or degenerate measurement never throws and yields the fallback', () => {
  for (const m of [null, undefined, {}, { vw: 0, vh: 0 }, { ...VIEW, tiles: 'nope' }, { ...VIEW, tiles: [{ x: 1, y: 1, w: 0, h: 0 }] }]) {
    assert.equal(computeCropRect(m).strategy, 'fallback', JSON.stringify(m));
  }
  // A union too small to be a video area is also not trusted.
  assert.equal(computeCropRect({ ...VIEW, tiles: [{ x: 10, y: 10, w: 12, h: 12 }] }, { pad: 0 }).strategy, 'fallback');
});

test('cropRectChanged ignores sub-epsilon jitter and reports real moves', () => {
  const a = { x: 0.1, y: 0.1, w: 0.7, h: 0.7 };
  assert.equal(cropRectChanged(a, { ...a, x: 0.1 + 0.001 }), false);
  assert.equal(cropRectChanged(a, { ...a, w: 0.72 }), true);
  assert.equal(cropRectChanged(null, a), true);
  assert.equal(cropRectChanged(a, null), false);
});

test('the measurement script is self-contained and returns plain data (no DOM nodes)', () => {
  assert.match(MEASURE_SCRIPT, /^\(\(\) => \{[\s\S]*\}\)\(\)$/);
  assert.match(MEASURE_SCRIPT, /data-participant-id/);
  assert.match(MEASURE_SCRIPT, /vibeconf-status-bar/);
  assert.doesNotMatch(MEASURE_SCRIPT, /return \{[^}]*el\b/);
});

test('the outline is drawn outside the box, so it can never be in the recording', () => {
  const s = outlineScript({ x: 0.1, y: 0.2, w: 0.5, h: 0.6 });
  assert.match(s, /outline:3px solid/);
  assert.match(s, /outline-offset:3px/);
  assert.match(s, /pointer-events:none/);
  assert.match(s, /bottom:100%/, 'the label sits above the box');
  assert.match(s, new RegExp(OUTLINE_ID));
  const removal = outlineScript(null);
  assert.match(removal, /\.remove\(\)/);
});

// --- growing the region out to 16:9 (#735) ------------------------------------

test('a region wider than 16:9 grows downward into the background, never into the banner', () => {
  // The live 1600x900 shape: a 960x540 main tile plus the bot's floating self
  // tile hanging off the right, which is 2.07:1 rather than 1.78:1.
  const m = {
    vw: 1600, vh: 900,
    banner: { x: 0, y: 0, w: 1600, h: 40 },
    controls: { x: 700, y: 810, w: 200, h: 60 },
    tiles: [{ x: 88, y: 64, w: 960, h: 532 }, { x: 965, y: 430, w: 232, h: 166 }],
    videos: [],
  };
  const union = computeCropRect(m, { aspect: null });
  const r = computeCropRect(m);
  assert.ok(union.w * 1600 / (union.h * 900) > 2, 'the union really is too wide');
  assert.ok(close(r.w * 1600 / (r.h * 900), TARGET_ASPECT, 1e-3), `got ${r.w * 1600 / (r.h * 900)}`);
  assert.equal(r.shortOfAspectPx, 0, 'there was room, so nothing is left for the encoder');
  assert.ok(close(r.y, union.y), 'the top edge does not move: the banner is up there');
  assert.ok(r.h > union.h, 'all of the growth went downward');
});

test('the growth stops clear of Meet\'s control bar', () => {
  const m = {
    vw: 1600, vh: 900,
    banner: null,
    controls: { x: 700, y: 640, w: 200, h: 60 }, // control bar sitting unusually high
    tiles: [{ x: 88, y: 64, w: 1400, h: 532 }],
    videos: [],
  };
  const r = computeCropRect(m);
  const bottomPx = (r.y + r.h) * 900;
  assert.ok(bottomPx <= 640, `region must not reach the controls at y=640, got ${bottomPx}`);
  assert.ok(r.shortOfAspectPx > 0, 'and it reports that the encoder must letterbox the rest');
});

test('a region TALLER than 16:9 grows sideways instead, centred', () => {
  const m = {
    vw: 1600, vh: 900,
    banner: null, controls: null,
    tiles: [{ x: 700, y: 100, w: 300, h: 600 }], // a portrait 1x2-ish grid
    videos: [],
  };
  const r = computeCropRect(m);
  assert.ok(close(r.w * 1600 / (r.h * 900), TARGET_ASPECT, 1e-3));
  assert.ok(close(r.h, computeCropRect(m, { aspect: null }).h), 'height untouched');
  const leftGap = r.x * 1600 - (700 - PAD_CSS_PX);
  const rightGap = (1000 + PAD_CSS_PX) - (r.x + r.w) * 1600;
  assert.ok(Math.abs(leftGap + rightGap) < 1e-6 || Math.abs(leftGap - rightGap) < 1, 'grown evenly either side');
});

test('a share layout reaches 16:9 too: shorter tiles leave more background below', () => {
  // Measured live 2026-09-10 with the whiteboard shared: 1103x426, i.e. 2.59:1,
  // and the space below the tiles grows from 300px to 395px at the same time.
  const m = {
    vw: 1600, vh: 900,
    banner: { x: 0, y: 0, w: 1600, h: 40 },
    controls: { x: 700, y: 810, w: 200, h: 60 },
    tiles: [{ x: 20, y: 83, w: 1000, h: 418 }, { x: 1030, y: 340, w: 85, h: 161 }],
    videos: [],
  };
  const r = computeCropRect(m);
  assert.ok(close(r.w * 1600 / (r.h * 900), TARGET_ASPECT, 1e-3));
  assert.equal(r.shortOfAspectPx, 0);
});

test('expandToAspect is a no-op on an already-16:9 region, and never shrinks one', () => {
  const limits = { top: 0, bottom: 1000, left: 0, right: 2000 };
  const box = { x0: 100, y0: 100, x1: 1060, y1: 640 }; // 960x540
  assert.deepEqual(expandToAspect(box, limits), box);
  for (const b of [{ x0: 0, y0: 0, x1: 500, y1: 200 }, { x0: 0, y0: 0, x1: 200, y1: 500 }]) {
    const g = expandToAspect(b, limits);
    assert.ok(g.x1 - g.x0 >= b.x1 - b.x0 && g.y1 - g.y0 >= b.y1 - b.y0, 'only ever grows');
  }
});

test('the measurement script measures the control bar, so the floor is real and not a fraction', () => {
  // #676: every hardcoded fraction was wrong somewhere. The floor is measured.
  assert.match(MEASURE_SCRIPT, /data-tooltip="Leave call"/);
  assert.match(MEASURE_SCRIPT, /controls:/);
});

test('the caption strip clamps the growth: subtitles never get pulled into frame', () => {
  // Meet renders captions directly under the grid, only a few px below the
  // tiles, so it -- not the control bar -- is usually the real floor. Clamping
  // only to the controls grew straight through the subtitles.
  const base = {
    vw: 1600, vh: 900,
    banner: { x: 0, y: 0, w: 1600, h: 40 },
    controls: { x: 700, y: 810, w: 200, h: 60 },
    tiles: [{ x: 88, y: 64, w: 960, h: 532 }, { x: 965, y: 430, w: 232, h: 166 }],
    videos: [],
  };
  const off = computeCropRect({ ...base, captions: null });
  assert.ok(close(off.w * 1600 / (off.h * 900), TARGET_ASPECT, 1e-3), 'no captions: room to reach 16:9');
  assert.equal(off.shortOfAspectPx, 0);

  const captions = { x: 100, y: 610, w: 1000, h: 180 };
  const on = computeCropRect({ ...base, captions });
  assert.ok((on.y + on.h) * 900 <= captions.y, `must stop above the caption strip at y=${captions.y}, got ${(on.y + on.h) * 900}`);
  assert.ok(on.h < off.h, 'captions on means less room, so a smaller grow');
  assert.ok(on.shortOfAspectPx > 0, 'and the shortfall is reported for the encoder');
});
