// call-media-merge.js — once a call recording stops, mux the video track with
// the N per-participant audio tracks (call-recorder.js's CallRecordingSession
// output) into one playable call-recording.mp4.
//
// WHY: call-recorder.js already writes bot.webm / remote-*.webm (audio) and,
// now, video.webm (the bot's own Meet view, captured by
// call-recording-window.js via getDisplayMedia — see that file for how the
// video track is produced). Neither alone is much use for "what actually
// happened" evidence — video is silent, and audio has no picture — so once
// recording stops this runs one ffmpeg pass that mixes the audio tracks with
// `amix` and muxes the result onto the video.
//
// This is a pure mux/mix step over files already on disk — it does not touch
// capture at all, so it has no Electron dependency and is fully unit-testable
// with plain Node (see tests/call-media-merge.test.mjs).
//
// Best-effort throughout: a failed or skipped merge never deletes or touches
// the raw per-track files it would have combined — those remain the ground
// truth on disk either way.

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

let _ffmpegPath = undefined; // memoized (undefined = not yet resolved, null = none found)

// Common locations for a manually-installed ffmpeg that a GUI-launched app's
// PATH won't see (below) — see the big comment on step 3.
const KNOWN_FFMPEG_PATHS = [
  '/opt/homebrew/bin/ffmpeg', // Homebrew, Apple Silicon
  '/usr/local/bin/ffmpeg', // Homebrew, Intel — also the common Linux manual-install spot
];

// The frame rate `tpad` padding is generated at, in the padStartMs branch
// below. `tpad` doesn't hold one still frame for the pad duration — it
// generates and encodes one frame per timestamp at whatever rate the input
// stream *declares*, and that declared rate cannot be trusted: MediaRecorder
// webm timestamps are irregular (same root cause as the raw-copy note in
// mergeCallMedia's own doc comment, "ffprobe reporting r_frame_rate=16000/1")
// and container muxers pick a nominal tbr/tbn from them that can land
// anywhere — observed in the wild: share.webm (the whiteboard capture,
// page-inject.js's `captureStream(5)` — genuinely 5fps content) reporting
// "1k tbr". Padding a real ~56-minute gap at a naively-trusted 1000fps meant
// generating and x264-encoding ~3.4 MILLION black frames — 40 minutes of
// wall-clock time for what should be instant, since every one of those
// frames is identical. An explicit `fps=` filter ahead of `tpad` forces a
// real, fixed rate regardless of what the input's metadata claims, so the
// frame count actually matches the padded duration. 5 matches the real
// whiteboard capture rate above, so it costs nothing in quality for the one
// thing padStartMs is used for today (call-recording-share.mp4) while
// keeping tpad's frame count sane no matter what a future input declares.
const PAD_NORMALIZE_FPS = 5;

// How long ffmpeg may go WITHOUT producing any output before we give up on it.
//
// This deliberately measures a stall, not total wall-clock time. The original
// guard here was a flat 60s cap on the whole merge, which is a cap on how long
// the *encode* is allowed to take — and the encode's cost scales with the
// call. A 36-minute call (issue #327) meant re-encoding a 1.06 GB VP9
// video.webm with a 4-way amix; it got SIGKILLed at exactly 60s, mid-write,
// leaving a headerless 14.9 MB mp4. Every recording long enough to be worth
// keeping was guaranteed to hit it.
//
// A merge that's simply big is not a merge that's broken, so there is no
// honest wall-clock number to pick. What we actually want to catch is a
// *wedged* ffmpeg, and that's directly observable: ffmpeg writes progress
// stats to stderr continuously while it works (hence the explicit `-stats`
// below, so this doesn't depend on the default staying on or on being
// attached to a tty). As long as those keep arriving, the merge is making
// progress and is allowed to run as long as it needs. Silence for this long
// means it's stuck. The user-facing merge window's Cancel button (main.js)
// remains the way to stop a merge that's merely slower than someone's
// patience.
const MERGE_STALL_TIMEOUT_MS = 120000;

// Keep only the tail of ffmpeg's stderr — with `-stats` on and no wall-clock
// cap, a long merge emits a progress line several times a second for the
// entire encode, and holding all of it would grow unboundedly for exactly the
// long calls this file now supports. Only the tail is ever reported (see the
// non-zero-exit path), so the rest is dead weight.
const STDERR_TAIL_BYTES = 8192;

// Where the real ffmpeg binary comes from — in priority order:
//   1. The bundled `ffmpeg-static` binary. This is what a distributed build
//      (dmg/nsis/AppImage) actually ships and runs — it must NOT depend on the
//      end user having ffmpeg installed or on PATH. Requires ffmpeg-static's
//      own postinstall script to have actually run at `pnpm install` time —
//      see `onlyBuiltDependencies` in package.json; pnpm blocks install
//      scripts for anything not listed there, which is exactly how this
//      silently regressed once (the package installed, but its script never
//      ran, so no binary was ever downloaded — this whole path resolved to
//      nothing and merges quietly fell through to steps 2/3 or failed).
//   2. `command -v ffmpeg` on PATH — a dev-mode convenience only (e.g. running
//      from source before `pnpm install` has pulled ffmpeg-static in, or on a
//      platform ffmpeg-static doesn't publish a binary for). Never the primary
//      mechanism for a packaged build.
//   3. Known install locations, checked directly rather than via PATH. A
//      macOS app launched from Finder/Dock (as opposed to a Terminal) does
//      NOT inherit the user's shell PATH — it gets Launch Services' minimal
//      default (`/usr/bin:/bin:/usr/sbin:/sbin`), so step 2 fails even when
//      `ffmpeg` is genuinely installed via Homebrew and works fine from a
//      terminal. This step exists specifically to survive step 1 failing
//      again in the future without silently losing the ability to merge.
// mergeCallMedia goes through this one resolver so there is exactly one place
// that knows how to find ffmpeg.
function resolveFfmpegPath({ execSyncFn = execSync, requireFn = require, existsSyncFn = fs.existsSync } = {}) {
  if (_ffmpegPath !== undefined) return _ffmpegPath;

  try {
    let bundled = requireFn('ffmpeg-static');
    if (bundled) {
      // Packaged builds asar-seal node_modules; the binary itself must be
      // asarUnpack'd (see electron-app/package.json build.asarUnpack) so it's a
      // real executable file on disk, not sealed bytes inside app.asar — an
      // asar path can't be spawned. Rewrite to the unpacked sibling directory.
      if (bundled.includes('app.asar') && !bundled.includes('app.asar.unpacked')) {
        bundled = bundled.replace('app.asar', 'app.asar.unpacked');
      }
      if (existsSyncFn(bundled)) {
        _ffmpegPath = bundled;
        return _ffmpegPath;
      }
    }
  } catch { /* ffmpeg-static not installed (e.g. running tests without a full install) — fall through */ }

  try {
    execSyncFn('command -v ffmpeg', { stdio: ['ignore', 'pipe', 'ignore'] });
    _ffmpegPath = 'ffmpeg'; // let the shell/PATH resolve it at spawn time
    return _ffmpegPath;
  } catch { /* not on this process's PATH — fall through to step 3 */ }

  const known = KNOWN_FFMPEG_PATHS.find((p) => existsSyncFn(p));
  _ffmpegPath = known || null;
  return _ffmpegPath;
}

function ffmpegAvailable(execSyncFn = execSync) {
  return resolveFfmpegPath({ execSyncFn }) !== null;
}

// Test-only hook: force the memoized resolution to re-run.
function _resetFfmpegAvailabilityCache() {
  _ffmpegPath = undefined;
}

// Mux a video track (if any) with N audio tracks (if any) into one playable
// file in `callDir`.
//
// tracks: the `tracks` array from CallRecordingSession.manifest() — each
// { track, file, kind, startWallClock, ... } where `file` is a basename
// relative to `tracksDir`. `kind` (added alongside video support) tells video
// and audio tracks apart directly; if it's missing (older manifest, or a
// caller that built the array by hand) a track named exactly 'video' is
// treated as video, and every OTHER track without a `kind` is treated as
// audio — same defaults call-recorder.js itself falls back to.
//
// videoTrackName: which track is "the video" for THIS merge — defaults to
// picking by kind==='video' (or the 'video' name fallback above), which is
// right for the main call.chunk() Meet-view track. Pass e.g. 'share' to mux
// onto the full-res whiteboard-share capture instead (see main.js's
// call-recording-share.mp4 extension) — the audio-track selection is unaffected
// either way (still every kind==='audio' track).
//
// outputName: output filename within callDir. Defaults to 'call-recording.mp4'; pass
// e.g. 'call-recording-share.mp4' for the share extension so it never collides with
// the main merge.
//
// padStartMs: prepend this many ms of black video before the real video
// content, via ffmpeg's `tpad` filter, BEFORE muxing. For the share
// extension: share.webm's own t=0 is when the share began (often minutes
// into the call), while the audio tracks' t=0 is call-recording start — pass
// the wall-clock delta between them here so call-recording-share.mp4's picture and
// its (borrowed) audio track actually line up in time. 0 (default) mux as-is
// — the main call-recording.mp4 merge never needs this, since video.webm and the
// audio tracks all start together at recording start.
//
// Handles every combination:
//   video + N audio  -> amix the audio, mux onto the video
//   video + 0 audio  -> re-encode the video alone (no mixing needed)
//   0 video + N audio -> no merge possible (nothing to attach audio to) — skip
//   0 video + 0 audio -> nothing to do
//
// Video is ALWAYS re-encoded to libx264 here, never '-c:v copy'd from the raw
// VP9 webm capture — two independent reasons, either one alone would be
// enough: (1) MediaRecorder's webm has irregular, live-streamed timestamps;
// copying them verbatim into an MP4 container produces bogus frame-rate
// metadata (observed: ffprobe reporting r_frame_rate=16000/1) that breaks
// several players' handling of the separately-encoded audio track sitting
// next to it, even though the audio itself decodes fine in more tolerant
// tools. (2) VP9-in-MP4 isn't supported by QuickTime/AVFoundation at all —
// the file simply won't open there regardless of the timestamp issue. Both
// are fixed by transcoding to a normalized, widely-supported h264 stream.
//
// Returns { ok, file, reason? }. Never throws — a failed merge just means the
// output file doesn't exist; the raw per-track files it would have combined
// are untouched.
// signal: an AbortSignal (optional). Lets a caller cancel an in-progress
// merge — e.g. the user dismissing the "Preparing recording…" window main.js
// shows during this step (it can take a while and pins a CPU core, worth a
// cancel option). Checked up front (skip starting ffmpeg at all if already
// aborted) and passed straight to spawn(), which kills the process on abort;
// resolves { ok: false, reason: 'cancelled' } rather than throwing, same as
// every other failure mode here.
// stallTimeoutMs: how long ffmpeg may produce NO output before it's treated
// as wedged and killed (default MERGE_STALL_TIMEOUT_MS — see there for why
// this is a stall watchdog and not a cap on total merge time). 0 disables it.
// On every failure — stall, cancel, or a non-zero exit — any partial output
// file is deleted rather than left behind masquerading as a finished
// recording.
async function mergeCallMedia(callDir, {
  tracksDir = path.join(callDir, 'call-recording-tracks'),
  tracks = [],
  execSyncFn = execSync,
  videoTrackName = null,
  outputName = 'call-recording.mp4',
  padStartMs = 0,
  signal = null,
  stallTimeoutMs = MERGE_STALL_TIMEOUT_MS,
} = {}) {
  if (signal && signal.aborted) return { ok: false, reason: 'cancelled' };
  const isVideo = (t) => videoTrackName
    ? t.track === videoTrackName
    : (t.kind ? t.kind === 'video' : t.track === 'video');
  const isAudio = (t) => (t.kind ? t.kind === 'audio' : t.track !== 'video');
  const resolved = (tracks || [])
    .filter((t) => t && t.file)
    .map((t) => ({ ...t, absPath: path.isAbsolute(t.file) ? t.file : path.join(tracksDir, t.file) }))
    .filter((t) => fs.existsSync(t.absPath));

  const videoTrack = resolved.find(isVideo);
  const audioTracks = resolved.filter((t) => t !== videoTrack && isAudio(t));

  if (!videoTrack && audioTracks.length === 0) {
    return { ok: false, reason: 'no video and no audio tracks to merge' };
  }
  if (!videoTrack) {
    return { ok: false, reason: 'no video captured — merge skipped, raw audio tracks remain on disk' };
  }
  const ffmpegPath = resolveFfmpegPath({ execSyncFn });
  if (!ffmpegPath) {
    return { ok: false, reason: 'no ffmpeg available (bundled binary missing and none on PATH)' };
  }

  fs.mkdirSync(callDir, { recursive: true });
  const outPath = path.join(callDir, outputName);
  // `-nostdin` so a spawned ffmpeg can never sit waiting on input it will
  // never get (which would read as a stall); `-stats` so the progress output
  // the stall watchdog below listens for is guaranteed, not incidental.
  const args = ['-y', '-nostdin', '-stats', '-i', videoTrack.absPath];
  for (const t of audioTracks) args.push('-i', t.absPath);

  const padSec = padStartMs > 0 ? (padStartMs / 1000).toFixed(3) : null;

  if (padSec) {
    // Padding needs the video stream FILTERED (tpad reads its own frame
    // size/rate from the input, so no ffprobe step is needed) — that rules
    // out '-c:v copy' for this branch, unlike the unpadded cases below.
    // `fps=` runs BEFORE `tpad` so the pad is generated at a real, fixed rate
    // rather than whatever (possibly bogus) rate the input declares — see
    // PAD_NORMALIZE_FPS above.
    const videoFilter = `[0:v]fps=${PAD_NORMALIZE_FPS},tpad=start_duration=${padSec}:color=black[vout]`;
    if (audioTracks.length === 0) {
      args.push('-filter_complex', videoFilter, '-map', '[vout]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outPath);
    } else if (audioTracks.length === 1) {
      args.push('-filter_complex', videoFilter, '-map', '[vout]', '-map', '1:a',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', outPath);
    } else {
      const inputs = audioTracks.map((_, i) => `[${i + 1}:a]`).join('');
      const filter = `${videoFilter};${inputs}amix=inputs=${audioTracks.length}:normalize=0[aout]`;
      args.push('-filter_complex', filter, '-map', '[vout]', '-map', '[aout]',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', outPath);
    }
  } else if (audioTracks.length === 0) {
    // Nothing to mix, but still re-encode the video (see note above) rather
    // than '-c:v copy' it as-is.
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', outPath);
  } else if (audioTracks.length === 1) {
    // No amix needed for a single track — map it straight through.
    args.push('-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', outPath);
  } else {
    // Build the filter_complex programmatically: [1:a][2:a]...[N:a]amix=inputs=N...
    const inputs = audioTracks.map((_, i) => `[${i + 1}:a]`).join('');
    const filter = `${inputs}amix=inputs=${audioTracks.length}:normalize=0[aout]`;
    args.push('-filter_complex', filter, '-map', '0:v', '-map', '[aout]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', outPath);
  }

  return new Promise((resolve) => {
    // `signal` here (Node's own spawn option, not our param name reused by
    // coincidence) auto-kills the process on abort — no manual proc.kill()
    // needed for the cancel path, only for the timeout below.
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], signal: signal || undefined });
    let stderr = '';
    let settled = false;
    let stallTimer = null;
    let exitBackstop = null;
    let timedOut = false;

    // ANY failure means whatever ffmpeg managed to write at outPath is a
    // partial mp4 — most visibly a killed encode, which leaves a file with no
    // moov atom that no player can open (issue #327). Every failure path goes
    // through here so none of them can leave that behind at the very filename
    // users are told to look for; the raw per-track files are untouched, and
    // are the ground truth a retry can be run against.
    const fail = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      clearTimeout(exitBackstop);
      try { fs.unlinkSync(outPath); } catch { /* never started writing, or already gone */ }
      resolve({ ok: false, reason });
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      clearTimeout(exitBackstop);
      resolve({ ok: true, file: outPath });
    };

    // Reset on every byte ffmpeg emits: this fires only when it has gone
    // completely quiet, not merely when it's taking a while. See
    // MERGE_STALL_TIMEOUT_MS.
    const armStallTimer = () => {
      clearTimeout(stallTimer);
      if (!(stallTimeoutMs > 0)) return;
      stallTimer = setTimeout(() => {
        timedOut = true;
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
        // Finish in the 'exit' handler so the unlink happens after the
        // process is actually gone; the backstop covers a kill that somehow
        // never produces one, so a wedged merge can't hang stopCallRecording.
        exitBackstop = setTimeout(() => fail('ffmpeg merge timed out'), 5000);
      }, stallTimeoutMs);
    };
    armStallTimer();

    proc.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-STDERR_TAIL_BYTES);
      if (!timedOut) armStallTimer();
    });
    proc.on('error', (err) => {
      // AbortError is spawn's own signal-triggered kill, not a real failure.
      const cancelled = (signal && signal.aborted) || err.name === 'AbortError';
      fail(cancelled ? 'cancelled' : `ffmpeg failed to start: ${err.message}`);
    });
    proc.on('exit', (code) => {
      if (signal && signal.aborted) fail('cancelled');
      else if (timedOut) fail('ffmpeg merge timed out');
      else if (code === 0 && fs.existsSync(outPath)) succeed();
      else fail(`ffmpeg exited ${code}: ${stderr.slice(-500)}`);
    });
  });
}

module.exports = {
  mergeCallMedia,
  ffmpegAvailable,
  resolveFfmpegPath,
  _resetFfmpegAvailabilityCache,
};
