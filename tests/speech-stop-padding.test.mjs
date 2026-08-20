// speech-stop-padding.test.mjs — the speaker tracker must report the TRUE stop
// edge; the padding that protects turn-resolution belongs to the silence gate
// that wants it (#395, following #392).
//
// The tracker used to hold a participant's `speaking` flag true for a
// hard-coded SPEAKING_GRACE_MS of 1000ms after their audio went quiet. The
// reason was sound — a breath mid-sentence must not read as "they finished" —
// but it was baked into the ONE shared flag, so every consumer inherited it.
//
// Measured live on call ded-iika-yrs (2026-08-15): every `→ true` transition
// came from the meter (sub-100ms); every `→ false` came from the poll, never
// sooner than 2.1s. That floor is LONGER than the barge-in grace a normal
// (urgency 0.4) utterance gets, so the grace could never expire into a cleared
// flag — a one-word interjection from a human cut the bot off every time,
// which is precisely what the grace exists to prevent. Reported from the room
// as: "I literally just said like one word, and you stopped talking."
//
// The pad is DELETED, not relocated (Stan, same call): the silence gate that
// wanted it already has `silenceSeconds`, and a flicker shorter than that
// threshold merely re-arms its timer. So the pad was a second, unnamed silence
// threshold stacked on the configured one — a 1.4s gate was really 2.4s, which
// is the "~1.4s extra wait observed every turn" the ingest code already
// complained about. One knob, honestly named: if the bot jumps in too fast,
// raise `silenceSeconds`.
//
// These tests pin both halves: the pad must be gone from the tracker AND must
// not reappear in the gate under a new name.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js'); // registers globalThis.LocalServer
const LocalServer = globalThis.LocalServer;

function makeServer(prefs = {}) {
  const s = new LocalServer({
    port: 0,
    getPref: (k) => ({ probeFiring: false, ...prefs })[k],
  });
  s.setRoom('test-room');
  s.callStatus = 'in-call';
  return s;
}

// --- the tracker side: no padding left in it ------------------------------

const providerSrc = readFileSync(
  new URL('../electron-app/google-meet-provider.js', import.meta.url), 'utf8');

test('#395: the speaker tracker no longer pads the stop edge', () => {
  assert.ok(!/SPEAKING_GRACE_MS\s*=/.test(providerSrc),
    'the hard-coded one-sided grace must be gone from the tracker');
  assert.ok(!/_isSpeakingWithGrace/.test(providerSrc),
    'the padded accessor must be gone, not merely unused');
  assert.ok(/_isSpeaking\s*\(info, now\)/.test(providerSrc),
    'the tracker exposes a plain, un-padded speaking check');
});

test('#395: the padded reading is not silently reintroduced at the combine layer', () => {
  // _rawSpeaking's rolling window is legitimate smoothing and stays. What must
  // not come back is a one-sided hold that only delays the FALSE edge.
  const held = /lastTrueAt\s*&&\s*\(now\s*-\s*info\.lastTrueAt\)\s*<\s*\w+/.test(providerSrc);
  assert.equal(held, false, 'no "still true because it was true recently" branch');
});

// --- the gate side: the padding survives, where it belongs -----------------

test('#395: silence is counted from the true stop edge, with nothing added', () => {
  const s = makeServer();
  const stopped = Date.now();
  s.lastSpeechStoppedAt = stopped;
  assert.equal(s.effectiveSilenceStart(), stopped,
    'the gate starts counting when the speaker actually stopped');
});

test('#395: no padding preference is reintroduced under any name', () => {
  // The pad was deleted, not relocated. A pref that re-adds a hidden delay in
  // front of silenceSeconds would recreate exactly the two-thresholds-for-one-
  // job problem this change removed.
  const schemaSrc = readFileSync(
    new URL('../electron-app/preferences-schema.js', import.meta.url), 'utf8');
  assert.ok(!/speechStopPaddingMs/.test(schemaSrc),
    'the relocated pad must not survive as a preference');
  const serverSrc = readFileSync(
    new URL('../electron-app/local-server.js', import.meta.url), 'utf8');
  assert.ok(!/speechStopPaddingMs/.test(serverSrc),
    'nor be read anywhere in the silence gate');
});

test('#395: the gate is honest when nobody has stopped yet', () => {
  const s = makeServer();
  s.lastSpeechStoppedAt = null;
  assert.equal(s.effectiveSilenceStart(), 0,
    'no stop edge means no timestamp to resolve from');
});
