// avatar-posture.test.mjs — each bot sits somewhere of its own in its tile, and
// shifts in its seat now and then: one quick move, then still.
//
// Stan, 2026-10-15: every bot's face was dead centre at the same size, which
// looks robotic in a grid. Run: node --test tests/avatar-posture.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../electron-app/avatar-posture.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const inject = readFileSync(join(root, 'electron-app/page-inject.js'), 'utf8');
const preload = readFileSync(join(root, 'electron-app/preload-meet.js'), 'utf8');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const { PREFERENCES } = require('../electron-app/preferences-schema.js');

const W = 1280, H = 720;
const inFrame = (p, w = W, h = H) => {
  const size = P.FACE_FRAC * Math.min(w, h) * p.scale;
  const cx = w / 2 + p.dx * w, cy = h / 2 + p.dy * h;
  return cx - size / 2 >= -1e-6 && cx + size / 2 <= w + 1e-6
    && cy - size / 2 >= -1e-6 && cy + size / 2 <= h + 1e-6;
};

test('FACE_FRAC matches the face size page-inject actually draws', () => {
  const m = inject.match(/const emojiSize = Math\.min\(w, h\) \* ([\d.]+);/);
  assert.ok(m, 'emojiSize line found');
  assert.equal(Number(m[1]), P.FACE_FRAC);
});

test('resting posture is deterministic per seed, and differs between bots', () => {
  const a1 = P.restingPosture('host|Default|Jimmy');
  const a2 = P.restingPosture('host|Default|Jimmy');
  const b = P.restingPosture('host|Default|Pepper');
  assert.deepEqual(a1, a2);
  assert.notDeepEqual(a1, b);
  // And the whole shift sequence replays identically from the same seed.
  const run = (seed) => {
    const s = P.createPostureState(seed, 0);
    const out = [];
    for (let t = 0; t < 10 * 60_000; t += 500) out.push(P.stepPosture(s, t, W, H, false));
    return out;
  };
  assert.deepEqual(run('x'), run('x'));
});

test('resting posture stays within the tasteful range', () => {
  for (let i = 0; i < 500; i++) {
    const r = P.restingPosture('seed-' + i);
    assert.ok(Math.abs(r.dx) <= P.REST_OFFSET_X);
    assert.ok(Math.abs(r.dy) <= P.REST_OFFSET_Y);
    assert.ok(r.scale >= P.REST_SCALE_MIN && r.scale <= P.REST_SCALE_MAX);
  }
});

test('the face never leaves the frame, at any moment, in any tile shape', () => {
  for (const [w, h] of [[1280, 720], [720, 720], [640, 960]]) {
    for (let i = 0; i < 40; i++) {
      const s = P.createPostureState('bounds-' + i, 0);
      for (let t = 0; t < 20 * 60_000; t += 250) {
        if (t % 90_000 === 0) P.noteNameMentioned(s, t, 1430);
        const p = P.stepPosture(s, t, w, h, false);
        assert.ok(inFrame(p, w, h), `off-frame at ${w}x${h} t=${t}: ${JSON.stringify(p)}`);
      }
    }
  }
  // clampPosture pulls an absurd pose back in.
  assert.ok(inFrame(P.clampPosture({ dx: 0.9, dy: -0.9, scale: 3 }, W, H)));
});

test('easing: starts and ends exactly, monotonic, no snaps', () => {
  assert.equal(P.easeInOutCubic(0), 0);
  assert.equal(P.easeInOutCubic(1), 1);
  assert.equal(P.easeInOutCubic(0.5), 0.5);
  assert.equal(P.easeInOutCubic(-1), 0);
  assert.equal(P.easeInOutCubic(2), 1);
  let prev = 0;
  for (let i = 1; i <= 100; i++) {
    const v = P.easeInOutCubic(i / 100);
    assert.ok(v >= prev, 'monotonic');
    assert.ok(v - prev < 0.04, 'no step bigger than 4% of the move per 1% of time');
    prev = v;
  }
  const a = { dx: 0, dy: 0, scale: 1 }, b = { dx: 0.1, dy: -0.05, scale: 1.1 };
  assert.deepEqual(P.lerpPosture(a, b, 0), a);
  assert.deepEqual(P.lerpPosture(a, b, 1), b);
});

test('a shift is one quick move, then the face holds completely still', () => {
  const s = P.createPostureState('hold', 0);
  const first = s.nextShiftAt;
  assert.ok(first >= P.INTERVAL_MS_MIN && first <= P.INTERVAL_MS_MAX, 'first shift 1–2 min in');
  // Still until then.
  const rest = P.stepPosture(s, 0, W, H, false);
  assert.deepEqual(P.stepPosture(s, first - 1, W, H, false), rest);
  // The move.
  P.stepPosture(s, first, W, H, false);
  assert.ok(s.duration >= P.SHIFT_MS_MIN && s.duration <= P.SHIFT_MS_MAX, 'move takes 1–2 s');
  const mid = P.stepPosture(s, first + s.duration / 2, W, H, false);
  const end = P.stepPosture(s, first + s.duration, W, H, false);
  assert.notDeepEqual(mid, end);
  // Then nothing until the next shift: no drift.
  const next = s.nextShiftAt;
  const gap = next - (first + s.duration);
  assert.ok(gap >= P.INTERVAL_MS_MIN && gap <= P.INTERVAL_MS_MAX, 'next shift 1–2 min after this one lands');
  for (let t = first + s.duration; t < next; t += 1000) {
    assert.deepEqual(P.stepPosture(s, t, W, H, false), end);
  }
});

test('shifts stay near the resting posture', () => {
  const s = P.createPostureState('near', 0);
  for (let i = 0; i < 50; i++) {
    P.startShift(s, i * 200_000);
    assert.ok(Math.abs(s.to.dx - s.rest.dx) <= P.SHIFT_OFFSET + 1e-12);
    assert.ok(Math.abs(s.to.dy - s.rest.dy) <= P.SHIFT_OFFSET + 1e-12);
    assert.ok(Math.abs(s.to.scale / s.rest.scale - 1) <= P.SHIFT_SCALE + 1e-12);
  }
});

test('a due shift waits while the bot is speaking', () => {
  const s = P.createPostureState('busy', 0);
  const due = s.nextShiftAt;
  P.stepPosture(s, due + 5000, W, H, true);
  assert.equal(s.startAt, 0, 'no shift mid-sentence');
  P.stepPosture(s, due + 6000, W, H, false);
  assert.equal(s.startAt, due + 6000, 'starts as soon as it stops');
});

test('after speaking: sometimes pulls the next shift forward, shortly after', () => {
  let fired = 0, trials = 400;
  for (let i = 0; i < trials; i++) {
    const s = P.createPostureState('speak-' + i, 0);
    const now = P.AFTER_SPEAK_MIN_GAP_MS + 1; // past the min gap, before the interval
    const before = s.nextShiftAt;
    if (P.noteSpeakingEnded(s, now)) {
      fired++;
      assert.ok(s.nextShiftAt >= now + P.AFTER_SPEAK_DELAY_MIN && s.nextShiftAt <= now + P.AFTER_SPEAK_DELAY_MAX);
      assert.ok(s.nextShiftAt < before);
    } else {
      assert.equal(s.nextShiftAt, before);
    }
  }
  const rate = fired / trials;
  assert.ok(rate > 0.3 && rate < 0.7, `~half the time, not every turn (got ${rate})`);
});

test('after speaking: not right after another shift, and not mid-move', () => {
  const s = P.createPostureState('gap', 0);
  assert.equal(P.noteSpeakingEnded(s, P.AFTER_SPEAK_MIN_GAP_MS - 1), false, 'too soon after the start');
  P.startShift(s, 100_000);
  assert.equal(P.noteSpeakingEnded(s, 100_000 + 10), false, 'mid-move');
});

test('name mention: sits up, more centred and larger, held; normal shifts resume later', () => {
  const s = P.createPostureState('host|Default|Jimmy', 0);
  const rest = s.rest;
  P.noteNameMentioned(s, 5000, 1430);
  assert.equal(s.duration, 1430, 'timed to the mention pulse');
  const up = P.stepPosture(s, 5000 + 1430, W, H, false);
  assert.ok(Math.abs(up.dx) < Math.abs(rest.dx) + 1e-12, 'more centred in x');
  assert.ok(Math.abs(up.dy) < Math.abs(rest.dy) + 1e-12, 'more centred in y');
  assert.ok(up.scale > rest.scale, 'larger');
  // Held through the answer...
  assert.deepEqual(P.stepPosture(s, 30_000, W, H, true), up);
  // ...and the ordinary schedule moves it on later, no special settle-back.
  const next = s.nextShiftAt;
  assert.ok(next - (5000 + 1430) >= P.INTERVAL_MS_MIN);
  P.stepPosture(s, next, W, H, false);
  const later = P.stepPosture(s, next + s.duration, W, H, false);
  assert.ok(Math.abs(later.dx - rest.dx) <= P.SHIFT_OFFSET + 1e-9, 'back to shifting around rest');
  // Duration is kept within the 1–2 s move even if the caller asks otherwise.
  P.noteNameMentioned(s, 1e6, 50);
  assert.equal(s.duration, P.SHIFT_MS_MIN);
});

test('wiring: preload exposes the module, page-inject composes it, main pushes the pref', () => {
  assert.match(preload, /globalThis\.__vibeAvatarPosture = require\('\.\/avatar-posture\.js'\)/);
  assert.ok(preload.indexOf('__vibeAvatarPosture') < preload.indexOf("'page-inject.js'"),
    'exposed before page-inject is eval\'d');
  // Added to the translate and multiplied into the scale, alongside (not
  // replacing) the existing tilts.
  assert.match(inject, /ctx\.translate\(cx \+ postX \+ thinkSway/);
  assert.match(inject, /ctx\.rotate\(speakTilt \+ tickTilt/);
  assert.match(inject, /mentionPop \* postScale/);
  assert.match(inject, /case 'set-avatar-posture':/);
  assert.match(inject, /noteNameMentioned\(.*VirtualCamera\.MENTION_PULSE_MS\)/);
  assert.match(inject, /avatarPostureWasSpeaking && !speaking\) P\.noteSpeakingEnded/);
  assert.match(main, /action: 'set-avatar-posture'/);
  assert.equal(PREFERENCES.avatarPostureShifts.type, 'boolean');
  assert.equal(PREFERENCES.avatarPostureShifts.default, true);
});

test('MENTION_PULSE_MS matches the pulse constants in _render', () => {
  const n = (name) => Number(inject.match(new RegExp(`const ${name} = (\\d+)`))[1]);
  const total = n('MENTION_ATTACK_MS') + n('MENTION_HOLD_MS') + n('MENTION_RELEASE_MS');
  const m = inject.match(/static MENTION_PULSE_MS = (\d+) \+ (\d+) \+ (\d+);/);
  assert.ok(m);
  assert.equal(Number(m[1]) + Number(m[2]) + Number(m[3]), total);
  assert.ok(total >= P.SHIFT_MS_MIN && total <= P.SHIFT_MS_MAX);
});
