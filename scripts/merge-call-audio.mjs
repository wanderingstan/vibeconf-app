// merge-call-audio.mjs — turn a call's per-track recording into (1) one complete
// call-audio file and (2) a who-spoke-when annotation, from the artifacts in a
// calls/<call-id>/audio-tracks/ directory.
//
// WHY: Google Meet mixes participants into a small fixed set of downstream audio
// SLOTS (it does not give one track per person), and it reassigns people —
// including late joiners and shared-screen audio — into those slots over time.
// So no single track is one participant, but the UNION of the tracks is the
// COMPLETE call audio. And who-was-speaking-when doesn't come from the tracks at
// all — it comes from speaker-events.jsonl (Meet's people-pane, wall-clock
// stamped), which this aligns to the merged audio. (See issue #209.)
//
//   node scripts/merge-call-audio.mjs <audio-tracks-dir> [--out DIR]
//
// Produces in the output dir (default: alongside the input):
//   call.m4a   — every track time-aligned (by startWallClock) and mixed down
//   call.srt   — subtitles naming who is speaking, playable over call.m4a
//   call-annotations.json — the same timeline, structured
//
// Needs ffmpeg on PATH. No native / platform-specific code — same on mac/win/linux.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir || !fs.existsSync(path.join(dir, 'manifest.json'))) {
  console.error('Usage: node scripts/merge-call-audio.mjs <audio-tracks-dir> [--out DIR]');
  console.error('  (the dir must contain manifest.json — a calls/<id>/audio-tracks folder)');
  process.exit(2);
}
const outDir = (() => { const i = process.argv.indexOf('--out'); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dir; })();
fs.mkdirSync(outDir, { recursive: true });

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const tracks = (manifest.tracks || []).filter((t) => fs.existsSync(path.join(dir, t.file)));
if (!tracks.length) { console.error('No track files found in', dir); process.exit(1); }

// The merged timeline's t=0 is the earliest track's real audio start (its
// startWallClock). Each track is delayed to line up on that one wall clock, so a
// share that began mid-call lands where it actually happened.
const anchors = tracks.map((t) => t.startWallClock).filter((n) => Number.isFinite(n));
const t0 = anchors.length ? Math.min(...anchors) : manifest.startedAt;

// ── 1. merge every track, time-aligned, into one file ──
const inputs = [];
const filters = [];
tracks.forEach((t, i) => {
  inputs.push('-i', path.join(dir, t.file));
  const delay = Math.max(0, (Number.isFinite(t.startWallClock) ? t.startWallClock : t0) - t0);
  filters.push(`[${i}:a]adelay=${delay}|${delay}[a${i}]`);
});
const mix = `${tracks.map((_, i) => `[a${i}]`).join('')}amix=inputs=${tracks.length}:normalize=0:duration=longest[out]`;
const callFile = path.join(outDir, 'call.m4a');
const ff = spawnSync('ffmpeg', ['-y', '-v', 'error', ...inputs,
  '-filter_complex', `${filters.join(';')};${mix}`, '-map', '[out]', '-c:a', 'aac', '-b:a', '96k', callFile],
  { stdio: 'inherit' });
if (ff.status !== 0) { console.error('ffmpeg merge failed'); process.exit(1); }
console.log(`✓ merged ${tracks.length} track(s) → ${callFile}`);

// ── 2. who-spoke-when, from speaker-events.jsonl ──
const evPath = path.join(dir, 'speaker-events.jsonl');
let cues = [];
if (fs.existsSync(evPath)) {
  const events = fs.readFileSync(evPath, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean).sort((a, b) => a.at - b.at);
  // Walk the events keeping the set of who's currently speaking; every change
  // closes the previous interval and opens a new one.
  const speaking = new Set();
  let segStart = null;
  const push = (end) => {
    if (segStart != null && speaking.size) cues.push({ start: segStart - t0, end: end - t0, names: [...speaking].sort() });
  };
  for (const e of events) {
    push(e.at);
    if (e.speaking) speaking.add(e.name); else speaking.delete(e.name);
    segStart = e.at;
  }
  // Merge adjacent cues with the same speaker set for a cleaner track.
  cues = cues.filter((c) => c.end > c.start).reduce((acc, c) => {
    const last = acc[acc.length - 1];
    if (last && last.end >= c.start - 50 && last.names.join() === c.names.join()) last.end = c.end;
    else acc.push({ ...c });
    return acc;
  }, []);
} else {
  console.warn('! no speaker-events.jsonl — call.srt will be empty (recorded before the timeline sidecar existed)');
}

const ts = (ms) => {
  ms = Math.max(0, Math.round(ms));
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
  const s = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  return `${h}:${m}:${s},${String(ms % 1000).padStart(3, '0')}`;
};
const srt = cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.names.join(', ')}\n`).join('\n');
fs.writeFileSync(path.join(outDir, 'call.srt'), srt);
fs.writeFileSync(path.join(outDir, 'call-annotations.json'),
  JSON.stringify({ callId: manifest.callId, startWallClock: t0, cues }, null, 2));
console.log(`✓ ${cues.length} speaking segment(s) → ${path.join(outDir, 'call.srt')} + call-annotations.json`);
