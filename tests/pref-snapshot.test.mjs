// pref-snapshot.test.mjs — a log must say which settings were live (#417).
//
// The failure this is for: a bot talked over a human three times on 2026-08-17
// because ONE preference on ONE machine (`fastFloorDetection`) sat at a
// non-default value. Nothing in its 8,000-line log said so. Working it out took
// three separate statistical arguments — counting stashes against DOM state,
// counting utterances that began while the analyser was busy, and matching 7
// barge-in arms against 770 analyser edges to show the analyser was never
// consulted. One line of log would have replaced all of it.
//
// Two hard requirements, and they pull against each other:
//   - COMPLETE. The old header dumped eight hand-picked prefs as raw store
//     values, and the one that mattered was not among them.
//   - SAFE. The same file holds `ttsApiKey` and `vcSessionToken`, and this block
//     is shipped to the log backend, copied into shared Drive folders, and
//     attached to bug reports. Dumping the file verbatim publishes credentials.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { snapshotForLog, PREFERENCES } = require('../electron-app/preferences-schema.js');

// A store shaped like the real one: get(key) reads one, get() returns all.
const storeOf = (data) => (k) => (k === undefined ? { ...data } : data[k]);

test('a pinned preference is called out, with the default beside it', () => {
  // The whole point. "fastFloorDetection=false" alone is not enough — a reader
  // has to know that is UNUSUAL to know it is the answer.
  const lines = snapshotForLog(storeOf({ fastFloorDetection: false }));
  const pin = lines.find((l) => l.includes('PINNED'));
  assert.ok(pin, 'a non-default value must be flagged');
  assert.match(pin, /fastFloorDetection=false/);
  assert.match(pin, /default true/);
});

test('the summary counts the pins, so a clean machine is obvious at a glance', () => {
  const clean = snapshotForLog(storeOf({}));
  assert.match(clean[0], /0 differing from defaults/);
  const dirty = snapshotForLog(storeOf({ fastFloorDetection: false, probeFiring: true }));
  assert.match(dirty[0], /2 differing from defaults/);
});

test('a value equal to the default is not reported as a pin', () => {
  // Otherwise every explicitly-set-to-default value becomes noise and the real
  // pins stop standing out.
  const lines = snapshotForLog(storeOf({ fastFloorDetection: true }));
  assert.equal(lines.filter((l) => l.includes('PINNED')).length, 0);
});

test('a stringified boolean is COERCED, not treated as off', () => {
  // The trap that cost two days: `_pref('fastFloorDetection') === true` reads a
  // stored string as "off" however the string reads, so `"true"` would disable
  // the fast floor exactly as thoroughly as `false`. Both _pref and this now go
  // through validate, so the stored form no longer decides behaviour.
  const on = snapshotForLog(storeOf({ fastFloorDetection: 'true' }));
  assert.equal(on.filter((l) => l.includes('PINNED')).length, 0,
    '"true" must resolve to the default, not to a pin or an error');

  const off = snapshotForLog(storeOf({ fastFloorDetection: 'false' }));
  const pin = off.find((l) => l.includes('PINNED'));
  assert.match(pin, /fastFloorDetection=false/, 'and "false" must resolve to false');
});

test('a value that cannot be coerced is reported INVALID with what is used instead', () => {
  // Coercion has limits, and where it stops the snapshot has to say so — an
  // unusable stored value is exactly as invisible as a wrong one otherwise.
  const lines = snapshotForLog(storeOf({ fastFloorDetection: 'maybe' }));
  const pin = lines.find((l) => l.includes('PINNED') && l.includes('fastFloorDetection'));
  assert.ok(pin, 'an unusable value must be surfaced');
  assert.match(pin, /INVALID/);
  assert.match(pin, /using true/, 'and name the value the code will actually use');
});

test('every schema preference appears, not a hand-picked subset', () => {
  // The old header carried eight. `fastFloorDetection` was not one of them.
  const body = snapshotForLog(storeOf({})).join('\n');
  for (const key of Object.keys(PREFERENCES)) {
    assert.ok(body.includes(`${key}=`), `${key} missing from the snapshot`);
  }
});

test('credentials are redacted by key name', () => {
  // Matched on the NAME, because a token is only recognisable by where it
  // lives. This block goes to the log backend and to shared Drive folders.
  const lines = snapshotForLog(storeOf({
    ttsApiKey: 'sk-elevenlabs-REALSECRET',
    vcSessionToken: 'eyJhbGciOiJIUzI1NiJ9.REALJWT',
    someAuthHeader: 'Bearer REALTOKEN',
  })).join('\n');
  assert.doesNotMatch(lines, /REALSECRET/);
  assert.doesNotMatch(lines, /REALJWT/);
  assert.doesNotMatch(lines, /REALTOKEN/);
  assert.match(lines, /ttsApiKey=<redacted>/, 'but its PRESENCE is still shown');
  assert.match(lines, /vcSessionToken=<redacted>/);
});

test('non-schema keys are included — they change behaviour too', () => {
  // 20 of 43 keys in a real config are not in PREFERENCES, and several plainly
  // matter. Skipping them would repeat this bug's shape: a complete-looking
  // snapshot missing the one line that mattered.
  const lines = snapshotForLog(storeOf({
    dangerousMode: true, claudeModel: 'sonnet', ackProvider: 'builtin',
  })).join('\n');
  assert.match(lines, /not in the schema/);
  assert.match(lines, /dangerousMode=true/);
  assert.match(lines, /claudeModel="sonnet"/);
});

test('a huge value is truncated rather than flooding the log', () => {
  // A real config holds a 14KB base64 profile icon and a 3KB SVG background.
  const lines = snapshotForLog(storeOf({ profileIcon: 'x'.repeat(20000) })).join('\n');
  assert.ok(lines.length < 6000, `snapshot ballooned to ${lines.length} chars`);
  assert.match(lines, /\.\.\.\(\d+ chars\)/, 'and says it was truncated');
});

test('a store that cannot enumerate degrades to schema-only', () => {
  // Not every caller has a store that answers get() with the whole object. That
  // must cost the non-schema section, not the whole snapshot.
  const lines = snapshotForLog((k) => (k === 'probeFiring' ? true : undefined));
  assert.match(lines[0], /74 settings|[0-9]+ settings/);
  assert.ok(lines.some((l) => l.includes('PINNED probeFiring=true')));
  assert.ok(!lines.some((l) => l.includes('not in schema')));
});

test('a throwing store does not take the call down with it', () => {
  // This runs on the call-start path. Diagnostics must never be why a call fails.
  const boom = () => { throw new Error('store exploded'); };
  assert.doesNotThrow(() => snapshotForLog(boom));
  assert.doesNotThrow(() => snapshotForLog(undefined));
  assert.doesNotThrow(() => snapshotForLog(null));
});

test('the label identifies which call this was', () => {
  // A session log holds several calls, and preferences change between them.
  const lines = snapshotForLog(storeOf({}), { label: 'call abc-defg-hij-20260819T000000Z' });
  assert.match(lines[0], /call abc-defg-hij-20260819T000000Z/);
});
