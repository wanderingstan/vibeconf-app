// self-view-in-grid.test.mjs — the selectors and gotchas behind #737: putting
// the bot's own camera in Meet's grid rather than the floating self view, so
// the recorded region is a plain rectangle the view size can make 16:9 (#735).
//
// The routine itself lives inside google-meet-provider.js's injected page
// script and is not importable, so these pin the SELECTOR CONTRACT and the two
// traps that cost real debugging time during the live recon.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const selectors = require('../electron-app/meet-selectors.js');
const MEET = selectors.MEET || selectors;
const PROVIDER = readFileSync(new URL('../electron-app/google-meet-provider.js', import.meta.url), 'utf8');

test('the self-view selectors are text/ARIA based, never minified classes', () => {
  const SV = MEET.selfView;
  assert.ok(SV, 'selfView block exists');
  assert.equal(SV.moreOptions, 'button[aria-label^="More options for"]');
  // Meet interpolates the bot's display name, so it MUST be a prefix match.
  assert.ok(SV.moreOptions.includes('^='), 'must match the prefix: the label ends with the bot name');
  assert.equal(SV.showInTileText, 'show in a tile');
  // Minified tokens churn between Meet builds. jsname is Meet's own stable
  // hook and is the documented exception in this file's house style.
  for (const [k, v] of Object.entries(SV)) {
    if (typeof v !== 'string') continue;
    assert.ok(!/VYBDae|aqdrmf|oZRSLe|[A-Za-z]{6}-[A-Za-z0-9]{6}/.test(v), `${k} must not use a minified class: ${v}`);
  }
});

test('the item is matched case-insensitively on text, so a label tweak does not break it', () => {
  assert.equal(MEET.selfView.showInTileText, MEET.selfView.showInTileText.toLowerCase());
  assert.match(PROVIDER, /toLowerCase\(\)/, 'the provider lowercases before comparing');
});

test('TRAP 1: the More options button is a toggle, so the click is guarded on aria-expanded', () => {
  // Clicking it while the menu is open CLOSES the menu. A probe that clicked
  // unconditionally reported "menu item not found" for exactly this reason,
  // and a retry loop doing the same would fail on every even attempt.
  assert.equal(MEET.selfView.expandedAttr, 'aria-expanded');
  assert.match(PROVIDER, /getAttribute\(SV\.expandedAttr\) !== 'true'\) btn\.click\(\)/,
    'the open click must be guarded on aria-expanded');
});

test('TRAP 2: menu items are searched in the menu that APPEARED, not page-wide', () => {
  // Three [role="menu"] nodes are in the DOM at all times before anything is
  // clicked (caption size, caption colour, and a global menu). A page-wide
  // query returns those, which reads as success when nothing was clicked.
  assert.match(PROVIDER, /const before = new Set\(document\.querySelectorAll\(SV\.menu\)\)/,
    'must snapshot the menus present before opening');
  assert.match(PROVIDER, /\.filter\(\(m\) => !before\.has\(m\)\)/,
    'must scope to menus that were not there before');
});

test('a missing item counts as success, because Meet drops it once already in the grid', () => {
  assert.match(PROVIDER, /already in the grid/, 'the no-item path must report ok');
  assert.match(PROVIDER, /ok: true, why: 'no "Show in a tile" item/,
    'idempotency: re-running on an already-in-grid call must not be an error');
});

test('the self tile is found by the People pane "(You)" row, excluding panel copies', () => {
  // The same data-participant-id appears on the grid tile AND on the People
  // pane listitem; only the grid one is the tile.
  assert.match(PROVIDER, /function selfGridTile\(\)/);
  assert.match(PROVIDER, /role="complementary"\], \[role="region"\], \[role="dialog"\], nav, header/,
    'must exclude panel/dialog copies, same exclusion record-region.js uses');
  assert.equal(MEET.people.selfMarker, '(You)');
});

test('it retries after admission rather than firing once, and gives up quietly', () => {
  // The grid, the People pane and the self tile all render after the toolbar.
  assert.match(PROVIDER, /function showSelfViewInGridWhenReady/);
  assert.match(PROVIDER, /showSelfViewInGridWhenReady\(\);/, 'armed at admission');
  assert.match(PROVIDER, /gave up putting the self view in the grid/, 'bounded, and says so');
  assert.match(PROVIDER, /clearInterval\(timer\)/, 'stops rather than polling all call');
});

test('it never throws: every failure leaves the status quo', () => {
  const fn = PROVIDER.slice(PROVIDER.indexOf('async function showSelfViewInGrid('));
  assert.match(fn.slice(0, 3000), /catch \(err\)/, 'the whole attempt is wrapped');
});
