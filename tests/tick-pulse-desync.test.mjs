// tick-pulse-desync.test.mjs — the background-tick "noted that" pulse (head
// tilt + pop on entering 'thinking') must not fire identically across bots.
//
// Every bot on a call hears the same silence gap at roughly the same
// real-world instant, so without per-process randomness they all entered
// 'thinking' — and fired this pulse — in visible lockstep. Each bot is a
// separate process with no shared state, so the fix has to be: jitter the
// pulse's start time, and re-roll a random direction + size on every firing.
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const inject = fs.readFileSync(path.join(__dirname, '../electron-app/page-inject.js'), 'utf-8');

test("the 'thinking' transition jitters the pulse start and rerolls direction + size", () => {
  const body = inject.slice(inject.indexOf("case 'set-bot-state':"), inject.indexOf("case 'set-mode':"));
  assert.match(body, /const TICK_JITTER_MS = 250/);
  assert.match(body, /cam\._tickPulseAt = Date\.now\(\) \+ Math\.random\(\) \* TICK_JITTER_MS/,
    'start time must be randomized, not a bare Date.now()');
  assert.match(body, /cam\._tickTiltSign = Math\.random\(\) < 0\.5 \? -1 : 1/,
    'direction must be re-rolled on every firing, not fixed/alternating');
  assert.match(body, /cam\._tickTiltMag = 0\.7 \+ Math\.random\(\) \* 0\.6/,
    'size must vary per firing too, or every bot still pops the same amount');
});

test('the render loop actually applies the randomized direction + size to the tilt', () => {
  assert.match(inject,
    /tickTilt = tickPulse \* \(this\._tickTiltSign \|\| 1\) \* \(this\._tickTiltMag \|\| 1\) \* 0\.16/);
});

test('a negative pulseAge (jittered start still in the future) shows no tilt yet', () => {
  // Documents the mechanism the jitter relies on: pulseAge = now - startTime,
  // and the pulse only shows for 0 <= pulseAge < PULSE_MS. A start time in
  // the future makes pulseAge negative, which the existing gate already
  // excludes — no separate "hasn't started yet" branch was needed.
  assert.match(inject, /pulseAge >= 0 && pulseAge < PULSE_MS/);
});
