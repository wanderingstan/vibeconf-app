#!/usr/bin/env node
/**
 * index-labelled-moments.mjs — mine the calls for moments a human LABELLED.
 *
 * Stan has been saying "awkward" out loud, in calls, at the moment the bot
 * misbehaves — and "nice" when it gets it right. That is a hand-labelled
 * dataset that already exists, scattered across ~50 call folders, and nothing
 * has ever read it.
 *
 * WHY THIS BEATS WRITING MORE RULES BY HAND. The etiquette suite asserts on the
 * app's own log markers, so the cheapest way to turn a rule green is to emit the
 * marker — not to fix the behaviour. A corpus of real moments is much harder to
 * game: the input is acoustics a person actually produced, at a moment a person
 * actually judged, and no amount of log-writing changes whether the bot yielded
 * to it. The 2026-08-30 fixture (see scripts/fixtures/README.md) is one of these
 * promoted by hand; this finds the rest.
 *
 * It does NOT classify. A label says a human disliked something within a few
 * seconds of saying it, not what went wrong — that still needs review, and the
 * output is deliberately shaped as a review queue rather than a verdict.
 *
 *   node scripts/index-labelled-moments.mjs <calls-dir> [more dirs...] [--json out.jsonl]
 *
 * The archive lives on an external drive that is usually unplugged, so this
 * writes a SELF-CONTAINED index: everything needed to decide whether a moment is
 * worth extracting is in the output, and the drive is only needed again to cut
 * the audio.
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const OUT = jsonAt >= 0 ? args[jsonAt + 1] : null;
// NOT `i !== jsonAt + 1`: with no --json, jsonAt is -1 and that expression
// excludes argument 0, i.e. the only directory you passed.
const DIRS = args.filter((a, i) => !a.startsWith('--') && !(jsonAt >= 0 && i === jsonAt + 1));
if (!DIRS.length) {
  console.error('usage: index-labelled-moments.mjs <calls-dir> [...] [--json out.jsonl]');
  process.exit(2);
}

// The labels, and what they mean. "awkward" is the one Stan actually uses; the
// others are here because they appeared in the same breath often enough to be
// worth catching, and a review queue costs nothing to over-collect into.
const NEGATIVE = /\b(awkward|talked over|talking over|you cut me off|stop interrupting)\b/i;
const POSITIVE = /\bnice\b/i;

// `[heard]` is what the bot's ears received, so it is the human's own words. NOT
// `[delivered]`, which repeats the same utterance to the agent and would double
// every moment — and not the transcript files, which the caption-replay bug
// (#12) is known to duplicate lines into.
const HEARD = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3}) .*\[heard\] ([^:]+): (.*)$/;

function callStartMs(callId) {
  // Call ids end in the UTC start: <room>-YYYYMMDDTHHMMSSZ
  const m = callId.match(/-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S] = m;
  return Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S);
}

const rows = [];
for (const dir of DIRS) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { console.error(`skip ${dir}: ${e.message}`); continue; }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const callId = ent.name;
    const callDir = path.join(dir, callId);
    const logPath = path.join(callDir, 'session-log.txt');
    if (!fs.existsSync(logPath)) continue;

    const startMs = callStartMs(callId);
    const tracksDir = path.join(callDir, 'call-recording-tracks');
    const tracks = fs.existsSync(tracksDir)
      ? fs.readdirSync(tracksDir).filter((f) => f.endsWith('.webm')).length : 0;

    const lines = fs.readFileSync(logPath, 'utf8').split('\n');
    // Local wall-clock -> offset needs the call's own start in the SAME clock.
    // The first timestamped line is the closest thing to it that is in the file.
    let firstMs = null;
    let prevSecs = -1, dayRoll = 0;
    const seen = new Set();

    for (const line of lines) {
      const m = HEARD.exec(line);
      if (!m) continue;
      const [, H, Mi, S, MS, speaker, text] = m;
      let secs = (+H * 3600 + +Mi * 60 + +S) * 1000 + +MS;
      // A call crossing midnight rolls the clock back; without this every line
      // after it gets a negative offset.
      if (prevSecs >= 0 && secs < prevSecs - 3600_000) dayRoll += 86400_000;
      prevSecs = secs;
      secs += dayRoll;
      if (firstMs === null) firstMs = secs;

      const negative = NEGATIVE.test(text);
      const positive = !negative && POSITIVE.test(text);
      if (!negative && !positive) continue;

      const offsetSec = Math.round((secs - firstMs) / 1000);
      // Collapse repeats: someone saying "awkward" five times in ten seconds is
      // ONE moment to review, not five. Keyed on the 10s bucket.
      const key = `${callId}:${Math.floor(offsetSec / 10)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      rows.push({
        callId,
        label: negative ? 'awkward' : 'nice',
        speaker: speaker.trim(),
        offsetSec,
        atClock: `${H}:${Mi}:${S}`,
        said: text.trim().slice(0, 160),
        tracks,
        // Everything the extractor needs later, so the drive is only required
        // once, for the cut itself.
        extractable: tracks > 0,
        callStartUtc: startMs ? new Date(startMs).toISOString() : null,
        dir: callDir,
      });
    }
  }
}

rows.sort((a, b) => (a.callId + String(a.offsetSec).padStart(6, '0'))
  .localeCompare(b.callId + String(b.offsetSec).padStart(6, '0')));

if (OUT) {
  fs.writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const neg = rows.filter((r) => r.label === 'awkward');
const pos = rows.filter((r) => r.label === 'nice');
const ext = neg.filter((r) => r.extractable);
console.log(`${rows.length} labelled moments across ${new Set(rows.map((r) => r.callId)).size} calls`);
console.log(`  ${neg.length} awkward (${ext.length} with per-speaker audio, i.e. extractable)`);
console.log(`  ${pos.length} nice`);
if (!OUT) {
  console.log('');
  for (const r of rows.slice(0, 40)) {
    console.log(`  ${r.label === 'awkward' ? '❌' : '✅'} ${r.callId}  +${String(r.offsetSec).padStart(5)}s  ${r.extractable ? '🎧' : '  '}  ${r.speaker}: ${r.said.slice(0, 80)}`);
  }
  if (rows.length > 40) console.log(`  … and ${rows.length - 40} more (use --json to capture them all)`);
}
