// score-speaking-large-capture.test.mjs
//
// score-speaking.mjs computed the capture extent with
// `Math.min(...allTs)` / `Math.max(...allTs)`. Each array element becomes a
// function argument, and the engine's argument limit is on the order of 10^5 —
// so a long call threw:
//
//     RangeError: Maximum call stack size exceeded
//
// It failed in the worst possible shape: short calls scored fine and every
// full-length one died, which reads as a data problem rather than a code one.
// Found on 2026-08-28 when the archive sweep (#422) scored nothing across a
// 53-call corpus; one 51-minute call had written 613,347 events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(join(root, 'scripts/score-speaking.mjs'), 'utf8');
// Comments stripped: the fix documents the broken construct by quoting it, and
// a naive source match would find the explanation and call it the bug.
const code = src.replace(/^\s*\/\/.*$/gm, '');

test('the capture extent is not computed by spreading every timestamp', () => {
  // The specific construct that broke. Guarding the source is the point: the
  // scorer needs a real capture and CLI args to run, but this line is a
  // one-character-class of bug that must not come back.
  assert.doesNotMatch(code, /Math\.(min|max)\(\s*\.\.\.\s*allTs/,
    'spreading the timestamp array overflows the argument limit on real captures');
  assert.match(code, /let t0 = Infinity, t1 = -Infinity/,
    'extent should be tracked with a running min/max instead');
});

test('an empty capture is still detected after the rewrite', () => {
  // The old guard was `if (!allTs.length)`. Dropping the array meant that check
  // had to move to a counter — losing it would turn "no events" into a silent
  // t0=Infinity, and a grid loop that never executes: a scored-nothing result
  // reported as success, which is the exact failure the sweep exists to avoid.
  assert.match(code, /if \(!nTs\)/);
  assert.match(code, /no events in capture/);
});

test('a running min/max survives an array that would overflow a spread', () => {
  // Prove the replacement technique on the size that actually broke it, so this
  // test fails loudly on an engine where the reduce-style approach also breaks.
  const N = 613_347;
  const arr = new Array(N);
  for (let i = 0; i < N; i++) arr[i] = 1_000_000 + ((i * 7919) % 5_000_000);

  assert.throws(() => Math.min(...arr), RangeError,
    'if this stops throwing, the original bug is no longer reproducible here');

  let lo = Infinity, hi = -Infinity;
  for (const t of arr) { if (t < lo) lo = t; if (t > hi) hi = t; }
  assert.equal(lo, arr.reduce((a, b) => (b < a ? b : a), Infinity));
  assert.equal(hi, arr.reduce((a, b) => (b > a ? b : a), -Infinity));
  assert.ok(Number.isFinite(lo) && Number.isFinite(hi));
});
