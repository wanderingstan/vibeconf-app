// bot-speak-delay.test.mjs — keeping two bots from answering in unison (#100).
//
// #230 added a random 0-800ms delay before a bot's audio starts, so two bots
// with identical timing wouldn't speak together. On the Jul 28 call it fired
// 119 times and the bots STILL answered together. The reason is that the delay
// only helps if the losing bot can SEE the winner before its own turn arrives,
// and seeing is slow: DOMSpeakerTracker needs MIN_MUTATIONS = 3 within a 1200ms
// window, so another bot takes ~400-700ms to register as speaking.
//
// Two draws from U(0, J) differ by more than the detection latency D with
// probability (1 - D/J)^2:
//
//     J=800   D=500ms  ->  14%      <- what shipped
//     J=2000  D=500ms  ->  56%
//
// So 86% of collisions produced two bots talking. The window is now wider, and
// the delay is ordered by urgency so the more valuable reply wins by
// construction rather than by coin flip.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PREFERENCES } = require('../electron-app/preferences-schema.js');
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

const def = (k) => {
  assert.ok(PREFERENCES[k], `no such preference: ${k}`);
  return PREFERENCES[k].default;
};

// A server with the real _speakDelay but deterministic prefs.
const srv = (over = {}) => {
  const s = new LocalServer({ port: 0 });
  s._pref = (k) => (k in over ? over[k] : def(k));
  return s;
};

// Probability two independent U(0,J) draws differ by more than D.
const yieldChance = (J, D) => (J <= D ? 0 : ((1 - D / J) ** 2));

test('the jitter window is wide enough to beat speaking-detection latency', () => {
  const J = def('botSpeakJitterMaxMs');
  // ~500ms is the middle of the 400-700ms detection range.
  assert.ok(yieldChance(J, 500) > 0.5,
    `jitter U(0,${J}) converts to a yield only ${(yieldChance(J, 500) * 100).toFixed(0)}% ` +
    'of the time — the loser starts before it can possibly see the winner');
  // The old value is kept as the counter-example so the regression stays visible.
  assert.ok(yieldChance(800, 500) < 0.2, 'sanity: the old 800ms default really was that bad');
});

test('no delay at all when nobody else could be answering', () => {
  const s = srv();
  for (const others of [0, 1]) {
    assert.equal(s._speakDelay({ urgency: 0.2 }, others).delayMs, 0,
      'solo and single-human calls must stay snappy');
  }
});

// Run the REAL _speakDelay with the random draw pinned, so ordering is the only
// variable. Math.random is restored even if an assertion throws.
function withFixedRandom(value, fn) {
  const real = Math.random;
  Math.random = () => value;
  try { return fn(); } finally { Math.random = real; }
}

test('urgency orders the queue: a more urgent reply reaches the floor first', () => {
  const s = srv();
  const delays = withFixedRandom(0.5, () =>
    [0.1, 0.5, 0.9].map((u) => s._speakDelay({ urgency: u }, 3).delayMs));
  const [low, mid, high] = delays;

  assert.ok(high < mid && mid < low,
    `expected higher urgency to go sooner, got ${JSON.stringify({ low, mid, high })}`);
  assert.ok(low - high > 500,
    `a 0.1 and a 0.9 reply are only ${low - high}ms apart — under the ~500ms ` +
    'detection latency, so the ordering would never convert into an actual yield');
});

test('an unscored utterance sits at the midpoint, not at the front or the back', () => {
  const lead = def('botSpeakUrgencyLeadMs');
  const s = srv({ botSpeakJitterMaxMs: 1 }); // near-zero random
  const unscored = s._speakDelay({}, 2).delayMs;
  const mid = Math.round(0.5 * lead);
  assert.ok(Math.abs(unscored - mid) <= 1,
    `unscored got ${unscored}ms, expected ~${mid}ms — it must not jump the queue ` +
    'or be starved, matching the midpoint convention used by the grace scaling');
});

test('delays stay within the configured budget', () => {
  const s = srv();
  const maxExpected = def('botSpeakUrgencyLeadMs') + def('botSpeakJitterMaxMs');
  for (let i = 0; i < 200; i++) {
    const u = i / 200;
    const d = s._speakDelay({ urgency: u }, 3).delayMs;
    assert.ok(d >= 0 && d <= maxExpected, `urgency ${u} -> ${d}ms, outside [0, ${maxExpected}]`);
  }
});

test('a top-urgency reply is never held for long', () => {
  const s = srv();
  const worst = Math.max(...Array.from({ length: 200 }, () => s._speakDelay({ urgency: 1 }, 3).delayMs));
  assert.ok(worst <= def('botSpeakJitterMaxMs'),
    'urgency 1 should contribute nothing to the wait — only the random tiebreak');
});

test('setting the urgency lead to 0 restores the old purely-random behaviour', () => {
  const s = srv({ botSpeakUrgencyLeadMs: 0 });
  for (const u of [0, 0.5, 1]) {
    const d = s._speakDelay({ urgency: u }, 3).delayMs;
    assert.ok(d <= def('botSpeakJitterMaxMs'), 'no urgency component when the lead is 0');
  }
});

test('the reason string explains the delay, since this is tuned from logs', () => {
  const s = srv();
  const { why } = s._speakDelay({ urgency: 0.9 }, 3);
  assert.match(why, /urgency 0\.90/, 'the log line must show the score that produced the delay');
  assert.match(why, /random/, 'and separate the deterministic part from the tiebreak');
});
