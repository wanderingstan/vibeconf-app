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

// Real, on-disk locations resolveFfmpegPath()'s step 3 checks directly — see
// KNOWN_FFMPEG_PATHS in call-media-merge.js. Computed here (not imported,
// call-media-merge.js doesn't export the list) so these tests can tell
// whether step 3 is even reachable in THIS environment before asserting on it.
const HAVE_KNOWN_PATH_FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']
  .some((p) => fs.existsSync(p));

test('resolveFfmpegPath returns null when nothing is found anywhere (bundled, PATH, or known install paths)', () => {
  _resetFfmpegAvailabilityCache();
  const fakeExecSync = () => { throw new Error('not found'); };
  const fakeRequire = () => { throw new Error('ffmpeg-static not installed'); };
  const fakeExistsSync = () => false; // also blocks step 3's direct file checks
  // Simulates: ffmpeg-static isn't installed/downloaded, nothing on PATH, and
  // no known install location has it either — the "truly no ffmpeg anywhere"
  // case that must degrade cleanly, not throw.
  assert.equal(
    resolveFfmpegPath({ execSyncFn: fakeExecSync, requireFn: fakeRequire, existsSyncFn: fakeExistsSync }),
    null,
  );
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

// Regression test: a GUI app launched from Finder/Dock (rather than a
// terminal) does NOT inherit the user's shell PATH — it gets macOS Launch
// Services' minimal default, which excludes Homebrew's /opt/homebrew/bin and
// /usr/local/bin. `command -v ffmpeg` genuinely fails in that process even
// though ffmpeg is installed and working. Step 3 exists to survive exactly
// that case by checking well-known install locations directly rather than via
// PATH — this is what actually broke a real recording once: the bundled
// binary's postinstall hadn't run (see the package.json onlyBuiltDependencies
// note in call-media-merge.js) and this fallback didn't exist yet, so the
// merge silently had nowhere left to turn.
test('resolveFfmpegPath falls back to a known install path when the bundled binary is unavailable AND PATH lookup fails', { skip: !HAVE_KNOWN_PATH_FFMPEG }, () => {
  _resetFfmpegAvailabilityCache();
  const fakeRequire = () => { throw new Error('ffmpeg-static not installed'); };
  const fakeExecSync = () => { throw new Error('not found on PATH'); }; // simulates the Finder-launch PATH problem
  const resolved = resolveFfmpegPath({ execSyncFn: fakeExecSync, requireFn: fakeRequire });
  assert.ok(resolved && resolved !== 'ffmpeg', `expected a known-path binary, got ${resolved}`);
  assert.ok(fs.existsSync(resolved));
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

// Regression test for the 34x frame-duplication bug.
//
// MediaRecorder webm declares no honest frame rate — the 1ms container
// timebase makes ffprobe report r_frame_rate=1000/1 on every recording the app
// produces, with avg_frame_rate=0/0 ("unknown"). ffmpeg 6.0 (the BUNDLED
// binary, and so the one users actually run) defaults fps_mode to `cfr` and
// duplicates frames up to that declared rate.
//
// Real damage, call ded-iika-yrs-20260815T133138Z: a 21.6-minute 900x592
// recording merged to an mp4 with 1,296,862 frames where ~38,000 exist. Twenty
// minutes of wall clock, 105 CPU-minutes, 402 MB.
//
// The guard is `-fps_mode passthrough`. Note ffmpeg 7+ changed this default, so
// a modern Homebrew ffmpeg will NOT reproduce it — hence asserting on the
// output's frame count rather than trusting the local binary to misbehave.
// Asserted against the SOURCE, not against a merge run, and deliberately so: a
// fixture that reproduces this needs webm written by a live MediaRecorder, and
// nothing ffmpeg can synthesize on the command line carries the same
// "r_frame_rate=1000/1 with avg_frame_rate=0/0" shape — every generated clip
// has an honest declared rate, so the merge behaves correctly on it whether or
// not the flag is present. A runtime test here passes for the wrong reason,
// which is worse than no test. (Checked: it passes with the flag removed.)
test('the video encode passes through real timestamps rather than materialising a declared frame rate', () => {
  const src = fs.readFileSync(new URL('../electron-app/call-media-merge.js', import.meta.url), 'utf8');
  const m = src.match(/const VIDEO_ENCODE_ARGS = \[([\s\S]*?)\];/);
  assert.ok(m, 'expected a VIDEO_ENCODE_ARGS array');
  assert.match(m[1], /'-fps_mode',\s*'passthrough'/);
});

// Regression test for an INVISIBLE default. The encode args carried no
// '-preset', which is not the same as neutral — libx264 silently falls back to
// 'medium', tuned for encode-once-distribute-widely, which this is the exact
// opposite of. Measured on 30s of a real 3024x1700 recording, medium took
// 13.1s against veryfast's 5.8s, and produced a LARGER file (11 MB vs 9 MB).
// A 40-minute call meant ~17 minutes of merge pinning a core behind a
// "Preparing recording…" window.
//
// Asserted via x264's own settings string, which it embeds in the output, so
// this checks what ffmpeg actually did rather than what args we think we
// built: 'rc=crf ... crf=23.0' only appears if -crf was passed at all, and
// subme/ref are the parameters the preset actually moves (veryfast: subme=2
// ref=1; medium would be subme=7 ref=3). A future preset change should update
// these numbers deliberately, not discover them.
test('the video encode sets an explicit fast preset — no silent libx264 "medium" default', { skip: !HAVE_FFMPEG }, async () => {
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

  const bytes = fs.readFileSync(path.join(dir, 'call-recording.mp4')).toString('latin1');
  const opts = bytes.match(/x264 - core[^\n\0]*options: ([^\n\0]*)/);
  assert.ok(opts, 'expected x264 to embed its settings string in the output');
  const settings = opts[1];

  assert.match(settings, /\brc=crf\b/, 'expected CRF rate control, i.e. an explicit -crf');
  assert.match(settings, /\bcrf=23\.0\b/, 'expected -crf 23');
  assert.match(settings, /\bsubme=2\b/, 'expected the veryfast preset (subme=2; medium is 7)');
  assert.match(settings, /\bref=1\b/, 'expected the veryfast preset (ref=1; medium is 3)');
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

// Regression test for a real incident: a real call's share.webm (the
// whiteboard capture — genuinely 5fps content, page-inject.js's
// `captureStream(5)`) had MediaRecorder's usual irregular timestamps mux down
// to a container-reported "1k tbr" — not real, just what ffmpeg inferred from
// the irregular timestamps. `tpad` trusted that declared rate to pad a real
// ~56-minute gap, so it generated and x264-encoded ~3.4 million black frames
// for something that should've been instant: ~40 minutes of wall-clock time.
// Reproduced here at test scale: a short fixture is deliberately muxed with
// an inflated declared rate (`-r 1000` on a sub-second source), then padded —
// PAD_NORMALIZE_FPS must keep the padding's frame count tied to a real fixed
// rate (5fps) rather than the input's bogus one, or this test's frame count
// assertion (not just a timing guess, which would be flaky) catches it.
test('padStartMs normalizes to a real frame rate before padding, even when the input declares a bogus one', { skip: !HAVE_FFMPEG }, async () => {
  const dir = tmpDir();
  // A short, real, decodable video whose CONTAINER declares 1000fps — same
  // shape as the real share.webm incident, at test scale.
  execSync(
    `"${FFMPEG_BIN}" -y -f lavfi -i color=c=black:s=16x16:r=1000:d=0.05 -c:v libvpx-vp9 "${path.join(dir, 'share.webm')}"`,
    { stdio: 'ignore' },
  );
  const declaredRate = execSync(
    `"${FFMPEG_BIN}" -i "${path.join(dir, 'share.webm')}" -hide_banner -f null - 2>&1 | grep -o "[0-9.]*k\\{0,1\\} fps" | head -1`,
    { encoding: 'utf8' },
  ).trim();
  // ffmpeg abbreviates round thousands ("1k fps" rather than "1000 fps") in
  // its stream-info banner — this just confirms the fixture actually
  // reproduces the bogus-declared-rate shape before relying on it below.
  assert.match(declaredRate, /^1k fps$/, `fixture setup didn't produce the expected bogus rate — got "${declaredRate}"`);

  const r = await mergeCallMedia(dir, {
    tracksDir: dir,
    tracks: [{ track: 'share', file: 'share.webm', kind: 'share' }],
    videoTrackName: 'share',
    outputName: 'call-recording-share.mp4',
    padStartMs: 3000, // at the (bogus) declared 1000fps this alone would be 3000 frames; at 5fps it's 15
  });
  assert.equal(r.ok, true);
  const outFile = path.join(dir, 'call-recording-share.mp4');
  assert.ok(fs.existsSync(outFile));

  const frameCountOut = execSync(
    `"${FFMPEG_BIN}" -i "${outFile}" -hide_banner -f null - 2>&1 | grep -o "frame=[ ]*[0-9]*" | tail -1`,
    { encoding: 'utf8' },
  );
  const frameCount = Number((frameCountOut.match(/frame=\s*(\d+)/) || [])[1]);
  assert.ok(Number.isFinite(frameCount) && frameCount > 0, `could not parse frame count from: ${frameCountOut}`);
  // At PAD_NORMALIZE_FPS=5, ~3.05s of total output should be roughly 15
  // frames — nowhere near the 3000+ a naive tpad-at-1000fps would produce.
  assert.ok(frameCount < 100, `expected frame count normalized to ~5fps (well under 100), got ${frameCount}`);
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

// Issue #327: the old fixed 60s cap SIGKILLed a perfectly healthy merge of a
// long call and then left the headerless partial mp4 on disk, which is worse
// than no file at all — it's unplayable but looks finished.
test('a stalled merge is killed and leaves no partial output file behind', { skip: !HAVE_FFMPEG }, async () => {
  const dir = tmpDir();
  writeFakeVideo(path.join(dir, 'video.webm'), { seconds: 3 });
  // 1ms of "silence" tolerated: the stall fires essentially immediately, so
  // this stands in for a wedged ffmpeg without having to wedge one.
  const r = await mergeCallMedia(dir, {
    tracksDir: dir,
    tracks: [{ track: 'video', file: 'video.webm', kind: 'video' }],
    stallTimeoutMs: 1,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ffmpeg merge timed out');
  assert.ok(!fs.existsSync(path.join(dir, 'call-recording.mp4')), 'no headerless partial mp4 left behind');
});

// The complement of the above, and the actual regression: as long as ffmpeg
// keeps reporting progress, a merge that takes longer than the stall window
// is NOT killed. Under the old wall-clock cap this case was a guaranteed
// failure for any call long enough to matter.
test('a merge that runs longer than the stall window still succeeds while ffmpeg reports progress', { skip: !HAVE_FFMPEG }, async () => {
  const dir = tmpDir();
  // Deliberately heavier than the other fixtures (720p/30fps/30s rather than
  // 16x16/5fps): the encode has to outlive the stall window below for this to
  // test anything, and ffmpeg has to emit its ~0.5s-interval progress stats
  // while it does. Takes a couple of seconds to build and merge.
  execSync(
    `"${FFMPEG_BIN}" -y -f lavfi -i color=c=black:s=1280x720:r=30:d=30 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 "${path.join(dir, 'video.webm')}"`,
    { stdio: 'ignore' },
  );
  const started = Date.now();
  const r = await mergeCallMedia(dir, {
    tracksDir: dir,
    tracks: [{ track: 'video', file: 'video.webm', kind: 'video' }],
    stallTimeoutMs: 1000, // shorter than the encode, longer than ffmpeg's stats interval
  });
  assert.equal(r.ok, true, `merge should not be killed while making progress (reason: ${r.reason})`);
  assert.ok(fs.existsSync(path.join(dir, 'call-recording.mp4')));
  // Not asserted (an unusually fast machine could beat it, which would make
  // this vacuous rather than wrong), but this is the case the fixture is sized
  // to produce — under the old fixed wall-clock cap it was an unavoidable kill.
  if (Date.now() - started <= 1000) console.log('note: encode finished inside the stall window — assertion above was vacuous');
});

test('a failed ffmpeg run deletes its partial output rather than leaving an unplayable file', { skip: !HAVE_FFMPEG }, async () => {
  const dir = tmpDir();
  // Truncated mid-stream: ffmpeg opens it, starts writing the mp4, then errors
  // out — exactly the shape that used to leave a moov-less file on disk.
  writeFakeVideo(path.join(dir, 'video.webm'), { seconds: 2 });
  const src = fs.readFileSync(path.join(dir, 'video.webm'));
  fs.writeFileSync(path.join(dir, 'truncated.webm'), src.subarray(0, Math.floor(src.length * 0.6)));
  const r = await mergeCallMedia(dir, {
    tracksDir: dir,
    tracks: [{ track: 'video', file: 'truncated.webm', kind: 'video' }],
  });
  if (r.ok) return; // tolerant ffmpeg build recovered the truncated input — nothing to assert
  assert.ok(!fs.existsSync(path.join(dir, 'call-recording.mp4')), 'no partial output left behind after a failed merge');
});
