#!/usr/bin/env node
//
// extract-speaker-tracks.mjs — CLI for electron-app/speaker-extract.js.
//
// Turns Meet's shuffled slot tracks into one audio file per PERSON. The logic
// lives in the app module, not here: the raw tracks are deleted moments after
// the merge unless keepCallRecordingTracks is on, so for a normal call this has
// to run INSIDE the app (main.js runPostRecordingMerges) and there must be
// exactly one implementation for both paths. See that file for how it works and
// why identity comes from the raw indicator rather than the detector verdict.
//
// This is the manual path: an archived corpus, or a call whose tracks were kept.
//
// Usage:
//   node scripts/extract-speaker-tracks.mjs --tracks <call-recording-tracks/> \
//        --events <speaking-events.jsonl> [--out <dir>] [--rate 48000]
//        [--no-audio]   labels + attribution.json only, no per-person WAVs
//        [--cleanup]    drop the .wav/ decode cache when done
//
// Outputs, under --out (default `<tracks>/by-speaker/`):
//   <Name>.wav               one file per person, silence where they are not
//                            talking, so the ORIGINAL call timeline is kept
//   attribution.json         every segment: track, span, owner, method, scores
//   labels-attribution.txt   who owns each segment      | Audacity:
//   labels-indicator.txt     what the raw indicator said| File > Import >
//   labels-review.txt        only the disagreements     | Labels (one per file)
//   under-determined/        excerpts (+2s context) of the unresolved windows,
//                            each with its own label file in excerpt-local time

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractSpeakerTracks } = require('../electron-app/speaker-extract.js');
const { resolveFfmpegPath } = require('../electron-app/call-media-merge.js');

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);

const tracksDir = arg('tracks');
const eventsFile = arg('events');
if (!tracksDir || !eventsFile) {
  console.error('usage: extract-speaker-tracks.mjs --tracks <dir> --events <speaking-events.jsonl>'
    + ' [--out <dir>] [--rate 48000] [--no-audio] [--cleanup]');
  process.exit(2);
}

const res = await extractSpeakerTracks({
  tracksDir,
  eventsFile,
  outDir: arg('out'),
  rate: Number(arg('rate', 48000)),
  ffmpegPath: resolveFfmpegPath() || 'ffmpeg',
  writeAudio: !has('no-audio'),
  cleanup: has('cleanup'),
});
if (!res.ok) {
  console.error(`extraction skipped: ${res.reason}`);
  process.exit(1);
}
