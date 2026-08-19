// pref-coercion.test.mjs — a stored preference must not be able to mean
// something different from what the reader expects (#417).
//
// The bug, measured: `get floorBusy()` was gated on
//
//     this._pref('fastFloorDetection') === true
//
// and `_pref` returned the stored value untouched. A pin written as the STRING
// "true" therefore fails `=== true` and disables the fast floor exactly as
// thoroughly as `false` — with no warning, and indistinguishable from `false` in
// any dump of the config.
//
// On the 2026-08-17 call this cost three barge-ins. The bot began speaking
// 0.19-0.40s after a human, every time, because floorBusy consulted only the DOM
// tracker — which on the measured event lagged the analyser by 1069ms.
//
// The fix is at the root rather than the two call sites: stored values go
// through validate(), so the schema's type is what the reader gets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

function serverWith(stored) {
  return new LocalServer({ port: 0, onBotSpeech: () => {}, getPref: (k) => stored[k] });
}

test('a stringified boolean resolves to a real boolean', () => {
  for (const [raw, want] of [['true', true], ['false', false], ['on', true], ['off', false]]) {
    assert.equal(serverWith({ fastFloorDetection: raw })._pref('fastFloorDetection'), want,
      `stored ${JSON.stringify(raw)}`);
  }
});

test('the fast floor survives a stringified "true" — the exact regression', () => {
  // With the old `=== true`, this returned the DOM-only floor and the bot spoke
  // over people. Assert on the OBSERVABLE behaviour, not just the pref read.
  const s = serverWith({ fastFloorDetection: 'true' });
  s.anyoneSpeaking = false;
  s.audioFloorSpeaking = true;      // the analyser hears someone
  assert.equal(s.floorBusy, true, 'the analyser edge must count as a busy floor');
});

test('a genuine false still disables the fast floor', () => {
  // The pin has to keep working — this is a fix for type confusion, not a
  // removal of the setting.
  const s = serverWith({ fastFloorDetection: false });
  s.anyoneSpeaking = false;
  s.audioFloorSpeaking = true;
  assert.equal(s.floorBusy, false);
});

test('an unset preference uses the schema default, which is fast-floor ON', () => {
  const s = serverWith({});
  s.anyoneSpeaking = false;
  s.audioFloorSpeaking = true;
  assert.equal(s.floorBusy, true);
});

test('a stringified number resolves to a number', () => {
  // Same class of hazard for arithmetic: "1500" + 100 is "1500100".
  const v = serverWith({ bargeInGraceMs: '1500' })._pref('bargeInGraceMs');
  assert.equal(v, 1500);
  assert.equal(typeof v, 'number');
});

test('an unusable stored value falls back to the default rather than propagating', () => {
  // An out-of-range or nonsense value is not a preference, it is a mistake, and
  // honouring it is how one machine ends up behaving unlike every other.
  const orig = console.warn;
  console.warn = () => {};
  try {
    assert.equal(serverWith({ fastFloorDetection: 'maybe' })._pref('fastFloorDetection'), true);
    assert.equal(serverWith({ bargeInGraceMs: 'soon' })._pref('bargeInGraceMs'), 1500);
  } finally { console.warn = orig; }
});

test('an unusable value is warned about once, not silently or repeatedly', () => {
  // Silence is the whole failure mode here. But a warning on every read would
  // be its own problem — _pref runs on the speak path.
  const warned = [];
  const orig = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    const s = serverWith({ fastFloorDetection: 'maybe' });
    for (let i = 0; i < 5; i++) s._pref('fastFloorDetection');
  } finally { console.warn = orig; }
  assert.equal(warned.length, 1, `warned ${warned.length} times`);
  assert.match(warned[0], /fastFloorDetection/);
  assert.match(warned[0], /"maybe"/, 'quote what was actually stored');
  assert.match(warned[0], /default/, 'and say what is used instead');
});

test('an unknown preference key still returns undefined', () => {
  assert.equal(serverWith({})._pref('noSuchPreference'), undefined);
});
