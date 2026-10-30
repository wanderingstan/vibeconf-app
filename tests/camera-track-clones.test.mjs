// camera-track-clones.test.mjs: every getUserMedia video request gets a LIVE track,
// and a consumer stopping its track can never kill another consumer's video.
//
// The 2026-10-27 WhatsApp incident: the pre-answer camera probe and the answer both
// asked for 1280x720, getCamera() reused the cached VirtualCamera, and getTrack()
// handed BOTH the same canvas track. WhatsApp then stop()ped the probe stream, which
// was the call's track too, so the caller saw no video until set_camera off/on.
//
// page-inject.js is a browser-context IIFE (not importable), so this pulls the pure
// handOutCameraTrack function out of the source and drives it with fake tracks.
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'packages/calls/inject/page-inject.js'), 'utf8');

const fnSrc = /\n {2}function handOutCameraTrack\([\s\S]*?\n {2}\}\n/.exec(src);
assert.ok(fnSrc, 'handOutCameraTrack not found in page-inject.js');

const logs = [];
const fakeConsole = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) };
// eslint-disable-next-line no-new-func
const handOutCameraTrack = new Function('console', `${fnSrc[0]}\nreturn handOutCameraTrack;`)(fakeConsole);

let nextId = 0;
// Models MediaStreamTrack semantics that matter here: clone() shares the source,
// stop() ends only that track, and a source ending ends every clone.
class FakeSource {
  constructor() { this.ended = false; this.tracks = []; }
  end() { this.ended = true; this.tracks.forEach((t) => t._fireEnded()); }
}
class FakeTrack {
  constructor(source) { this.id = `t${nextId++}`; this.source = source; this.stopped = false; this._l = []; source.tracks.push(this); }
  get readyState() { return (this.stopped || this.source.ended) ? 'ended' : 'live'; }
  clone() { return new FakeTrack(this.source); }
  stop() { this.stopped = true; }
  addEventListener(ev, fn) { if (ev === 'ended') this._l.push(fn); }
  _fireEnded() { if (!this.stopped) this._l.forEach((f) => f()); }
}
function fakeCamera() {
  const canvas = {
    width: 1280, height: 720, captures: 0,
    captureStream() {
      this.captures++;
      const src = new FakeSource();
      const t = new FakeTrack(src);
      return { getVideoTracks: () => [t], _src: src };
    },
  };
  return { canvas, stream: canvas.captureStream() };
}

test('the WhatsApp sequence: probe + answer at the same size, probe stopped after answer', () => {
  const cam = fakeCamera();
  const probe = handOutCameraTrack(cam, 'call:getUserMedia', 15);
  const answer = handOutCameraTrack(cam, 'call:getUserMedia', 15);
  assert.notEqual(probe, answer, 'two consumers must never share one track object');
  probe.stop(); // WhatsApp tears down its preview AFTER acquiring the call stream
  assert.equal(answer.readyState, 'live', 'the call track must survive the probe being stopped');
  assert.equal(cam.stream.getVideoTracks()[0].readyState, 'live', 'master must be untouched');
});

test('the master track itself is never handed out', () => {
  const cam = fakeCamera();
  const master = cam.stream.getVideoTracks()[0];
  for (let i = 0; i < 3; i++) assert.notEqual(handOutCameraTrack(cam, 'c', 15), master);
});

test('stopping every handed-out track still leaves the next request live (set_camera off/on)', () => {
  const cam = fakeCamera();
  handOutCameraTrack(cam, 'c', 15).stop();
  handOutCameraTrack(cam, 'c', 15).stop();
  const next = handOutCameraTrack(cam, 'c', 15);
  assert.equal(next.readyState, 'live');
  assert.equal(cam.canvas.captures, 1, 'a healthy master needs no re-capture');
});

test('a dead master is re-captured from the same canvas, loudly, and the handout is live', () => {
  const cam = fakeCamera();
  cam.stream._src.end();
  logs.length = 0;
  const t = handOutCameraTrack(cam, 'call:getUserMedia', 15);
  assert.equal(t.readyState, 'live');
  assert.equal(cam.canvas.captures, 2);
  assert.ok(logs.some((l) => l.includes('camera GUARD: master dead')), 'master death must be logged');
});

test('a missing master is re-captured too', () => {
  const cam = fakeCamera();
  cam.stream = null;
  assert.equal(handOutCameraTrack(cam, 'c', 15).readyState, 'live');
});

test('each handout logs consumer + masterState, like the #274 mic handout', () => {
  const cam = fakeCamera();
  logs.length = 0;
  handOutCameraTrack(cam, 'call:getUserMedia', 15);
  assert.match(logs.join('\n'), /camera getTrack consumer=call:getUserMedia size=1280x720 clone=\S+ master=\S+ \(masterState=live cloneState=live\)/);
});

test('a clone whose source ends logs it (a dead call video is never silent)', () => {
  const cam = fakeCamera();
  handOutCameraTrack(cam, 'call:getUserMedia', 15);
  logs.length = 0;
  cam.stream._src.end();
  assert.ok(logs.some((l) => l.includes('camera clone ENDED consumer=call:getUserMedia')));
});

test('CameraSurface.getTrack delegates to the clone handout and getUserMedia labels its consumer', () => {
  const method = /\n {4}getTrack\(consumer = 'unknown'\) \{([\s\S]*?)\n {4}\}\n/.exec(
    src.slice(src.indexOf('class CameraSurface'), src.indexOf('class VirtualMic')));
  assert.ok(method, 'CameraSurface.getTrack(consumer) not found');
  assert.match(method[1], /return handOutCameraTrack\(this, consumer, config\.fps\)/);
  assert.match(src, /tracks\.push\(camera\.getTrack\('call:getUserMedia'\)\)/);
});
