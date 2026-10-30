// platforms-table.test.mjs: Phase 1 step 3 of the calls library. What differs
// between the platforms the call view holds is data in main.js's PLATFORMS, and
// one activatePlatform(id) does the view swap the same way for every one. These
// pin the table's shape and the order activatePlatform does things in.
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../electron-app/main.js', import.meta.url), 'utf8');
const table = main.slice(main.indexOf('const PLATFORMS = {'), main.indexOf('function activatePlatform('));
const start = main.indexOf('function activatePlatform(');
const fn = main.slice(start, main.indexOf('\n}\n', start));

test('every platform has an entry', () => {
  for (const id of ['meet', 'slack', 'zoom', 'teams']) assert.match(table, new RegExp(`\\n  ${id}: \\{`), id);
  // telegram, whatsapp, twilio come from CALLING_APP_ORDER
  assert.match(table, /\.\.\.Object\.fromEntries\(CALLING_APP_ORDER\.map\(/);
  assert.ok(main.indexOf('const CALLING_APP_ORDER') < main.indexOf('const PLATFORMS = {'), 'built after CALLING_APP_ORDER exists');
});

test('each entry says how it presents itself to the site', () => {
  assert.match(table, /meet: \{[\s\S]*?identity: null,/);          // Electron's own Chrome (#930)
  assert.match(table, /zoom: \{[\s\S]*?identity: 'ua',/);
  assert.match(table, /teams: \{[\s\S]*?identity: 'ua\+hints',/);
  assert.match(table, /CALLING_APP_CALLS\[app\]\.preload,\s*identity: 'ua\+hints',/);
});

test('activatePlatform reports a torn-down standby, discards the old view, then builds the new one', () => {
  const order = [
    "if (!p.callingApp) noteCallingAppStandbyTeardown(",
    'destroyProviderView();',
    'ensureMeetSessionConfigured(partition);',
    'meetView = built.view;',
    'activePlatform = id;',
    'slackSurface = built.surface;',
    'layoutViews();',
  ].map((s) => { const i = fn.indexOf(s); assert.ok(i >= 0, s); return i; });
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('a link the platform does not take changes nothing', () => {
  const refuse = fn.indexOf("if (load && !startUrl) {");
  assert.ok(refuse >= 0 && refuse < fn.indexOf('destroyProviderView();'));
});

test('the room registers before the page loads', () => {
  assert.ok(fn.indexOf('const room = p.register') < fn.indexOf('meetView.webContents.loadURL(startUrl)'));
});
