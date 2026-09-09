// stash-replay-is-ordered.test.mjs — a held reply must take its turn too (#442).
//
// #442 named this the most likely way a room with two bots still hears them
// talk over each other after #426: two bots that stashed during the SAME busy
// floor both wake on the SAME opening, and with nothing between them they
// start together. The floor check added later stops a replay landing on speech
// already in progress; it does nothing about two replays starting at once,
// because at that instant the floor is genuinely open for both.
//
// So the replay path consults the same ranked order as fresh speech. Two
// things the issue warned about, both pinned here:
//
//   • DO NOT DOUBLE-DELAY. "A stash has already waited; adding a full ranked
//     delay on top may push it past the opening it was waiting for." The gap
//     is botSpeakReplayRankGapMs (200ms), not botSpeakRankGapMs (500ms).
//   • A ranked delay is not a licence to speak at the end of it. If a
//     higher-ranked bot took the opening during the wait, the reply stays held
//     for the next one — the floor is re-read at the instant audio would start
//     (#67), exactly as it is for fresh speech.
//
// Run: node --test tests/stash-replay-is-ordered.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;
const { speakOrder } = require('../electron-app/speak-order.js');

const PEERS = ['Pepper', 'Scripty'];
const SPEAKER = 'Stan';
const UTTERANCE = 'what should we do about the class next week';

function makeServer(botName, prefs = {}) {
  const spoken = [];
  const s = new LocalServer({
    port: 0,
    onBotSpeech: (text) => spoken.push(text),
    getConfiguredBotName: () => botName,
    getPref: (k) => ({
      botSpeakOrdering: 'ranked',
      botSpeakSeed: 'clock',
      botSpeakClockBucketMs: 6000,
      botSpeakRankGapMs: 500,
      botSpeakReplayRankGapMs: 200,   // explicit: the DEFAULT is 500, see the schema note
      botSpeakJitterMaxMs: 0,
      bargeInStashMaxAgeMs: 45000,
      bargeInStashRedeliverMaxNewWords: 60,
      ...prefs,
    })[k],
  });
  s.setRoom('test-room');
  s.callStatus = 'in-call';
  s.mode = 'active';
  s.spoken = spoken;
  // Peers named explicitly: presence discovery needs a backend, and this test
  // is about the ordering, not about how the roster was learned.
  s._presencePeers = [...PEERS];
  s.setParticipants([
    { name: SPEAKER, speaking: false, isSelf: false },
    ...PEERS.filter((p) => p !== botName).map((p) => ({ name: p, speaking: false, isSelf: false })),
  ]);
  // The human turn every bot keys on.
  s._turnsAsEntries = () => [{ participantName: SPEAKER, text: UTTERANCE, at: Date.now() }];
  return s;
}

const stashOne = (s, text) => {
  s.bargeInStash = { entries: [{ text, voice: null, emoji: null, urgency: 0.4 }], at: Date.now(), seqAtStash: 0 };
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// Which of the two peers is ranked first for this turn, so the test asserts
// against the real order rather than a hardcoded guess that could flip.
const RANKED = speakOrder({ botNames: PEERS, speaker: SPEAKER, utterance: UTTERANCE }).map((e) => e.bot);
const FIRST = RANKED[0];
const SECOND = RANKED[1];

test('the rank-0 bot replays immediately — a winner waits for nothing', async () => {
  const s = makeServer(FIRST);
  stashOne(s, 'the first bot reply');
  const out = s._maybeReplayBargeInStash();
  assert.deepEqual(out, ['the first bot reply'], 'replayed synchronously');
  assert.deepEqual(s.spoken, ['the first bot reply']);
});

test('the rank-1 bot waits its turn instead of starting alongside', async () => {
  const s = makeServer(SECOND);
  stashOne(s, 'the second bot reply');
  const out = s._maybeReplayBargeInStash();
  assert.equal(out, null, 'not spoken yet — it is holding for its rank');
  assert.deepEqual(s.spoken, [], 'nothing has gone out');
  await settle(300);
  assert.deepEqual(s.spoken, ['the second bot reply'], 'spoken once the gap elapsed');
});

test('the replay gap is the SHORT one — a stash has already waited (#442)', async () => {
  const s = makeServer(SECOND);
  stashOne(s, 'held reply');
  const startedAt = Date.now();
  s._maybeReplayBargeInStash();
  await settle(300);
  const waited = Date.now() - startedAt;
  assert.deepEqual(s.spoken, ['held reply']);
  assert.ok(waited < 500,
    `rank-1 replay should use botSpeakReplayRankGapMs (200ms), not botSpeakRankGapMs (500ms); waited ~${waited}ms`);
});

test('if a higher-ranked bot takes the opening during the wait, the reply stays held', async () => {
  const s = makeServer(SECOND);
  stashOne(s, 'should not be said');
  s._maybeReplayBargeInStash();
  // The rank-0 peer starts talking while this bot is waiting out its gap —
  // which is exactly what the gap is for.
  s.setParticipants([
    { name: SPEAKER, speaking: false, isSelf: false },
    { name: FIRST, speaking: true, isSelf: false },
  ]);
  await settle(300);
  assert.deepEqual(s.spoken, [], 'the floor was busy at audio-start, so nothing played');
  assert.ok(s.bargeInStash, 'and the reply survives for the next opening');
});

test('with ordering off, a replay behaves exactly as it did before', async () => {
  // The fallback is what makes this safe to ship: no peers, no order, no delay
  // — and critically NOT a jitter wait, which is the ~1000ms a held reply
  // cannot afford.
  const s = makeServer(SECOND, { botSpeakOrdering: 'jitter' });
  stashOne(s, 'unordered reply');
  const out = s._maybeReplayBargeInStash();
  assert.deepEqual(out, ['unordered reply'], 'replayed synchronously, as before');
});

// --- what the caller is told, which is not the same as what was said -------

test('a deferred replay still tells the agent its held reply went out', async () => {
  // The synchronous callers do `const replayed = _maybeReplayBargeInStash();
  // if (replayed) this._lastReplayedStash = replayed`, and _buildResponse hands
  // that to the agent so it "learns its queued thought went out and builds on
  // it instead of repeating it".
  //
  // A ranked hold returns null — there is nothing to inspect yet — so without
  // setting the marker from inside the timer the reply is SPOKEN and the agent
  // is never told. It then answers the same question again a few seconds later.
  // That is every rank>=1 bot: half the replays in a two-bot room.
  const s = makeServer(SECOND);
  stashOne(s, 'the held reply');
  assert.equal(s._maybeReplayBargeInStash(), null, 'held for its rank');
  await settle(400);
  assert.deepEqual(s.spoken, ['the held reply'], 'it was spoken');
  assert.deepEqual(s._lastReplayedStash, ['the held reply'],
    'and the agent is told, exactly as the synchronous path tells it');
});

test('a reply superseded during the hold is not spoken', async () => {
  // #519: if the agent has submitted a newer thought, the held one is no longer
  // its latest word. That guard runs before the hold; the hold gives it time to
  // become true, so it has to run again after.
  const s = makeServer(SECOND);
  stashOne(s, 'superseded reply');
  s.bargeInStash.seqAtStash = 0;
  s._maybeReplayBargeInStash();
  s._agentUtteranceSeq = 1;              // the agent moved on while we waited
  await settle(400);
  assert.deepEqual(s.spoken, [], 'the stale reply must not go out');
});

test('going silent during the hold cancels the replay', async () => {
  // "Act but never speak". _maybeReplayStashOnOpening checks this before it
  // ever calls the replay; the hold reopens the window.
  const s = makeServer(SECOND);
  stashOne(s, 'should stay unsaid');
  s._maybeReplayBargeInStash();
  s.mode = 'silent';
  await settle(400);
  assert.deepEqual(s.spoken, []);
});

test('leaving the call during the hold cancels the replay', async () => {
  const s = makeServer(SECOND);
  stashOne(s, 'should stay unsaid');
  s._maybeReplayBargeInStash();
  s.callStatus = 'left';
  await settle(400);
  assert.deepEqual(s.spoken, [], 'nothing is emitted into a call that ended');
});

test('two callers landing on one opening still speak exactly once', async () => {
  // The opening timer and the waiter's silence resolve are scheduled from the
  // same speech-stop edge, so both call this within milliseconds.
  //
  // What protects against double speech is the stash-identity check in the
  // timer, not the clearTimeout beside it — this test passes without the
  // clearTimeout, and that is worth stating rather than implying coverage the
  // test does not have. The clearTimeout stops a HANDLE leaking, which nothing
  // here can observe.
  const s = makeServer(SECOND);
  stashOne(s, 'said once');
  s._maybeReplayBargeInStash();
  s._maybeReplayBargeInStash();
  await settle(400);
  assert.deepEqual(s.spoken, ['said once'], 'exactly once, not twice');
});

test('the server seeds the order from the silence edge, not from "now"', async () => {
  // The seed must be the same for both decisions a bot makes about one turn,
  // and the same for both bots. lastSpeechStoppedAt is one physical event all
  // bots observe within the detection spread; Date.now() at decision time is
  // not — the start decision and the yield decision run up to 1.5s apart.
  const { clockKey } = require('../electron-app/speak-order.js');
  const s = makeServer(FIRST);
  s.lastSpeechStoppedAt = 1757400000123;
  const ctx = s._rankedContext();
  assert.equal(ctx.seed, clockKey(1757400000123, 6000),
    'seeded from the edge, bucketed at the default 6s');

  // Time passing must not move it — that is the property "now" would break.
  await settle(30);
  assert.equal(s._rankedContext().seed, ctx.seed);
});

test('with no silence edge yet, it falls back to the utterance seed', () => {
  // The first turn of a call. The content seed is what shipped, so falling back
  // to it means the old behaviour rather than no ordering at all.
  const s = makeServer(FIRST);
  s.lastSpeechStoppedAt = 0;
  assert.equal(s._rankedContext().seed, undefined);
});

test('botSpeakSeed="utterance" restores the original content seed', () => {
  const s = makeServer(FIRST, { botSpeakSeed: 'utterance' });
  s.lastSpeechStoppedAt = 1757400000123;
  assert.equal(s._rankedContext().seed, undefined, 'no clock seed — speakOrder falls back to turnKey');
});
