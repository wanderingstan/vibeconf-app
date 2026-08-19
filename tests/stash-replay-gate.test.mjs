// stash-replay-gate.test.mjs — a held reply must pass the same floor gate as a
// fresh one (#430/#442).
//
// Freshly composed speech goes through _speakWithBotJitter, which re-reads the
// floor at the instant audio would start (#67) — the only instant a floor read
// means anything. A replayed stash called onBotSpeech directly, so it skipped
// that gate entirely and could play into a gap somebody was already taking.
// Observed twice on the 2026-08-17 call.
//
// One caller (_maybeReplayStashOnOpening) happened to check floorBusy before
// calling. The other — the wait_for_speech resolve path — did not, which is why
// this belongs inside the replay rather than at its call sites.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

function makeServer(prefs = {}) {
  const spoken = [];
  const s = new LocalServer({
    port: 0,
    onBotSpeech: (text) => spoken.push(text),
    getPref: (k) => ({
      bargeInStashMaxAgeMs: 45_000,
      bargeInStashRedeliverMaxNewWords: 15,
      ...prefs,
    })[k],
  });
  s.setRoom('test-room');
  s.callStatus = 'in-call';
  s.mode = 'active';
  s.spoken = spoken;
  return s;
}

const stash = (s, entries) => {
  s.bargeInStash = { entries, at: Date.now(), wordsAtStash: 0 };
};

test('a replay does not play into a busy floor', () => {
  const s = makeServer();
  stash(s, [{ text: 'the thing I was going to say' }]);
  s.anyoneSpeaking = true;                     // somebody is talking

  assert.equal(s._maybeReplayBargeInStash(), null, 'must not speak');
  assert.deepEqual(s.spoken, []);
  assert.ok(s.bargeInStash, 'and the stash must SURVIVE for the next opening');
});

test('a replay does play when the floor is genuinely open', () => {
  const s = makeServer();
  stash(s, [{ text: 'the thing I was going to say' }]);
  s.anyoneSpeaking = false;

  const out = s._maybeReplayBargeInStash();
  assert.deepEqual(out, ['the thing I was going to say']);
  assert.deepEqual(s.spoken, ['the thing I was going to say']);
  assert.equal(s.bargeInStash, null, 'and the stash is consumed');
});

test('the analyser counts as a busy floor for a replay too', () => {
  // #115: floorBusy is analyser-or-DOM. The analyser leads the DOM by up to a
  // second, and that lead is the whole window a replay could sneak into.
  const s = makeServer({ fastFloorDetection: true });
  stash(s, [{ text: 'held' }]);
  s.anyoneSpeaking = false;
  s.audioFloorSpeaking = true;

  assert.equal(s._maybeReplayBargeInStash(), null);
  assert.ok(s.bargeInStash);
});

test('a replayed utterance carries its OWN urgency, not the last one used', () => {
  // urgency was preserved into the stash and then dropped by the destructure,
  // so _armBargeIn scaled the replay's grace from whatever spoke before it.
  const s = makeServer();
  s._currentUrgency = 0.9;                     // a previous, urgent utterance
  stash(s, [{ text: 'a low-stakes aside', urgency: 0.2 }]);
  s.anyoneSpeaking = false;

  s._maybeReplayBargeInStash();
  assert.equal(s._currentUrgency, 0.2, 'the replay must be graded on its own urgency');
});

test('an entry with no urgency clears the stale one rather than inheriting it', () => {
  const s = makeServer();
  s._currentUrgency = 0.9;
  stash(s, [{ text: 'no urgency recorded' }]);
  s.anyoneSpeaking = false;

  s._maybeReplayBargeInStash();
  assert.equal(s._currentUrgency, null);
});

test('a re-held stash keeps its original age', () => {
  // Otherwise a reply outlives bargeInStashMaxAgeMs indefinitely, one hold at a
  // time — and that guard exists because a stale answer is worse than none.
  const s = makeServer();
  const composedAt = Date.now() - 30_000;
  s._tickWordCount = () => 0;

  s._stashUnspokenSpeech([{ text: 'held once' }], { at: composedAt });
  assert.equal(s.bargeInStash.at, composedAt);

  s._stashUnspokenSpeech([{ text: 'held once' }], { at: s.bargeInStash.at });
  assert.equal(s.bargeInStash.at, composedAt, 'a re-hold must not restamp it');
});

test('a fresh stash with no explicit time is stamped now', () => {
  const s = makeServer();
  s._tickWordCount = () => 0;
  const before = Date.now();
  s._stashUnspokenSpeech([{ text: 'new thought' }]);
  assert.ok(s.bargeInStash.at >= before);
});

test('the age and relevance guards still run before the floor check', () => {
  // The floor check must not mask them: a stash that is too old should be
  // DISCARDED with its reason logged, not held forever because someone happened
  // to be talking.
  const s = makeServer({ bargeInStashMaxAgeMs: 1000 });
  s.bargeInStash = { entries: [{ text: 'ancient' }], at: Date.now() - 60_000, wordsAtStash: 0 };
  s.anyoneSpeaking = true;

  assert.equal(s._maybeReplayBargeInStash(), null);
  assert.equal(s.bargeInStash, null, 'an aged-out stash is discarded, not held');
});
