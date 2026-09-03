// recording-size-indicator.test.mjs — #328: the recording indicator shows how
// much disk the capture is eating, not just how long it's been running.
//
// Motivating number: a 36-minute stand-up wrote a 1.06 GB video.webm. That is
// worth knowing while it's happening.
//
// totalBytes() is real logic and gets a real test. The IPC plumbing and the
// renderer formatting need an Electron window to exercise, so those are pinned
// by source assertions — the point being that the three ends (session → main
// push → renderer channel) agree on one channel name and one field name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CallRecordingSession } = require('../electron-app/call-recorder.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const rendererJs = fs.readFileSync(join(root, 'electron-app/renderer/call-recording-window.js'), 'utf8');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rec-size-'));
}

test('totalBytes sums every track, and is live before stop()', () => {
  const s = new CallRecordingSession(path.join(tmpDir(), 'call'), { room: 'r', startedAt: 1000 });
  assert.equal(s.totalBytes(), 0, 'no chunks yet');

  s.chunk('bot', 0, Buffer.alloc(100), 'audio/webm');
  s.chunk('remote-1', 0, Buffer.alloc(250), 'audio/webm');
  s.chunk('video', 0, Buffer.alloc(9000), 'video/webm', undefined, 'video');
  // The indicator polls DURING the recording — a total that only became correct
  // at stop() would be useless for the thing this exists to show.
  assert.equal(s.totalBytes(), 9350);

  s.chunk('bot', 1, Buffer.alloc(50), 'audio/webm');
  assert.equal(s.totalBytes(), 9400, 'keeps climbing as chunks arrive');

  s.stop();
  assert.equal(s.totalBytes(), 9400, 'still readable after finalize');
});

test('totalBytes matches what the manifest reports per track', () => {
  const s = new CallRecordingSession(path.join(tmpDir(), 'call'), { room: 'r', startedAt: 1000 });
  s.chunk('bot', 0, Buffer.alloc(11), 'audio/webm');
  s.chunk('video', 0, Buffer.alloc(22), 'video/webm', undefined, 'video');
  const m = s.stop();
  const summed = m.tracks.reduce((n, t) => n + t.bytes, 0);
  assert.equal(s.totalBytes(), summed);
});

test('main pushes size to the indicator window on a timer', () => {
  assert.match(main, /const RECORDING_STATS_MS = \d+/);
  assert.match(main, /function startRecordingStatsPush\(\)/);
  assert.match(main, /activeRecording\.totalBytes\(\)/);
  assert.match(main, /send\('recording-stats'/);
  // Started with the window it feeds, and stopped when the recording is
  // finalized — a surviving interval would keep poking a destroyed window.
  const start = main.slice(main.indexOf('function startCallRecording'));
  assert.match(start.slice(0, start.indexOf('\n}\n')), /startRecordingStatsPush\(\)/);
  const stop = main.slice(main.indexOf('async function stopCallRecording'));
  assert.match(stop.slice(0, stop.indexOf('\n}\n')), /stopRecordingStatsPush\(\)/);
});

test('the push is guarded against a torn-down window', () => {
  const fn = main.slice(main.indexOf('function startRecordingStatsPush'));
  const body = fn.slice(0, fn.indexOf('\n}\n\n'));
  assert.match(body, /activeRecordingWindow\.isDestroyed\(\)/,
    'the timer outlives the window in a teardown race');
});

test('free space is best-effort, never fatal', () => {
  // statfsSync is the nice-to-have; the size display is the point. A platform
  // without it must still show bytes.
  const fn = main.slice(main.indexOf('function volumeFreeBytes'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /try \{[\s\S]*catch \{ return null; \}/);
});

test('the renderer listens on the same channel main sends on', () => {
  assert.match(rendererJs, /on\('recording-stats'/);
  assert.match(rendererJs, /stats\.bytes/);
});

test('the renderer shows time alone until the first size arrives', () => {
  // A "0 MB" before the first push would read as "nothing is being written" —
  // the exact anxiety the size display is meant to settle.
  assert.match(rendererJs, /let sizeBytes = null;/);
  const fn = rendererJs.slice(rendererJs.indexOf('function renderElapsed'));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.match(body, /sizeBytes === null \? '' :/);
  assert.match(body, /size \? `\$\{time\} · \$\{size\} raw` : time/);
});

test('the number on screen is labelled raw, and paired with an estimate', () => {
  // On the VP9 fallback the raw capture is ~6x the file you keep, so "1.21 GB"
  // on its own reads as a disk emergency. Neither half works alone: "raw" without a scale is just
  // a word, and an estimate next to an unlabelled number is two figures with
  // no stated relationship.
  const fn = rendererJs.slice(rendererJs.indexOf('function renderElapsed'));
  assert.match(fn.slice(0, fn.indexOf('\n  }\n')), /\$\{size\} raw/);

  const i = rendererJs.indexOf("on('recording-stats'");
  const handler = rendererJs.slice(i, i + 1200);
  assert.match(handler, /mergedSizeRatio\(\)/);
  assert.match(handler, /~\$\{est\} final/);
});

test('the estimate is a tilde, never a promise', () => {
  // The ratio depends on the codec the capture landed on: H.264 is
  // stream-copied by the merge (the final file IS the raw bytes, ratio 1),
  // while the VP9 fallback is re-encoded — measured once (1.28 GB of tracks
  // -> a 193 MB mp4) on a mostly-static Meet view. A share full of motion
  // will compress worse, so either way the figure is a scale and the tilde is
  // load-bearing — if it ever renders bare, this fails.
  const m = rendererJs.match(/function mergedSizeRatio\(\) \{\n\s*return ([^;]+);/);
  assert.ok(m, 'the ratio is a named function, not an inline magic number');
  const ratioFor = (recordingMime) => new Function('recordingMime', `return ${m[1]}`)(recordingMime);
  assert.equal(ratioFor('video/webm;codecs=h264'), 1, 'H.264 is copied, not shrunk');
  const vp9 = ratioFor('video/webm;codecs=vp9');
  assert.ok(vp9 > 0 && vp9 < 1, 'the VP9 re-encode shrinks the recording');

  const i = rendererJs.indexOf("on('recording-stats'");
  const handler = rendererJs.slice(i, i + 1200);
  assert.doesNotMatch(handler, /[^~]\$\{est\}/, 'est never renders without its tilde');
});

test('the note degrades to whichever half it has', () => {
  // freeBytes is best-effort (statfsSync may not exist); sizeBytes is null
  // until the first push. Either missing must not leave a dangling separator.
  const i = rendererJs.indexOf("on('recording-stats'");
  const handler = rendererJs.slice(i, i + 1200);
  assert.match(handler, /\.filter\(Boolean\)\.join\(' · '\)/);
  assert.match(handler, /sizeBytes === null \? '' :/);
});

test('an error message is never overwritten by a size push', () => {
  // note is shared between setError() and the free-space line; the error is the
  // more important thing on screen and it must survive the next tick.
  const i = rendererJs.indexOf("on('recording-stats'");
  const handler = rendererJs.slice(i, i + 900);
  assert.match(handler, /dot\.classList\.contains\('error'\)/);
});

test('byte sizes read at about three significant figures', () => {
  // #416: the free-disk note read "130.92 GB free on disk". Two decimals on a
  // three-digit number is noise. Decimals now scale with magnitude, so the
  // growing-recording case that motivated this indicator (1.06 GB) keeps them
  // and the free-disk case loses them.
  const src = rendererJs.slice(rendererJs.indexOf('function fmtBytes'));
  const fmtBytes = new Function(`return ${src.slice(0, src.indexOf('\n  }\n') + 4)}`)();

  assert.equal(fmtBytes(130.92e9), '131 GB');   // the reported case
  assert.equal(fmtBytes(1.06e9), '1.06 GB');    // what you watch tick up
  assert.equal(fmtBytes(12.34e9), '12.3 GB');
  assert.equal(fmtBytes(4.2e6), '4 MB');
  assert.equal(fmtBytes(0), '0 KB');
  // Never render a unit for a value we don't have — the note hides instead.
  assert.equal(fmtBytes(NaN), '');
  assert.equal(fmtBytes(-1), '');
});
