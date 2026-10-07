#!/usr/bin/env node
// build-subtitles.mjs — rebuild a recording's .srt/.vtt from its captions.jsonl.
//
// The app writes these automatically when a recording finishes. This is for the
// two cases where that isn't enough:
//   • re-timing. The cues land where Meet's recognizer published them, which is
//     a beat after the words were audible. `--offset -800` pulls them earlier
//     without re-recording anything.
//   • recovery. A merge that failed or was cancelled leaves the tracks dir on
//     disk (see its RECOVERY.md) with captions.jsonl intact.
//
// Usage:
//   node scripts/build-subtitles.mjs <call-recording-tracks-dir> [options]
//
//   --out <dir>       where the sidecars land (default: the tracks dir's parent,
//                     i.e. the call folder, beside call-recording.mp4)
//   --name <stem>     output stem (default: inferred from the tracks dir suffix,
//                     so call-recording-tracks-2 -> call-recording-2)
//   --offset <ms>     shift every cue, negative = earlier (default: 0)

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { writeSubtitleSidecars } = require('../electron-app/call-subtitles-write.js');

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

// First bare argument that isn't a flag's value.
const FLAGS_WITH_VALUES = new Set(['--out', '--name', '--offset']);
let tracksDir = null;
for (let i = 0; i < argv.length; i++) {
  if (FLAGS_WITH_VALUES.has(argv[i])) { i++; continue; }
  if (argv[i].startsWith('--')) continue;
  tracksDir = argv[i];
  break;
}
if (!tracksDir) {
  console.error('usage: node scripts/build-subtitles.mjs <call-recording-tracks-dir> [--out dir] [--name stem] [--offset ms]');
  process.exit(2);
}
if (!fs.existsSync(tracksDir)) {
  console.error(`no such directory: ${tracksDir}`);
  process.exit(2);
}

const outDir = flag('--out', path.dirname(path.resolve(tracksDir)));
// call-recording-tracks-2 -> call-recording-2; call-recording-tracks -> call-recording
const suffix = path.basename(path.resolve(tracksDir)).replace(/^call-recording-tracks/, '');
const baseName = flag('--name', `call-recording${suffix}`);
const offsetMs = Number(flag('--offset', '0')) || 0;

const res = writeSubtitleSidecars({ tracksDir, outDir, baseName, offsetMs });
if (!res.ok) {
  console.error(`could not build subtitles: ${res.reason}`);
  process.exit(1);
}
console.log(`${res.cues} cues`);
console.log(res.srt);
console.log(res.vtt);
