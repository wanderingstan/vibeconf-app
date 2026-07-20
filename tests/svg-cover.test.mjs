// svg-cover.test.mjs — the panel's bot-box avatar must COVER, not letterbox.
//
// The tile is square (54×54). Backgrounds are authored landscape, because the
// virtual camera is 16:9. Dropping a 1280×720 SVG into a square box letterboxed
// it: `object-fit: cover` was in the stylesheet, but object-fit only applies to
// REPLACED elements (<img>, <video>), and the panel injects the background as an
// INLINE <svg> via innerHTML. So the rule was inert and the SVG used its default
// preserveAspectRatio, "xMidYMid meet" — which is `contain`.
//
// The SVG-native spelling of cover is "xMidYMid slice". Same decision as
// drawCover() in page-inject.js (#428), different renderer.
//
// No jsdom in this repo, so these drive a tiny attribute-bag stub. That's enough:
// the function only reads and writes attributes.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { coverFitSvg, coverFitFirstSvg, COVER } = require('../electron-app/renderer/svg-cover.js');

function fakeSvg(attrs = {}) {
  const bag = { ...attrs };
  return {
    tagName: 'svg',
    getAttribute: (k) => (k in bag ? bag[k] : null),
    setAttribute: (k, v) => { bag[k] = String(v); },
    removeAttribute: (k) => { delete bag[k]; },
    attrs: bag,
  };
}

test('cover is spelled "xMidYMid slice" — meet would be contain', () => {
  assert.equal(COVER, 'xMidYMid slice');
});

test('a landscape SVG with a viewBox gets cover-fitted', () => {
  const svg = fakeSvg({ viewBox: '0 0 1280 720' });
  assert.equal(coverFitSvg(svg), true);
  assert.equal(svg.attrs.preserveAspectRatio, 'xMidYMid slice');
  assert.equal(svg.attrs.viewBox, '0 0 1280 720', 'existing viewBox untouched');
});

test('an author-set preserveAspectRatio is overridden — the tile decides its fit', () => {
  const svg = fakeSvg({ viewBox: '0 0 400 400', preserveAspectRatio: 'xMinYMin meet' });
  coverFitSvg(svg);
  assert.equal(svg.attrs.preserveAspectRatio, 'xMidYMid slice');
});

test('baked-in width/height are stripped so CSS owns the box', () => {
  const svg = fakeSvg({ viewBox: '0 0 1280 720', width: '1280', height: '720' });
  coverFitSvg(svg);
  assert.equal(svg.attrs.width, undefined);
  assert.equal(svg.attrs.height, undefined);
});

test('no viewBox: one is synthesized from width/height, or nothing happens', () => {
  // preserveAspectRatio has NO effect without a viewBox — the svg just stretches.
  const sized = fakeSvg({ width: '1280', height: '720' });
  assert.equal(coverFitSvg(sized), true);
  assert.equal(sized.attrs.viewBox, '0 0 1280 720');
  assert.equal(sized.attrs.preserveAspectRatio, 'xMidYMid slice');

  const px = fakeSvg({ width: '800px', height: '600px' });
  assert.equal(coverFitSvg(px), true);
  assert.equal(px.attrs.viewBox, '0 0 800 600');

  // Percentages carry no intrinsic aspect. Guessing would be worse than leaving it.
  const pct = fakeSvg({ width: '100%', height: '100%' });
  assert.equal(coverFitSvg(pct), false);
  assert.equal(pct.attrs.preserveAspectRatio, undefined);

  const bare = fakeSvg({});
  assert.equal(coverFitSvg(bare), false);
  assert.equal(bare.attrs.preserveAspectRatio, undefined);
});

test('non-svg input is ignored rather than mangled', () => {
  assert.equal(coverFitSvg(null), false);
  assert.equal(coverFitSvg(undefined), false);
  assert.equal(coverFitSvg({ tagName: 'div', getAttribute: () => null, setAttribute: () => {} }), false);
});

test('coverFitFirstSvg reaches into the container the panel actually builds', () => {
  const svg = fakeSvg({ viewBox: '0 0 1280 720' });
  const container = { querySelector: (sel) => (sel === 'svg' ? svg : null) };
  assert.equal(coverFitFirstSvg(container), true);
  assert.equal(svg.attrs.preserveAspectRatio, 'xMidYMid slice');

  assert.equal(coverFitFirstSvg({ querySelector: () => null }), false, 'empty container');
  assert.equal(coverFitFirstSvg(null), false);
});

test('the square-source case still covers (Stan’s 400x400 backgrounds)', () => {
  // A square SVG in a square tile is a no-crop exact fit — slice and meet agree.
  // The point is that we never *stretch*, whatever the source aspect.
  const svg = fakeSvg({ viewBox: '0 0 400 400' });
  coverFitSvg(svg);
  assert.equal(svg.attrs.preserveAspectRatio, 'xMidYMid slice');
});
