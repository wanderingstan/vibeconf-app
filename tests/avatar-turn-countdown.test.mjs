// avatar-turn-countdown.test.mjs — the pendulum that lands on the moment the
// bot takes its turn.
//
// The avatar swings out and returns to LEVEL exactly when the silence gate
// fires. Level-is-the-endpoint is the whole design: a fill or a fade has no
// unmistakable finish, but "back where it started" does, so the room can learn
// without being told how long they have before the bot speaks. The bot answers
// slower than a human, and those seconds are where people either wait or talk
// over it.
//
// Run: node --test tests/avatar-turn-countdown.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const inject = readFileSync(join(root, 'electron-app/page-inject.js'), 'utf8');

test('the sweep starts and ends at level, peaking in the middle', () => {
  // sin(πp) over p∈[0,1]. Anything that does not return to 0 at p=1 breaks the
  // only thing the viewer is meant to read.
  const m = inject.match(/Math\.sin\(Math\.PI \* p\) \* ([\d.]+)/);
  assert.ok(m, 'the countdown must be a half-sine');
  const amp = Number(m[1]);
  const at = (p) => Math.sin(Math.PI * p) * amp;
  assert.equal(at(0), 0, 'starts level');
  assert.ok(Math.abs(at(1)) < 1e-9, 'RETURNS to level — this is the signal');
  assert.ok(at(0.5) > at(0.25) && at(0.5) > at(0.75), 'peaks in the middle');
  // Big enough to notice on a video tile, small enough not to compete with the
  // speaking jaw or the tick head-tilt (~9°).
  const deg = amp * 180 / Math.PI;
  assert.ok(deg > 4 && deg < 12, `${deg.toFixed(1)}° is outside the legible-but-quiet band`);
});

test('it tracks an ABSOLUTE deadline, re-read every frame', () => {
  // The deadline genuinely moves: name-mention resolves faster, and #372's
  // re-arm corrects a late timer. A duration captured when the gate armed would
  // be stale the moment it is corrected, and a countdown that finishes at the
  // wrong time teaches the room to distrust the endpoint — worse than none.
  assert.match(inject, /const span = gate\.deadline - gate\.from/);
  assert.match(inject, /const p = \(Date\.now\(\) - gate\.from\) \/ span/);
  assert.match(inject, /case 'set-silence-gate'/);
});

test('the server announces every arm and every clear', () => {
  // Three call sites: armed/re-armed, fired, and the resolve-on-arrival path
  // where there is no window to show at all.
  const arms = server.match(/_announceSilenceGate\(/g) || [];
  assert.ok(arms.length >= 4, `expected the helper plus arm/fire/immediate, saw ${arms.length}`);
  assert.match(server, /this\._announceSilenceGate\(fireAt, silenceStart\)/);
  assert.match(server, /this\._announceSilenceGate\(null\);\s*\/\/ no window to show/);
});

test('re-announcements are deduped, or a talkative moment floods the renderer', () => {
  // _checkWaiters runs on every caption event. Without dedup this would push
  // dozens of identical deadlines a second, and re-targeting the animation on
  // each would make it stutter rather than sweep.
  const fn = server.slice(server.indexOf('_announceSilenceGate(deadline, from)'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /Math\.abs\(deadline - prev\) < 25/, 'slop must match the re-arm guard');
  assert.match(body, /if \(prev == null\) return/, 'clearing an already-clear gate is not an event');
});

test('it stays out of the way of the states that own the face', () => {
  // While someone is still talking the window means nothing yet; while the bot
  // speaks or yields, other motion is already saying something louder.
  const block = inject.slice(inject.indexOf('let gateTilt = 0;'), inject.indexOf('const peeking ='));
  assert.match(block, /!this\.anyoneSpeaking/);
  assert.match(block, /!this\.speaking/);
  assert.match(block, /this\.state !== 'speaking'/);
  assert.match(block, /this\.state !== 'yielding'/);
  // And it composes with the existing rotations rather than replacing them.
  assert.match(inject, /ctx\.rotate\(speakTilt \+ tickTilt \+ agentTiltNow \+ deadFlip \+ mentionTilt \+ gateTilt\)/);
});

test('a stale or out-of-range gate produces no tilt', () => {
  // p outside [0,1] means the deadline passed or the clock jumped; the avatar
  // must sit level rather than snapping to some arbitrary angle.
  const block = inject.slice(inject.indexOf('let gateTilt = 0;'), inject.indexOf('const peeking ='));
  assert.match(block, /if \(p >= 0 && p <= 1\)/);
  assert.match(block, /if \(span > 0\)/, 'a zero or negative span must not divide');
});
