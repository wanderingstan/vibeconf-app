// audio-transcription.test.mjs — hearing a call by transcribing its audio
// (#850 phase 2, #836): tapped PCM in, the same caption turns out as Meet's.
// The engine is faked (it "transcribes" by audio length); the gate is real.
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AudioTranscription, SOURCE_EVENTS, STT_AUDIO_CHANNEL } = require('../packages/calls/hearing/caption-source.js');
const { RATE } = require('../packages/calls/hearing/speech-gate.js');

const tone = (ms, a = 0.3) => Float32Array.from({ length: Math.round(ms * RATE / 1000) }, (_, i) => a * Math.sin(2 * Math.PI * 220 * i / RATE));
const silence = (ms) => new Float32Array(Math.round(ms * RATE / 1000));
const toInt16 = (f) => Int16Array.from(f, (v) => Math.round(v * 32767));

function fakeEngine({ delayMs = 0, fail = false } = {}) {
  const calls = [];
  return {
    calls,
    ready: async () => {},
    transcribe: async (audio, opts) => {
      calls.push({ secs: audio.length / RATE, ...opts });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (fail) throw new Error('engine down');
      // A word per ~0.5 s, so a longer segment reads as a longer sentence.
      return { text: Array.from({ length: Math.max(1, Math.round(audio.length / RATE / 0.5)) }, (_, i) => `w${i}`).join(' '), language: 'en' };
    },
  };
}

function harness(opts = {}) {
  const ipcMain = new EventEmitter();
  const taps = [];
  const engine = opts.engine || fakeEngine();
  const src = new AudioTranscription({
    ipcMain,
    startTap: () => taps.push('start'),
    stopTap: () => taps.push('stop'),
    engine,
    attribute: opts.attribute || (() => 'Stan James'),
    keywords: () => ['Melinda', 'Stan James'],
    engineLanguage: (t) => (t ? t.split('-')[0] : null),
  });
  const events = [];
  for (const ev of Object.values(SOURCE_EVENTS)) src.on(ev, (p) => events.push([ev, p]));
  let at = 1_000_000;
  const feed = (stream, audio) => {
    for (let i = 0; i < audio.length; i += 4096) {
      const c = audio.subarray(i, i + 4096);
      ipcMain.emit(STT_AUDIO_CHANNEL, {}, { stream, rate: RATE, at, pcm: toInt16(c) });
      at += (c.length / RATE) * 1000;
    }
  };
  const settle = () => new Promise((r) => setTimeout(r, 30));
  return { ipcMain, src, engine, taps, events, feed, settle };
}
const lastTurns = (events) => [...events].reverse().find(([e]) => e === SOURCE_EVENTS.turns)?.[1].turns;

test('start taps the page and reports it can hear; stop releases the tap', async () => {
  const h = harness();
  h.src.start();
  h.src.start(); // idempotent
  await h.settle();
  assert.deepEqual(h.taps, ['start']);
  assert.deepEqual(h.events.find(([e]) => e === SOURCE_EVENTS.state), [SOURCE_EVENTS.state, { on: true }]);
  h.src.stop();
  assert.deepEqual(h.taps, ['start', 'stop']);
  assert.equal(h.ipcMain.listenerCount(STT_AUDIO_CHANNEL), 0);
});

test('an utterance becomes one caption turn, attributed, final after the pause', async () => {
  const h = harness();
  h.src.start();
  h.feed('remote-media-1', silence(1000));
  h.feed('remote-media-1', tone(3000));
  h.feed('remote-media-1', silence(1500));
  await h.settle();
  const turns = lastTurns(h.events);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].speaker, 'Stan James');
  assert.equal(turns[0].isBottommost, true);
  assert.ok(turns[0].text.split(' ').length >= 5, turns[0].text);
  assert.ok(h.events.some(([e]) => e === SOURCE_EVENTS.ready), 'ready on first heard words');
  // Fed faster than real time, the queued partials are superseded by the final
  // (only the latest view of a segment matters), so at least the final ran,
  // with the call's names as keywords.
  assert.ok(h.engine.calls.length >= 1);
  assert.deepEqual(h.engine.calls.at(-1).keywords, ['Melinda', 'Stan James']);
});

test('silence never reaches the engine (no invented words)', async () => {
  const h = harness();
  h.src.start();
  h.feed('remote-media-1', silence(8000));
  await h.settle();
  assert.equal(h.engine.calls.length, 0);
  assert.equal(lastTurns(h.events), undefined);
});

test('two utterances are two turns, in order; the turn shape matches the platform captions', async () => {
  const h = harness();
  h.src.start();
  h.feed('remote-media-1', tone(1500));
  h.feed('remote-media-1', silence(1500));
  h.feed('remote-media-1', tone(2500));
  h.feed('remote-media-1', silence(1500));
  await h.settle();
  const turns = lastTurns(h.events);
  assert.equal(turns.length, 2);
  assert.ok(turns[0].turnId < turns[1].turnId);
  assert.deepEqual(Object.keys(turns[0]).sort(), ['isBottommost', 'speaker', 'text', 'turnId']);
  assert.deepEqual(turns.map((t) => t.isBottommost), [false, true]);
});

test('a slow engine never lets a stale partial overwrite the final text', async () => {
  const h = harness({ engine: fakeEngine({ delayMs: 15 }) });
  h.src.start();
  h.feed('s', tone(6000));
  h.feed('s', silence(1500));
  await new Promise((r) => setTimeout(r, 400));
  const turns = lastTurns(h.events);
  assert.equal(turns.length, 1);
  // the final covers the whole 6 s utterance (+padding): ~12 words, not a partial's fewer
  assert.ok(turns[0].text.split(' ').length >= 12, turns[0].text);
});

test('an engine failure is logged, not thrown, and the source keeps running', async () => {
  const h = harness({ engine: fakeEngine({ fail: true }) });
  h.src.start();
  h.feed('s', tone(2000));
  h.feed('s', silence(1500));
  await h.settle();
  assert.equal(lastTurns(h.events), undefined);
});

test('language: supported tags pin the engine; unsupported ones say so', async () => {
  const h = harness({});
  h.src._engineLanguage = (t) => (t && /^(en|de|es)/.test(t) ? t.slice(0, 2) : null);
  assert.deepEqual(await h.src.setLanguage('de-DE'), { ok: true, language: 'de-DE' });
  h.src.start();
  h.feed('s', tone(2000));
  h.feed('s', silence(1500));
  await h.settle();
  assert.equal(h.engine.calls.at(-1).language, 'de');
  const r = await h.src.setLanguage('ja-JP');
  assert.equal(r.ok, false);
  assert.match(r.error, /auto-detect/);
});

test('each stream has its own gate; a detached stream closes its open segment', async () => {
  const names = { a: 'Stan James', b: 'Anya' };
  const h = harness({ attribute: (s) => names[s] });
  h.src.start();
  h.feed('a', tone(2000));
  h.feed('b', tone(2000));
  h.ipcMain.emit(STT_AUDIO_CHANNEL, {}, { stream: 'a', event: 'detached' });
  h.feed('b', silence(1500));
  await h.settle();
  const speakers = lastTurns(h.events).map((t) => t.speaker).sort();
  assert.deepEqual(speakers, ['Anya', 'Stan James']);
});

test('the router re-emits the active source and switches cleanly per call', async () => {
  const { CaptionRouter } = require('../packages/calls/hearing/caption-source.js');
  const mk = () => {
    const e = new EventEmitter();
    e.started = 0; e.stopped = 0;
    e.start = () => e.started++;
    e.stop = () => e.stopped++;
    e.setLanguage = async (l) => ({ ok: true, language: l });
    e.recover = () => {};
    return e;
  };
  const a = mk(), b = mk();
  const r = new CaptionRouter(a);
  const got = [];
  r.on(SOURCE_EVENTS.turns, (p) => got.push(p));
  r.start();
  assert.equal(a.started, 1);
  a.emit(SOURCE_EVENTS.turns, { from: 'a' });
  r.use(b);
  assert.equal(a.stopped, 1);
  assert.equal(b.started, 1);
  a.emit(SOURCE_EVENTS.turns, { from: 'a-late' }); // detached: must not leak through
  b.emit(SOURCE_EVENTS.turns, { from: 'b' });
  assert.deepEqual(got, [{ from: 'a' }, { from: 'b' }]);
  r.use(b); // no-op
  assert.equal(b.started, 1);
  assert.deepEqual(await r.setLanguage('es'), { ok: true, language: 'es' });
});

test('1:1 attribution: the one other human, else a neutral label (never a guess)', () => {
  const { oneToOneSpeaker, UNATTRIBUTED_SPEAKER } = require('../packages/calls/hearing/caption-source.js');
  const me = { name: 'Melinda', isSelf: true };
  assert.equal(oneToOneSpeaker([me, { name: 'Stan James' }], { selfName: 'Melinda' }), 'Stan James');
  assert.equal(oneToOneSpeaker([{ name: 'Melinda' }, { name: 'Stan James' }], { selfName: 'Melinda' }), 'Stan James');
  assert.equal(oneToOneSpeaker([me, { name: 'Stan James' }, { name: 'Jimmy' }], { botNames: ['Jimmy'] }), 'Stan James');
  assert.equal(oneToOneSpeaker([me, { name: 'Stan James' }, { name: 'Anya' }]), UNATTRIBUTED_SPEAKER);
  assert.equal(oneToOneSpeaker([me]), UNATTRIBUTED_SPEAKER);
  assert.equal(oneToOneSpeaker(null), UNATTRIBUTED_SPEAKER);
});
