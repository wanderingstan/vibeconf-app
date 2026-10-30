// avatar-tilt-snap.test.mjs — the head must never snap between two frames.
//
// Stan, live in teams-9361264884308-20261016T151416Z (~2 min in): while a human
// was talking, the bot's face slowly leaned over, then jolted back upright in a
// single frame. The lean was the turn-countdown pendulum (gateTilt), which
// sweeps out while the floor is quiet; when the human carried on talking,
// `!this.anyoneSpeaking` zeroed it outright — up to ~8° gone in one frame. The
// same cut happens on a gate clear/re-arm or the bot starting to speak, and the
// agent jostle and dead flip snap by construction.
//
// The fix routes the whole rotation (and the pendulum on its own, with a tighter
// rate limit) through avatar-posture.js smoothTilt. These tests replay the
// reported sequence frame by frame and measure the largest per-frame change.
//
// Run: node --test tests/avatar-tilt-snap.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../electron-app/avatar-posture.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const inject = readFileSync(join(root, 'electron-app/page-avatar.js'), 'utf8');

const FRAME_MS = 1000 / 30;       // the virtual camera's render rate
const DEG = Math.PI / 180;
const SNAP = 2 * DEG;             // a per-frame change past this reads as a jolt
const GATE_MAX_RATE = Number(inject.match(/GATE_TILT_MAX_RATE = ([\d.]+)/)[1]);

// page-inject's pendulum, guards included.
const gateTiltAt = (now, gate, anyoneSpeaking) => {
  if (!gate || anyoneSpeaking) return 0;
  const span = gate.deadline - gate.from;
  if (!(span > 0)) return 0;
  const p = (now - gate.from) / span;
  return p >= 0 && p <= 1 ? Math.sin(Math.PI * p) * 0.14 : 0;
};

// Drive a frame sequence; `smooth` mirrors page-inject (gate smoother, then the
// combined one). Returns the drawn angles.
function run(frames, rawAt, { smooth }) {
  const gateS = P.createTiltSmoother();
  const allS = P.createTiltSmoother();
  const out = [];
  for (let i = 0; i < frames; i++) {
    const now = 1_000_000 + i * FRAME_MS;
    let { gate = 0, other = 0 } = rawAt(now, i);
    if (smooth) gate = P.smoothTilt(gateS, gate, now, GATE_MAX_RATE);
    let tilt = gate + other;
    if (smooth) tilt = P.smoothTilt(allS, tilt, now);
    out.push(tilt);
  }
  return out;
}
const maxStep = (a) => a.slice(1).reduce((m, v, i) => Math.max(m, Math.abs(v - a[i])), 0);

// The reported sequence: floor goes quiet, the gate arms a 2s window, the
// pendulum swings out, and 1s in (the peak) the human resumes talking.
const t0 = 1_000_000;
const gate = { from: t0, deadline: t0 + 2000 };
const humanResumesAt = t0 + 1000;
const reported = (now) => ({ gate: gateTiltAt(now, gate, now >= humanResumesAt) });

test('BEFORE: the pendulum is cut to level in one frame when the human resumes', () => {
  const raw = run(90, reported, { smooth: false });
  assert.ok(maxStep(raw) > 7 * DEG, `raw jump ${(maxStep(raw) / DEG).toFixed(1)}° — the snap Stan saw`);
});

test('AFTER: the same sequence eases back with no per-frame jump', () => {
  const drawn = run(90, reported, { smooth: true });
  assert.ok(maxStep(drawn) < SNAP, `largest frame step ${(maxStep(drawn) / DEG).toFixed(2)}°`);
  assert.ok(Math.abs(drawn[drawn.length - 1]) < 1e-6, 'and it still lands exactly level');
});

test('a cut anywhere in the sweep, not just at the peak, is eased', () => {
  for (const at of [100, 300, 600, 1400, 1800]) {
    const seq = (now) => ({ gate: gateTiltAt(now, gate, now >= t0 + at) });
    const drawn = run(90, seq, { smooth: true });
    assert.ok(maxStep(drawn) < SNAP, `cut at ${at}ms: ${(maxStep(drawn) / DEG).toFixed(2)}°`);
  }
});

test('a re-armed gate (sweep restarts from level mid-swing) is eased', () => {
  const rearmed = { from: t0 + 900, deadline: t0 + 2900 };
  const seq = (now) => ({ gate: gateTiltAt(now, now < t0 + 900 ? gate : rearmed, false) });
  assert.ok(maxStep(run(120, seq, { smooth: false })) > 5 * DEG, 'raw re-arm snaps');
  assert.ok(maxStep(run(120, seq, { smooth: true })) < SNAP);
});

test('the agent jostle and the dead-flip revival ease instead of snapping', () => {
  const jostle = (now, i) => ({ other: i < 30 ? -0.52 : 0.52 });      // −30° → +30°
  const revive = (now, i) => ({ other: i < 30 ? Math.PI * 0.75 : 0 }); // toppled → upright
  for (const seq of [jostle, revive]) {
    const drawn = run(60, seq, { smooth: true });
    // A 60°+ move over ~500ms has a steep middle by design; what matters is
    // that it is spread over many frames, not one.
    assert.ok(maxStep(drawn) < 0.5 * Math.abs(drawn[0] - drawn[59]), 'spread out, not a jump');
    assert.ok(Math.abs(drawn[59] - seq(0, 59).other) < 1e-6, 'lands on the target');
  }
});

test('continuous motion passes through untouched', () => {
  // The speaking wobble, the tick pulse and the name-mention cock (fast attack,
  // hold, ease-in release, at its ±30% max) must draw exactly as before.
  const mention = (age) => {
    if (age < 0) return 0;
    if (age < 150) return age / 150;
    if (age < 1050) return 1;
    if (age < 1430) { const p = (age - 1050) / 380; return 1 - p * p * p; }
    return 0;
  };
  const seq = (now, i) => ({
    other: Math.sin(i * 0.3) * 0.05
      + (i * FRAME_MS < 700 ? Math.sin((i * FRAME_MS / 700) * Math.PI) * 0.16 * 1.3 : 0)
      + mention(i * FRAME_MS - 200) * 0.24 * 1.3,
  });
  const raw = run(80, seq, { smooth: false });
  const drawn = run(80, seq, { smooth: true });
  raw.forEach((v, i) => assert.ok(Math.abs(v - drawn[i]) < 1e-9, `frame ${i} changed`));
});

test('page-inject draws through the smoother, pendulum first', () => {
  assert.match(inject, /gateTilt = tiltApi\.smoothTilt\(this\._gateTiltSmooth, gateTilt, Date\.now\(\), GATE_TILT_MAX_RATE\)/);
  assert.match(inject, /tilt = tiltApi\.smoothTilt\(this\._tiltSmooth, tilt, Date\.now\(\)\)/);
  assert.match(inject, /ctx\.rotate\(tilt\)/);
  assert.doesNotMatch(inject, /ctx\.rotate\(speakTilt/, 'the raw sum is being drawn again');
});

// ── The path the Teams call actually took ──────────────────────────────────
// Teams has no speaking meter (the log shows peakSpeakers=0), so the gate is
// caption-driven. The server arms it from the LAST CAPTION time, which is
// already in the past when the renderer hears about it; when it fires and a
// newer caption has arrived, it re-arms with another past `from`. Sweeping from
// a past `from` starts the pendulum mid-swing: the head jumps out, drifts back
// to level, and repeats every 1–2s while the human talks.

// Mirrors page-inject's 'set-silence-gate' handler.
const receiveGate = (prev, payload, now) => {
  if (!payload || !payload.deadline) return null;
  const live = prev && prev.deadline > now;
  const from = live ? prev.from : Math.max(payload.from || now, now);
  return { deadline: payload.deadline, from: Math.min(from, payload.deadline) };
};

// Captions every ~1s for 8s; the gate arms 2.5s after the latest caption,
// fires, and re-arms from whichever caption is newest at that moment.
function teamsCaptionRearms({ anchor }) {
  const captions = Array.from({ length: 8 }, (_, i) => t0 + i * 1000);
  const SIL = 2500;
  const events = [];
  let deadline = captions[0] + SIL;
  events.push({ at: captions[0] + 400, payload: { from: captions[0], deadline } });
  while (deadline < captions[captions.length - 1] + SIL) {
    const fireAt = deadline;
    const last = captions.filter((c) => c <= fireAt).pop();
    events.push({ at: fireAt, payload: null });
    deadline = last + SIL + 50;
    events.push({ at: fireAt + 1, payload: { from: last, deadline } });
  }
  let g = null, ei = 0;
  return (now) => {
    while (ei < events.length && events[ei].at <= now) {
      g = anchor ? receiveGate(g, events[ei].payload, events[ei].at) : events[ei].payload;
      ei++;
    }
    return { gate: gateTiltAt(now, g, false) };
  };
}

test('BEFORE: a gate armed from a past caption starts mid-swing (the Teams jolt)', () => {
  const raw = run(330, teamsCaptionRearms({ anchor: false }), { smooth: false });
  assert.ok(maxStep(raw) > 4 * DEG, `raw jump ${(maxStep(raw) / DEG).toFixed(1)}°`);
});

test('AFTER: anchoring a new sweep at arrival removes the jump at its source', () => {
  const anchored = run(330, teamsCaptionRearms({ anchor: true }), { smooth: false });
  assert.ok(maxStep(anchored) < SNAP, `largest frame step ${(maxStep(anchored) / DEG).toFixed(2)}°`);
  const drawn = run(330, teamsCaptionRearms({ anchor: true }), { smooth: true });
  assert.ok(maxStep(drawn) < SNAP);
});

test('the smoother alone would also have caught it', () => {
  const drawn = run(330, teamsCaptionRearms({ anchor: false }), { smooth: true });
  assert.ok(maxStep(drawn) < SNAP, `largest frame step ${(maxStep(drawn) / DEG).toFixed(2)}°`);
});

test("page-inject's gate handler anchors new sweeps and keeps a live one's start", () => {
  const h = inject.slice(inject.indexOf("case 'set-silence-gate'"));
  const body = h.slice(0, h.indexOf('break;'));
  assert.match(body, /const live = prev && prev\.deadline > gateNow/);
  assert.match(body, /live \? prev\.from : Math\.max\(payload\.from \|\| gateNow, gateNow\)/);
  assert.match(body, /Math\.min\(from, payload\.deadline\)/);
});
