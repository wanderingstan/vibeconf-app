// thinking-sway-jump.test.mjs — the avatar must not teleport on entering 🤔 (#290).
//
// The report was "the animation into 🤔 has a jump that becomes jarring after a
// while." It was not a matter of taste. The sway was:
//
//     const thinkSway = this.state === 'thinking' ? Math.sin(t * 1.2) * 8 : 0;
//
// against `t`, the free-running frame clock. That clock's phase is uncorrelated
// with when the state changes, so the term went from exactly 0 to sin(whatever)
// * 8 in ONE frame — an arbitrary horizontal offset anywhere in ±8px, ~5px on
// average. Leaving thinking snapped it back the same way. Twice a turn, every
// turn: precisely the "jarring after a while" being described.
//
// page-inject.js is an IIFE eval'd into Meet's page context, so it cannot be
// imported. These are source assertions, the same approach avatar-settling.test.mjs
// uses on this file. They lock the two properties that make the jump impossible:
// the phase is anchored to the state change, and the amplitude ramps both ways.
//
// Run: node --test tests/thinking-sway-jump.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const inject = readFileSync(join(root, 'electron-app/page-inject.js'), 'utf8');

test('the sway is NOT driven by the free-running frame clock', () => {
  // The exact regression. `t` is `this.frameCount * 0.02`, shared by every
  // ambient animation in the loop — fine for things that are always on, fatal
  // for one that switches on and off, because it cannot start at zero.
  assert.doesNotMatch(inject, /thinkSway\s*=\s*this\.state === 'thinking'/,
    'the sway is back on the free-running clock — entering 🤔 will teleport the head');
  assert.doesNotMatch(inject, /Math\.sin\(t \* 1\.2\) \* 8/,
    'the pre-#290 sway expression is back');
});

test('the sway phase is anchored to the moment thinking began', () => {
  // sin(0) = 0, so the first swaying frame puts the face exactly where the
  // non-swaying frame before it left it. This is the half of the fix that kills
  // the entry jump specifically.
  assert.match(inject, /_swaySince/,
    'nothing records when thinking started, so the phase cannot be anchored');
  assert.match(inject, /Math\.sin\(\(elapsed \/ 1000\) \* SWAY_RATE\)/,
    'the sway phase must be measured from _swaySince, not from the frame clock');
});

test('the amplitude ramps in AND out', () => {
  // Anchoring alone fixes entry and leaves exit broken: the term would still be
  // cut from mid-swing to 0 the frame thinking ends.
  assert.match(inject, /SWAY_RAMP_MS/, 'no ramp constant');
  assert.match(inject, /fadeIn/, 'no ramp-in');
  assert.match(inject, /fadeOut/, 'no ramp-out — leaving 🤔 would still snap');
  assert.match(inject, /_swayLeftAt/, 'nothing records when thinking ended');
});

test('the envelope is wall-clock, not frame-counted', () => {
  // rAF stops for an occluded view — the same reasoning reportContentHeight and
  // the tick pulse already document. A frame-counted ramp would play in slow
  // motion behind another window, which is when nobody can see it correct itself.
  const sway = inject.slice(inject.indexOf('const SWAY_PX'), inject.indexOf('let thinkSway = 0'));
  assert.match(sway, /Date\.now\(\)/, 'the envelope must run on wall-clock');
  assert.doesNotMatch(sway, /frameCount/, 'the envelope must not be frame-counted');
});

test('the sway rate is preserved, so only the edges changed', () => {
  // frameCount * 0.02 * 1.2 at 30fps = 0.72 rad/s. #290 asked to soften the
  // transition, not to restyle an animation nobody complained about.
  const m = inject.match(/const SWAY_RATE = ([0-9.]+)/);
  assert.ok(m, 'the rate should be a named constant so this stays checkable');
  assert.equal(Number(m[1]), 0.72);
  const px = inject.match(/const SWAY_PX = ([0-9.]+)/);
  assert.ok(px, 'the amplitude should be a named constant');
  assert.equal(Number(px[1]), 8, 'the sway distance itself was not the complaint');
});

test('re-entering thinking mid-fade does not restart the phase', () => {
  // thinking → brief listening → thinking happens constantly in a real turn. If
  // the ramp-out were left running while _swaySince got re-stamped, the sway
  // would stutter. Clearing _swayLeftAt on re-entry is what prevents it.
  assert.match(inject, /this\._swayLeftAt = 0;\s*\/\/ re-entered/,
    're-entry must cancel an in-flight ramp-out');
});
