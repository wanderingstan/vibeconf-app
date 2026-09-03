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
const { spawn, execSync, execFileSync } = require('child_process');

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

// The video encode args for the RE-ENCODE fallback (see "Video codec: copy
// when we can, transcode when we must" on mergeCallMedia). Since the capture
// side records H.264 (renderer/call-recording-window.js pickMime), the main
// call-recording.mp4 merge never runs this branch on a fresh recording; it
// still handles VP9 inputs (recordings made before the H.264 switch, or an
// engine whose MediaRecorder can't do H.264) and every padStartMs merge.
//
// In one place because six branches below build the same encode with
// different maps and filters.
//
// `-preset` used to be absent, which is not the same as neutral: libx264
// silently defaults to `medium`, and medium is tuned for a file you encode
// once and distribute widely. This is the opposite — a debug artifact,
// encoded on the user's own machine, watched by one or two people, while a
// "Preparing recording…" window sits in front of them.
//
// Measured on 30s of a real 3024x1700 recording:
//
//   default (medium)          13.1s   11 MB
//   -preset veryfast -crf 23   5.8s    9 MB   <- this
//   -preset ultrafast -crf 25  3.1s   27 MB
//   h264_videotoolbox -b:v 6M 10.8s   22 MB
//
// veryfast is the sweet spot: 2.3x faster AND a slightly smaller file than
// the medium default. ultrafast is faster again but the file nearly triples,
// which matters because these get uploaded to Drive. Hardware videotoolbox
// looks obvious on a Mac and isn't — at this resolution x264-veryfast beats
// it outright and at half the bitrate, and it wouldn't be portable anyway.
//
// (VP9 decode is only ~1.5s of that 13.1s, so this really is the encode.)
//
// `-fps_mode passthrough` is the big one, and it is a CORRECTNESS fix wearing
// a performance fix's clothes. MediaRecorder's webm carries no honest frame
// rate — the container's 1ms timebase makes ffprobe report
// `r_frame_rate=1000/1` on every recording we produce (`avg_frame_rate=0/0`,
// i.e. "unknown"). The real content is ~30fps.
//
// The bundled ffmpeg is 6.0, whose default fps_mode for a CFR-friendly muxer
// is `cfr`: it DUPLICATES frames to hit the declared rate. So it faithfully
// padded 30fps of content out to 1000fps. Measured on a real 21.6-minute
// call (ded-iika-yrs-20260815T133138Z): the finished mp4 had **1,296,862
// frames** where ~38,000 exist — 34x too many — took **20 minutes** to merge
// (105 CPU-minutes at 369%), and weighed 402 MB at 900x592.
//
// This is the same trap the file already documents at PAD_NORMALIZE_FPS
// ("padding a real ~56-minute gap at a naively-trusted 1000fps meant
// generating and x264-encoding ~3.4 MILLION black frames"). That fix only
// ever went into the tpad branch; the MAIN merge path — every ordinary
// call-recording.mp4 — never got it.
//
// `passthrough` rather than `-vf fps=30`: it keeps exactly the frames that
// exist with their real timestamps, so nothing is invented and nothing is
// dropped. A fixed `fps=30` would resample genuinely-variable screen capture.
//
// Worth knowing when testing this by hand: ffmpeg 7+ changed the default away
// from cfr, so a Homebrew ffmpeg 8 shows none of this. It reproduces only
// with the bundled binary — which is the one that actually runs for users.
const VIDEO_ENCODE_ARGS = [
  '-fps_mode', 'passthrough',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
];

// Default crop margins for the `crop` option below, as a fraction of the raw
// frame (not pixels) — this is what makes them hold regardless of which
// botViewState (hidden/thumbnail/popped) the recording was actually captured
// at, since main.js's bot-view-layout.js keeps Meet's CSS viewport pinned to
// a constant width and only ever changes the render scale (see its
// MEET_TARGET_CSS_WIDTH comment), so Meet's own chrome occupies a constant
// FRACTION of the frame no matter the physical capture resolution.
//
// Strips Google Meet's own UI chrome from the bot's Meet-view capture: the
// top header, the bottom strip (captions overlay + in-call toolbar), and a
// right-side margin sized for the people/chat panel. There is deliberately
// no left margin — Meet has no left-side chrome.
//
// TOP is derived, not estimated. The app's own status banner
// (google-meet-provider.js ensureStatusBar: "🤖 Bot's view — <status>") is
// `position: fixed; top: 0` at min-height 56 CSS px, overlaying Meet's own
// top strip (the clock and meeting code) — it doesn't push Meet's layout
// down (that stylesheet's `body { padding-top }` has no visible effect on
// Meet's fixed-position UI). With the CSS viewport pinned to 1173px
// wide, a 16:9 frame is 660 CSS px tall and the banner alone is 56/660 =
// 8.5% of it — which is why the previous 0.07 left a sliver of blue along the
// top of every recording. Measured on a real frame (rkv-pdma-pkv, 2026-09-03,
// 1920x1080): banner bottom at 8.3%, first video-tile edge at 9.8%. 0.10
// clears the banner with Meet's own gap above the grid as the slack, and
// takes nothing off the tiles.
//
// The right margin is safe to crop unconditionally (no need to track
// panel-open/closed state): this is the BOT's own Meet view, and the bot
// always has the people/chat panel open (see google-meet-provider.js), so
// that margin is never real meeting video. bottom/right are estimated from
// Meet's standard layout proportions, not measured pixel-for-pixel against
// live DOM geometry (this codebase has no selector for Meet's video-grid
// container to measure against) — nudge these if a real recording shows them
// cutting into real video or leaving chrome visible.
const DEFAULT_CROP_MARGINS = { top: 0.10, bottom: 0.14, left: 0, right: 0.27 };

// Build a ffmpeg crop filter expression from fractional margins. Uses `iw`/
// `ih` (ffmpeg's input-width/height variables) rather than baked-in pixel
// numbers so the same expression is correct at whatever resolution the input
// video actually is.
function cropExprFromMargins({ top, bottom, left, right }) {
  const w = 1 - left - right;
  const h = 1 - top - bottom;
  return `crop=iw*${w}:ih*${h}:iw*${left}:ih*${top}`;
}

// The same fractional margins as PIXEL offsets for the H.264 stream-copy
// path: an H.264 SPS carries frame-cropping offsets (it's how every 1080p
// stream signals 1080 rows inside 1088 coded rows, so every decoder honours
// them), and ffmpeg's `h264_metadata` bitstream filter rewrites those without
// decoding a single frame. The offsets are in pixels and, for 4:2:0 chroma,
// must be even — so each is rounded to the nearest even number. Only sides
// with a non-zero margin make it into the filter string.
function spsCropFromMargins({ top, bottom, left, right }, width, height) {
  const even = (v) => Math.round(v / 2) * 2;
  return {
    top: even(height * top),
    bottom: even(height * bottom),
    left: even(width * left),
    right: even(width * right),
  };
}

function h264CropBsf(px) {
  const parts = Object.entries(px)
    .filter(([, v]) => v > 0)
    .map(([side, v]) => `crop_${side}=${v}`);
  return parts.length ? `h264_metadata=${parts.join(':')}` : null;
}

// Read the codec and dimensions of a file's first video stream off ffmpeg's
// own stream-info banner. ffmpeg-static ships ffmpeg but not ffprobe, so
// `ffmpeg -i <file>` with no output is the probe: it exits non-zero ("At
// least one output file must be specified") after printing the banner to
// stderr, which is all that's needed. Returns { codec, width, height } or
// null if the file couldn't be read/parsed — a null just means the merge
// takes the always-works re-encode path.
function probeVideoStream(ffmpegPath, file, execFileSyncFn = execFileSync) {
  let banner = '';
  try {
    execFileSyncFn(ffmpegPath, ['-hide_banner', '-nostdin', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  } catch (err) {
    banner = String((err && err.stderr) || '');
  }
  const m = banner.match(/Stream #\d+:\d+.*?Video:\s*([a-zA-Z0-9_]+).*?\b(\d{2,5})x(\d{2,5})\b/);
  if (!m) return null;
  return { codec: m[1], width: Number(m[2]), height: Number(m[3]) };
}

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
// crop: crop Meet's own UI chrome out of the video before muxing — see
// DEFAULT_CROP_MARGINS above for what and why (including why the right-side
// margin is safe to crop unconditionally for this app's own bot-view
// capture). Pass `true` to use those defaults, an object with any of
// {top,bottom,left,right} to override individual margins (fractions of the
// frame, unset ones fall back to the default), or leave it false/omitted
// (default) for the raw, uncropped frame. Only makes sense for the main
// Meet-view video track — callers muxing a different track (e.g.
// videoTrackName: 'share') should leave this off, since there is no Meet
// chrome in that frame to crop.
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
// Video codec: copy when we can, transcode when we must.
//
// The capture side records H.264 (renderer/call-recording-window.js
// pickMime — Chromium's MediaRecorder encodes it in hardware where the
// platform has an encoder, which is also ~4x less CPU during the call than
// VP9 was). An H.264 input is STREAM-COPIED into the mp4: no decode, no
// encode, so the merge's cost stops scaling with the length of the call —
// measured on a real 14-minute recording, copy + a 4-way amix took 18s where
// the re-encode path is ~20x realtime at best (~45s) and was 20+ minutes
// before #398. See issue #362 for the full investigation.
//
// This file used to insist video was ALWAYS re-encoded, for two reasons that
// don't survive measurement: (1) "MediaRecorder's timestamps are irregular"
// — they are ordinary variable-frame-rate at 25–40ms spacing; the scary
// "1000 fps" is just webm's 1ms timebase, and the 34x frame duplication was
// ffmpeg 6.0's cfr default during a RE-ENCODE (see VIDEO_ENCODE_ARGS). A
// stream copy duplicates nothing. (2) "VP9-in-MP4 won't open in QuickTime"
// — true, but it's a codec problem, not a container one, and it's moot once
// the capture is H.264.
//
// The re-encode path (VIDEO_ENCODE_ARGS) remains for every input that ISN'T
// stream-copyable: a VP9 video.webm (recordings made before the H.264 switch,
// or a MediaRecorder with no H.264 support), and any padStartMs merge (tpad
// needs decoded frames to pad).
//
// Cropping on the copy path never touches pixels either: the crop margins are
// written into the H.264 stream's own SPS frame-cropping fields via the
// `h264_metadata` bitstream filter (see spsCropFromMargins), which every
// decoder honours. ffmpeg copies the container's track header BEFORE that
// filter runs, though, so the mp4 would still declare the uncropped size and
// AVFoundation would present it stretched — hence the crop is a separate
// first pass into a temp file, and the mux pass reads THAT (re-parsing the
// now-cropped SPS into a correct track header). Both passes are copies, so
// the pair still completes in well under a second per hour of video. A nice
// property: the raw pixels are all still in the file, so this crop is
// reversible metadata rather than a lossy choice.
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
  probeFn = probeVideoStream,
  videoTrackName = null,
  outputName = 'call-recording.mp4',
  crop = false,
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

  const padSec = padStartMs > 0 ? (padStartMs / 1000).toFixed(3) : null;
  const cropMargins = crop ? { ...DEFAULT_CROP_MARGINS, ...(typeof crop === 'object' ? crop : null) } : null;

  // Stream-copy is possible when the input is already H.264 and nothing
  // needs decoded frames (tpad does). The probe is skipped entirely when
  // padding is requested, and a probe that fails or reads anything but h264
  // simply means the re-encode path below — which handles every input.
  let probe = null;
  if (!padSec) {
    try { probe = probeFn(ffmpegPath, videoTrack.absPath); } catch { probe = null; }
  }
  const copyVideo = !!(probe && probe.codec === 'h264' && probe.width > 0 && probe.height > 0);

  const run = (args, target) => runFfmpeg(ffmpegPath, args, { outPath: target, signal, stallTimeoutMs });

  // `-nostdin` so a spawned ffmpeg can never sit waiting on input it will
  // never get (which would read as a stall); `-stats` so the progress output
  // the stall watchdog listens for is guaranteed, not incidental.
  const baseArgs = () => ['-y', '-nostdin', '-stats'];

  if (copyVideo) {
    // Pass 1 (only when cropping): rewrite the SPS crop into a temp file.
    // Video only — the audio is dealt with once, in the mux pass.
    let videoInput = videoTrack.absPath;
    let cropTmp = null;
    const bsf = cropMargins ? h264CropBsf(spsCropFromMargins(cropMargins, probe.width, probe.height)) : null;
    if (bsf) {
      cropTmp = path.join(callDir, `.${outputName}.crop-tmp.mp4`);
      const r = await run([...baseArgs(), '-i', videoTrack.absPath, '-map', '0:v', '-c:v', 'copy', '-bsf:v', bsf, cropTmp], cropTmp);
      if (!r.ok) return r;
      videoInput = cropTmp;
    }
    try {
      // Pass 2: mux the (possibly cropped) H.264 stream with the mixed audio.
      const args = [...baseArgs(), '-i', videoInput];
      for (const t of audioTracks) args.push('-i', t.absPath);
      if (audioTracks.length === 0) {
        args.push('-map', '0:v', '-c:v', 'copy', outPath);
      } else if (audioTracks.length === 1) {
        args.push('-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', outPath);
      } else {
        const inputs = audioTracks.map((_, i) => `[${i + 1}:a]`).join('');
        const filter = `${inputs}amix=inputs=${audioTracks.length}:normalize=0[aout]`;
        args.push('-filter_complex', filter, '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', outPath);
      }
      const r = await run(args, outPath);
      return r.ok ? { ok: true, file: outPath, videoCopied: true, cropped: !!bsf } : r;
    } finally {
      if (cropTmp) { try { fs.unlinkSync(cropTmp); } catch { /* never written, or already gone */ } }
    }
  }

  // Re-encode path.
  const args = [...baseArgs(), '-i', videoTrack.absPath];
  for (const t of audioTracks) args.push('-i', t.absPath);

  // Video-only filter chain (crop, then pad), built once and shared by every
  // audio-track-count branch below. `fps=` runs BEFORE `tpad` so the pad is
  // generated at a real, fixed rate rather than whatever (possibly bogus)
  // rate the input declares — see PAD_NORMALIZE_FPS above. crop runs first so
  // tpad's black frames are generated at the already-cropped size.
  const videoFilterParts = [];
  if (cropMargins) videoFilterParts.push(cropExprFromMargins(cropMargins));
  if (padSec) videoFilterParts.push(`fps=${PAD_NORMALIZE_FPS}`, `tpad=start_duration=${padSec}:color=black`);
  const videoFilter = videoFilterParts.length ? videoFilterParts.join(',') : null;

  if (videoFilter) {
    // Cropping or padding needs the video stream FILTERED — that rules out
    // '-c:v copy' for this branch, unlike the plain case below.
    const chain = `[0:v]${videoFilter}[vout]`;
    if (audioTracks.length === 0) {
      args.push('-filter_complex', chain, '-map', '[vout]', ...VIDEO_ENCODE_ARGS, outPath);
    } else if (audioTracks.length === 1) {
      args.push('-filter_complex', chain, '-map', '[vout]', '-map', '1:a',
        ...VIDEO_ENCODE_ARGS, '-c:a', 'aac', outPath);
    } else {
      const inputs = audioTracks.map((_, i) => `[${i + 1}:a]`).join('');
      const filter = `${chain};${inputs}amix=inputs=${audioTracks.length}:normalize=0[aout]`;
      args.push('-filter_complex', filter, '-map', '[vout]', '-map', '[aout]',
        ...VIDEO_ENCODE_ARGS, '-c:a', 'aac', outPath);
    }
  } else if (audioTracks.length === 0) {
    // Nothing to mix, but still re-encode the video (see note above) rather
    // than '-c:v copy' it as-is.
    args.push(...VIDEO_ENCODE_ARGS, outPath);
  } else if (audioTracks.length === 1) {
    // No amix needed for a single track — map it straight through.
    args.push('-map', '0:v', '-map', '1:a', ...VIDEO_ENCODE_ARGS, '-c:a', 'aac', outPath);
  } else {
    // Build the filter_complex programmatically: [1:a][2:a]...[N:a]amix=inputs=N...
    const inputs = audioTracks.map((_, i) => `[${i + 1}:a]`).join('');
    const filter = `${inputs}amix=inputs=${audioTracks.length}:normalize=0[aout]`;
    args.push('-filter_complex', filter, '-map', '0:v', '-map', '[aout]', ...VIDEO_ENCODE_ARGS, '-c:a', 'aac', outPath);
  }

  const r = await run(args, outPath);
  return r.ok ? { ok: true, file: outPath, videoCopied: false, cropped: !!cropMargins } : r;
}

// Run one ffmpeg invocation that writes `outPath`, with the cancel signal and
// the stall watchdog applied. Resolves { ok: true } or { ok: false, reason };
// never throws. On every failure — stall, cancel, or a non-zero exit — the
// partial output file is deleted rather than left behind masquerading as a
// finished file.
function runFfmpeg(ffmpegPath, args, { outPath, signal, stallTimeoutMs }) {
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
      resolve({ ok: true });
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
  probeVideoStream,
  _resetFfmpegAvailabilityCache,
  DEFAULT_CROP_MARGINS,
  cropExprFromMargins,
  spsCropFromMargins,
  h264CropBsf,
};
