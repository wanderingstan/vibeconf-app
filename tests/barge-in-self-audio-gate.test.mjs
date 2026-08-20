// barge-in-self-audio-gate.test.mjs — #467's gate is GONE (#487); this pins what
// survived it.
//
// The gate made analyser silence count for nothing whenever our own mic had
// been loud through it. It existed only because page-inject's echo guard (#245)
// blanked the far end while the bot spoke, so an interrupter arrived as
// fragments with blind gaps between — one fragment set _audioFloorOffAt and
// 250ms later the bot concluded they had finished. Measured yield rate against
// a sustained human interrupter: 1 in 6.
//
// #487 deleted the echo guard instead. With the analyser hearing an interrupter
// continuously, an OFF edge means what it says and #392's confirmation window
// does the work. Keeping the gate on top would have been strictly harmful: it
// refuses to trust silence for the whole of every utterance, so the bot could
// never ride out a cough.
//
// What is still tested here: #392's own two guards (silence must be confirmed,
// and must postdate the arm), and the self-audio envelope itself, which is kept
// as a diagnostic signal and must still track only LOUD edges, monotonically.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

function makeServer(prefs = {}) {
  const s = new LocalServer({
    port: 0,
    onBotSpeech: () => {},
    getPref: (k) => ({ bargeInQuietConfirmMs: 250, ...prefs })[k],
  });
  s.setRoom('test-room');
  s.callStatus = 'in-call';
  return s;
}

// Arm the monitor at t0, then report the analyser going quiet at `offAt`.
function armedWithQuietSince(s, { armedAt, offAt }) {
  s._bargeInArmedAt = armedAt;
  s.audioFloorSpeaking = false;
  s._audioFloorOffAt = offAt;
  return s;
}

test('confirmed analyser silence after the arm means the blip is over', () => {
  // #392's case. The interruption ended inside the grace window, so the bot
  // keeps its sentence. Post-#487 this is decided by the analyser alone.
  const s = makeServer();
  const now = Date.now();
  armedWithQuietSince(s, { armedAt: now - 2000, offAt: now - 1000 });
  assert.equal(s._floorQuietPerAnalyser(now), true, 'trustworthy silence');
});

test('the self-audio envelope no longer influences the decision at all', () => {
  // #487: loud or quiet, ours is not evidence about them any more.
  const s = makeServer();
  const now = Date.now();
  armedWithQuietSince(s, { armedAt: now - 2000, offAt: now - 1000 });
  assert.equal(s._selfAudioLastLoudAt, undefined);
  assert.equal(s._floorQuietPerAnalyser(now), true);
  s._selfAudioLastLoudAt = now;               // loud right up to this instant
  assert.equal(s._floorQuietPerAnalyser(now), true, 'same verdict either way');
});

test('an analyser still hearing someone is never "quiet"', () => {
  const s = makeServer();
  s.audioFloorSpeaking = true;
  assert.equal(s._floorQuietPerAnalyser(), false);
});

test('silence that predates the arm is still not evidence', () => {
  // #392's other guard: an OFF edge from before this interruption says nothing
  // about it. Unchanged.
  const s = makeServer();
  const now = Date.now();
  armedWithQuietSince(s, { armedAt: now - 1000, offAt: now - 3000 });
  s._selfAudioLastLoudAt = now - 9000;
  assert.equal(s._floorQuietPerAnalyser(now), false);
});

test('setSelfAudioLoud only advances on LOUD edges, and never rewinds', () => {
  // Kept as a diagnostic: the envelope is still published (#422 scores against
  // it offline) even though barge-in no longer consults it, and a quiet edge
  // read as "we stopped being loud at T" would corrupt those recordings.
  const s = makeServer();
  s.setSelfAudioLoud(true, 1000);
  s.setSelfAudioLoud(false, 5000);
  assert.equal(s._selfAudioLastLoudAt, 1000, 'a quiet edge must not advance it');
  s.setSelfAudioLoud(true, 3000);
  assert.equal(s._selfAudioLastLoudAt, 3000);
  s.setSelfAudioLoud(true, 2000);
  assert.equal(s._selfAudioLastLoudAt, 3000, 'an out-of-order edge must not rewind it');
});
