// barge-in-self-audio-gate.test.mjs — silence only counts as evidence if we
// could have heard through it (#467).
//
// The bot yielded to a sustained human interrupter 1 time in 6, failing
// identically every time: barge-in ARMED, then `_evaluateBargeIn` concluded
// "interruption already ended" and talked straight through a person.
//
// The cause is that page-inject's echo guard (#245) forces the far-end verdict
// false whenever the bot's own mic is loud, so while the bot talks an
// interrupter reaches the analyser as fragments with blind gaps between them.
// Same audio, same room: floor episodes of 3.0-5.1s while the bot was quiet,
// 0.35-0.49s while it spoke.
//
// The sharp edge is that a PARTIAL glimpse was worse than none: with no
// floor-audio events at all the monitor stays armed and the bot yields
// ("uncertainty means not quiet", #392), but ONE fragment sets _audioFloorOffAt
// and 250ms later the bot decides they finished.
//
// The gate is deliberately not a longer timeout. A timeout also discards #392's
// real case — a blip that genuinely ends during a gap in the bot's own speech,
// where keeping the sentence is right. Asking "was OUR audio quiet through that
// silence" separates the two exactly.

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

test('analyser silence counts when our own audio was silent through it', () => {
  // #392's case, preserved. The blip ended during a gap in the bot's speech, so
  // the quiet is real evidence and the bot should keep its sentence.
  const s = makeServer();
  const now = Date.now();
  armedWithQuietSince(s, { armedAt: now - 2000, offAt: now - 1000 });
  s._selfAudioLastLoudAt = now - 3000;        // we went quiet BEFORE the analyser did
  assert.equal(s._floorQuietPerAnalyser(now), true, 'trustworthy silence');
});

test('analyser silence counts for NOTHING if we were loud during it', () => {
  // #467. Our mic was loud after the analyser fell silent, so the echo guard was
  // suppressing and that silence says nothing about the person.
  const s = makeServer();
  const now = Date.now();
  armedWithQuietSince(s, { armedAt: now - 2000, offAt: now - 1000 });
  s._selfAudioLastLoudAt = now - 200;         // still talking, well after the OFF edge
  assert.equal(s._floorQuietPerAnalyser(now), false, 'we could not have heard them');
});

test('loudness exactly at the OFF edge already disqualifies the silence', () => {
  // The boundary matters: the suppression that produced the OFF edge is the
  // thing being ruled out, so >= rather than >.
  const s = makeServer();
  const now = Date.now();
  armedWithQuietSince(s, { armedAt: now - 2000, offAt: now - 1000 });
  s._selfAudioLastLoudAt = now - 1000;
  assert.equal(s._floorQuietPerAnalyser(now), false);
});

test('with no self-audio signal at all, behaviour is exactly as before', () => {
  // Degrades safely: an older renderer, or the envelope never arriving, must not
  // change the decision — it just does not get the improvement.
  const s = makeServer();
  const now = Date.now();
  armedWithQuietSince(s, { armedAt: now - 2000, offAt: now - 1000 });
  assert.equal(s._selfAudioLastLoudAt, undefined);
  assert.equal(s._floorQuietPerAnalyser(now), true, 'unchanged from the old path');
});

test('an analyser still hearing someone is never "quiet", whatever we are doing', () => {
  const s = makeServer();
  s.audioFloorSpeaking = true;
  s._selfAudioLastLoudAt = Date.now() - 5000;
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
  // The quiet edges are published too (#422 keeps both for offline scoring), and
  // treating one as "we stopped being loud at T" would let a mid-word dip make
  // the analyser's silence look trustworthy again.
  const s = makeServer();
  s.setSelfAudioLoud(true, 1000);
  s.setSelfAudioLoud(false, 5000);
  assert.equal(s._selfAudioLastLoudAt, 1000, 'a quiet edge must not advance it');
  s.setSelfAudioLoud(true, 3000);
  assert.equal(s._selfAudioLastLoudAt, 3000);
  s.setSelfAudioLoud(true, 2000);
  assert.equal(s._selfAudioLastLoudAt, 3000, 'an out-of-order edge must not rewind it');
});
