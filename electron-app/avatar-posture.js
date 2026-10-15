// avatar-posture.js — where the face sits in its tile, and when it shifts.
//
// Every bot's face used to sit dead centre at exactly the same size, so a Meet
// grid of bots looked like one stamp repeated. People don't sit like that: each
// has their own resting spot in frame, and every so often they shift in their
// seat — one quick move, then still again for a minute or two.
//
// Two layers:
//   · RESTING posture: a per-bot offset + scale, derived from a seed (host +
//     profile + bot name), so it is stable across a call and across reloads,
//     and two bots in the same Meet land in different places.
//   · SHIFTS: every 60–120 s, or (sometimes) shortly after the bot finishes
//     speaking, ease over 1–2 s to a new pose near the resting one, then HOLD
//     completely still. No drift between shifts — Stan, 2026-10-15.
//
// The posture composes UNDER the existing motion (bob, breathe, tilts, sway):
// page-inject.js adds it to the translate and multiplies it into the scale.
//
// Pure: no DOM, no timers, no Math.random. The caller passes `now`, and the
// randomness comes from a seeded PRNG held in the state, so tests can drive it.
//
// Loaded two ways: require()d by tests, and by preload-meet.js, which hangs it
// on globalThis.__vibeAvatarPosture for page-inject.js (eval'd into the page
// world, where require does not exist).

'use strict';

// Face box as a fraction of min(w, h). Mirrors `emojiSize` in page-inject's
// _render; tests/avatar-posture.test.mjs pins the two together.
const FACE_FRAC = 0.77;

const REST_OFFSET_X = 0.15;       // ± fraction of tile width (Stan: sideways is where tiles have room)
const REST_OFFSET_Y = 0.06;       // ± fraction of tile height (the face fills more of it)
const REST_SCALE_MIN = 0.9;
const REST_SCALE_MAX = 1.1;

const SHIFT_OFFSET = 0.03;        // ± fraction of tile, around the resting pose
const SHIFT_SCALE = 0.04;         // ± around the resting scale

const SHIFT_MS_MIN = 1000;        // one quick move...
const SHIFT_MS_MAX = 2000;
const INTERVAL_MS_MIN = 60_000;   // ...then still for a minute or two
const INTERVAL_MS_MAX = 120_000;

// After the bot stops talking, sometimes settle into a new pose, the way a
// speaker sits back. Not every time — that would turn into a tic.
const AFTER_SPEAK_PROB = 0.5;
const AFTER_SPEAK_DELAY_MIN = 600;
const AFTER_SPEAK_DELAY_MAX = 2500;
const AFTER_SPEAK_MIN_GAP_MS = 20_000; // no after-speak shift this soon after the last one

// Name mentioned: sit up and pay attention. Move most of the way back toward
// centre and grow a little, then hold like any other pose. There is no special
// "settle back": the ordinary shifts (interval, or after speaking) move it on
// as usual (Stan, 2026-10-15). Sits on top of page-inject's mention pulse: the
// pulse is the quick perk-up, this is the pose it settles into.
const ATTENTIVE_CENTER_KEEP = 0.25; // keep a quarter of the resting offset
const ATTENTIVE_SCALE = 1.08;       // relative to max(rest scale, 1)

const IDENTITY = Object.freeze({ dx: 0, dy: 0, scale: 1 });

// FNV-1a, 32-bit. Stable across runs and platforms.
function hashSeed(str) {
  let h = 0x811c9dc5;
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// mulberry32: tiny, deterministic, good enough for jitter.
function makeRng(seed) {
  let a = (typeof seed === 'number' ? seed : hashSeed(seed)) >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (rng, lo, hi) => lo + rng() * (hi - lo);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Keep the face's box inside the w×h tile. dx/dy are fractions of w/h; the box
// is FACE_FRAC·min(w,h)·scale on a side, centred at (w/2 + dx·w, h/2 + dy·h).
// Scale is clamped first (a face bigger than the tile can't be placed at all),
// then each offset to the slack left on that axis.
function clampPosture(p, w, h) {
  const face = FACE_FRAC * Math.min(w, h);
  const scale = clamp(p.scale, 0.5, Math.min(w, h) / face);
  const size = face * scale;
  const maxDx = Math.max(0, (w - size) / 2) / w;
  const maxDy = Math.max(0, (h - size) / 2) / h;
  return { dx: clamp(p.dx, -maxDx, maxDx), dy: clamp(p.dy, -maxDy, maxDy), scale };
}

function restingPosture(seed) {
  const rng = makeRng(hashSeed('rest|' + seed));
  return {
    dx: between(rng, -REST_OFFSET_X, REST_OFFSET_X),
    dy: between(rng, -REST_OFFSET_Y, REST_OFFSET_Y),
    scale: between(rng, REST_SCALE_MIN, REST_SCALE_MAX),
  };
}

function nearbyPosture(rest, rng) {
  return {
    dx: rest.dx + between(rng, -SHIFT_OFFSET, SHIFT_OFFSET),
    dy: rest.dy + between(rng, -SHIFT_OFFSET, SHIFT_OFFSET),
    scale: rest.scale * (1 + between(rng, -SHIFT_SCALE, SHIFT_SCALE)),
  };
}

function attentivePosture(rest) {
  return {
    dx: rest.dx * ATTENTIVE_CENTER_KEEP,
    dy: rest.dy * ATTENTIVE_CENTER_KEEP,
    scale: Math.max(rest.scale, 1) * ATTENTIVE_SCALE,
  };
}

function easeInOutCubic(t) {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function lerpPosture(a, b, t) {
  const e = easeInOutCubic(t);
  return {
    dx: a.dx + (b.dx - a.dx) * e,
    dy: a.dy + (b.dy - a.dy) * e,
    scale: a.scale + (b.scale - a.scale) * e,
  };
}

// State for one camera. Starts AT rest (no entrance move).
function createPostureState(seed, now) {
  const rest = restingPosture(seed);
  const rng = makeRng(hashSeed('shift|' + seed));
  return {
    rest,
    rng,
    from: rest,
    to: rest,
    startAt: 0,
    duration: 0,
    lastShiftAt: now,
    nextShiftAt: now + between(rng, INTERVAL_MS_MIN, INTERVAL_MS_MAX),
  };
}

function isMoving(s, now) {
  return s.duration > 0 && now < s.startAt + s.duration;
}

function postureAt(s, now) {
  if (!s.duration || now >= s.startAt + s.duration) return s.to;
  if (now <= s.startAt) return s.from;
  return lerpPosture(s.from, s.to, (now - s.startAt) / s.duration);
}

function startShift(s, now, target, duration) {
  s.from = postureAt(s, now);
  s.to = target || nearbyPosture(s.rest, s.rng);
  s.startAt = now;
  s.duration = duration || between(s.rng, SHIFT_MS_MIN, SHIFT_MS_MAX);
  s.lastShiftAt = now;
  s.nextShiftAt = now + s.duration + between(s.rng, INTERVAL_MS_MIN, INTERVAL_MS_MAX);
}

// Someone said the bot's name: sit up. Starts immediately, from wherever the
// face is (even mid-shift), and restarts the interval clock like any shift.
// `duration` lets the caller line the move up with its mention pulse.
function noteNameMentioned(s, now, duration) {
  const d = clamp(duration || SHIFT_MS_MIN, SHIFT_MS_MIN, SHIFT_MS_MAX);
  startShift(s, now, attentivePosture(s.rest), d);
}

// The bot just stopped speaking. Maybe pull the next shift forward to a moment
// from now. Returns true when it did.
function noteSpeakingEnded(s, now) {
  if (isMoving(s, now)) return false;
  if (now - s.lastShiftAt < AFTER_SPEAK_MIN_GAP_MS) return false;
  if (s.rng() >= AFTER_SPEAK_PROB) return false;
  const at = now + between(s.rng, AFTER_SPEAK_DELAY_MIN, AFTER_SPEAK_DELAY_MAX);
  if (at >= s.nextShiftAt) return false;
  s.nextShiftAt = at;
  return true;
}

// Per frame. `busy` (the bot is speaking) defers a due shift rather than
// starting one mid-sentence. Returns the posture to draw, clamped to the tile.
function stepPosture(s, now, w, h, busy) {
  if (!busy && !isMoving(s, now) && now >= s.nextShiftAt) startShift(s, now);
  return clampPosture(postureAt(s, now), w, h);
}

module.exports = {
  FACE_FRAC,
  REST_OFFSET_X, REST_OFFSET_Y, REST_SCALE_MIN, REST_SCALE_MAX,
  SHIFT_OFFSET, SHIFT_SCALE, SHIFT_MS_MIN, SHIFT_MS_MAX,
  INTERVAL_MS_MIN, INTERVAL_MS_MAX,
  AFTER_SPEAK_PROB, AFTER_SPEAK_DELAY_MIN, AFTER_SPEAK_DELAY_MAX, AFTER_SPEAK_MIN_GAP_MS,
  ATTENTIVE_CENTER_KEEP, ATTENTIVE_SCALE,
  IDENTITY,
  attentivePosture, noteNameMentioned,
  hashSeed, makeRng, clampPosture, restingPosture, nearbyPosture,
  easeInOutCubic, lerpPosture,
  createPostureState, postureAt, isMoving, startShift, noteSpeakingEnded, stepPosture,
};
