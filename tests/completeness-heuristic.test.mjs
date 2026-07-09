// completeness-heuristic.test.mjs — the endpoint-free fallback for the probe
// firing gate. When nothing is listening on ackEndpoint, judgeComplete returns
// null; before this fallback existed the gate skipped and active listening was
// silently dead (observed: a 30-minute call where probeFiring was ON, two
// probes were banked, and neither ever fired).
//
// The bar: conservative. A wrong "complete" makes the bot talk over someone;
// a wrong "not complete" just costs a probe. So partials must never slip
// through, and we accept some finished thoughts being judged unfinished.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { heuristicComplete } = require('../electron-app/completeness.js');

const isComplete = (s) => heuristicComplete(s).complete;

test('dangling final words are never a real opening', () => {
  // These come straight from the system prompt's own partial examples.
  const partials = [
    'jimmy can you',
    'i think the most important part is to',
    'and then after that we need to',
    'we should put a diagram on the',
    'what do you',
    'the part is to',
    'so i was thinking that we could just',
    'it depends on whether',
  ];
  for (const p of partials) {
    assert.equal(isComplete(p), false, `must not fire on: "${p}"`);
  }
  // Known blind spot: a truncated word ("share the white…") reads as a finished
  // noun to a lexical gate. Only the model catches that. Documented, not fixed —
  // the cost is one ill-timed 2-word probe, and only when the model is down.
  assert.equal(isComplete('share the white'), true);
});

test('finished sentences and questions fire even without punctuation', () => {
  const completes = [
    'jimmy can you share the whiteboard',
    'what do you think jimmy',
    'the demo went really well',
    'what should we work on next',
    'thanks that is really helpful',
    'lets keep testing and see how it holds up',
  ];
  for (const c of completes) {
    assert.equal(isComplete(c), true, `should fire on: "${c}"`);
  }
});

test('terminal punctuation is the strongest signal and short-circuits', () => {
  assert.equal(isComplete('Go ahead.'), true);
  assert.equal(isComplete('Really?'), true);
  assert.equal(isComplete('Stop!'), true);
  assert.equal(isComplete('"Exactly."'), true);
  // Even a normally-dangling word is complete once Meet emits a terminator.
  assert.equal(isComplete('I know why.'), true);
});

test('too-short utterances are not openings', () => {
  assert.equal(isComplete('yeah'), false);
  assert.equal(isComplete('ok sure'), false);
  // Three words clears the floor.
  assert.equal(isComplete('that makes sense'), true);
});

test('the fallback is conservative: it never fires on an obvious mid-phrase', () => {
  // Every auxiliary/preposition/conjunction ending must be treated as unfinished.
  for (const tail of ['and', 'but', 'because', 'to', 'the', 'a', 'is', 'was', 'could', 'what', 'i', 'gonna']) {
    assert.equal(isComplete(`we were talking about this ${tail}`), false, `tail "${tail}" must be partial`);
  }
});

test('result shape carries the heuristic flag and a debuggable reason', () => {
  const r = heuristicComplete('what do you');
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
