// bot-vs-bot-yield-by-rank.test.mjs — when two bots are already talking, who stops?
//
// speak-order.js stated this rule in its own header from the day it was
// written — "they detect each other within ~180ms and the yield rule is
// already common knowledge: higher rank stops" — and nothing implemented it.
// The app's bot-vs-bot branch drew a SECOND random delay instead (#573), which
// handed the collision the ordering exists to resolve straight back to the coin
// flip. Measured cost on 2026-08-26: 1500ms grace + up to 3000ms random is up
// to 4.5s of two bots talking BY DESIGN, against observed overlaps of 4.5s and
// 3.4s.
//
// The property that makes a local decision safe is COMPLEMENTARITY: both bots
// compute the same order from the same seed, so exactly one of them concludes
// "I keep the floor". A rule that can return "yield" to both loses the turn;
// one that can return "keep" to both is the bug it was meant to fix.
//
// Run: node --test tests/bot-vs-bot-yield-by-rank.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { yieldsTo, speakOrder } = require('../electron-app/speak-order.js');

const SPEAKER = 'Bethany';
const UTTERANCE = 'so how would we actually set this up for the class';

// Every bot but `self` is talking over it.
const verdictFor = (self, bots, utterance = UTTERANCE) =>
  yieldsTo({
    selfName: self,
    botNames: bots,
    speaker: SPEAKER,
    utterance,
    interrupters: bots.filter((b) => b !== self),
  });

// --- the property the whole rule rests on ----------------------------------

test('exactly one bot keeps the floor — never none, never two', () => {
  const bots = ['Pepper', 'Scripty', 'Taylor Script'];
  const keepers = bots.filter((self) => verdictFor(self, bots).yield === false);
  assert.deepEqual(keepers.length, 1,
    `exactly one bot must keep the floor, got ${JSON.stringify(keepers)}`);
});

test('holds across many turns and roster sizes, not just a lucky seed', () => {
  const rosters = [
    ['Alice', 'Jimmy'],
    ['Pepper', 'Scripty', 'Taylor Script'],
    ['Alice', 'Jimmy', 'Cosmo', 'Pepper', 'Scripty'],
  ];
  for (const bots of rosters) {
    for (let i = 0; i < 200; i++) {
      const utterance = `turn number ${i} about the thing we were discussing`;
      const keepers = bots.filter((self) => verdictFor(self, bots, utterance).yield === false);
      assert.equal(keepers.length, 1,
        `roster ${bots.length}, turn ${i}: expected 1 keeper, got ${JSON.stringify(keepers)}`);
    }
  }
});

test('the bot that keeps the floor is the one ranked first to speak', () => {
  // The yield rule and the start order must agree. If they disagreed, the bot
  // that won the right to start could be the one told to stop.
  const bots = ['Pepper', 'Scripty', 'Taylor Script'];
  for (let i = 0; i < 100; i++) {
    const utterance = `another turn ${i}`;
    const first = speakOrder({ botNames: bots, speaker: SPEAKER, utterance })[0].bot;
    const keeper = bots.find((self) => verdictFor(self, bots, utterance).yield === false);
    assert.equal(keeper, first, `turn ${i}: keeper ${keeper} should be rank-0 bot ${first}`);
  }
});

// --- yielding is immediate, and to the RIGHT bot ---------------------------

test('a bot yields only to peers ranked ahead of it, and names them', () => {
  const bots = ['Pepper', 'Scripty', 'Taylor Script'];
  const order = speakOrder({ botNames: bots, speaker: SPEAKER, utterance: UTTERANCE });
  const last = order[order.length - 1].bot;
  const v = verdictFor(last, bots);
  assert.equal(v.yield, true, 'the last-ranked bot always yields');
  assert.equal(v.ahead.length, order.length - 1, 'it is behind everyone else');
  assert.match(v.why, /behind/);
});

test('being interrupted only by bots ranked BEHIND you is not a reason to stop', () => {
  // The rank-0 bot interrupted by rank 2 keeps going: rank 2 is the one that
  // must stop, and if both backed off the turn would be lost to nobody.
  const bots = ['Pepper', 'Scripty', 'Taylor Script'];
  const order = speakOrder({ botNames: bots, speaker: SPEAKER, utterance: UTTERANCE });
  const v = yieldsTo({
    selfName: order[0].bot,
    botNames: bots,
    speaker: SPEAKER,
    utterance: UTTERANCE,
    interrupters: [order[2].bot],
  });
  assert.equal(v.yield, false);
});

// --- the cautious cases ----------------------------------------------------

test('an interrupter that cannot be ranked makes this bot yield, not assume', () => {
  // Everywhere else in barge-in, unknown means "treat as human, back off" —
  // talking over a real person is the worse failure. Claiming the floor
  // against a participant whose rank we could not compute is exactly the case
  // where both bots think they won.
  const v = yieldsTo({
    selfName: 'Pepper',
    botNames: ['Pepper', 'Scripty'],
    speaker: SPEAKER,
    utterance: UTTERANCE,
    interrupters: ['Somebody Else'],
  });
  assert.equal(v.yield, true);
  assert.deepEqual(v.unplaced, ['Somebody Else']);
  assert.match(v.why, /cannot rank/);
});

test('returns null — not a guess — when the order cannot be computed', () => {
  // null is the caller's signal to fall back to the old random delay. A rule
  // that guessed here would be worse than the dice it replaced.
  assert.equal(
    yieldsTo({ selfName: 'Nobody', botNames: ['Pepper', 'Scripty'], speaker: SPEAKER, utterance: UTTERANCE, interrupters: ['Pepper'] }),
    null, 'self not in the bot set');
  assert.equal(
    yieldsTo({ selfName: 'Pepper', botNames: ['Pepper', 'Scripty'], speaker: SPEAKER, utterance: UTTERANCE, interrupters: [] }),
    null, 'nobody is interrupting');
});

test('a named bot keeps the floor against one that was not named', () => {
  // The mention bonus already decides who ANSWERS; the yield rule must not
  // contradict it and hand the turn to a bot nobody addressed.
  const bots = ['Alice', 'Jimmy'];
  const utterance = 'Alice, what do you think about the pricing?';
  assert.equal(verdictFor('Alice', bots, utterance).yield, false, 'Alice was addressed');
  assert.equal(verdictFor('Jimmy', bots, utterance).yield, true, 'Jimmy was not');
});
