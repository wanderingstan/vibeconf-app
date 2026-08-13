// finish-call-recording.mjs — do, by hand, the merge step the app normally runs
// when a call recording stops (#343).
//
// WHY THIS EXISTS: the merge is the one expensive part of finalizing a recording
// (ffmpeg, minutes, a pinned CPU core), so the app does NOT hold up a quit for
// it. Quitting mid-recording, or a crash, therefore leaves a
// call-recording-tracks/ folder with its manifest and raw webm files intact but
// no .mp4. This turns that folder into the same outputs the app would have
// produced. The RECOVERY.md the app leaves in such a folder points here.
//
//   node scripts/finish-call-recording.mjs <call-recording-tracks-dir>
//
// Produces, in the folder's PARENT (where the app puts them):
//   call-recording.mp4        — the bot's Meet view + every audio track mixed
//   call-recording-share.mp4  — the same audio over the full-res share capture,
//                               only when a 'share' track was recorded
//
// Removes RECOVERY.md on full success. Needs ffmpeg on PATH.
//
// This deliberately reuses electron-app/call-media-merge.js rather than shelling
// out to ffmpeg itself: the share-track padding and the video/audio track
// selection are subtle enough that a second implementation would drift from what
// the app does, and "recovered by hand" must mean the same file, not a similar
// one.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { mergeCallMedia, ffmpegAvailable } = require(path.join(root, 'electron-app/call-media-merge.js'));

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node scripts/finish-call-recording.mjs <call-recording-tracks-dir>');
  process.exit(2);
}
const tracksDir = path.resolve(dir);
const manifestPath = path.join(tracksDir, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`No manifest.json in ${tracksDir}`);
  console.error('Without it the tracks cannot be time-aligned, and this cannot be recovered.');
  process.exit(1);
}
if (!ffmpegAvailable()) {
  console.error('ffmpeg was not found on your PATH. Install it and run this again.');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const tracks = manifest.tracks || [];
if (!tracks.length) {
  console.error('The manifest lists no tracks.');
  process.exit(1);
}

// The app writes the .mp4s into the tracks folder's PARENT (the per-call dir),
// and suffixes them when a call was recorded more than once. Mirror both, by
// reading the suffix back off the folder name we were handed.
const callDir = path.dirname(tracksDir);
const suffix = (path.basename(tracksDir).match(/^call-recording-tracks(-\d+)?$/) || [])[1] || '';

const shareTrack = tracks.find((t) => t.track === 'share');
const videoTrack = tracks.find((t) => t.track === 'video');

console.log(`Merging ${tracks.length} track(s) from ${tracksDir}`);
let allOk = true;

const main = await mergeCallMedia(callDir, {
  tracksDir,
  tracks,
  outputName: `call-recording${suffix}.mp4`,
});
if (main.ok) console.log(`  wrote ${main.file}`);
else { allOk = false; console.warn(`  main merge skipped: ${main.reason}`); }

if (shareTrack) {
  // share.webm's t=0 is when the SHARE began, often minutes into the call,
  // while the audio tracks' t=0 is recording start. Pad by the delta so the
  // picture lines up with the borrowed audio. Same rule the app applies.
  let padStartMs = 0;
  if (videoTrack && Number.isFinite(shareTrack.startWallClock) && Number.isFinite(videoTrack.startWallClock)) {
    padStartMs = Math.max(0, shareTrack.startWallClock - videoTrack.startWallClock);
  }
  const share = await mergeCallMedia(callDir, {
    tracksDir,
    tracks,
    videoTrackName: 'share',
    outputName: `call-recording-share${suffix}.mp4`,
    padStartMs,
  });
  if (share.ok) console.log(`  wrote ${share.file} (padded ${padStartMs}ms)`);
  else { allOk = false; console.warn(`  share merge skipped: ${share.reason}`); }
}

if (allOk) {
  // Same contract as the app: the note goes away only when there is genuinely
  // nothing left to finish.
  fs.rmSync(path.join(tracksDir, 'RECOVERY.md'), { force: true });
  console.log('Done. The raw tracks are untouched; delete the folder if you no longer need them.');
} else {
  console.error('\nSomething did not merge. The raw tracks are untouched, and RECOVERY.md is kept.');
  process.exit(1);
}
