// speech-gate.test.mjs — the STT speech gate hands the engine real speech only
// (#850 phase 2, gating rules from the #845 benchmark).
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SpeechGate, RATE, MAX_SEGMENT_MS } = require('../packages/calls/hearing/speech-gate.js');

// Synthetic audio: "speech" = a 220 Hz tone at amplitude a; silence = zeros
// (call slots are digitally silent between talkers); noise = tiny random.
const tone = (ms, a = 0.3) => Float32Array.from({ length: Math.round(ms * RATE / 1000) }, (_, i) => a * Math.sin(2 * Math.PI * 220 * i / RATE));
const silence = (ms) => new Float32Array(Math.round(ms * RATE / 1000));
const noise = (ms, a = 0.004) => Float32Array.from({ length: Math.round(ms * RATE / 1000) }, () => (Math.random() * 2 - 1) * a);

function run(parts) {
  const finals = [], partials = [];
  const g = new SpeechGate({ onFinal: (s) => finals.push(s), onPartial: (s) => partials.push(s) });
  let at = 1_000_000;
  for (const p of parts) {
    // feed in 256 ms chunks, as the page tap does
    for (let i = 0; i < p.length; i += 4096) {
      const c = p.subarray(i, i + 4096);
      g.push(c, at);
      at += (c.length / RATE) * 1000;
    }
  }
  g.flush();
  return { finals, partials };
}
const secs = (s) => s.audio.length / RATE;

test('one utterance between silences is one segment, padded, with its timing', () => {
  const { finals } = run([silence(2000), tone(2000), silence(2000)]);
  assert.equal(finals.length, 1);
  assert.ok(secs(finals[0]) >= 2.0 && secs(finals[0]) <= 2.8, `segment ${secs(finals[0])}s`);
  assert.ok(Math.abs(finals[0].startAt - (1_000_000 + 2000 - 300)) < 60, `startAt ${finals[0].startAt}`);
});

test('silence and faint noise produce nothing (no invented "Thank you.")', () => {
  assert.equal(run([silence(10000)]).finals.length, 0);
  assert.equal(run([noise(10000)]).finals.length, 0);
});

test('short isolated bursts (clicks, breaths) are dropped', () => {
  const { finals } = run([silence(1000), tone(200), silence(2000), tone(300), silence(2000)]);
  assert.equal(finals.length, 0);
});

test('a brief pause inside a sentence does not split it; a real pause does', () => {
  assert.equal(run([tone(1200), silence(300), tone(1200), silence(1500)]).finals.length, 1);
  assert.equal(run([tone(1200), silence(1500), tone(1200), silence(1500)]).finals.length, 2);
});

test('a quieter speaker after a loud one is still heard (threshold is relative, not a noise floor)', () => {
  const { finals } = run([tone(3000, 0.5), silence(2000), tone(2000, 0.12), silence(2000)]);
  assert.equal(finals.length, 2);
});

test('partials arrive while someone is still talking', () => {
  const { partials, finals } = run([tone(5000), silence(1500)]);
  assert.ok(partials.length >= 2, `partials: ${partials.length}`);
  assert.ok(partials.every((p, i) => i === 0 || secs(p) > secs(partials[i - 1])), 'partials grow');
  assert.equal(finals.length, 1);
});

test('a monologue is closed inside the model window', () => {
  const { finals } = run([tone(40000), silence(1500)]);
  assert.ok(finals.length >= 2);
  for (const f of finals) assert.ok(secs(f) * 1000 <= MAX_SEGMENT_MS + 50, `segment ${secs(f)}s`);
});

test('Int16 input (what the page tap sends) is accepted', () => {
  const g = new SpeechGate({ onFinal: (s) => (g.got = s) });
  const t = tone(2000);
  g.push(Int16Array.from(t, (v) => Math.round(v * 32767)), 0);
  g.push(new Int16Array(RATE), 2000);
  g.flush();
  assert.ok(g.got && secs(g.got) >= 2);
});
