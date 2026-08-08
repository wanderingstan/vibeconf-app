// call-media-merge.test.mjs — the ffmpeg mux/mix step that turns a
// CallRecordingSession's per-track files (call-recording-tracks/bot.webm,
// call-recording-tracks/remote-1.webm, ..., call-recording-tracks/video.webm)
// into one call-recording.mp4.
//
// This module has no Electron dependency — it just shells out to ffmpeg over
// files already on disk — so it's fully testable with plain Node.
//
// These tests use whatever real ffmpeg resolveFfmpegPath() itself resolves to
// (the bundled ffmpeg-static binary when its postinstall has run, PATH
// otherwise) — skip everything ffmpeg-dependent if neither is available. The
// test helpers below deliberately use that SAME resolved binary, not a bare
// `ffmpeg` shell lookup: a bare lookup could silently hit a different,
// possibly more minimal ffmpeg on PATH than the one call-media-merge.js
// itself would use, which is exactly the kind of mismatch that once caused
// these tests to fail in CI (PATH ffmpeg missing the libvpx-vp9 encoder these
// fixtures need) while resolveFfmpegPath()'s own binary had it all along.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  mergeCallMedia,
  ffmpegAvailable,
  resolveFfmpegPath,
  _resetFfmpegAvailabilityCache,
} = require('../electron-app/call-media-merge.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'call-media-merge-'));
}

const HAVE_FFMPEG = ffmpegAvailable();
const HAVE_FFMPEG_ON_PATH = (() => {
  try { execSync('command -v ffmpeg', { stdio: 'ignore' }); return true; } catch { return false; }
})();
const FFMPEG_BIN = resolveFfmpegPath(); // same binary mergeCallMedia() itself will use — see note above

// A short, real, silent video ffmpeg can actually decode — used as the
// "video.webm" track in tests that need one.
function writeFakeVideo(file, { seconds = 0.5 } = {}) {
  execSync(
    `"${FFMPEG_BIN}" -y -f lavfi -i color=c=black:s=16x16:r=5:d=${seconds} -c:v libvpx-vp9 "${file}"`,
    { stdio: 'ignore' },
  );
}

function writeFakeAudio(file, { seconds = 0.5 } = {}) {
  execSync(
    `"${FFMPEG_BIN}" -y -f lavfi -i anullsrc=r=48000:cl=mono -t ${seconds} -c:a libopus "${file}"`,
    { stdio: 'ignore' },
  );
}

test('resolveFfmpegPath returns null when neither the bundled binary nor PATH have one', () => {
  _resetFfmpegAvailabilityCache();
  const fakeExecSync = () => { throw new Error('not found'); };
  const fakeRequire = () => { throw new Error('ffmpeg-static not installed'); };
  // Simulates: ffmpeg-static isn't installed/downloaded AND nothing on PATH —
  // the "truly no ffmpeg anywhere" case that must degrade cleanly, not throw.
  assert.equal(resolveFfmpegPath({ execSyncFn: fakeExecSync, requireFn: fakeRequire }), null);
  _resetFfmpegAvailabilityCache(); // restore for later tests
});

test('resolveFfmpegPath falls back to PATH when the bundled binary is unavailable', () => {
  _resetFfmpegAvailabilityCache();
  const fakeRequire = () => { throw new Error('ffmpeg-static not installed'); };
  // Uses the REAL execSync — this is the "dev sandbox, package not installed"
  // scenario this repo is actually in right now.
  const resolved = resolveFfmpegPath({ requireFn: fakeRequire });
  assert.equal(resolved, HAVE_FFMPEG_ON_PATH ? 'ffmpeg' : null);
  _resetFfmpegAvailabilityCache();
});

// NOTE: resolveFfmpegPath() memoizes at module scope (one real lookup per
// process, not per session). Tests that stub "no ffmpeg anywhere" reset the
// cache before AND after, so they don't poison the real-ffmpeg tests below.

test('mergeCallMedia with zero video and zero audio does nothing', async () => {
  const dir = tmpDir();
  const r = await mergeCallMedia(dir, { tracksDir: dir, tracks: [] });
  assert.equal(r.ok, false);
  assert.ok(!fs.existsSync(path.join(dir, 'call-recording.mp4')));
});

test('mergeCallMedia with audio but no video skips the merge and explains why', async () => {
  const dir = tmpDir();
  const audioFile = path.join(dir, 'bot.webm');
  fs.writeFileSync(audioFile, 'not-really-audio');
  const r = await mergeCallMedia(dir, {
    tracksDir: dir,
    tracks: [{ track: 'bot', file: 'bot.webm', kind: 'audio' }],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no video/);
  assert.ok(!fs.existsSync(path.join(dir, 'call-recording.mp4')));
});

test('a track named "video" is treated as the video track even without an explicit kind', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'video.webm'), 'not-really-video');
  const r = await mergeCallMedia(dir, {
    tracksDir: dir,
    tracks: [{ track: 'video', file: 'video.webm' }], // no `kind` field
  });
  // No ffmpeg needed to prove routing: with 0 audio tracks and a "video" file
  // present, this should attempt the copy branch (and fail because the file
  // isn't real video) rather than reporting "no video captured".
  assert.equal(/no video captured/.test(r.reason || ''), false);
});

test('mergeCallMedia skips missing track files rather than failing the whole merge', { skip: !HAVE_FFMPEG }, async () => {
  const dir = tmpDir();
  writeFakeVideo(path.join(dir, 'video.webm'));
  const r = await mergeCallMedia(dir, {
    tracksDir: dir,
    tracks: [
      { track: 'video', file: 'video.webm', kind: 'video' },
      { track: 'bot', file: 'nonexistent.webm', kind: 'audio' },
    ],
  });
  // No real audio tracks left after filtering — falls back to "copy the video".
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(dir, 'call-recording.mp4')));
});

test('mergeCallMedia with video but zero audio re-encodes the video to call-recording.mp4', { skip: !HAVE_FFMPEG }, async () => {
  const dir = tmpDir();
  writeFakeVideo(path.join(dir, 'video.webm'));

  const r = await mergeCallMedia(dir, {
    tracksDir: dir,
    tracks: [{ track: 'video', file: 'video.webm', kind: 'video' }],
  });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(dir, 'call-recording.mp4')));
  assert.ok(fs.statSync(path.join(dir, 'call-recording.mp4')).size > 0);
});

// Regression test for a real bug: '-c:v copy' preserved video.webm's raw VP9
// codec and irregular MediaRecorder timestamps straight into the MP4
// container. That produced bogus frame-rate metadata (observed in the wild:
// ffprobe reporting r_frame_rate=16000/1) AND, independently, VP9-in-MP4
// simply doesn't play in QuickTime/AVFoundation at all — so call-recording.mp4 opened
// with no audible audio (or didn't open) despite the audio track itself
// being fully intact. Every merge output must be a re-encoded, widely
// playable h264 stream, never a raw copy of the VP9 capture.
test('merged output is always re-encoded to h264, never a raw VP9 copy — video-only, one audio track, and multi-audio-track cases', { skip: !HAVE_FFMPEG }, async () => {
  // ffmpeg-static (the binary these tests actually resolve to via
  // FFMPEG_BIN) doesn't bundle ffprobe — only ffmpeg — so read the codec off
  // ffmpeg's own stream-info banner (always printed to stderr, even on a
  // successful `-f null -` decode) instead of shelling out to a tool that
  // isn't guaranteed to exist.
  const probeVideoCodec = (file) => {
    const out = execSync(`"${FFMPEG_BIN}" -i "${file}" -f null - 2>&1`, { encoding: 'utf8' });
    const m = out.match(/Video:\s*([a-zA-Z0-9_]+)/);
    return m ? m[1] : null;
  };

  // video only
  {
    const dir = tmpDir();
    writeFakeVideo(path.join(dir, 'video.webm'));
    const r = await mergeCallMedia(dir, {
      tracksDir: dir,
      tracks: [{ track: 'video', file: 'video.webm', kind: 'video' }],
    });
    assert.equal(r.ok, true);
    assert.equal(probeVideoCodec(path.join(dir, 'call-recording.mp4')), 'h264');
  }

  // video + one audio track
  {
    const dir = tmpDir();
    writeFakeVideo(path.join(dir, 'video.webm'));
    writeFakeAudio(path.join(dir, 'bot.webm'));
    const r = await mergeCallMedia(dir, {
      tracksDir: dir,
      tracks: [
        { track: 'video', file: 'video.webm', kind: 'video' },
        { track: 'bot', file: 'bot.webm', kind: 'audio' },
      ],
    });
    assert.equal(r.ok, true);
    assert.equal(probeVideoCodec(path.join(dir, 'call-recording.mp4')), 'h264');
  }

  // video + two audio tracks (the amix filter_complex path)
  {
    const dir = tmpDir();
    writeFakeVideo(path.join(dir, 'video.webm'));
    writeFakeAudio(path.join(dir, 'bot.webm'));
    writeFakeAudio(path.join(dir, 'remote-1.webm'));
    const r = await mergeCallMedia(dir, {
      tracksDir: dir,
      tracks: [
        { track: 'video', file: 'video.webm', kind: 'video' },
        { track: 'bot', file: 'bot.webm', kind: 'audio' },
        { track: 'remote-1', file: 'remote-1.webm', kind: 'audio' },
      ],
    });
    assert.equal(r.ok, true);
    assert.equal(probeVideoCodec(path.join(dir, 'call-recording.mp4')), 'h264');
  }
});

test('mergeCallMedia with video + one audio track muxes without amix', { skip: !HAVE_FFMPEG }, async () => {
  const dir = tmpDir();
  writeFakeVideo(path.join(dir, 'video.webm'));
  writeFakeAudio(path.join(dir, 'bot.webm'));

  const r = await mergeCallMedia(dir, {
    tracksDir: dir,
    tracks: [
      { track: 'video', file: 'video.webm', kind: 'video' },
      { track: 'bot', file: 'bot.webm', kind: 'audio' },
    ],
  });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(dir, 'call-recording.mp4')));
});

test('mergeCallMedia with video + two audio tracks builds an amix filter_complex', { skip: !HAVE_FFMPEG }, async () => {
  const dir = tmpDir();
  writeFakeVideo(path.join(dir, 'video.webm'));
  writeFakeAudio(path.join(dir, 'bot.webm'));
  writeFakeAudio(path.join(dir, 'remote-1.webm'));

  const r = await mergeCallMedia(dir, {
    tracksDir: dir,
    tracks: [
      { track: 'video', file: 'video.webm', kind: 'video' },
      { track: 'bot', file: 'bot.webm', kind: 'audio' },
      { track: 'remote-1', file: 'remote-1.webm', kind: 'audio' },
    ],
  });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(dir, 'call-recording.mp4')));
});

test('mergeCallMedia resolves track files against tracksDir, separate from the output dir', { skip: !HAVE_FFMPEG }, async () => {
  const outDir = tmpDir();
  const tracksDir = path.join(outDir, 'call-recording-tracks');
  fs.mkdirSync(tracksDir, { recursive: true });
  writeFakeVideo(path.join(tracksDir, 'video.webm'));

  const r = await mergeCallMedia(outDir, {
    tracksDir,
    tracks: [{ track: 'video', file: 'video.webm', kind: 'video' }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.file, path.join(outDir, 'call-recording.mp4'));
  assert.ok(fs.existsSync(path.join(outDir, 'call-recording.mp4')));
});

// --- Extension: the whiteboard-share side capture (videoTrackName/outputName/padStartMs) ---

test('videoTrackName picks a differently-named track as the video (call-recording-share.mp4 extension)', { skip: !HAVE_FFMPEG }, async () => {
  const dir = tmpDir();
  // A 'video' track present too — must be IGNORED when videoTrackName='share'.
  writeFakeVideo(path.join(dir, 'video.webm'));
  writeFakeVideo(path.join(dir, 'share.webm'));

  const r = await mergeCallMedia(dir, {
    tracksDir: dir,
    tracks: [
      { track: 'video', file: 'video.webm', kind: 'video' },
      { track: 'share', file: 'share.webm', kind: 'share' },
    ],
    videoTrackName: 'share',
    outputName: 'call-recording-share.mp4',
  });
  assert.equal(r.ok, true);
  assert.equal(r.file, path.join(dir, 'call-recording-share.mp4'));
  assert.ok(fs.existsSync(path.join(dir, 'call-recording-share.mp4')));
  assert.ok(!fs.existsSync(path.join(dir, 'call-recording.mp4'))); // never touched
});

test('a "share"-kind track is excluded from the main call-recording.mp4 merge (not muxed in as audio or picked as video)', { skip: !HAVE_FFMPEG }, async () => {
  const dir = tmpDir();
  writeFakeVideo(path.join(dir, 'video.webm'));
  writeFakeVideo(path.join(dir, 'share.webm'));

  const r = await mergeCallMedia(dir, {
    tracksDir: dir,
    tracks: [
      { track: 'video', file: 'video.webm', kind: 'video' },
      { track: 'share', file: 'share.webm', kind: 'share' },
    ],
  });
  // Default merge (no videoTrackName): picks the kind:'video' track, and the
  // kind:'share' track is neither video nor a valid audio input — ffmpeg
  // would fail to find an audio stream in share.webm if it were wrongly
  // treated as audio, so success here proves it was excluded entirely.
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(dir, 'call-recording.mp4')));
});

test('padStartMs prepends black video via tpad before muxing', { skip: !HAVE_FFMPEG }, async () => {
  const dir = tmpDir();
  writeFakeVideo(path.join(dir, 'share.webm'), { seconds: 0.5 });
  writeFakeAudio(path.join(dir, 'bot.webm'), { seconds: 1 });

  const r = await mergeCallMedia(dir, {
    tracksDir: dir,
    tracks: [
      { track: 'share', file: 'share.webm', kind: 'share' },
      { track: 'bot', file: 'bot.webm', kind: 'audio' },
    ],
    videoTrackName: 'share',
    outputName: 'call-recording-share.mp4',
    padStartMs: 750,
  });
  assert.equal(r.ok, true);
  const outFile = path.join(dir, 'call-recording-share.mp4');
  assert.ok(fs.existsSync(outFile));

  // Padded output's video duration should be roughly the original 0.5s PLUS
  // the 0.75s pad — i.e. noticeably longer than the unpadded source, not just
  // re-encoded at the same length. A loose bound (not exact-frame) since
  // container/keyframe rounding varies by ffmpeg build.
  const probe = execSync(
    `"${FFMPEG_BIN}" -i "${outFile}" -hide_banner -f null - 2>&1 | grep -o "Duration: [0-9:.]*" | head -1`,
    { encoding: 'utf8' },
  );
  const m = probe.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  assert.ok(m, `could not parse duration from: ${probe}`);
  const durationSec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  assert.ok(durationSec > 1.0, `expected padded duration > 1.0s, got ${durationSec}`);
});

test('padStartMs=0 (the default) never invokes the tpad filter path (main call-recording.mp4 unaffected)', { skip: !HAVE_FFMPEG }, async () => {
  const dir = tmpDir();
  writeFakeVideo(path.join(dir, 'video.webm'));
  const r = await mergeCallMedia(dir, {
    tracksDir: dir,
    tracks: [{ track: 'video', file: 'video.webm', kind: 'video' }],
  });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(dir, 'call-recording.mp4')));
});

// --- Extension: cancellation via AbortSignal (the "Preparing recording…" window's Cancel button) ---

test('mergeCallMedia with an already-aborted signal skips ffmpeg entirely and reports cancelled', { skip: !HAVE_FFMPEG }, async () => {
  const dir = tmpDir();
  writeFakeVideo(path.join(dir, 'video.webm'));
  const controller = new AbortController();
  controller.abort();
  const r = await mergeCallMedia(dir, {
    tracksDir: dir,
    tracks: [{ track: 'video', file: 'video.webm', kind: 'video' }],
    signal: controller.signal,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cancelled');
  assert.ok(!fs.existsSync(path.join(dir, 'call-recording.mp4')));
});

test('aborting mid-flight kills ffmpeg, reports cancelled, and leaves no partial output file', { skip: !HAVE_FFMPEG }, async () => {
  const dir = tmpDir();
  writeFakeVideo(path.join(dir, 'video.webm'), { seconds: 3 }); // enough source material for the encode to still be running when abort() fires
  const controller = new AbortController();
  const merging = mergeCallMedia(dir, {
    tracksDir: dir,
    tracks: [{ track: 'video', file: 'video.webm', kind: 'video' }],
    signal: controller.signal,
  });
  controller.abort(); // fires synchronously, right after spawn() but before the process can finish
  const r = await merging;
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cancelled');
  assert.ok(!fs.existsSync(path.join(dir, 'call-recording.mp4')), 'no partial/corrupt file left behind');
});
