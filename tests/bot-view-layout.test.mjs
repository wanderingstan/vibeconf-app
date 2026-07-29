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

test('three states; the button toggles the RESTING one against popped', () => {
  assert.deepEqual(L.STATES, ['hidden', 'thumbnail', 'popped']);

  // Default resting state is 'hidden' (#103).
  assert.equal(L.nextState('hidden'), 'popped');
  assert.equal(L.nextState('popped'), 'hidden');

  // With the legacy preference, the same button means thumbnail ↔ popped.
  assert.equal(L.nextState('thumbnail', { restingState: 'thumbnail' }), 'popped');
  assert.equal(L.nextState('popped', { restingState: 'thumbnail' }), 'thumbnail');

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

// ── Out of a call the region doesn't exist at all (the bot's view used to sit
// there permanently showing a "This is the bot's view" placard). ──────────────

test('out of a call, the panel gets the whole column and there is no region', () => {
  for (const state of L.STATES) {
    const l = L.computeLayout(state, { width: 380, height: 800 }, { panelWidth: 380, inCall: false });
    assert.equal(l.regionHidden, true, `${state}: region is hidden out of a call`);
    assert.equal(l.meetBounds, null, `${state}: nothing docked`);
    assert.equal(l.placeholderBounds, null, `${state}: not even the popped-out placeholder`);
    assert.deepEqual(l.panelBounds, { x: 0, y: 0, width: 380, height: 800 },
      `${state}: the panel takes the full height`);
  }
});

test('in a call, the region comes back exactly as before', () => {
  const inCall = L.computeLayout('thumbnail', { width: 380, height: 800 }, { panelWidth: 380, inCall: true });
  const legacy = L.computeLayout('thumbnail', { width: 380, height: 800 }, { panelWidth: 380 });
  assert.deepEqual(inCall.meetBounds, legacy.meetBounds);
  assert.deepEqual(inCall.panelBounds, legacy.panelBounds);
  assert.ok(!inCall.regionHidden);
});

test('omitting inCall keeps the old behaviour, so existing callers are unaffected', () => {
  assert.equal(L.showRegion({}), true);
  assert.equal(L.showRegion({ panelWidth: 380 }), true);
  assert.equal(L.showRegion({ inCall: false }), false);
  assert.equal(L.showRegion({ inCall: true }), true);
});

test('a hidden region still reports a usable zoom (applyMeetZoom reads it)', () => {
  for (const state of L.STATES) {
    const l = L.computeLayout(state, { width: 380, height: 800 }, { panelWidth: 380, inCall: false });
    assert.ok(l.meetZoom >= L.MIN_ZOOM && l.meetZoom <= L.MAX_ZOOM, `${state}: zoom stays in range`);
  }
});

// --- #103: the 'hidden' resting state ---
//
// capturePage() returns bounds x devicePixelRatio with the page zoom already
// baked in — it does NOT re-render at 1:1. Measured, bounds fixed at 400x300:
//
//   zoom 1.00  innerWidth  400css  capture 800x600  a 100px box -> 200 px
//   zoom 0.32  innerWidth 1250css  capture 800x600  a 100px box ->  64 px
//
// So the thumbnail's zoom compensation, which exists to stop Meet reflowing,
// was ALSO shrinking what the bot could see. On the Jul 28 call that meant a
// participant's shared terminal arrived at ~3px per line and the bot had to say
// out loud that it couldn't read the screen. 'hidden' gives it real pixels.

test('hidden renders at full size and zoom 1 — the whole point of #103', () => {
  const h = L.computeLayout('hidden', { width: 380, height: 800 }, { panelWidth: 380 });
  assert.equal(h.meetZoom, 1, 'no zoom compensation: nothing is being squeezed into a column');
  assert.equal(h.meetInOwnWindow, true, 'it lives in its own (never-shown) host window');
  assert.equal(h.meetBounds, null, 'nothing to lay out inside the main window');
  assert.equal(h.placeholderBounds, null, 'and no "popped out" placard — nothing popped out');
  assert.equal(h.regionHidden, true);
});

test('hidden gives the panel the entire column', () => {
  const height = 800;
  const h = L.computeLayout('hidden', { width: 380, height }, { panelWidth: 380 });
  assert.deepEqual(h.panelBounds, { x: 0, y: 0, width: 380, height },
    'no 16:9 slab is reserved for a view nobody can see');
  assert.equal(L.regionHeightFor(380, 'hidden'), 0);
  assert.ok(L.regionHeightFor(380, 'thumbnail') > 0, 'thumbnail still reserves its region');
});

test('hidden beats thumbnail on captured pixels by a wide margin', () => {
  const thumb = L.computeLayout('thumbnail', { width: 380, height: 800 }, { panelWidth: 380 });
  const thumbPx = thumb.meetBounds.width * thumb.meetBounds.height;
  const hiddenPx = L.HIDDEN_SIZE.width * L.HIDDEN_SIZE.height;
  assert.ok(hiddenPx / thumbPx > 8,
    `only ${(hiddenPx / thumbPx).toFixed(1)}x more pixels — not worth the added window`);

  // The measured Jul 28 capture was 760x428, i.e. this region at 2x DPR.
  assert.equal(thumb.meetBounds.width * 2, 760, 'pins the observed docked capture width');
  assert.equal(thumb.meetBounds.height * 2, 428, 'pins the observed docked capture height');
});

test('hidden stays own-window OUT of a call too', () => {
  // The host persists between calls so the capture surface (and Meet) survive
  // the gap; the out-of-call branch must not report it as dockable.
  const h = L.computeLayout('hidden', { width: 380, height: 800 }, { panelWidth: 380, inCall: false });
  assert.equal(h.meetInOwnWindow, true);
  assert.equal(h.meetZoom, 1, 'and must not fall back to the thumbnail zoom');
  assert.equal(h.meetBounds, null);
});

test('thumbnail is unchanged — the legacy path still works exactly as before', () => {
  const t = L.computeLayout('thumbnail', { width: 380, height: 800 }, { panelWidth: 380 });
  assert.equal(t.meetInOwnWindow, false);
  assert.ok(t.meetBounds, 'still docked in the column');
  const virtual = t.meetBounds.width / t.meetZoom;
  assert.ok(Math.abs(virtual - L.MEET_TARGET_CSS_WIDTH) < 1,
    'and still pins Meet\'s virtual width so the DOM never reflows');
});
