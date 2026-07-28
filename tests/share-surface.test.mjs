// share-surface.test.mjs — sizing the shared board, and the input events the
// bot sends into it.
//
// The event builders are worth testing because synthetic input fails SILENTLY
// when the shape is wrong: a 'char' event carrying "Enter" types the word
// rather than pressing the key, and a keyDown with no matching 'char' moves
// focus without inserting anything. Neither throws — the board just doesn't
// change, which is indistinguishable from the page ignoring the click.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  SHARE_SIZE, SHARE_GAP, resolveShareSize, shareWindowPosition,
  normalizeModifiers, keyEventsFor, clickEventsFor,
} = require('../electron-app/share-surface.js');

// A 1512x945 work area with the menu bar taken off the top — a MacBook default.
const AREA = { x: 0, y: 25, width: 1512, height: 920 };

// --- sizing ---------------------------------------------------------------

test('the recommended board is square — Meet stacks tiles down the right (#4)', () => {
  assert.equal(SHARE_SIZE.recommended.width, SHARE_SIZE.recommended.height);
  assert.equal(SHARE_SIZE.recommended.width, 800);
});

test('an omitted dimension keeps the current one, so "wider" is a single field', () => {
  const r = resolveShareSize({ width: 1200 }, { width: 800, height: 800 });
  assert.equal(r.width, 1200);
  assert.equal(r.height, 800, 'height untouched');
  assert.deepEqual(r.notes, []);
});

test('no current size falls back to the recommended square', () => {
  const r = resolveShareSize({}, null);
  assert.deepEqual({ width: r.width, height: r.height }, SHARE_SIZE.recommended);
});

test('out-of-range clamps rather than failing — a board is better than an error', () => {
  const big = resolveShareSize({ width: 99999, height: 10 }, { width: 800, height: 800 });
  assert.equal(big.width, SHARE_SIZE.max);
  assert.equal(big.height, SHARE_SIZE.min);
  assert.equal(big.notes.length, 2, 'both adjustments are explained back to the agent');
  assert.match(big.notes[0], /maximum/);
  assert.match(big.notes[1], /minimum/);
});

test('garbage keeps the current value and says so', () => {
  const r = resolveShareSize({ width: 'wide' }, { width: 800, height: 800 });
  assert.equal(r.width, 800);
  assert.match(r.notes[0], /not a number/);
});

test('fractional sizes round — window dimensions are whole pixels', () => {
  const r = resolveShareSize({ width: 640.6, height: 480.2 }, null);
  assert.equal(r.width, 641);
  assert.equal(r.height, 480);
});

// --- modifiers ------------------------------------------------------------

test('Mac-flavoured modifier names map to what Electron expects', () => {
  assert.deepEqual(normalizeModifiers(['cmd']), ['meta']);
  assert.deepEqual(normalizeModifiers(['Command', 'Shift']), ['meta', 'shift']);
  assert.deepEqual(normalizeModifiers(['option']), ['alt']);
  assert.deepEqual(normalizeModifiers(['ctrl']), ['control']);
});

test('unknown modifiers are dropped, not passed through to Electron', () => {
  assert.deepEqual(normalizeModifiers(['hyper', 'shift']), ['shift']);
  assert.deepEqual(normalizeModifiers(undefined), []);
});

test('duplicates collapse', () => {
  assert.deepEqual(normalizeModifiers(['cmd', 'meta', 'command']), ['meta']);
});

// --- typing ---------------------------------------------------------------

test('text becomes one char event per character', () => {
  const { events } = keyEventsFor({ text: 'hi' });
  assert.deepEqual(events, [
    { type: 'char', keyCode: 'h', modifiers: [] },
    { type: 'char', keyCode: 'i', modifiers: [] },
  ]);
});

test('a named key becomes keyDown/keyUp, NOT a char event', () => {
  const { events } = keyEventsFor({ key: 'Enter' });
  assert.deepEqual(events.map(e => e.type), ['keyDown', 'keyUp']);
  assert.equal(events[0].keyCode, 'Enter');
  assert.ok(!events.some(e => e.type === 'char'),
    'a char event would type the literal word "Enter"');
});

test('a newline inside typed text presses Return rather than inserting \\n', () => {
  const { events } = keyEventsFor({ text: 'a\nb' });
  assert.deepEqual(events.map(e => e.type), ['char', 'keyDown', 'keyUp', 'char']);
  assert.equal(events[1].keyCode, 'Return');
});

test('text WITH modifiers is a shortcut, not literal characters', () => {
  const { events } = keyEventsFor({ text: 'a', modifiers: ['cmd'] });
  assert.deepEqual(events.map(e => e.type), ['keyDown', 'keyUp'],
    'cmd+A is select-all; char events carry no modifier state');
  assert.deepEqual(events[0].modifiers, ['meta']);
});

test('unicode is handled per code point, not per UTF-16 unit', () => {
  const { events } = keyEventsFor({ text: '🙂' });
  assert.equal(events.length, 1, 'one emoji is one char event, not two surrogates');
  assert.equal(events[0].keyCode, '🙂');
});

test('nothing to type is an error, not a silent no-op', () => {
  const r = keyEventsFor({});
  assert.deepEqual(r.events, []);
  assert.match(r.error, /text|key/i);
});

test('empty text is treated as nothing to type', () => {
  assert.ok(keyEventsFor({ text: '' }).error);
});

// --- clicking -------------------------------------------------------------

test('a click moves the mouse first, so hover-driven UI opens before the press', () => {
  const { events } = clickEventsFor({ x: 10, y: 20 });
  assert.deepEqual(events.map(e => e.type), ['mouseMove', 'mouseDown', 'mouseUp']);
  assert.ok(events.every(e => e.x === 10 && e.y === 20));
});

test('button defaults to left and unknown buttons do not reach Electron', () => {
  assert.equal(clickEventsFor({ x: 1, y: 1 }).events[1].button, 'left');
  assert.equal(clickEventsFor({ x: 1, y: 1, button: 'right' }).events[1].button, 'right');
  assert.equal(clickEventsFor({ x: 1, y: 1, button: 'spin' }).events[1].button, 'left');
});

test('a double click carries clickCount 2 on both press events', () => {
  const { events } = clickEventsFor({ x: 5, y: 5, clickCount: 2 });
  assert.equal(events[1].clickCount, 2);
  assert.equal(events[2].clickCount, 2);
});

test('coordinates round, and non-numeric coordinates are refused', () => {
  assert.equal(clickEventsFor({ x: 10.6, y: 4.2 }).events[0].x, 11);
  const bad = clickEventsFor({ x: 'middle', y: 4 });
  assert.deepEqual(bad.events, []);
  assert.match(bad.error, /numeric/i);
});

test('0,0 is a legitimate click target', () => {
  const r = clickEventsFor({ x: 0, y: 0 });
  assert.equal(r.error, undefined, 'falsy-but-valid coordinates must not be rejected');
  assert.equal(r.events.length, 3);
});

// --- positioning ------------------------------------------------------------

test('the board sits to the LEFT of the app, top-aligned', () => {
  // App parked top-right, the way people actually keep it.
  const main = { x: 1100, y: 60, width: 400, height: 700 };
  const p = shareWindowPosition({ mainBounds: main, workArea: AREA, width: 800, height: 800 });
  assert.equal(p.side, 'left');
  assert.equal(p.x, 1100 - SHARE_GAP - 800, 'right edge hugs the app');
  assert.equal(p.y, 60, 'top-aligned with the app');
});

test('the RIGHT edge is anchored, so growing the board extends leftward', () => {
  const main = { x: 1100, y: 60, width: 400, height: 700 };
  const narrow = shareWindowPosition({ mainBounds: main, workArea: AREA, width: 400, height: 400 });
  const wide = shareWindowPosition({ mainBounds: main, workArea: AREA, width: 800, height: 400 });
  assert.equal(narrow.x + 400, wide.x + 800,
    'both end at the same right edge — the board grows away from the app, not under it');
});

test('no room on the left falls back to the right', () => {
  const main = { x: 40, y: 60, width: 400, height: 700 };
  const p = shareWindowPosition({ mainBounds: main, workArea: AREA, width: 800, height: 800 });
  assert.equal(p.side, 'right');
  assert.equal(p.x, 40 + 400 + SHARE_GAP);
});

test('when neither side fits, stay on-screen rather than tidy', () => {
  // A board nearly as wide as the display: overlap is acceptable, off-screen is not.
  const main = { x: 600, y: 60, width: 400, height: 700 };
  const p = shareWindowPosition({ mainBounds: main, workArea: AREA, width: 1400, height: 800 });
  assert.equal(p.side, 'clamped');
  assert.ok(p.x >= AREA.x, 'not off the left edge');
  assert.ok(p.x + 1400 <= AREA.x + AREA.width, 'not off the right edge');
});

test('a tall board is pulled up so its bottom stays on-screen', () => {
  const main = { x: 1100, y: 800, width: 400, height: 120 };
  const p = shareWindowPosition({ mainBounds: main, workArea: AREA, width: 800, height: 800 });
  assert.equal(p.y, AREA.y + AREA.height - 800);
  assert.ok(p.y >= AREA.y);
});

test('the top never lands above the work area (under the menu bar)', () => {
  const main = { x: 1100, y: 0, width: 400, height: 700 };
  const p = shareWindowPosition({ mainBounds: main, workArea: AREA, width: 800, height: 800 });
  assert.equal(p.y, AREA.y);
});

test('a second display with a non-zero origin is handled', () => {
  const area = { x: 1512, y: 0, width: 1920, height: 1080 };
  const main = { x: 2900, y: 100, width: 400, height: 700 };
  const p = shareWindowPosition({ mainBounds: main, workArea: area, width: 800, height: 800 });
  assert.equal(p.side, 'left');
  assert.ok(p.x >= area.x, 'stays on the second display, not spilling onto the first');
});

test('missing bounds returns null rather than guessing', () => {
  assert.equal(shareWindowPosition({ workArea: AREA, width: 800, height: 800 }), null);
  assert.equal(shareWindowPosition({ mainBounds: { x: 0, y: 0, width: 10, height: 10 } }), null);
});
