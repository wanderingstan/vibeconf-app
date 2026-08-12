// call-recorder.test.mjs — the main-process side of call audio recording.
//
// The renderer captures the audio; this module's whole job is to turn a stream
// of arriving base64 chunks into one file per track plus a manifest, without
// corrupting a file on a dropped chunk or a teardown race. That's what's worth
// pinning — the live capture needs a real Meet and can't be unit-tested.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  CallRecordingSession,
  MAX_TRACK_BYTES_BY_KIND,
  CAP_WARN_RATIO,
} = require('../electron-app/call-recorder.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'call-rec-'));
}

test('each track becomes its own file, appended in arrival order', () => {
  const dir = path.join(tmpDir(), 'call');
  const s = new CallRecordingSession(dir, { room: 'abc-defg-hij', startedAt: 1000 });

  // Interleave two tracks the way concurrent MediaRecorders would arrive.
  s.chunk('bot', 0, Buffer.from('B0'), 'audio/webm');
  s.chunk('remote-1', 0, Buffer.from('R0'), 'audio/webm');
  s.chunk('bot', 1, Buffer.from('B1'), 'audio/webm');
  s.chunk('remote-1', 1, Buffer.from('R1'), 'audio/webm');
  s.stop();

  assert.equal(fs.readFileSync(path.join(dir, 'bot.webm'), 'utf8'), 'B0B1');
  assert.equal(fs.readFileSync(path.join(dir, 'remote-1.webm'), 'utf8'), 'R0R1');
});

test('the manifest lists every track with byte/chunk counts and offsets', () => {
  const dir = path.join(tmpDir(), 'call');
  const s = new CallRecordingSession(dir, { room: 'r', botName: 'Jimmy', startedAt: Date.now() });
  s.chunk('bot', 0, Buffer.from('hello'));
  s.chunk('remote-1', 0, Buffer.from('worldworld'));
  const m = s.stop();

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(m, onDisk); // stop() returns exactly what it wrote
  assert.equal(m.room, 'r');
  assert.equal(m.botName, 'Jimmy');
  assert.equal(m.tracks.length, 2);
  const bot = m.tracks.find((t) => t.track === 'bot');
  assert.equal(bot.file, 'bot.webm');
  assert.equal(bot.bytes, 5);
  assert.equal(bot.chunks, 1);
  assert.ok(Number.isInteger(bot.startOffsetMs) && bot.startOffsetMs >= 0);
});

test('a gap in sequence numbers is COUNTED, not silently dropped', () => {
  const dir = path.join(tmpDir(), 'call');
  const s = new CallRecordingSession(dir, {});
  s.chunk('remote-1', 0, Buffer.from('a'));
  s.chunk('remote-1', 1, Buffer.from('b'));
  s.chunk('remote-1', 3, Buffer.from('d')); // seq 2 dropped
  const m = s.stop();
  const t = m.tracks.find((x) => x.track === 'remote-1');
  assert.equal(t.seqGaps, 1);
  assert.equal(t.bytes, 3); // still wrote what it got — never corrupts
});

test('track names are sanitized so they cannot escape the directory', () => {
  const dir = path.join(tmpDir(), 'call');
  const s = new CallRecordingSession(dir, {});
  s.chunk('../evil', 0, Buffer.from('x'));
  s.stop();
  // Nothing written outside dir; the sanitized file lives inside it.
  assert.ok(!fs.existsSync(path.join(dir, '..', 'evil')));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.webm'));
  assert.equal(files.length, 1);
});

test('chunks after stop() are ignored (teardown race), and stop() is idempotent', () => {
  const dir = path.join(tmpDir(), 'call');
  const s = new CallRecordingSession(dir, {});
  s.chunk('bot', 0, Buffer.from('a'));
  const first = s.stop();
  s.chunk('bot', 1, Buffer.from('LATE')); // arrives after finalize — must be dropped
  const second = s.stop();
  assert.equal(fs.readFileSync(path.join(dir, 'bot.webm'), 'utf8'), 'a');
  assert.equal(first.tracks[0].bytes, 1);
  assert.deepEqual(first.tracks, second.tracks);
});

test('startWallClock (the track t=0) is recorded from the first chunk for alignment', () => {
  const dir = path.join(tmpDir(), 'call');
  const s = new CallRecordingSession(dir, { startedAt: 1000 });
  s.chunk('bot', 0, Buffer.from('a'), 'audio/webm', 1785000000000);
  s.chunk('bot', 1, Buffer.from('b'), 'audio/webm', 1785000009999); // later chunks don't move the anchor
  const m = s.stop();
  const bot = m.tracks.find((t) => t.track === 'bot');
  assert.equal(bot.startWallClock, 1785000000000);
});

test('startWallClock is null when the renderer did not send one (graceful)', () => {
  const dir = path.join(tmpDir(), 'call');
  const s = new CallRecordingSession(dir, {});
  s.chunk('bot', 0, Buffer.from('a')); // 4-arg call, no clock
  const m = s.stop();
  assert.equal(m.tracks[0].startWallClock, null);
});

test('an attributed participant name lands in the manifest for its track', () => {
  const dir = path.join(tmpDir(), 'call');
  const s = new CallRecordingSession(dir, {});
  s.chunk('remote-participant-1', 0, Buffer.from('a'));
  s.chunk('remote-participant-2', 0, Buffer.from('b'));
  s.setName('remote-participant-1', 'Cosmo'); // later vote overrides
  s.setName('remote-participant-1', 'Alice');
  const m = s.stop();
  const p1 = m.tracks.find((t) => t.track === 'remote-participant-1');
  const p2 = m.tracks.find((t) => t.track === 'remote-participant-2');
  assert.equal(p1.name, 'Alice'); // last vote wins
  assert.equal(p2.name, null);    // never attributed → explicit null
});

test('setName after stop() is ignored (no late mutation of a written manifest)', () => {
  const dir = path.join(tmpDir(), 'call');
  const s = new CallRecordingSession(dir, {});
  s.chunk('remote-participant-1', 0, Buffer.from('a'));
  s.stop();
  s.setName('remote-participant-1', 'Alice');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(onDisk.tracks[0].name, null);
});

test('empty or missing buffers never open a file', () => {
  const dir = path.join(tmpDir(), 'call');
  const s = new CallRecordingSession(dir, {});
  s.chunk('bot', 0, Buffer.alloc(0));
  s.chunk('bot', 1, null);
  const m = s.stop();
  assert.equal(m.tracks.length, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'bot.webm')));
});

// --- Per-track byte caps (regression: a single shared cap let video, at a
// far higher bitrate than audio, silently stop recording after under nine
// minutes on any real call — see MAX_TRACK_BYTES_BY_KIND in call-recorder.js) ---

test('video and audio tracks get different real-world caps', () => {
  const dir = path.join(tmpDir(), 'call');
  const s = new CallRecordingSession(dir, {});
  s.chunk('bot', 0, Buffer.from('a'), 'audio/webm');
  s.chunk('video', 0, Buffer.from('b'), 'video/webm', null, 'video');
  const m = s.stop();
  const audio = m.tracks.find((t) => t.track === 'bot');
  const video = m.tracks.find((t) => t.track === 'video');
  assert.equal(audio.maxBytes, MAX_TRACK_BYTES_BY_KIND.audio);
  assert.equal(video.maxBytes, MAX_TRACK_BYTES_BY_KIND.video);
  assert.ok(video.maxBytes > audio.maxBytes, 'video must get a materially higher ceiling than audio');
});

test('a track that exceeds its cap stops accepting chunks, but other tracks are unaffected', () => {
  const dir = path.join(tmpDir(), 'call');
  // A tiny override so the test doesn't need to write real gigabytes — see
  // the constructor's maxBytesByKind param.
  const s = new CallRecordingSession(dir, { maxBytesByKind: { audio: 5, video: 5 } });
  s.chunk('bot', 0, Buffer.from('abc'));  // 3 bytes, under the 5-byte cap
  s.chunk('bot', 1, Buffer.from('defg')); // would bring it to 7 — over cap, dropped
  s.chunk('remote-1', 0, Buffer.from('x')); // untouched track keeps recording fine
  const m = s.stop();
  const bot = m.tracks.find((t) => t.track === 'bot');
  const remote = m.tracks.find((t) => t.track === 'remote-1');
  assert.equal(bot.capped, true);
  assert.equal(bot.bytes, 3); // only the chunk that fit was written
  assert.equal(fs.readFileSync(path.join(dir, 'bot.webm'), 'utf8'), 'abc');
  assert.equal(remote.capped, false);
});

test('chunks after a track is capped are silently ignored, not retried', () => {
  const dir = path.join(tmpDir(), 'call');
  const s = new CallRecordingSession(dir, { maxBytesByKind: { audio: 2, video: 2 } });
  s.chunk('bot', 0, Buffer.from('ab'));  // exactly at the cap — fits
  s.chunk('bot', 1, Buffer.from('c'));   // over cap — capped, dropped
  s.chunk('bot', 2, Buffer.from('d'));   // already capped — dropped, no re-evaluation
  const m = s.stop();
  const bot = m.tracks.find((t) => t.track === 'bot');
  assert.equal(bot.bytes, 2);
  assert.equal(fs.readFileSync(path.join(dir, 'bot.webm'), 'utf8'), 'ab');
});

test('a near-cap warning fires exactly once, before the track actually caps', () => {
  const dir = path.join(tmpDir(), 'call');
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    // capWarnRatio 0.5 over a 10-byte cap: the 90%-equivalent warning line
    // should fire once bytes reach 5, well before the 10-byte cap bites.
    const s = new CallRecordingSession(dir, { maxBytesByKind: { audio: 10, video: 10 }, capWarnRatio: 0.5 });
    s.chunk('bot', 0, Buffer.from('abc'));  // 3 bytes — under 5, no warning yet
    s.chunk('bot', 1, Buffer.from('de'));   // 5 bytes — crosses the 50% warn threshold
    s.chunk('bot', 2, Buffer.from('fg'));   // 7 bytes — still under cap, must NOT warn again
    s.chunk('bot', 3, Buffer.from('hijkl')); // would bring it to 12 — over cap, capped
    const m = s.stop();
    const bot = m.tracks.find((t) => t.track === 'bot');
    assert.equal(bot.capped, true);
    const nearCapWarnings = warnings.filter((w) => w.includes('is at') && w.includes('% of its'));
    const cappedWarnings = warnings.filter((w) => w.includes('hit its'));
    assert.equal(nearCapWarnings.length, 1, `expected exactly one near-cap warning, got: ${JSON.stringify(warnings)}`);
    assert.equal(cappedWarnings.length, 1, `expected exactly one cap-hit warning, got: ${JSON.stringify(warnings)}`);
  } finally {
    console.warn = originalWarn;
  }
});
