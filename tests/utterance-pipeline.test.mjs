// utterance-pipeline.test.mjs — one pipeline, one preamble, one staleness
// evaluation (#493).
//
// THE BUG THIS LOCKS DOWN. Five call sites emitted audio and each wrote the
// same preamble by hand: set the urgency the barge-in grace scales from, set
// botState, dispatch. Two of the five never wrote the first line. So a probe
// was graded with whatever urgency the PREVIOUS utterance had scored, and
// _armBargeIn scaled its grace from that stale number — #367, which was
// "fixed" by adding the assignment to the paths someone remembered at the time.
//
// The tests below are therefore deliberately shaped as "every path, same
// guarantee" rather than "this path works". A new emit site that bypasses
// _emitUtterance should fail here, because the point was never the two missing
// assignments — it was that N sites means a fix is a fix per site.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const {
  makeUtterance, reduceUrgency, defaultStaleWhen, evaluateStaleness,
} = require('../electron-app/utterance.js');
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

const PREFS = {
  bargeInStashMaxAgeMs: 45_000,
  bargeInStashRedeliverMaxNewWords: 15,
  bargeInGraceMinMs: 1000,
  bargeInGraceMaxMs: 3000,
  probeFiring: true,
  probeMinIntervalMs: 0,
  probeGenericPhrases: ['Huh.'],
};

function makeServer(prefs = {}) {
  const spoken = [];
  const states = [];
  const s = new LocalServer({
    port: 0,
    onBotSpeech: (text, voice, emoji) => spoken.push({ text, voice, emoji }),
    onBotStateChange: (state) => states.push(state),
    getPref: (k) => ({ ...PREFS, ...prefs })[k],
  });
  s.setRoom('test-room');
  s.callStatus = 'in-call';
  s.mode = 'active';
  s.getEffectiveBotName = () => 'Alice';
  s.spoken = spoken;
  s.states = states;
  return s;
}

// ── the record ──────────────────────────────────────────────────────────────

test('an unscored utterance is null, not 0.5 — the midpoint belongs to the reader', () => {
  assert.equal(makeUtterance({ text: 'hi' }).urgency, null);
  assert.equal(makeUtterance({ text: 'hi', urgency: 0.9 }).urgency, 0.9);
});

test('resume is a declared property, defaulted by source, not inferred from provenance', () => {
  // Composed speech is worth finishing. An ack or a probe cut off mid-word
  // should die: "Mm-hmm" two seconds late is worse than silence.
  assert.equal(makeUtterance({ text: 'x', source: 'speak' }).resumable, true);
  assert.equal(makeUtterance({ text: 'x', source: 'stash-replay' }).resumable, true);
  assert.equal(makeUtterance({ text: 'x', source: 'probe' }).resumable, false);
  assert.equal(makeUtterance({ text: 'x', source: 'auto-leave' }).resumable, false);
  // ...and any caller may override, which is the part that matters: the split
  // stops depending on WHERE the audio came from.
  assert.equal(makeUtterance({ text: 'x', source: 'probe', resumable: true }).resumable, true);
});

test('the goodbye is exempt by declaration, not by having no gate at all', () => {
  assert.equal(makeUtterance({ text: 'bye', source: 'auto-leave' }).exempt, true);
  assert.equal(makeUtterance({ text: 'x', source: 'speak' }).exempt, false);
});

test('urgency reduces to a boolean at the threshold that earned its keep', () => {
  // 92% of 1000 scored arms were 0.4 or 0.5, so the continuum is fiction — but
  // the line at 0.5 blocked 150 ack decisions, so the line is real.
  assert.equal(reduceUrgency(0.4, 0.5), false);
  assert.equal(reduceUrgency(0.5, 0.5), true);
  assert.equal(reduceUrgency(0.9, 0.5), true);
  // Unscored → midpoint, matching _graceForCurrentUtterance's convention.
  assert.equal(reduceUrgency(undefined, 0.5), true);
  // Threshold off → everything interrupts, as today.
  assert.equal(reduceUrgency(0.1, 0), true);
});

test('a record with no text is not an utterance', () => {
  assert.equal(makeUtterance({ text: '' }), null);
  assert.equal(makeUtterance({}), null);
});

// ── the preamble, once, for every path ──────────────────────────────────────

test('a probe does not inherit the previous utterance\'s urgency (#367)', () => {
  const s = makeServer();
  s.participants = [{ name: 'Bob' }, { name: 'Carol' }];
  // A high-urgency utterance just went out and set the grade.
  s._emitUtterance(makeUtterance({ text: 'something urgent', urgency: 0.9 }));
  assert.equal(s._currentUrgency, 0.9);

  s._setBotState('listening', undefined, { force: true });
  s.anyoneSpeaking = false;
  assert.equal(s.fireProbe(), 'Huh.');

  // The bug: the probe used to be graded 0.9 and _armBargeIn scaled its grace
  // from that. A probe declares no urgency of its own.
  assert.equal(s._currentUrgency, null, 'probe must not inherit 0.9');
  const g = s._graceForCurrentUtterance();
  assert.equal(g.u, 0.5, 'unscored reads as the midpoint, like everywhere else');
  assert.equal(g.ms, 2000);
});

test('every emit path sets the urgency from its OWN record', () => {
  // The five paths, driven through the one chokepoint they now share. If a new
  // path is added that writes onBotSpeech directly, it will not appear here —
  // which is the failure mode this file exists to make visible.
  const s = makeServer();
  for (const [source, urgency, expected] of [
    ['speak', 0.8, 0.8],
    ['pending-flush', 0.3, 0.3],
    ['stash-replay', 0.6, 0.6],
    ['probe', undefined, null],
    ['auto-leave', undefined, null],
  ]) {
    s._currentUrgency = 0.95; // whatever the previous utterance left behind
    s._emitUtterance(makeUtterance({ text: 'x', source, urgency }));
    assert.equal(s._currentUrgency, expected, `${source} carries its own urgency`);
  }
});

test('the goodbye enters speaking, so leaveCall has in-flight TTS to wait on', () => {
  // It was the only emit site that set no state at all. leaveCall polls
  // botState to let the sign-off finish playing before tearing the call down;
  // with no transition, that loop had nothing to wait on and the line was
  // covered by a hardcoded 3s guess instead.
  const s = makeServer();
  s._sawOtherParticipant = true;
  s.participants = [];
  s.onLeaveCall = () => {};

  s._triggerAutoLeave();

  assert.equal(s.spoken.length, 1);
  assert.match(s.spoken[0].text, /signing off/);
  assert.equal(s.spoken[0].emoji, '👋');
  assert.equal(s.botState, 'speaking');
  assert.equal(s.speakingAloud, true, 'the latch leaveCall polls');
});

test('a passive bot still leaves quietly', () => {
  const s = makeServer();
  s.mode = 'passive';
  s._sawOtherParticipant = true;
  s.participants = [];
  s.onLeaveCall = () => {};

  s._triggerAutoLeave();
  assert.deepEqual(s.spoken, [], 'no sign-off, and no state transition either');
  assert.notEqual(s.botState, 'speaking');
});

test('_nowPlaying records the head — but speakingAloud is still the authority', () => {
  // Deliberately narrow. The record exists so that "is our audio playing" CAN
  // become derived (#412), but it is not derived yet: speakingAloud is still
  // the flag both barge-in gates depend on, and the raw botState write in
  // _buildResponse can still clobber it. Asserting anything stronger here would
  // let a green tick stand in for a fix this PR does not contain.
  const s = makeServer();
  assert.equal(s._nowPlaying, undefined);
  const rec = s._emitUtterance(makeUtterance({ text: 'hello', emoji: '💬', urgency: 0.7 }));
  assert.equal(s._nowPlaying, rec);
  assert.equal(s._nowPlaying.source, 'speak');
  // The flag is still set the old way, by _setBotState — which is the point.
  assert.equal(s.speakingAloud, true);
});

test('a stashed reply is the same record, not a copy of some of its fields', () => {
  // The old stash flattened each entry to { text, voice, emoji, urgency }, and
  // #367 was re-fixed on the line that destructured it back out. A record goes
  // in and the same record comes out, so nothing has to be re-inferred.
  const s = makeServer();
  const rec = makeUtterance({ text: 'held thought', voice: 'v', emoji: '💬', urgency: 0.65 });
  s._stashUnspokenSpeech([rec]);
  const held = s.bargeInStash.entries[0];
  assert.equal(held, rec, 'the identical record, not a reconstruction');
  assert.equal(held.urgency, 0.65);
  assert.equal(held.resumable, true);
  assert.equal(held.voice, 'v');
  // Provenance is where it was COMPOSED, and holding it does not change that.
  // 'stash-replay' is the fallback for legacy entries that never had a record.
  assert.equal(held.source, 'speak');
});

test('the pre-record stash shape still replays — plain objects are coerced', () => {
  // The tests that predate #493 build a stash by hand, and so did every
  // producer. Normalising on the way OUT is what lets the migration be a
  // strangler rather than a rewrite.
  const s = makeServer();
  s.bargeInStash = { entries: [{ text: 'legacy', urgency: 0.4 }], at: Date.now(), wordsAtStash: 0 };
  s._tickWordCount = () => 0;
  s.anyoneSpeaking = false;

  assert.deepEqual(s._maybeReplayBargeInStash(), ['legacy']);
  assert.equal(s._currentUrgency, 0.4, 'urgency survived the legacy shape');
});

// ── staleness: one mechanism, two signals ───────────────────────────────────

const stale = (opts, rec, room) =>
  defaultStaleWhen(opts)(rec || { at: 0 }, room || {});

test('age and new-words are separate signals, and the disagreements are the point', () => {
  const opts = { maxAgeMs: 45_000, maxNewWords: 15 };
  // 10 of 220 held replies waited 16-30s with ZERO new words. Time passed;
  // nothing was said; nothing went stale.
  assert.equal(stale(opts, { at: 0 }, { now: 29_500, newWords: 0 }), null);
  // 6 waited <=5s while 15-40 words landed on top of them. Stale in 3 seconds.
  const moved = stale(opts, { at: 0 }, { now: 3_100, newWords: 17 });
  assert.equal(moved.signal, 'words');
  // Either one alone throws away a real case.
  assert.equal(stale(opts, { at: 0 }, { now: 50_000, newWords: 0 }).signal, 'age');
});

test('the age gate is never waived; the word gate is, by name', () => {
  const opts = { maxAgeMs: 30_000, maxNewWords: 15 };
  const named = { now: 40_000, newWords: 99, addressedByName: true };
  assert.equal(stale(opts, { at: 0 }, named).signal, 'age',
    'a genuinely ancient thought is wrong to replay however it was asked for');

  const fresh = { now: 1_000, newWords: 99, addressedByName: true };
  const verdict = stale(opts, { at: 0 }, fresh);
  assert.equal(verdict.waived, true);
  assert.match(verdict.note, /addressed by name/);
});

test('the name scan is lazy — it only runs once the word gate trips', () => {
  const opts = { maxAgeMs: 30_000, maxNewWords: 15 };
  let scans = 0;
  const addressedByName = () => { scans++; return true; };

  stale(opts, { at: 0 }, { now: 1_000, newWords: 2, addressedByName });
  assert.equal(scans, 0, 'nothing to waive');

  stale(opts, { at: 0 }, { now: 1_000, newWords: 40, addressedByName });
  assert.equal(scans, 1);
});

test('an unbaselined word signal falls back to age only', () => {
  // The mid-TTS back-off path never records wordsAtStash. Zero is a real
  // measurement; null is the absence of one, and they must not be confused.
  const opts = { maxAgeMs: 30_000, maxNewWords: 15 };
  assert.equal(stale(opts, { at: 0 }, { now: 1_000, newWords: null }), null);
  assert.equal(stale(opts, { at: 0 }, { now: 1_000, newWords: 0 }), null);
});

test('a record may carry its own predicate, and it outranks the default', () => {
  const rec = makeUtterance({
    text: 'x',
    staleWhen: () => ({ signal: 'custom', note: 'because I said so', reason: 'custom' }),
  });
  const verdict = evaluateStaleness(rec, {}, defaultStaleWhen({ maxAgeMs: 1e9, maxNewWords: 1e9 }));
  assert.equal(verdict.signal, 'custom');
  // ...and with no predicate anywhere, nothing is stale.
  assert.equal(evaluateStaleness({ at: 0 }, {}, undefined), null);
});

test('thresholds are read when the floor opens, not when the reply was stashed', () => {
  // Both are tunable mid-call via set_preference, and a held reply must be
  // judged by the rule in force at the moment it would go out.
  let maxNewWords = 999;
  const s = makeServer();
  s._pref = (k) => (k === 'bargeInStashRedeliverMaxNewWords' ? maxNewWords
    : k === 'bargeInStashMaxAgeMs' ? 45_000 : PREFS[k]);
  s.bargeInStash = { entries: [{ text: 'held' }], at: Date.now(), wordsAtStash: 0 };
  s._tickWordCount = () => 40;
  s._entriesSince = () => [];
  s.anyoneSpeaking = false;

  maxNewWords = 15; // tightened after the reply was already being held
  assert.equal(s._maybeReplayBargeInStash(), null, 'judged by the new rule');
  assert.equal(s.bargeInStash, null);
});

// ── how many paths are there? ───────────────────────────────────────────────

test('there is exactly ONE place bot speech is dispatched', () => {
  // The original complaint was not "two sites forgot a line". It was that
  // nothing anywhere said how many paths existed, so every gate had to be
  // added N times and the bug count grew as gates × paths. This test is the
  // answer to "how many", and it fails when a new path is added rather than
  // years later on a call.
  const src = readFileSync(new URL('../electron-app/local-server.js', import.meta.url), 'utf8');
  const dispatches = src.match(/this\.onBotSpeech\(/g) || [];
  assert.equal(dispatches.length, 1,
    'onBotSpeech must be called only from _emitUtterance — route the new path through it');

  // Five submitters feed that one dispatch. The count is asserted so that
  // adding a sixth is a deliberate act with a test to update, not a silent one.
  const submits = src.match(/this\._emitUtterance\(/g) || [];
  assert.equal(submits.length, 5, 'speak, pending-flush, stash-replay, probe, auto-leave');
});

test('the audible paths NOT yet on the pipeline are named, not forgotten', () => {
  // play_audio and play_sound are audible, set botState, and — like the probe
  // and the goodbye did — never set _currentUrgency, so a sound effect after an
  // urgent utterance still borrows its grace. They dispatch through onPlayAudio
  // rather than onBotSpeech, and folding them in means deciding whether
  // _uninterruptiblePlayback is the same property as `exempt` (it is not
  // obviously: one gates STARTING over the room, the other gates STOPPING for
  // it). Left for the next step of the migration, counted here so it stays a
  // known gap rather than a rediscovery.
  const src = readFileSync(new URL('../electron-app/local-server.js', import.meta.url), 'utf8');
  const playbacks = src.match(/this\.onPlayAudio\(/g) || [];
  assert.equal(playbacks.length, 2, 'play-audio and play-sound');
});

test('exempt and interrupts stay distinct — that conflation was #109', () => {
  // `interrupts` is "worth interrupting a person for" (the 0.5 line, which the
  // data says earned its keep). `exempt` is that AND short enough to be an ack.
  // When length alone was the gate, 30-word paragraphs played over live humans;
  // all 14 exemptions on the Jul 28 call came through at a median of 18 words.
  const urgentButLong = makeUtterance({ text: 'x', urgency: 0.9, interrupts: true, exempt: false });
  assert.equal(urgentButLong.interrupts, true);
  assert.equal(urgentButLong.exempt, false, 'urgent is not licence to talk over someone');

  const shortAck = makeUtterance({ text: 'On it.', urgency: 0.6, interrupts: true, exempt: true });
  assert.equal(shortAck.exempt, true);
});
