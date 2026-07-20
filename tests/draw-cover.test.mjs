// draw-cover.test.mjs — the cover-fit geometry used to paint the avatar
// background onto the virtual camera (#428). The real drawCover lives inside
// page-inject.js (a browser-context IIFE, not importable), so this pins the
// MATH it implements: scale by the larger axis ratio, center the overflow.
// If the implementation ever drifts back to a stretch, these numbers change.
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mirror of drawCover's geometry (page-inject.js). Returns the drawImage args.
function coverRect(sw, sh, w, h) {
  const scale = Math.max(w / sw, h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  return { dx: (w - dw) / 2, dy: (h - dh) / 2, dw, dh };
}

const aspect = (r) => r.dw / r.dh;

test('square source on a 16:9 canvas: aspect preserved, top/bottom cropped evenly', () => {
  const r = coverRect(400, 400, 1280, 720); // the real-world case: viewBox 0 0 400 400
  assert.equal(aspect(r), 1, 'a square must stay square — this is the squashed-sun bug');
  assert.equal(r.dw, 1280);
  assert.equal(r.dh, 1280);
  assert.equal(r.dx, 0, 'fills the width exactly');
  assert.equal(r.dy, (720 - 1280) / 2, 'overflow centered vertically');
  assert.equal(r.dy, -280);
});

test('covers the whole canvas — never letterboxes', () => {
  for (const [sw, sh] of [[400, 400], [1920, 1080], [100, 3000], [3000, 100]]) {
    const r = coverRect(sw, sh, 1280, 720);
    assert.ok(r.dw >= 1280 - 1e-9, `width covers (${sw}x${sh})`);
    assert.ok(r.dh >= 720 - 1e-9, `height covers (${sw}x${sh})`);
    assert.ok(r.dx <= 1e-9 && r.dy <= 1e-9, 'overflow crops outward, never inset');
  }
});

test('matching aspect is an exact fit with no crop', () => {
  const r = coverRect(1920, 1080, 1280, 720);
  assert.equal(r.dw, 1280);
  assert.equal(r.dh, 720);
  assert.equal(r.dx, 0);
  assert.equal(r.dy, 0);
});

test('future portrait canvas: wide source crops left/right, aspect preserved', () => {
  const r = coverRect(1280, 720, 720, 1280); // 16:9 source, 9:16 canvas
  assert.ok(Math.abs(aspect(r) - 1280 / 720) < 1e-9, 'source aspect preserved');
  assert.equal(r.dh, 1280, 'fills the height');
  assert.ok(r.dx < 0 && r.dy === 0, 'crops horizontally, centered');
});

test('source aspect is always preserved, never the canvas aspect', () => {
  for (const [sw, sh] of [[400, 400], [800, 200], [200, 800], [1024, 768]]) {
    const r = coverRect(sw, sh, 1280, 720);
    assert.ok(Math.abs(aspect(r) - sw / sh) < 1e-9, `${sw}x${sh} keeps its aspect`);
  }
});
