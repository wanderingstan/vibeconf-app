// score-speaking.test.mjs — the scoring harness that will decide our constants.
//
// This file exists because of what it is for. Once #422's rig is running, every
// argument about WINDOW_MS or METER_HOLD_MS gets settled by numbers this code
// produces — so a bug here does not produce a wrong test result, it produces a
// wrong CONSTANT, shipped, with a measurement cited in its defence.
//
// So the detectors are checked against hand-computed cases where the right
// answer is known by construction, and the metrics against spans laid out by
// hand.
//
// Run: node --test tests/score-speaking.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreCounter, scoreIndicator, applyEchoGuard, spansOf, score,
} from '../scripts/score-speaking.mjs';

const gridOf = (from, to, step = 10) => {
  const g = [];
  for (let t = from; t <= to; t += step) g.push(t);
  return g;
};

// --- the mutation counter ---------------------------------------------------

test('the counter arms on the third mutation in the window, not the first', () => {
  const grid = gridOf(0, 3000);
  // Three mutations 100ms apart, then silence.
  const v = scoreCounter([1000, 1100, 1200], { windowMs: 1200, arm: 3, release: 2 }, grid);
  const spans = spansOf(v, grid);
  assert.equal(spans.length, 1);
  assert.equal(spans[0][0], 1200, 'true at the third, not the first');
});

test('the counter releases only below 2 — the Schmitt trigger from #407', () => {
  // Drain to exactly 2 must NOT release: that flap is the feedback-loop bug.
  const grid = gridOf(0, 4000);
  const v = scoreCounter([1000, 1100, 1200], { windowMs: 1200, arm: 3, release: 2 }, grid);
  // At t=2250 the 1000 has aged out (window 1200) leaving 2 in window.
  const at = (t) => v[grid.indexOf(t)];
  assert.equal(at(2250), true, 'two in window keeps it armed');
  assert.equal(at(2450), false, 'below two releases');
});

test('a shorter window releases sooner — the point of sweeping it', () => {
  const grid = gridOf(0, 4000);
  const long = spansOf(scoreCounter([1000, 1100, 1200], { windowMs: 1200 }, grid), grid);
  const short = spansOf(scoreCounter([1000, 1100, 1200], { windowMs: 400 }, grid), grid);
  assert.ok(short[0][1] < long[0][1], `short window should release first (${short[0][1]} < ${long[0][1]})`);
});

// --- the indicator ----------------------------------------------------------

const readings = (specs) => specs.flatMap(([from, to, v]) => {
  const out = [];
  for (let t = from; t < to; t += 50) out.push({ t, v });
  return out;
});

test('the indicator calibrates rest from the value it parks on', () => {
  const grid = gridOf(0, 6000);
  // Parked at 0px for 2s, then alternating raised bars, then parked again.
  const r = [
    ...readings([[0, 2000, '0px']]),
    ...readings([[2000, 4000, '-30px']]).map((x, i) => ({ ...x, v: i % 2 ? '-30px' : '-15px' })),
    ...readings([[4000, 6000, '0px']]),
  ];
  const v = scoreIndicator(r, { attackMs: 50, holdMs: 250, restHoldMs: 1000 }, grid);
  const spans = spansOf(v, grid);
  assert.equal(spans.length, 1, 'one continuous utterance');
  assert.ok(spans[0][0] >= 2000 && spans[0][0] <= 2200, `starts with the raise (${spans[0][0]})`);
  assert.ok(spans[0][1] >= 4000 && spans[0][1] <= 4350, `ends a hold after it (${spans[0][1]})`);
});

test('a hold shorter than the gaps fragments one utterance — the #422 question', () => {
  // The indicator returns to rest DURING speech. Measured on real calls, a
  // third of speaking beats were raised less than half the time. If the hold is
  // shorter than those gaps, one turn is reported as several — which is exactly
  // what this metric has to be able to see.
  const grid = gridOf(0, 8000);
  const r = [...readings([[0, 1500, '0px']])];
  for (let t = 1500; t < 6000; t += 800) {          // raised 300ms, rest 500ms
    r.push(...readings([[t, t + 300, '-30px']]), ...readings([[t + 300, t + 800, '0px']]));
  }
  r.push(...readings([[6000, 8000, '0px']]));

  const shortHold = spansOf(scoreIndicator(r, { holdMs: 250 }, grid), grid);
  const longHold = spansOf(scoreIndicator(r, { holdMs: 600 }, grid), grid);
  assert.ok(shortHold.length > 1, `a 250ms hold fragments this (${shortHold.length} pieces)`);
  assert.equal(longHold.length, 1, 'a 600ms hold bridges the same gaps');
});

test('the attack rejects a single raised frame', () => {
  const grid = gridOf(0, 4000);
  const r = [...readings([[0, 2000, '0px']]), { t: 2000, v: '-30px' }, ...readings([[2050, 4000, '0px']])];
  assert.equal(spansOf(scoreIndicator(r, { attackMs: 50 }, grid), grid).length, 0, 'one frame is not a turn');
});

// --- the echo guard ---------------------------------------------------------

test('the guard DELAYS a rise inside the lookback — it does not cancel it', () => {
  // The distinction matters and is easy to get wrong. The rise is withheld only
  // while our own audio is recent; the moment the lookback expires, a verdict
  // that is still true gets credited. So the guard's cost is LATENCY on a real
  // speaker, not a lost turn — and that latency is the number worth watching
  // when tuning DOM_ECHO_LOOKBACK_MS, which is why it is asserted exactly.
  const grid = gridOf(0, 4000);
  const verdicts = grid.map((t) => t >= 2000 && t < 3000);

  const guarded = spansOf(applyEchoGuard(verdicts, [{ t: 1900, loud: true }], { lookbackMs: 700 }, grid), grid);
  assert.equal(guarded.length, 1, 'the turn is not lost');
  assert.equal(guarded[0][0], 2600, 'credited when the lookback expires (1900 + 700), 600ms late');

  // Our audio old enough to be irrelevant: credited on time.
  const clean = spansOf(applyEchoGuard(verdicts, [{ t: 1000, loud: true }], { lookbackMs: 700 }, grid), grid);
  assert.equal(clean[0][0], 2000);

  // And a turn entirely inside the shadow of our own speech is lost outright —
  // the case the corpus in #422 has to contain for this to be tunable at all.
  const shortTurn = grid.map((t) => t >= 2000 && t < 2300);
  const swallowed = spansOf(applyEchoGuard(shortTurn, [{ t: 1900, loud: true }], { lookbackMs: 700 }, grid), grid);
  assert.equal(swallowed.length, 0, 'a 300ms interjection under our own voice never surfaces');
});

test('someone already detected is not cut off when we start talking', () => {
  const grid = gridOf(0, 4000);
  const verdicts = grid.map((t) => t >= 1000 && t < 3000);
  const guarded = applyEchoGuard(verdicts, [{ t: 2000, loud: true }], { lookbackMs: 700 }, grid);
  const spans = spansOf(guarded, grid);
  assert.equal(spans.length, 1);
  assert.equal(spans[0][1], 3000, 'runs to its natural end');
});

// --- the metrics ------------------------------------------------------------

test('onset and offset latencies are measured against the label, not each other', () => {
  const labels = [[1000, 3000]];
  const m = score([[1300, 3400]], labels);
  assert.equal(m.onsetP50, 300, 'detected 300ms late');
  assert.equal(m.offsetP50, 400, 'released 400ms late');
  assert.equal(m.missed, 0);
  assert.equal(m.fragPerTurn, 1);
});

test('an early detection scores 0 onset, and is charged as a false positive instead', () => {
  // Letting it score negative would let earliness cancel lateness elsewhere and
  // flatter a jumpy detector.
  const m = score([[800, 3000]], [[1000, 3000]]);
  assert.equal(m.onsetP50, 0);
  assert.ok(m.fpSecPerMin > 0, 'the 200ms before the turn is still charged');
});

test('fragmentation counts detections per turn', () => {
  const m = score([[1000, 1400], [1600, 2000], [2200, 3000]], [[1000, 3000]]);
  assert.equal(m.fragPerTurn, 3);
  assert.equal(m.fpEvents, 0, 'all three are inside the turn — not false positives');
});

test('a turn with no detection at all is a miss, not a zero-latency success', () => {
  const m = score([], [[1000, 3000], [5000, 6000]]);
  assert.equal(m.missed, 2);
  assert.equal(m.onsetP50, null, 'no latency to report');
});

test('detection in genuine silence is a false positive, counted and timed', () => {
  const m = score([[4000, 4500]], [[1000, 3000]]);
  assert.equal(m.fpEvents, 1);
  assert.equal(m.missed, 1);
  // 500ms of false positive against 2000ms (=1/30 min) of labelled speech.
  assert.ok(Math.abs(m.fpSecPerMin - 15) < 0.01, `${m.fpSecPerMin} s/min`);
});
