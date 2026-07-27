// svg-scope.test.mjs — inline SVG ids must be namespaced per injected copy.
//
// The panel paints the same background SVG into several tiles at once. Inline
// SVG ids are DOCUMENT-global, so without this every copy's `url(#sky)` and
// `<use href="#cloud">` resolved to the first match in document order — the
// masthead copy, which sits inside #mainScreen and is display:none whenever the
// Settings screen is up. A paint server in a display:none subtree paints
// nothing, so gradient fills and <use> silently vanished while literal fills
// kept working: reported live as "black sky and no clouds", hills still there.
//
// Reproduced in Chrome before fixing: three inline copies, first one hidden →
// copies two and three lost their sky and clouds exactly as the app did.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scopeSvgIds } = require('../electron-app/renderer/svg-scope.js');

const SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">',
  '<defs>',
  '<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#bfe3f2"/></linearGradient>',
  '<g id="cloud"><circle cx="60" cy="48" r="42"/></g>',
  '</defs>',
  '<rect width="1280" height="720" fill="url(#sky)"/>',
  '<use href="#cloud" transform="translate(140 150)"/>',
  '<use xlink:href="#cloud" transform="translate(980 110)"/>',
  '<path d="M0 430 L1280 430 Z" fill="#a8c46f"/>',
  '</svg>',
].join('');

test('definitions and every reference to them move together', () => {
  const out = scopeSvgIds(SVG, 'vbg7');
  assert.match(out, /id="vbg7-sky"/);
  assert.match(out, /id="vbg7-cloud"/);
  assert.match(out, /fill="url\(#vbg7-sky\)"/);
  assert.match(out, /\shref="#vbg7-cloud"/);
  assert.match(out, /xlink:href="#vbg7-cloud"/);
  // A reference left pointing at the old id would render as nothing — the very
  // bug this exists to prevent.
  assert.ok(!/#sky\b/.test(out.replace(/vbg7-sky/g, '')), 'no bare #sky reference may survive');
  assert.ok(!/#cloud\b/.test(out.replace(/vbg7-cloud/g, '')), 'no bare #cloud reference may survive');
});

test('two copies of the same SVG end up sharing no ids', () => {
  const a = scopeSvgIds(SVG, 'vbg1');
  const b = scopeSvgIds(SVG, 'vbg2');
  const idsOf = (s) => [...s.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const idsA = idsOf(a);
  const idsB = idsOf(b);
  assert.ok(idsA.length > 0);
  assert.equal(idsA.some((id) => idsB.includes(id)), false, 'copies must not collide');
});

test('literal fills are untouched', () => {
  // These never broke; if a rewrite ever mangles a colour we want to know.
  assert.match(scopeSvgIds(SVG, 'vbg1'), /fill="#a8c46f"/);
});

test('references to ids this SVG does not define are left alone', () => {
  // Silently repointing an external reference would be worse than leaving it.
  const svg = '<svg><rect fill="url(#elsewhere)"/></svg>';
  assert.equal(scopeSvgIds(svg, 'vbg1'), svg);
});

test('an SVG with no ids, and empty input, pass through unchanged', () => {
  const plain = '<svg><rect fill="#fff"/></svg>';
  assert.equal(scopeSvgIds(plain, 'vbg1'), plain);
  assert.equal(scopeSvgIds('', 'vbg1'), '');
  assert.equal(scopeSvgIds(null, 'vbg1'), null);
});

test('a missing scope is a no-op rather than an "undefined-" prefix', () => {
  assert.equal(scopeSvgIds(SVG, ''), SVG);
});
