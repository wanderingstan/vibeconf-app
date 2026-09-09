// speak-order.test.mjs — do all the bots reach the SAME conclusion?
//
// This replaces random jitter (#230/#100) with a deterministic ordering every
// bot computes independently. The whole thing rests on one property: given the
// same roster and the same utterance, every bot must produce the same order.
// If they don't, they all think they won, and the result is worse than the
// jitter it replaced.
//
// So most of these tests are agreement tests, and the rest are about the ways
// agreement could quietly break — a bot's own name in the key, an ASR revision
// changing the seed, a substring matching the wrong name.
//
// Run: node --test tests/speak-order.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { speakOrder, speakDelay, turnKey, clockKey, nameMentioned, mentionedBots, lastMentionIndex, hash32 } =
  require('../electron-app/speak-order.js');

const BOTS = ['Alice', 'Jimmy', 'Cosmo'];
const orderOf = (utterance, speaker = 'Stan', bots = BOTS) =>
  speakOrder({ botNames: bots, speaker, utterance }).map((e) => e.bot);

// --- the property everything depends on ------------------------------------

test('every bot computes the same order from the same inputs', () => {
  // Each bot runs this locally with its own name; nothing is exchanged. If the
  // orders differed at all, two bots would both believe they were first.
  const utterance = 'so what do we do about the migration';
  const fromEachBot = BOTS.map((self) => {
    const d = speakDelay({ selfName: self, botNames: BOTS, speaker: 'Stan', utterance });
    return { self, rank: d.rank };
  });
  const ranks = fromEachBot.map((r) => r.rank).sort();
  assert.deepEqual(ranks, [0, 1, 2], 'exactly one bot per rank — no duplicates, no gaps');
});

test('the roster order it is given cannot change the result', () => {
  // Bots see the Meet roster in whatever order the DOM happens to yield.
  const u = 'anyone have thoughts on this';
  const a = orderOf(u, 'Stan', ['Alice', 'Jimmy', 'Cosmo']);
  const b = orderOf(u, 'Stan', ['Cosmo', 'Alice', 'Jimmy']);
  const c = orderOf(u, 'Stan', ['Jimmy', 'Cosmo', 'Alice']);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test('a different turn produces a different winner — nobody is permanently first', () => {
  // A static priority (alphabetical, join order) would make one bot answer
  // everything. The hash varies per turn, so the floor rotates.
  const winners = new Set();
  for (let i = 0; i < 40; i++) winners.add(orderOf(`question number ${i} for the room`)[0]);
  assert.ok(winners.size >= 2, `expected rotation, always got ${[...winners]}`);
});

test('over many turns each bot wins roughly its share', () => {
  // Fairness, not just rotation: a hash that clumped would starve someone.
  const wins = Object.fromEntries(BOTS.map((b) => [b, 0]));
  const N = 600;
  for (let i = 0; i < N; i++) wins[orderOf(`utterance ${i} about various topics`)[0]]++;
  for (const b of BOTS) {
    const share = wins[b] / N;
    assert.ok(share > 0.2 && share < 0.47, `${b} won ${(share * 100).toFixed(0)}% — expected ~33%`);
  }
});

// --- mentions ---------------------------------------------------------------

test('being named puts you first', () => {
  assert.equal(orderOf('Cosmo, what do you make of that?')[0], 'Cosmo');
  assert.equal(orderOf('I think Jimmy should take this one')[0], 'Jimmy');
});

test('naming several bots orders those bots ahead of the rest, deterministically', () => {
  // The bonus is shared by everyone named — it is not a single winner — and the
  // hash then orders the named group among themselves.
  const order = orderOf('Alice and Jimmy, thoughts?');
  assert.deepEqual(order.slice(0, 2).sort(), ['Alice', 'Jimmy']);
  assert.equal(order[2], 'Cosmo');
  assert.deepEqual(orderOf('Alice and Jimmy, thoughts?'), order, 'and it is stable');
});

test('a sole mention outranks one-of-several', () => {
  // "Alice, what do you think?" is a direct address; "Alice and Jimmy" is not.
  //
  // Asserted as BEHAVIOUR rather than as the bonus magnitude. This test used to
  // pin bonus === 2 and bonus === 1, which are implementation detail: the bonus
  // is now derived from mention POSITION (see mentionedBots), so the numbers
  // moved while the rule it was written to protect did not. A test that fails
  // when the numbers change but the behaviour holds is a test that will get
  // "fixed" by loosening it.
  const solo = speakOrder({ botNames: BOTS, speaker: 'Stan', utterance: 'Alice, what do you think?' });
  const pair = speakOrder({ botNames: BOTS, speaker: 'Stan', utterance: 'Alice and Jimmy, what do you think?' });

  assert.equal(solo[0].bot, 'Alice', 'a direct address is answered by the bot addressed');
  assert.ok(solo.find((e) => e.bot === 'Alice').bonus > solo.find((e) => e.bot === 'Jimmy').bonus,
    'and outranks the bot who was not named at all');

  // Named jointly, both outrank the unnamed third — which of the two leads is
  // decided by position and is arbitrary here, since neither is being closed
  // off. Someone has to go first; the other takes the floor if they abstain.
  const cosmo = pair.find((e) => e.bot === 'Cosmo');
  for (const named of ['Alice', 'Jimmy']) {
    assert.ok(pair.find((e) => e.bot === named).bonus > cosmo.bonus,
      `${named} was named and Cosmo was not`);
  }
});

test('name matching is whole-word — "Ray" must not match "array"', () => {
  // The existing mention check is a substring test. That was survivable when a
  // mention only shortened a silence threshold; now it decides who speaks, so a
  // false positive silences the bot that should have answered.
  assert.equal(nameMentioned('the array needs resizing', 'Ray'), false);
  assert.equal(nameMentioned('Ray, can you resize it', 'Ray'), true);
  assert.equal(nameMentioned('ask ray about it', 'Ray'), true, 'case-insensitive');
  assert.equal(nameMentioned("that's Ray's problem", 'Ray'), true, 'possessive still counts');
  assert.equal(nameMentioned('disarray everywhere', 'Ray'), false);
});

// --- the seed ---------------------------------------------------------------

test('a late ASR revision to the tail does not change the seed', () => {
  // Meet keeps editing caption text as recognition settles, and two bots
  // sample at different instants. Keying on the whole utterance would have
  // them hash different strings and disagree — so the seed uses the head,
  // which has stabilised by the time the silence threshold fires.
  const early = 'so what should we do about the migration then';
  const revised = 'so what should we do about the migration though I forget';
  assert.equal(turnKey('Stan', early), turnKey('Stan', revised));
  assert.deepEqual(orderOf(early), orderOf(revised));
});

test('punctuation and capitalisation drift do not change the seed', () => {
  assert.equal(turnKey('Stan', 'Okay — so, what next?'), turnKey('Stan', 'okay so what next'));
});

test('a genuinely different utterance gets a different seed', () => {
  assert.notEqual(turnKey('Stan', 'what about the database'), turnKey('Stan', 'what about the frontend'));
});

test('the same words from a different speaker are a different turn', () => {
  assert.notEqual(turnKey('Stan', 'what do you think'), turnKey('Seth', 'what do you think'));
});

// --- delays -----------------------------------------------------------------

test('the winner waits for nothing', () => {
  // The point of the whole exercise. Jitter charged every bot a mean of ~1000ms
  // on every turn; the winner here pays zero.
  const order = orderOf('right, where were we');
  const d = speakDelay({ selfName: order[0], botNames: BOTS, speaker: 'Stan', utterance: 'right, where were we' });
  assert.equal(d.delayMs, 0);
});

test('the others wake one gap apart, so the loser can SEE the winner', () => {
  const u = 'right, where were we';
  const order = orderOf(u);
  const delays = order.map((b) => speakDelay({ selfName: b, botNames: BOTS, speaker: 'Stan', utterance: u, gapMs: 500 }).delayMs);
  assert.deepEqual(delays, [0, 500, 1000]);
  // The gap has to exceed detection latency (#422: onset p90 ~180ms on the
  // meter, ~360-460ms on the mutation counter) or the loser's delay expires
  // before it has noticed the winner started.
  assert.ok(500 > 460);
});

test('an unknown bot gets no ordering, so the caller can fall back', () => {
  // Peer sets can be stale or unconfigured. Returning null is how this stays
  // strictly no-worse-than-jitter: the caller keeps its old behaviour.
  assert.equal(speakDelay({ selfName: 'Stranger', botNames: BOTS, speaker: 'Stan', utterance: 'hello' }), null);
});

test('a bot alone in the call answers immediately', () => {
  const d = speakDelay({ selfName: 'Alice', botNames: ['Alice'], speaker: 'Stan', utterance: 'hello' });
  assert.equal(d.rank, 0);
  assert.equal(d.delayMs, 0);
});

// --- where the utterance is read from ---------------------------------------

test('the ranked path reads the MERGED transcript, not this.transcripts', () => {
  // The bug that made every live measurement meaningless. Human speech arrives
  // as Meet CAPTION TURNS (_turnsAsEntries); this.transcripts holds only the
  // bot's own speech and legacy Web-Speech entries. _entriesSince merges them,
  // which is why the sync API showed a human utterance that the ranked lookup
  // swore did not exist — it was reading the half that cannot contain one.
  //
  // Asserted against the source because the alternative is standing up a whole
  // LocalServer, and the mistake is a one-word one: the wrong collection name.
  //
  // Scans _rankedContext, which is where the seed is now built: #573 needed the
  // SAME seed for the yield rule, so the lookup moved out of _rankedSpeakDelay
  // into a helper both callers share. The guard is unchanged — only its address.
  const { readFileSync } = require('node:fs');
  const { join, dirname } = require('node:path');
  const { fileURLToPath } = require('node:url');
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'electron-app', 'local-server.js'), 'utf8');
  const at = src.search(/_rankedContext\([^)]*\) \{/);   // signature-agnostic: it takes args now
  assert.ok(at > 0, '_rankedContext must exist — it is where the ranked seed is built');
  const fn = src.slice(at);
  // Comments only, stripped — the explanation of the bug naturally NAMES the
  // collection it warns against, which would fail the check below.
  const body = fn.slice(0, fn.indexOf('\n  }')).split('\n')
    .filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(body, /_entriesSince\(null, null\)/, 'must read the merged view');
  assert.doesNotMatch(body, /this\.transcripts/, 'must NOT read bot-speech-only transcripts');
});

// --- the hash itself --------------------------------------------------------

test('the hash is stable across processes and platforms', () => {
  // Every bot must compute the same value from the same string — including
  // bots on different machines, on different Node versions. Pinned literals,
  // so a "harmless" change to the hash cannot silently desynchronise a fleet.
  assert.equal(hash32(''), 0x811c9dc5);
  assert.equal(hash32('a'), 0xe40c292c);
  assert.equal(hash32('stan|what do you think|Alice'), hash32('stan|what do you think|Alice'));
});

// --- the seed: content vs the clock -----------------------------------------

test('the clock seed produces one agreed order, like the utterance seed', () => {
  // Same property as the top of this file, keyed on a time bucket instead.
  const seed = clockKey(1757400000123, 6000);
  const bots = ['Alice', 'Jimmy', 'Cosmo'];
  const ranks = bots
    .map((self) => speakDelay({ selfName: self, botNames: bots, speaker: 'Stan', utterance: 'anything', seed }).rank)
    .sort();
  assert.deepEqual(ranks, [0, 1, 2]);
});

test('the clock seed ignores the utterance entirely', () => {
  // The whole point: two bots that sampled DIFFERENT caption text for the same
  // turn still agree. Under the utterance seed they would not.
  const seed = clockKey(1757400000123, 6000);
  const bots = ['Alice', 'Jimmy'];
  const a = speakDelay({ selfName: 'Alice', botNames: bots, speaker: 'Stan', seed,
    utterance: 'so what should we do about the migration next week' });
  const b = speakDelay({ selfName: 'Alice', botNames: bots, speaker: 'Stan', seed,
    utterance: 'what should we do about the migration next week' });   // ASR dropped a word
  assert.equal(a.rank, b.rank, 'the caption text must not move the order');
});

test('two observations of the same silence edge share a bucket, unless they straddle', () => {
  // The residual risk, stated as a test so the trade is visible rather than
  // buried in a comment: agreement holds while both observations land in one
  // bucket, and the straddle probability is (spread / bucket).
  const B = 6000;
  assert.equal(clockKey(1_000_000_000, B), clockKey(1_000_000_180, B), '180ms apart, same bucket');
  const boundary = Math.ceil(1_000_000_000 / B) * B;
  assert.notEqual(clockKey(boundary - 1, B), clockKey(boundary, B), 'a boundary does separate them');
});

test('the winner still rotates — a fixed order would let one bot dominate', () => {
  // The order must change over a conversation. Buckets advance with time, so
  // this is what stops the clock seed becoming a static priority list.
  const bots = ['Alice', 'Jimmy', 'Cosmo'];
  const winners = new Set();
  for (let i = 0; i < 200; i++) {
    const seed = clockKey(1757400000000 + i * 6000, 6000);
    winners.add(speakOrder({ botNames: bots, speaker: 'Stan', utterance: 'x', seed })[0].bot);
  }
  assert.equal(winners.size, 3, `every bot should win sometimes, got ${[...winners].join(', ')}`);
});

test('being named still wins under the clock seed', () => {
  // The mention bonus deliberately still reads the utterance. A scheduler that
  // cannot hear a direct address is worse than one that rarely disagrees.
  const seed = clockKey(1757400000123, 6000);
  const bots = ['Alice', 'Jimmy'];
  const d = speakDelay({ selfName: 'Alice', botNames: bots, speaker: 'Stan', seed,
    utterance: 'Alice, what do you think about the pricing?' });
  assert.equal(d.rank, 0, 'the addressed bot answers');
  assert.equal(d.delayMs, 0);
});

// --- who was named, and WHERE ----------------------------------------------

test('the bot named LAST answers, not whichever the hash prefers', () => {
  // Stan's case, 2026-09-09. Both bots are named, so under the old flat bonus
  // both scored 1 and the hash decided: Jimmy — who had just been told to stop
  // — answered 55% of the time. Position is information the sentence already
  // carries and the ordering was discarding.
  const bots = ['Jimmy', 'Alice'];
  const text = "ok Jimmy that's enough about the PR. Alice, what were you saying?";
  const winners = new Set();
  for (let i = 0; i < 300; i++) {
    winners.add(speakOrder({ botNames: bots, speaker: 'Stan', utterance: text, seed: `t${i}` })[0].bot);
  }
  assert.deepEqual([...winners], ['Alice'], 'Alice every time — the hash must not get a vote here');
});

test('a bot named twice is placed by its LAST mention', () => {
  // "Alice, ... actually Jimmy, ... no, Alice" resolves to Alice: the speaker
  // changed their mind, and the last word is the one that counts.
  const bots = ['Alice', 'Jimmy'];
  const text = 'Alice, can you — actually Jimmy, you take it. No, Alice, go ahead.';
  assert.deepEqual(mentionedBots(text, bots), ['Alice', 'Jimmy']);
  assert.equal(speakOrder({ botNames: bots, speaker: 'Stan', utterance: text, seed: 'x' })[0].bot, 'Alice');
});

test('a sole mention still wins outright', () => {
  // The old rule ("sole mention outranks one-of-several") is now a consequence
  // of the ordering rather than a separate case, so pin that it still holds.
  const bots = ['Alice', 'Jimmy', 'Cosmo'];
  const d = speakDelay({ selfName: 'Alice', botNames: bots, speaker: 'Stan',
    utterance: 'Alice, what do you think?', seed: 'x' });
  assert.equal(d.rank, 0);
  assert.equal(d.delayMs, 0);
  assert.match(d.why, /named alone/);
});

test('named bots outrank unnamed ones regardless of position', () => {
  const bots = ['Alice', 'Jimmy', 'Cosmo'];
  const text = 'Jimmy and Alice, either of you?';
  const order = speakOrder({ botNames: bots, speaker: 'Stan', utterance: text, seed: 'x' });
  assert.equal(order[2].bot, 'Cosmo', 'the unnamed bot ranks last');
  assert.equal(order[0].bot, 'Alice', 'and of the two named, the later one leads');
});

test('the mention scan is whole-word, so a name inside another word does not count', () => {
  // Same hazard nameMentioned guards: "array" must not mention a bot named Ray,
  // now that it decides who answers rather than only waking one early.
  assert.equal(lastMentionIndex('build the array first', 'Ray'), -1);
  assert.ok(lastMentionIndex('Ray, build the array', 'Ray') >= 0);
});

test('every bot still computes the same mention-aware order', () => {
  // The property from the top of the file, re-checked with the bonus in play:
  // position is read from the same caption text everyone holds.
  const bots = ['Alice', 'Jimmy', 'Cosmo'];
  const text = 'Cosmo, hold on. Jimmy, go.';
  const ranks = bots
    .map((self) => speakDelay({ selfName: self, botNames: bots, speaker: 'Stan', utterance: text, seed: 'x' }).rank)
    .sort();
  assert.deepEqual(ranks, [0, 1, 2]);
});
