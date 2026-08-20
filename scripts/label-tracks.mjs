#!/usr/bin/env node
//
// label-tracks.mjs — ground truth for speaking detection (#422).
//
// Every constant in our speaking detection was chosen by reasoning over a few
// observed calls, then corrected when a call went wrong. The reason that loop
// never closed is that we could only ever compare our signals to EACH OTHER —
// [meter-latency] does exactly that, and it cannot tell you when both are wrong.
//
// A recording with ONE SPEAKER PER TRACK breaks that ceiling. Run a VAD over
// each track separately and you have an exact, labelled timeline of who spoke
// when, owing nothing to any code we are trying to evaluate.
//
// The VAD here is deliberately simple — short-window RMS with an adaptive
// noise floor and hysteresis. A neural VAD would label conversational speech a
// little better, but it would also be a second opaque detector standing between
// us and the answer. This one is ~40 lines, its failure modes are obvious, and
// the numbers it produces can be checked by hand against the audio.
//
// Usage:
//   node scripts/label-tracks.mjs <file.mov|file.mkv>            # multi-stream file
//   node scripts/label-tracks.mjs a.wav b.wav --names Stan,Seth  # one file per speaker
//   node scripts/label-tracks.mjs in.mov --start 300 --duration 600
//   node scripts/label-tracks.mjs in.mov --out labels.json
//
// Output (stdout summary, JSON to --out):
//   { source, startOffsetSec, speakers: [{ name, spans: [[startMs, endMs], ...] }] }
//
// Requires ffmpeg/ffprobe on PATH.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
};
const inputs = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const START = Number(flag('start', '0'));
const DURATION = flag('duration', null);
const OUT = flag('out', null);
const NAMES = flag('names', '').split(',').filter(Boolean);

// 8kHz mono is plenty for energy VAD and keeps a 60-minute call under 30MB of
// decoded samples per speaker.
const RATE = 8000;
const WIN_MS = 20;                  // RMS window
const WIN = (RATE * WIN_MS) / 1000;

if (!inputs.length) {
  console.error('usage: label-tracks.mjs <file...> [--names A,B] [--start s] [--duration s] [--out labels.json]');
  process.exit(2);
}

function ffprobeAudioStreams(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a',
    '-show_entries', 'stream=index', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean).map(Number);
}

// Decode one audio stream to raw mono 16-bit PCM.
function decode(file, streamIndex) {
  const args = ['-v', 'error'];
  if (START) args.push('-ss', String(START));
  args.push('-i', file);
  if (DURATION) args.push('-t', String(DURATION));
  args.push('-map', streamIndex == null ? '0:a:0' : `0:${streamIndex}`,
    '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-');
  return execFileSync('ffmpeg', args, { maxBuffer: 1024 * 1024 * 1024 });
}

function rmsWindows(buf) {
  const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
  const out = new Float64Array(Math.floor(samples.length / WIN));
  for (let w = 0; w < out.length; w++) {
    let sum = 0;
    const base = w * WIN;
    for (let i = 0; i < WIN; i++) { const v = samples[base + i]; sum += v * v; }
    out[w] = Math.sqrt(sum / WIN);
  }
  return out;
}

// Thresholds from the material itself, not from a constant. Conversational
// tracks are mostly silence, so a low percentile IS the noise floor; speech
// sits far above it. Two thresholds (enter high, leave low) so one quiet
// syllable inside a sentence doesn't split it.
function thresholds(rms) {
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const floor = pct(0.20) || 1;
  const loud = pct(0.95) || floor * 20;
  // Geometric middle, biased toward the floor: speech onsets are gradual and a
  // high bar clips the first syllable, which would bias every onset latency we
  // then measure against these labels.
  const enter = Math.max(floor * 3, Math.sqrt(floor * loud) * 0.6);
  return { enter, leave: enter * 0.6, floor, loud };
}

// Windows -> spans, with the two hygiene rules any VAD needs: bridge short
// internal gaps (a pause between words is not the end of a turn) and drop
// spans too short to be speech (a click, a chair).
function spansFrom(rms, { enter, leave }, { bridgeMs = 300, minMs = 200 } = {}) {
  const spans = [];
  let inSpeech = false, start = 0;
  for (let w = 0; w < rms.length; w++) {
    const v = rms[w];
    if (!inSpeech && v >= enter) { inSpeech = true; start = w; }
    else if (inSpeech && v < leave) { inSpeech = false; spans.push([start * WIN_MS, w * WIN_MS]); }
  }
  if (inSpeech) spans.push([start * WIN_MS, rms.length * WIN_MS]);

  const bridged = [];
  for (const sp of spans) {
    const last = bridged[bridged.length - 1];
    if (last && sp[0] - last[1] <= bridgeMs) last[1] = sp[1];
    else bridged.push(sp.slice());
  }
  return bridged.filter(([a, b]) => b - a >= minMs);
}

// --- run ---
const sources = [];
if (inputs.length === 1) {
  const streams = ffprobeAudioStreams(inputs[0]);
  if (streams.length < 2) {
    console.error(`${basename(inputs[0])} has ${streams.length} audio stream(s) — this rig needs one per speaker.`);
    console.error('A single mixed track cannot give per-speaker ground truth, which is the whole point.');
    process.exit(2);
  }
  streams.forEach((idx, i) => sources.push({ file: inputs[0], stream: idx, name: NAMES[i] || `speaker${i + 1}` }));
} else {
  inputs.forEach((f, i) => sources.push({ file: f, stream: null, name: NAMES[i] || basename(f).replace(/\.[^.]+$/, '') }));
}

const speakers = [];
for (const src of sources) {
  const rms = rmsWindows(decode(src.file, src.stream));
  const th = thresholds(rms);
  const spans = spansFrom(rms, th);
  const speech = spans.reduce((a, [s, e]) => a + (e - s), 0);
  const total = rms.length * WIN_MS;
  speakers.push({ name: src.name, spans, speechMs: speech, totalMs: total });
  console.log(`${src.name.padEnd(16)} ${spans.length.toString().padStart(4)} turns  `
    + `${(speech / 1000).toFixed(1)}s speech of ${(total / 1000).toFixed(0)}s `
    + `(${(100 * speech / total).toFixed(0)}%)  enter=${th.enter.toFixed(0)} floor=${th.floor.toFixed(0)}`);
}

// Overlap is the sanity check on the whole premise: if two "separate" tracks
// are really the same mix, they light up together and these labels are worthless.
if (speakers.length === 2) {
  const [a, b] = speakers;
  const overlap = a.spans.reduce((acc, [s, e]) => acc
    + b.spans.reduce((x, [s2, e2]) => x + Math.max(0, Math.min(e, e2) - Math.max(s, s2)), 0), 0);
  const union = a.speechMs + b.speechMs - overlap;
  const pct = union ? (100 * overlap / union) : 0;
  console.log(`\noverlap: ${(overlap / 1000).toFixed(1)}s of ${(union / 1000).toFixed(1)}s speaking (${pct.toFixed(1)}%)`);
  if (pct > 40) {
    console.log('⚠️  that is high enough to suspect the two streams carry the SAME mix.');
    console.log('   Per-speaker labels from a shared mix are not ground truth — check the source.');
  }
}

const result = { source: inputs.map((f) => basename(f)), startOffsetSec: START, windowMs: WIN_MS, speakers };
if (OUT) { writeFileSync(OUT, JSON.stringify(result, null, 2)); console.log(`\nwrote ${OUT}`); }
