// time-format.test.mjs — show times the way the USER asked for them.
//
// Stan, 2026-08-31: his Mac is set to 24-hour time and the calendar banner said
// "4:30 PM". The panel's code was not obviously wrong — it already passed `[]`
// for the system locale. The bug is that macOS keeps the 24-hour choice in a
// preference SEPARATE from the locale (AppleICUForce24HourTime) and Chromium's
// ICU resolves the hour cycle from the locale alone:
//
//     AppleICUForce24HourTime = 1      the checkbox is ticked
//     AppleLocale             = en_US
//     Intl ... hourCycle      = h12    what Electron believes
//
// So the preference has to be read and turned into an explicit `hour12`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { formatTime, formatDate, resolveHour12 } = require('../electron-app/time-format.js');

const read = (p) => fs.readFileSync(join(root, p), 'utf8');
const AT = '2026-08-31T16:30:00Z';

test('an explicit preference wins over the locale', () => {
  // The entire point: the locale says h12 and the user says otherwise.
  assert.match(formatTime(AT, { hour12: false }), /^\d{1,2}:\d{2}$/, 'no AM/PM');
  assert.match(formatTime(AT, { hour12: true }), /[AP]M$/i);
});

test('no preference means the locale decides — the old behaviour, kept', () => {
  // Correct on Linux (LC_TIME) and Windows, and the only sane fallback if
  // reading the macOS preference ever fails.
  // null, not undefined: a destructuring default only fires for undefined, so
  // `{hour12: undefined}` still consults the machine's real preference.
  const noPref = formatTime(AT, { hour12: null });
  const plainLocale = new Date(AT).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  assert.equal(noPref, plainLocale);
});

test('seconds are opt-in, and respect the preference too', () => {
  assert.match(formatTime(AT, { hour12: false, seconds: true }), /^\d{1,2}:\d{2}:\d{2}$/);
  assert.match(formatTime(AT, { hour12: false }), /^\d{1,2}:\d{2}$/);
});

test('resolveHour12 answers with a preference or with nothing', () => {
  const v = resolveHour12();
  assert.ok(v === true || v === false || v === undefined, `unexpected: ${v}`);
});

test('hours are not zero-padded under 12-hour', () => {
  // '2-digit' would render "04:30 PM", which no Mac does.
  const morning = formatTime('2026-08-31T15:05:00Z', { hour12: true });
  assert.doesNotMatch(morning, /^0\d:/, morning);
});

test('nothing hardcodes a locale any more', () => {
  // A hardcoded 'en-US' pins the separator and the ordering as well as the hour
  // cycle — it is wrong for every user outside one country, not just Stan.
  for (const f of [
    'electron-app/renderer/panel.js',
    'electron-app/page-inject.js',
    'electron-app/time-format.js',
    'mcp-server/call-time.js',
  ]) {
    // Strip comments first — these files DOCUMENT the old bad call, and a
    // scanner that reads prose flags the explanation as the offence.
    const src = read(f)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const bad = [...src.matchAll(/toLocale(?:Time|Date)?String\(\s*['"]/g)];
    assert.equal(bad.length, 0, `${f} passes a hardcoded locale to toLocale*String`);
  }
});

test('every renderer site can actually see the preference', () => {
  // Renderers cannot read the macOS preference themselves, so each one needs a
  // channel. Without this the code looks right and behaves exactly as before.
  const main = read('electron-app/main.js');
  assert.match(main, /ipcMain\.handle\('get-hour12'/, 'main must expose it');

  const panel = read('electron-app/renderer/panel.js');
  assert.match(panel, /invoke\('get-hour12'\)/, 'the panel must ask for it');
  assert.match(panel, /function fmtTime\(/);
  // And the calendar banner — the site Stan actually reported — must use it.
  assert.match(panel, /const localTime = fmtTime\(next\.start\)/);

  const preload = read('electron-app/preload-meet.js');
  assert.match(preload, /window\.__vibeconfHour12/, 'the meet preload must carry it in');
  const inject = read('electron-app/page-inject.js');
  assert.match(inject, /window\.__vibeconfHour12/, 'the canvas clock must read it');
});

test('a missing preference never throws or renders "undefined"', () => {
  // resolveHour12 shells out to `defaults`, which fails on a non-Mac and on a
  // Mac where the key is unset. Both must degrade to the locale, silently.
  for (const opts of [{}, { hour12: undefined }, { hour12: null }]) {
    const out = formatTime(AT, opts);
    assert.doesNotMatch(out, /undefined|null|NaN|Invalid/, `${JSON.stringify(opts)} -> ${out}`);
    assert.match(out, /\d/, out);
  }
});

test('dates go through the system locale as well', () => {
  assert.match(formatDate(AT), /\d/);
  assert.equal(formatDate(AT), new Date(AT).toLocaleDateString([], { dateStyle: 'medium' }));
});
