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
  const r = computeCropRect(m);
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
  const r = computeCropRect(m, { pad: 0 });
  assert.ok(close(r.y, 30 / 660), `top must stay on the tile, got ${r.y * 660}px`);
  assert.equal(r.bannerOverlapPx, 90);
  assert.equal(r.strategy, 'tiles');
  const clear = computeCropRect({ ...m, banner: { x: 0, y: 0, w: 1173, h: 20 } }, { pad: 0 });
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

// --- reporting the achieved aspect (#735) ------------------------------------

test('the region reports the aspect it actually achieved, and how far off 16:9 it is', () => {
  // This is the early-warning instrument for #735: the view sizes are computed
  // to make the region 16:9, so a non-zero offBy16x9Px in the session log means
  // Meet's chrome moved and every recording has quietly gone oblong.
  const spotOn = computeCropRect({
    vw: 2320, vh: 1440, banner: null, videos: [],
    tiles: [{ x: 12, y: 60, w: 1920, h: 1080 }],
  }, { pad: 0 });
  assert.equal(spotOn.aspect, 1.778);
  assert.equal(spotOn.offBy16x9Px, 0, 'the default view size must report dead on');

  const tooWide = computeCropRect({
    vw: 2320, vh: 1440, banner: null, videos: [],
    tiles: [{ x: 12, y: 60, w: 1920, h: 985 }], // a share moves the bottom band
  }, { pad: 0 });
  assert.ok(tooWide.aspect > TARGET_ASPECT, `expected wider than 16:9, got ${tooWide.aspect}`);
  assert.ok(tooWide.offBy16x9Px > 0, 'positive px when too wide');
  assert.equal(tooWide.offBy16x9Px, Math.round(1920 / TARGET_ASPECT - 985));

  const tooTall = computeCropRect({
    vw: 2320, vh: 1440, banner: null, videos: [],
    tiles: [{ x: 12, y: 60, w: 900, h: 1080 }],
  }, { pad: 0 });
  assert.ok(tooTall.offBy16x9Px < 0, 'negative px when too tall');
});

test('reporting is reporting: the region itself is never moved to hit 16:9', () => {
  const m = { vw: 2320, vh: 1440, banner: null, videos: [], tiles: [{ x: 12, y: 60, w: 1920, h: 985 }] };
  const r = computeCropRect(m, { pad: 0 });
  assert.ok(close(r.w, 1920 / 2320), 'width untouched');
  assert.ok(close(r.h, 985 / 1440), 'height untouched — no silent growing or cropping here');
});
