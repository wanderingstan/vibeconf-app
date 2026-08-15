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
// So: the tracker tells the truth, and `speechStopPaddingMs` re-applies the
// margin inside the silence gate only. These tests pin BOTH halves — the gate
// must still be padded (or turns resolve a second early), and the padding must
// not leak into anything else.
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

test('#395: the silence gate still waits out the padding before counting silence', () => {
  const s = makeServer({ speechStopPaddingMs: 1000 });
  // Someone stopped speaking RIGHT NOW. With a 1s pad the gate must not treat
  // silence as having started yet.
  s.lastSpeechStoppedAt = Date.now();
  assert.equal(s.effectiveSilenceStart(), s.lastSpeechStoppedAt + 1000,
    'silence starts one padded second after the true stop edge');
});

test('#395: the padding is configurable, and 0 means "trust the true edge"', () => {
  const s = makeServer({ speechStopPaddingMs: 0 });
  s.lastSpeechStoppedAt = Date.now();
  assert.equal(s.effectiveSilenceStart(), s.lastSpeechStoppedAt,
    'a zero pad resolves from the real stop edge');
});

test('#395: a missing/invalid pref falls back to the 1000ms it replaced', () => {
  const s = makeServer({}); // no speechStopPaddingMs at all
  s.lastSpeechStoppedAt = Date.now();
  assert.equal(s.effectiveSilenceStart(), s.lastSpeechStoppedAt + 1000,
    'default preserves the behaviour the tracker used to provide');
});

test('#395: no stop edge yet means no padded timestamp to resolve from', () => {
  const s = makeServer({ speechStopPaddingMs: 1000 });
  s.lastSpeechStoppedAt = null;
  assert.equal(s.effectiveSilenceStart(), 0,
    'padding must not manufacture a stop that never happened');
});
