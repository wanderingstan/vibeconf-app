// completeness-heuristic.test.mjs — the endpoint-free fallback for the probe
// firing gate. When nothing is listening on ackEndpoint, judgeComplete returns
// null; before this fallback existed the gate skipped and active listening was
// silently dead (observed: a 30-minute call where probeFiring was ON, two
// probes were banked, and neither ever fired).
//
// The gate ANDs two signals, both calibrated against 388 hand-labelled caption
// states from six session logs. Measured in the regime it runs in (after the
// room has been quiet for probeSilenceMs):
//
//     bare terminal punctuation ....... 46% precision / 92% recall
//     dangling-word test only ......... 41% / 83%
//     BOTH (what ships) ............... 49% / 79%
//
// The bar is conservative. A wrong "complete" makes the bot talk over someone;
// a wrong "not complete" just costs a probe.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { heuristicComplete } = require('../electron-app/completeness.js');

const isComplete = (s) => heuristicComplete(s).complete;

test('a terminator is REQUIRED — an unterminated clause is never an opening', () => {
  // Meet punctuates. The absence of a terminator where the source normally puts
  // one is real evidence the speaker is still going. Firing without one scored
  // 0-for-7 on the labelled set: every case was an early-turn fragment.
  assert.equal(isComplete('the demo went really well'), false);
  assert.equal(isComplete('what should we work on next'), false);
  assert.equal(isComplete('this is,'), false);
  assert.equal(isComplete("that's,"), false);
});

test('a terminator is NOT SUFFICIENT — Meet posts speculative periods', () => {
  // The live regression: Meet emitted "...Everything else." and then revised it
  // to "...everything else kind of crowds the screen." A bare period would have
  // fired here; the dangling test is what holds the line.
  assert.equal(isComplete('it should be reduced to just the response time. Everything else kind of.'), false,
    '"kind of" is dangling even with a period after it');
  assert.equal(isComplete("sorry, he's a little."), true, 'no dangling word — the gate cannot catch this one');
  assert.equal(isComplete('and then after that we need to.'), false);
  assert.equal(isComplete('i think the most important part is to.'), false);
});

test('terminated, non-dangling sentences fire', () => {
  for (const s of [
    'jimmy can you share the whiteboard?',
    'what do you think jimmy?',
    'the demo went really well.',
    'lets keep testing and see how it holds up.',
    'thanks that is really helpful.',
  ]) {
    assert.equal(isComplete(s), true, `should fire on: "${s}"`);
  }
});

test('terminated one-word answers clear the word-count floor', () => {
  assert.equal(isComplete('Really?'), true);
  assert.equal(isComplete('Exactly.'), true);
  assert.equal(isComplete('Stop!'), true);
  assert.equal(isComplete('"Exactly."'), true);
  // But an unterminated one-worder does not.
  assert.equal(isComplete('yeah'), false);
  assert.equal(isComplete('ok sure'), false);
});

test('every dangling tail is caught, terminator or not', () => {
  for (const tail of ['and', 'but', 'because', 'to', 'the', 'a', 'is', 'was', 'could', 'what', 'i', 'gonna']) {
    assert.equal(isComplete(`we were talking about this ${tail}.`), false, `tail "${tail}" must be partial`);
  }
});

test('a non-punctuating source is diagnosable, not silently gated out', () => {
  // If a caption source never emits terminators this gate can never fire. That
  // is an acceptable failure (a quieter bot), but it must be visible in the log
  // rather than read as "the room is never at a boundary."
  const r = heuristicComplete('we were just talking about the latency numbers');
  assert.equal(r.complete, false);
  assert.match(r.reason, /no punctuation at all \(source may not punctuate\)/);

  const r2 = heuristicComplete('one sentence ended. and this one has not');
  assert.match(r2.reason, /no terminator at the end/, 'punctuating source, missing terminator — different reason');
});

test('result shape carries the heuristic flag and a debuggable reason', () => {
  const r = heuristicComplete('what do you.');
  assert.equal(r.complete, false);
  assert.equal(r.heuristic, true);
  assert.match(r.reason, /dangling final word "you"/);
  assert.ok(Number.isFinite(r.ms));
});

test('empty and garbage input never fire', () => {
  for (const bad of ['', '   ', null, undefined, '...', '???']) {
    assert.equal(heuristicComplete(bad).complete, false, `must not fire on ${JSON.stringify(bad)}`);
  }
});

test('known blind spot: a truncated word reads as a finished noun', () => {
  // "share the white…" (about to be "whiteboard"). Only the model catches this.
  // Documented, not fixed — the cost is one ill-timed 2-word probe, and only
  // while the model is down. Needs a terminator to fire at all, which makes it
  // rarer than it was.
  assert.equal(isComplete('share the white.'), true);
});
