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

// Where the real ffmpeg binary comes from — in priority order:
//   1. The bundled `ffmpeg-static` binary. This is what a distributed build
//      (dmg/nsis/AppImage) actually ships and runs — it must NOT depend on the
//      end user having ffmpeg installed or on PATH.
//   2. `command -v ffmpeg` on PATH — a dev-mode convenience only (e.g. running
//      from source before `pnpm install` has pulled ffmpeg-static in, or on a
//      platform ffmpeg-static doesn't publish a binary for). Never the primary
//      mechanism for a packaged build.
// mergeCallMedia goes through this one resolver so there is exactly one place
// that knows how to find ffmpeg.
function resolveFfmpegPath({ execSyncFn = execSync, requireFn = require } = {}) {
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
      if (fs.existsSync(bundled)) {
        _ffmpegPath = bundled;
        return _ffmpegPath;
      }
    }
  } catch { /* ffmpeg-static not installed (e.g. running tests without a full install) — fall through */ }

  try {
    execSyncFn('command -v ffmpeg', { stdio: ['ignore', 'pipe', 'ignore'] });
    _ffmpegPath = 'ffmpeg'; // let the shell/PATH resolve it at spawn time
  } catch {
    _ffmpegPath = null;
  }
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
async function mergeCallMedia(callDir, {
  tracksDir = path.join(callDir, 'call-recording-tracks'),
  tracks = [],
  execSyncFn = execSync,
  videoTrackName = null,
  outputName = 'call-recording.mp4',
  padStartMs = 0,
  signal = null,
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
  const args = ['-y', '-i', videoTrack.absPath];
  for (const t of audioTracks) args.push('-i', t.absPath);

  const padSec = padStartMs > 0 ? (padStartMs / 1000).toFixed(3) : null;

  if (padSec) {
    // Padding needs the video stream FILTERED (tpad reads its own frame
    // size/rate from the input, so no ffprobe step is needed) — that rules
    // out '-c:v copy' for this branch, unlike the unpadded cases below.
    const videoFilter = `[0:v]tpad=start_duration=${padSec}:color=black[vout]`;
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
    proc.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      resolve({ ok: false, reason: 'ffmpeg merge timed out' });
    }, 60000);
    proc.on('error', (err) => {
      clearTimeout(timer);
      // AbortError is spawn's own signal-triggered kill, not a real failure.
      const cancelled = (signal && signal.aborted) || err.name === 'AbortError';
      resolve(cancelled ? { ok: false, reason: 'cancelled' } : { ok: false, reason: `ffmpeg failed to start: ${err.message}` });
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (signal && signal.aborted) {
        // A killed ffmpeg can still have written a partial/corrupt outPath —
        // don't leave that behind looking like a real, finished recording.
        try { fs.unlinkSync(outPath); } catch { /* never started writing, or already gone */ }
        resolve({ ok: false, reason: 'cancelled' });
      } else if (code === 0 && fs.existsSync(outPath)) {
        resolve({ ok: true, file: outPath });
      } else {
        resolve({ ok: false, reason: `ffmpeg exited ${code}: ${stderr.slice(-500)}` });
      }
    });
  });
}

module.exports = {
  mergeCallMedia,
  ffmpegAvailable,
  resolveFfmpegPath,
  _resetFfmpegAvailabilityCache,
};
