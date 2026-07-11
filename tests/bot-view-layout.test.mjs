// bot-view-layout.test.mjs — the geometry + zoom for the bot's Meet thumbnail.
//
// The load-bearing claim: in both states (thumbnail ↔ popped), Meet's VIRTUAL
// viewport width stays constant, so its layout never reflows and every DOM
// selector keeps working. Only the rendered scale changes. These pin that
// invariant and the toggle; the Electron window surgery on top is not
// unit-testable and lives in main.js.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../electron-app/bot-view-layout.js');

test('it toggles thumbnail ↔ popped (no separate expanded state)', () => {
  assert.deepEqual(L.STATES, ['thumbnail', 'popped']);
  assert.equal(L.nextState('thumbnail'), 'popped');
  assert.equal(L.nextState('popped'), 'thumbnail');
  assert.equal(L.nextState('nonsense'), 'popped', 'a bad state toggles toward popped');
});

test('the whole point: the thumbnail holds Meet\'s virtual width at the pinned target', () => {
  const thumb = L.computeLayout('thumbnail', { width: 380, height: 800 }, { panelWidth: 380 });
  // virtual width = device width / zoom.
  const thumbVirtual = thumb.meetBounds.width / thumb.meetZoom;
  assert.ok(Math.abs(thumbVirtual - L.MEET_TARGET_CSS_WIDTH) < 1,
    `thumbnail virtual width ${thumbVirtual} should be ~${L.MEET_TARGET_CSS_WIDTH}`);
  // The popped window renders Meet at that same virtual width (device 880 / 0.75).
  assert.ok(Math.abs(880 / L.POPPED_ZOOM - L.MEET_TARGET_CSS_WIDTH) < 20,
    'the large window shows the same layout, just unscaled');
});

test('thumbnail: narrow column, panel on top, Meet 16:9 below', () => {
  const l = L.computeLayout('thumbnail', { width: 380, height: 900 }, { panelWidth: 380 });
  assert.equal(l.meetInOwnWindow, false);
  // Meet region is a 16:9 box at column width.
  assert.equal(l.meetBounds.width, 380);
  assert.equal(l.meetBounds.height, Math.round(380 * 9 / 16)); // 214
  // Panel sits above it and fills the rest.
  assert.equal(l.panelBounds.x, 0);
  assert.equal(l.panelBounds.y, 0);
  assert.equal(l.panelBounds.height, 900 - 214);
  assert.equal(l.meetBounds.y, 900 - 214, 'meet is directly below the panel, no gap');
  // The zoom compensates the column width down to the target virtual width.
  assert.ok(Math.abs(l.meetZoom - 380 / 1173) < 1e-9);
  assert.equal(l.clamped, false, '380px is well above the zoom floor');
  assert.equal(l.placeholderBounds, null, 'no placeholder while docked');
});

test('popped: Meet leaves the main window; a placeholder fills the region it left', () => {
  const l = L.computeLayout('popped', { width: 380, height: 900 }, { panelWidth: 380 });
  assert.equal(l.meetInOwnWindow, true);
  assert.equal(l.meetBounds, null, 'no Meet in the main window');
  // The column keeps its shape: panel on top, 16:9 region below — now a placeholder.
  const region = { x: 0, y: 900 - 214, width: 380, height: 214 };
  assert.deepEqual(l.placeholderBounds, region, 'placeholder occupies the freed region, not an empty rectangle');
  assert.deepEqual(l.panelBounds, { x: 0, y: 0, width: 380, height: 900 - 214 });
  assert.equal(l.meetZoom, L.POPPED_ZOOM, 'the floating window shows Meet at today\'s zoom');
});

test('the column keeps the SAME shape across the toggle — only the region occupant changes', () => {
  const thumb = L.computeLayout('thumbnail', { width: 380, height: 900 }, { panelWidth: 380 });
  const popped = L.computeLayout('popped', { width: 380, height: 900 }, { panelWidth: 380 });
  assert.deepEqual(thumb.panelBounds, popped.panelBounds, 'panel bounds identical, so nothing reshuffles');
  assert.deepEqual(thumb.meetBounds, popped.placeholderBounds, 'thumbnail Meet region == popped placeholder region');
  assert.equal(thumb.placeholderBounds, null);
  assert.equal(popped.meetBounds, null);
});

test('the main window is always a narrow column, in both states', () => {
  assert.equal(L.windowWidthFor('thumbnail', { panelWidth: 380 }), 380);
  assert.equal(L.windowWidthFor('popped', { panelWidth: 380 }), 380);
});

test('the zoom is clamped at the Chromium floor, and says when layout is no longer exact', () => {
  // A normal panel width stays above the floor.
  const ok = L.meetZoomForWidth(380);
  assert.ok(ok.zoom > L.MIN_ZOOM && !ok.clamped);

  // An absurdly narrow column would need a sub-0.25 zoom; we clamp and flag it.
  const tiny = L.meetZoomForWidth(200);
  assert.equal(tiny.zoom, L.MIN_ZOOM);
  assert.equal(tiny.clamped, true, 'below the floor, Meet would reflow — the caller should know');
});

test('degenerate sizes never produce negative bounds', () => {
  for (const size of [{ width: 0, height: 0 }, { width: 100, height: 50 }, {}]) {
    for (const state of L.STATES) {
      const l = L.computeLayout(state, size, { panelWidth: 380 });
      for (const b of [l.panelBounds, l.meetBounds, l.placeholderBounds]) {
        if (!b) continue;
        assert.ok(b.width >= 0 && b.height >= 0, `${state} @ ${JSON.stringify(size)} → non-negative bounds`);
      }
    }
  }
});
