#!/usr/bin/env node
//
// extract-speaker-tracks.mjs — turn Meet's shuffled slot tracks into one audio
// file per PERSON (#209/#422).
//
// THE PROBLEM. A recorded `remote-*.webm` is not one participant. Meet forwards
// whoever is speaking into a small fixed pool of slots and reassigns them
// mid-call: on the 2026-08-17 corpus all three humans appear on all three
// tracks in roughly equal amounts, and the manifest's per-track `name` — a
// whole-call majority vote — is simply wrong wherever a slot changed hands.
//
// WHAT MAKES IT SOLVABLE. Reassignment happens across SILENCE, never mid-word
// (observed by ear in Audacity, 2026-08-18). So a contiguous burst of energy on
// one track is one person for its whole length, and the job is not continuous
// re-attribution but labelling a few hundred segments.
//
// THE TWO SIGNALS, DELIBERATELY KEPT APART:
//
//   boundaries <- the recorded audio (energy envelope of the track itself)
//   identity   <- raw `ind` samples, Meet's own mic-meter sprite position
//
// Neither is the detector verdict, and that is the entire point. Nothing here
// depends on WINDOW_MS, ARM, RELEASE, METER_HOLD_MS or any other constant we
// might want to TUNE against the output — so the result is usable as ground
// truth for scoring those constants without circularity. Measured against the
// smoothed verdict instead, unlabelled time is 3.5% and 17 segments come out
// under-determined; against raw `ind` those become 0.4% and 4, because most
// apparent overlap was the Schmitt trigger's hold keeping an indicator lit
// after its owner stopped.
//
// Identity resolution is floored by the indicator POLL CADENCE (~200ms). That
// is a sampling rate, not a policy knob — it does not bias any detector.
//
// OVERLAP IS RESOLVED BY EXCLUSION, NOT BY GUESSING. When two people talk at
// once they are necessarily in different slots, so the window becomes an
// assignment problem: match hot tracks to lit names, maximising total overlap,
// with a small bonus for a track keeping its previous occupant. Where there are
// fewer hot tracks than lit names the window is genuinely under-determined and
// is emitted as `unknown` with an excerpt — never resolved by coin-flip. Those
// are the interesting ones: an indicator lit with no audio behind it and no
// spare track to explain it is the #378 signature.
//
// Usage:
//   node scripts/extract-speaker-tracks.mjs --tracks <call-recording-tracks/> \
//        --events <speaking-events.jsonl> [--out <dir>] [--rate 16000]
//
// Outputs, under --out (default `<tracks>/by-speaker/`):
//   <Name>.wav            one file per person, silence where they are not
//                         talking, so the ORIGINAL call timeline is preserved
//   attribution.json      every segment: track, span, owner, method, scores
//   labels-attribution.txt   who owns each segment (Audacity: File > Import >
//   labels-indicator.txt     what the raw indicator claimed  |  Labels — one
//   labels-review.txt        only the disagreements          |  track per file)
//   under-determined/     excerpts (+2s context) of the unresolved windows,
//                         with their own label file, for listening by ear

import { readFileSync, writeFileSync, openSync, readSync, closeSync, mkdirSync,
         existsSync, createWriteStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// --- WAV: 16-bit mono PCM. Enough for what ffmpeg hands us, no dependency. ---

export function parseWavHeader(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let off = 12, fmt = null, dataOff = 0, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = { channels: buf.readUInt16LE(off + 10), sampleRate: buf.readUInt32LE(off + 12),
              bits: buf.readUInt16LE(off + 22) };
    } else if (id === 'data') { dataOff = off + 8; dataLen = size; break; }
    off += 8 + size + (size % 2);
  }
  if (!fmt || !dataOff) throw new Error('missing fmt/data chunk');
  return { ...fmt, dataOff, dataLen };
}

export function wavHeader(dataBytes, { sampleRate = 48000, channels = 1, bits = 16 } = {}) {
  const b = Buffer.alloc(44);
  const byteRate = sampleRate * channels * bits / 8;
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataBytes, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22); b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(byteRate, 28); b.writeUInt16LE(channels * bits / 8, 32);
  b.writeUInt16LE(bits, 34); b.write('data', 36); b.writeUInt32LE(dataBytes, 40);
  return b;
}

// --- boundaries: energy segmentation of one track ---------------------------

// Frame-wise RMS in dBFS. The threshold is floor-relative with an absolute
// ceiling: a track whose noise floor is -95 dB should not get a -83 dB gate
// just because it is quiet, and one with a hissy floor should not gate at -60.
export function frameDb(samples, frameLen) {
  const n = Math.floor(samples.length / frameLen);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < frameLen; j++) { const s = samples[i * frameLen + j]; acc += s * s; }
    out[i] = 20 * Math.log10(Math.sqrt(acc / frameLen) / 32768 + 1e-12);
  }
  return out;
}

// Gate, then close short gaps and drop short blips. The gap-closing is what
// makes a segment an UTTERANCE rather than a syllable — and utterances are the
// unit Meet reassigns at, so this granularity is the one that matters.
export function segmentsFromDb(db, { frameMs = 20, gapMs = 300, minMs = 200,
                                     relDb = 12, absDb = -60, maxDb = -30 } = {}) {
  if (!db.length) return [];
  const sorted = Float64Array.from(db).sort();
  const floor = sorted[Math.floor(sorted.length * 0.2)];
  // Clamped at BOTH ends. The floor-relative part adapts to a hissy slot, but
  // on its own it eats a track that is mostly speech: the 20th percentile is
  // then a voiced frame and the gate climbs above the signal it should pass,
  // silencing the loudest slot in the call. Our slots run ~15% voiced so this
  // never bit here, but a monologue would have vanished. `maxDb` bounds it to
  // below where speech actually sits; `absDb` keeps a near-silent floor from
  // dragging the gate down into the noise.
  const thr = Math.min(Math.max(floor + relDb, absDb), maxDb);
  const gapFrames = Math.round(gapMs / frameMs), minFrames = Math.round(minMs / frameMs);
  const on = Array.from(db, (v) => v > thr);
  const segs = [];
  let i = 0;
  while (i < on.length) {
    if (!on[i]) { i++; continue; }
    let j = i;
    while (j < on.length) {
      if (on[j]) { j++; continue; }
      let k = j;
      while (k < on.length && !on[k] && k - j < gapFrames) k++;
      if (k < on.length && on[k]) j = k; else break;
    }
    if (j - i >= minFrames) segs.push({ startMs: i * frameMs, endMs: j * frameMs });
    i = j;
  }
  return { segments: segs, floorDb: floor, thresholdDb: thr };
}

// --- identity: raw indicator samples ----------------------------------------

// Each non-zero `ind` sample says "lit at this instant". Widening by one poll
// period is SAMPLE WIDTH, not smoothing: it reconstructs the interval the
// sample stands for. Adjacent samples merge into one lit interval.
// Meet's people-pane name is not the manifest's `botName`: the manifest says
// "Jimmy" and the roster says "jimmy bot". An exact-match exclusion therefore
// silently lets the bot compete as a fourth PERSON, and since it holds no
// remote slot it makes every window it is lit in look like more speakers than
// slots — inventing under-determined windows out of our own TTS. Match on the
// normalised prefix instead.
export const isBotName = (name, botName) => {
  if (!name || !botName) return false;
  const n = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  return n(name).startsWith(n(botName)) || n(botName).startsWith(n(name));
};

export function litIntervals(events, { holdMs = 260, exclude = [] } = {}) {
  const by = new Map();
  for (const e of events) {
    if (e.k !== 'ind' || !e.p) continue;
    if (exclude.some((x) => isBotName(e.p, x))) continue;
    if (!e.v || e.v === '0px') continue;
    if (!by.has(e.p)) by.set(e.p, []);
    by.get(e.p).push(e.t);
  }
  const out = new Map();
  for (const [name, ts] of by) {
    ts.sort((a, b) => a - b);
    const iv = [];
    for (const t of ts) {
      if (iv.length && t - iv[iv.length - 1][1] <= holdMs) iv[iv.length - 1][1] = t + holdMs;
      else iv.push([t, t + holdMs]);
    }
    out.set(name, iv);
  }
  return out;
}

export const overlapMs = (a, b, c, d) => Math.max(0, Math.min(b, d) - Math.max(a, c));

export function overlapWith(intervals, a, b) {
  let acc = 0;
  for (const [c, d] of intervals) { if (c >= b) break; acc += overlapMs(a, b, c, d); }
  return acc;
}

// --- assignment: who owns which hot track during an overlapping window ------

// Max-weight perfect matching by exhaustive permutation. n is the number of
// simultaneously-hot slots, which Meet keeps small (3 in every call recorded so
// far), so n! is trivial and optimal beats clever here.
export function bestAssignment(scoreMatrix, { bonus = null } = {}) {
  const T = scoreMatrix.length;
  if (!T) return { pairs: [], score: 0 };
  const N = scoreMatrix[0].length;
  const idx = [...Array(N).keys()];
  let best = null;
  const walk = (ti, used, acc, pairs) => {
    if (ti === T) {
      if (!best || acc > best.score) best = { score: acc, pairs: pairs.slice() };
      return;
    }
    for (const n of idx) {
      if (used.has(n)) continue;
      let s = scoreMatrix[ti][n];
      if (bonus && bonus[ti] === n) s += bonus.weight ?? 0;
      used.add(n); pairs.push([ti, n]);
      walk(ti + 1, used, acc + s, pairs);
      pairs.pop(); used.delete(n);
    }
    // A track may also go unassigned — necessary when hot tracks outnumber lit
    // names (a slot carrying noise nobody's indicator claims).
    pairs.push([ti, -1]);
    walk(ti + 1, used, acc, pairs);
    pairs.pop();
  };
  walk(0, new Set(), 0, []);
  return best;
}

// Label one segment against the lit intervals. `minShare` keeps a name from
// claiming a segment it barely grazes.
export function candidatesFor(seg, lit, { minShare = 0.30 } = {}) {
  const dur = seg.endMs - seg.startMs;
  const cand = [];
  for (const [name, iv] of lit) {
    const o = overlapWith(iv, seg.startMs, seg.endMs);
    if (o > minShare * dur) cand.push({ name, share: o / dur });
  }
  return cand.sort((a, b) => b.share - a.share);
}

// The whole attribution pass. Segments arrive per track, already in wall-clock
// ms relative to the call start.
export function attribute(trackSegs, lit, { dominance = 1.8, continuityBonus = 0.25 } = {}) {
  const all = [];
  for (const [track, segs] of Object.entries(trackSegs)) {
    for (const s of segs) all.push({ track, ...s, cand: candidatesFor(s, lit) });
  }
  all.sort((a, b) => a.startMs - b.startMs);

  // Pass 1 — anything with one candidate, or one clear winner, is settled.
  for (const s of all) {
    if (!s.cand.length) { s.owner = null; s.method = 'unlabelled'; }
    else if (s.cand.length === 1) { s.owner = s.cand[0].name; s.method = 'sole'; }
    else if (s.cand[0].share > s.cand[1].share * dominance) {
      s.owner = s.cand[0].name; s.method = 'dominant';
    }
  }

  // Pass 2 — the rest are contested. Group segments that overlap in time into
  // one window and solve it as an assignment, so exclusion does the work.
  const last = new Map(); // track -> last settled owner, for the continuity bonus
  for (const s of all) if (s.owner) last.set(s.track, s.owner);

  const open = all.filter((s) => s.owner === undefined);
  const windows = [];
  for (const s of open) {
    const w = windows.find((x) => x.some((y) => overlapMs(y.startMs, y.endMs, s.startMs, s.endMs) > 0));
    if (w) w.push(s); else windows.push([s]);
  }

  for (const w of windows) {
    const from = Math.min(...w.map((s) => s.startMs));
    const to = Math.max(...w.map((s) => s.endMs));
    // Slots and names ALREADY SPOKEN FOR in this window are removed from the
    // problem, not ignored. Counting only the contested segments makes slots
    // look scarcer than they are — a neighbouring track settled in pass 1 is
    // still a slot that is occupied, and its owner is still a person who is
    // accounted for. Without this, ordinary two-way overlap next to a settled
    // third speaker reads as under-determined: it reported 46 such windows
    // where there are 4.
    const settled = all.filter((x) => x.owner && overlapMs(x.startMs, x.endMs, from, to) > 0);
    const takenTracks = new Set(settled.map((x) => x.track));
    const takenNames = new Set(settled.map((x) => x.owner));
    const tracks = [...new Set(w.map((s) => s.track))].filter((t) => !takenTracks.has(t));
    const names = [...new Set(w.flatMap((s) => s.cand.map((c) => c.name)))]
      .filter((n) => !takenNames.has(n));
    if (!tracks.length || !names.length) {
      for (const s of w) {
        const free = s.cand.filter((c) => !takenNames.has(c.name));
        s.owner = free.length === 1 ? free[0].name : null;
        s.method = free.length === 1 ? 'by-elimination' : 'under-determined';
      }
      continue;
    }
    const matrix = tracks.map((t) => names.map((n) => {
      const iv = lit.get(n) || [];
      return w.filter((s) => s.track === t)
              .reduce((acc, s) => acc + overlapWith(iv, s.startMs, s.endMs), 0);
    }));
    const prev = tracks.map((t) => names.indexOf(last.get(t)));
    prev.weight = continuityBonus * Math.max(1, ...matrix.flat());
    const { pairs } = bestAssignment(matrix, { bonus: prev });
    const chosen = new Map(pairs.map(([ti, ni]) => [tracks[ti], ni < 0 ? null : names[ni]]));
    // Under-determined: more lit names than hot tracks means somebody's audio
    // is not here at all. Do not pick one.
    const under = names.length > tracks.length;
    for (const s of w) {
      s.owner = under ? null : chosen.get(s.track) ?? null;
      s.method = under ? 'under-determined' : 'assigned';
    }
  }
  return all;
}

// --- audio plumbing ---------------------------------------------------------

const ffmpeg = (args) => execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', ...args]);

function decodeToWav(src, dst, rate) {
  ffmpeg(['-i', src, '-ac', '1', '-ar', String(rate), '-c:a', 'pcm_s16le', dst]);
  return dst;
}

function readSamples(file) {
  const buf = readFileSync(file);
  const h = parseWavHeader(buf);
  const n = Math.floor(Math.min(h.dataLen, buf.length - h.dataOff) / 2);
  const s = new Int16Array(n);
  for (let i = 0; i < n; i++) s[i] = buf.readInt16LE(h.dataOff + i * 2);
  return { samples: s, sampleRate: h.sampleRate };
}

// Write one person's timeline: their segments copied from whichever slot
// carried them, silence in between. Streamed and read on demand, because
// holding four 54-minute tracks in memory at 48 kHz is a gigabyte for nothing.
function writePersonTrack(outFile, segs, sources, sampleRate, totalMs) {
  const bytes = Math.ceil(totalMs / 1000 * sampleRate) * 2;
  const out = createWriteStream(outFile);
  out.write(wavHeader(bytes, { sampleRate }));
  const SIL = Buffer.alloc(1 << 20);
  let cursor = 0; // bytes written of the data section
  const at = (ms) => Math.floor(ms / 1000 * sampleRate) * 2;
  for (const s of segs.slice().sort((a, b) => a.startMs - b.startMs)) {
    let pad = at(s.startMs) - cursor;
    if (pad < 0) continue; // overlapping claim; first writer wins
    while (pad > 0) { const n = Math.min(pad, SIL.length); out.write(SIL.subarray(0, n)); pad -= n; cursor += n; }
    const src = sources[s.track];
    const from = at(s.startMs - src.offsetMs) + src.dataOff;
    const len = at(s.endMs) - at(s.startMs);
    const buf = Buffer.alloc(len);
    const got = readSync(src.fd, buf, 0, len, from);
    out.write(buf.subarray(0, got)); cursor += got;
  }
  let tail = bytes - cursor;
  while (tail > 0) { const n = Math.min(tail, SIL.length); out.write(SIL.subarray(0, n)); tail -= n; }
  return new Promise((r) => out.end(r));
}

const secs = (ms) => (ms / 1000).toFixed(3);
// One rendering of call time everywhere — filenames, labels and console. Two
// spellings of the same instant is how 18:32 gets read as 18:33.
// Audacity label track: TAB-separated start/end/label seconds. File > Import >
// Labels, one label track per file. (Not XML — that is the .aup project file.)
const labelFile = (rows) =>
  rows.map(([a, b, t]) => `${secs(a)}\t${secs(b)}\t${t}`).join('\n') + '\n';

const clock = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:`
  + String(Math.floor(ms / 1000) % 60).padStart(2, '0');

// --- CLI --------------------------------------------------------------------

async function main() {
  const arg = (k, d) => {
    const i = process.argv.indexOf(`--${k}`);
    return i > 0 ? process.argv[i + 1] : d;
  };
  const tracksDir = arg('tracks');
  const eventsFile = arg('events');
  if (!tracksDir || !eventsFile) {
    console.error('usage: extract-speaker-tracks.mjs --tracks <dir> --events <speaking-events.jsonl> [--out <dir>] [--rate 48000]');
    process.exit(2);
  }
  const outDir = arg('out', path.join(tracksDir, 'by-speaker'));
  const rate = Number(arg('rate', 48000));
  mkdirSync(outDir, { recursive: true });
  const workDir = path.join(outDir, '.wav');
  mkdirSync(workDir, { recursive: true });

  const manifest = JSON.parse(readFileSync(path.join(tracksDir, 'manifest.json'), 'utf8'));
  const audio = manifest.tracks.filter((t) => t.kind === 'audio' && t.track !== 'bot');
  const T0 = Math.min(...manifest.tracks.filter((t) => t.kind === 'audio').map((t) => t.startWallClock));
  const botName = manifest.botName;

  console.log(`call ${manifest.callId} — ${audio.length} remote slots, bot "${botName}"`);

  // 1. boundaries, from the audio
  const trackSegs = {}, sources = {};
  let totalMs = 0;
  for (const t of audio) {
    const wav = path.join(workDir, `${t.track}.wav`);
    if (!existsSync(wav)) decodeToWav(path.join(tracksDir, t.file), wav, rate);
    const { samples, sampleRate } = readSamples(wav);
    const frameMs = 20;
    const { segments, floorDb, thresholdDb } =
      segmentsFromDb(frameDb(samples, Math.round(sampleRate * frameMs / 1000)), { frameMs });
    const offsetMs = t.startWallClock - T0;
    trackSegs[t.track] = segments.map((s) => ({ startMs: s.startMs + offsetMs, endMs: s.endMs + offsetMs }));
    const h = parseWavHeader(readFileSync(wav).subarray(0, 4096));
    sources[t.track] = { fd: openSync(wav, 'r'), dataOff: h.dataOff, offsetMs };
    totalMs = Math.max(totalMs, offsetMs + samples.length / sampleRate * 1000);
    console.log(`  ${t.track.padEnd(22)} ${String(segments.length).padStart(4)} segments  `
      + `floor ${floorDb.toFixed(1)}dB  gate ${thresholdDb.toFixed(1)}dB`);
  }

  // 2. identity, from the RAW indicator — never the verdict
  const events = readFileSync(eventsFile, 'utf8').split('\n')
    .filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean).map((e) => ({ ...e, t: e.t - T0 }));
  const lit = litIntervals(events, { exclude: [botName] });
  console.log(`  indicator: ${lit.size} people, `
    + [...lit].map(([n, iv]) => `${n} ${(iv.reduce((a, [c, d]) => a + d - c, 0) / 60000).toFixed(1)}m`).join('  '));

  // 3. attribute
  const segs = attribute(trackSegs, lit);
  const stat = {}, time = {};
  for (const s of segs) {
    stat[s.method] = (stat[s.method] || 0) + 1;
    time[s.method] = (time[s.method] || 0) + (s.endMs - s.startMs);
  }
  const voiced = Object.values(time).reduce((a, b) => a + b, 0);
  console.log('\nattribution:');
  for (const k of Object.keys(stat).sort((a, b) => stat[b] - stat[a])) {
    console.log(`  ${k.padEnd(18)} ${String(stat[k]).padStart(4)} segments  ${(100 * time[k] / voiced).toFixed(1)}% of voiced time`);
  }

  // 4. one file per person
  const byPerson = new Map();
  for (const s of segs) {
    if (!s.owner) continue;
    if (!byPerson.has(s.owner)) byPerson.set(s.owner, []);
    byPerson.get(s.owner).push(s);
  }
  console.log('\nwriting per-person tracks:');
  for (const [name, list] of byPerson) {
    const file = path.join(outDir, `${name.replace(/[^\w.-]+/g, '_')}.wav`);
    await writePersonTrack(file, list, sources, rate, totalMs);
    const mins = list.reduce((a, s) => a + s.endMs - s.startMs, 0) / 60000;
    console.log(`  ${path.basename(file).padEnd(24)} ${String(list.length).padStart(4)} segments  ${mins.toFixed(1)} min voiced`);
  }

  // 5. sidecars — the record of HOW each call was made, and the unresolved ones
  writeFileSync(path.join(outDir, 'attribution.json'), JSON.stringify({
    callId: manifest.callId, t0: T0, generated: 'extract-speaker-tracks.mjs',
    note: 'Boundaries from track audio energy; identity from RAW `ind` indicator '
        + 'samples, never the detector verdict — so this is usable as ground truth '
        + 'for scoring the detectors. owner=null with method=under-determined means '
        + 'more indicators were lit than slots carried audio: unresolved ON PURPOSE.',
    segments: segs.map((s) => ({ track: s.track, startMs: Math.round(s.startMs),
      endMs: Math.round(s.endMs), owner: s.owner, method: s.method,
      candidates: s.cand.map((c) => ({ name: c.name, share: +c.share.toFixed(3) })) })),
  }, null, 2));

  // Several label tracks rather than one: Audacity imports one track per file
  // and the questions are different — who owns this audio, what did the
  // indicator think, and which moments are worth an ear.
  writeFileSync(path.join(outDir, 'labels-attribution.txt'), labelFile(
    segs.map((s) => [s.startMs, s.endMs,
      `${s.owner || '???'} [${s.track.replace('remote-participant-', 'p')}`
      + `${s.method === 'sole' ? '' : ' ' + s.method}]`])));

  // The indicator's own opinion, as a row you can read AGAINST the waveform.
  // A gap here over visible audio is the detector missing real speech; a label
  // running past the audio is its hold. Side by side, both are obvious at a
  // glance — which no amount of summary statistics achieves.
  // Clipped to the recorded window. The event capture starts when the app does,
  // which on this corpus is 99.7s BEFORE recording began — those indicator
  // intervals are real but have no audio to sit beside, and a negative label
  // time is not something Audacity can place.
  writeFileSync(path.join(outDir, 'labels-indicator.txt'), labelFile(
    [...lit].flatMap(([name, iv]) => iv.map(([a, b]) => [a, b, name]))
      .filter(([, b]) => b > 0)
      .map(([a, b, name]) => [Math.max(0, a), Math.min(b, totalMs), name])
      .sort((x, y) => x[0] - y[0])));

  // Only the disagreements, for review.
  writeFileSync(path.join(outDir, 'labels-review.txt'), labelFile(
    segs.filter((s) => s.method === 'unlabelled' || s.method === 'under-determined')
      .map((s) => [s.startMs, s.endMs,
        `${s.method === 'unlabelled' ? 'MISS' : 'AMBIG'} ${clock(s.startMs)} `
        + `${s.track.replace('remote-participant-', 'p')} `
        + (s.cand.length ? `lit=${s.cand.map((c) => c.name).join('+')}` : 'lit=nobody')])));

  const unresolved = segs.filter((s) => s.method === 'under-determined' || s.method === 'unlabelled');
  if (unresolved.length) {
    const udDir = path.join(outDir, 'under-determined');
    mkdirSync(udDir, { recursive: true });
    const PAD = 2000;
    for (const [i, s] of unresolved.entries()) {
      const src = audio.find((t) => t.track === s.track);
      const from = Math.max(0, s.startMs - sources[s.track].offsetMs - PAD) / 1000;
      const dur = (s.endMs - s.startMs + 2 * PAD) / 1000;
      // mm-ss, matching how the console and Audacity both show it. A bare
      // "1113s" invites reading it as 18:33 against a table that floors to
      // 18:32, and four seconds is the difference between one speaker and the
      // next in a busy handover.
      const tag = `${String(i + 1).padStart(2, '0')}-${s.method}-${clock(s.startMs).replace(':', 'm')}s-${s.track.replace('remote-participant-', 'p')}`;
      ffmpeg(['-ss', String(from), '-t', String(dur), '-i', path.join(tracksDir, src.file),
              '-ac', '1', '-ar', String(rate), '-c:a', 'pcm_s16le', path.join(udDir, `${tag}.wav`)]);
      // Per-excerpt labels in EXCERPT-LOCAL time. The absolute file below is
      // for overlaying on the whole call; importing it onto a 4-second excerpt
      // would put the mark ~18 minutes past the end.
      const lead = Math.min(PAD, s.startMs - sources[s.track].offsetMs);
      writeFileSync(path.join(udDir, `${tag}.labels.txt`),
        `${secs(lead)}\t${secs(lead + (s.endMs - s.startMs))}\t`
        + `${s.method} @ ${clock(s.startMs)} — lit: ${s.cand.map((c) => c.name).join(' + ') || 'nobody'}\n`);
    }
    writeFileSync(path.join(udDir, 'labels.txt'), unresolved.map((s) =>
      `${secs(s.startMs)}\t${secs(s.endMs)}\t${clock(s.startMs)} ${s.method}: lit=${s.cand.map((c) => c.name).join('+') || 'nobody'} on ${s.track}`).join('\n') + '\n');
    console.log(`\n${unresolved.length} unresolved windows -> ${udDir} (excerpts +${PAD / 1000}s context, labels.txt)`);
  }

  for (const s of Object.values(sources)) closeSync(s.fd);
  console.log(`\ndone -> ${outDir}`);
}

if (process.argv[1] && process.argv[1].endsWith('extract-speaker-tracks.mjs')) main();
