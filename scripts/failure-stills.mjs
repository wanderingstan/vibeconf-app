#!/usr/bin/env node
// failure-stills.mjs — when a lane fails, LOOK at the screen it failed on.
//
// Motivating night (2026-08-13, v0.8.25): dmg-meet failed 14 steps with a real
// stall. The logs read like a product regression — share never engaged, 0
// participants, nothing heard, and a `tiles=0 / totalToolbarBtns=0` line that
// sent triage chasing a Meet page that "never rendered". The actual cause was a
// macOS modal parked dead centre of the screen for the whole lane:
//
//     "Vibeconferencing.app" wants access to control "System Events.app"
//
// The nightly's own self-update had just replaced /Applications/Vibeconferencing.app,
// which changes the code signature, which drops the Automation grant, which
// re-prompts on first launch — unattended, with nobody to click it. One frame
// from the .mov we ALREADY keep on failure answers in seconds what an hour of
// log-reading got wrong.
//
// So: on a red lane, pull a few stills and ask whether something is sitting on
// top of the app. Best-effort throughout — this is diagnostics, never a gate.
// Every failure path logs and exits 0, because a broken screenshot must not turn
// a lane's real result into a different one.
//
// Usage:
//   node scripts/failure-stills.mjs --mov <path> --lane <lane> --stamp <stamp>
//        [--out <dir>] [--count 3] [--no-vision]
//
// Writes the frames next to the recordings (RESULTS/stills/) and appends one
// line per lane to RESULTS/failure-stills.jsonl for notify-nightly.mjs to read.

import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';

const RESULTS = process.env.VIBECONF_RESULTS_DIR || join(homedir(), 'vibeconf-test-results');
const VISION_MODEL = process.env.VIBECONF_VISION_MODEL || 'claude-sonnet-5';

// ── frame selection ─────────────────────────────────────────────────────────
// Evenly spaced across the middle of the recording, never at the very edges: t=0
// is the desktop before the app is up, and the last instant is teardown. A modal
// that only appears halfway through (this is the common shape — it fires on the
// app's first AppleScript call, not at launch) has to be inside the sample, so
// spread the picks rather than clustering them at one moment.
//
// Exported and pure so the spacing is pinned by a test instead of eyeballed.
export function frameTimestamps(durationSec, count = 3) {
  const d = Number(durationSec);
  if (!Number.isFinite(d) || d <= 0 || count < 1) return [];
  // Interior points: for n=3 → 25%, 50%, 75%. Never 0 and never the final frame.
  return Array.from({ length: count }, (_, i) => +(d * ((i + 1) / (count + 1))).toFixed(2));
}

function movDuration(mov) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', mov,
    ], { encoding: 'utf8', timeout: 30000 });
    const d = parseFloat((out || '').trim());
    return Number.isFinite(d) ? d : null;
  } catch { return null; }
}

// Pull the frames. Scaled down to 1280px wide: enough to read a dialog's title
// and buttons, small enough to attach to a Telegram message without a resize.
export function extractStills({ mov, outDir, lane, stamp, count = 3 }) {
  if (!existsSync(mov)) return [];
  const dur = movDuration(mov);
  if (!dur) return [];
  mkdirSync(outDir, { recursive: true });
  const made = [];
  for (const [i, t] of frameTimestamps(dur, count).entries()) {
    const out = join(outDir, `${lane}-${stamp}-${String(i + 1).padStart(2, '0')}.jpg`);
    try {
      // -ss BEFORE -i is the fast seek; -frames:v 1 grabs exactly one picture.
      execFileSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', String(t), '-i', mov,
        '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '4', out,
      ], { timeout: 60000, stdio: ['ignore', 'ignore', 'pipe'] });
      if (existsSync(out) && statSync(out).size > 1024) made.push(out);
    } catch { /* one bad frame shouldn't lose the others */ }
  }
  return made;
}

// ── the actual question ─────────────────────────────────────────────────────
// Deliberately narrow. This is not "describe the screenshot" — a vague read is
// worse than none at the top of an alert. It asks the one thing logs cannot
// answer: is something SITTING ON TOP of the app, and what does it say?
const VISION_PROMPT = [
  'This is a screenshot from an automated test run of a macOS app (Vibeconferencing)',
  'driving Google Meet. The test FAILED.',
  '',
  'Look ONLY for something obstructing or blocking the app: a macOS system dialog or',
  'permission prompt (Automation / "wants access to control", Screen Recording,',
  'microphone, camera, notifications), a crash or "unexpectedly quit" alert, a',
  'software-update or restart prompt, a login/keychain prompt, or any other modal',
  'window on top of the app.',
  '',
  'If you see one, answer exactly: YES | <the dialog title or its main sentence, verbatim if legible>',
  'If the screen just shows the app and/or Google Meet with no such obstruction, answer exactly: NO',
  'Answer with that one line and nothing else.',
].join('\n');

// Parse the model's one line into a verdict. Separate + exported because the
// string handling is where this would silently rot, and a wrong `blocked` bit
// puts a false "a dialog blocked the run" banner at the top of an alert.
export function parseVerdict(raw) {
  const line = (raw || '').trim().split('\n').find((l) => l.trim()) || '';
  if (/^\s*yes\b/i.test(line)) {
    const detail = line.replace(/^\s*yes\s*[|:—-]?\s*/i, '').trim();
    return { blocked: true, detail: detail || 'a system dialog was on screen (no detail given)' };
  }
  if (/^\s*no\b/i.test(line)) return { blocked: false, detail: '' };
  return null; // unparseable → caller treats as "no answer", never as a pass or a fail
}

// CLI-first, API-fallback — the same shape whiteboard-e2e-test.mjs uses for its
// vision check, so there's one story on this machine: the interactive `claude`
// subscription when it's there, an API key when it isn't, null when neither.
function claudeCliSees(imagePath) {
  return new Promise((resolve) => {
    const prompt = `Read the image file at ${imagePath}. ${VISION_PROMPT}`;
    execFile('claude', ['-p', prompt, '--allowedTools', 'Read', '--add-dir', dirname(imagePath)],
      { timeout: 120000 }, (err, stdout) => {
        if (err) { resolve(null); return; } // not installed / not logged in
        resolve(parseVerdict(stdout));
      });
  });
}

async function apiSees(imagePath) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const b64 = readFileSync(imagePath).toString('base64');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          { type: 'text', text: VISION_PROMPT },
        ],
      }],
    }),
    signal: AbortSignal.timeout(60000),
  }).catch(() => null);
  if (!resp || !resp.ok) return null;
  const data = await resp.json().catch(() => ({}));
  return parseVerdict(data?.content?.[0]?.text || '');
}

// Check the frames in order and stop at the first obstruction found. One hit is
// the whole answer — and stopping early keeps a red night from spending three
// vision calls to say the same thing three times.
export async function findObstruction(stills) {
  for (const s of stills) {
    const v = (await claudeCliSees(s)) ?? (await apiSees(s));
    if (v?.blocked) return { ...v, frame: basename(s) };
  }
  return { blocked: false, detail: '', frame: null };
}

// ── entry point ─────────────────────────────────────────────────────────────
function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const mov = arg('mov');
  const lane = arg('lane', 'lane');
  const stamp = arg('stamp', 'now');
  const outDir = arg('out', join(RESULTS, 'stills'));
  const count = Math.max(1, Math.min(6, parseInt(arg('count', '3'), 10) || 3));
  if (!mov) { console.log('[stills] no --mov given — skipping'); return; }

  const stills = extractStills({ mov, outDir, lane, stamp, count });
  if (!stills.length) {
    console.log(`[stills] could not extract frames from ${basename(mov)} (ffmpeg/ffprobe missing or unreadable .mov)`);
    return;
  }
  console.log(`=== 🖼  stills from failing lane '${lane}': ${stills.length} frame(s) → ${outDir} ===`);

  let verdict = { blocked: false, detail: '', frame: null };
  if (process.argv.includes('--no-vision') || process.env.VIBECONF_STILLS_VISION === '0') {
    console.log('[stills] vision check disabled — frames kept for a manual eyeball');
  } else {
    verdict = await findObstruction(stills);
    if (verdict.blocked) {
      // Loud on purpose. This is the line that would have saved the 2026-08-13
      // triage, so it belongs in the run log too, not only in the digest.
      console.log(`=== 🚨 SCREEN BLOCKED during '${lane}': ${verdict.detail} (see ${verdict.frame}) ===`);
    } else {
      console.log(`[stills] no system dialog seen on screen during '${lane}'`);
    }
  }

  try {
    appendFileSync(join(RESULTS, 'failure-stills.jsonl'),
      JSON.stringify({ ts: stamp, lane, files: stills, blocked: verdict.blocked, detail: verdict.detail, frame: verdict.frame }) + '\n');
  } catch { /* diagnostics only */ }
}

// Only run when invoked directly, so the exported helpers stay importable from tests.
if (process.argv[1] && process.argv[1].endsWith('failure-stills.mjs')) {
  main().catch((e) => console.log(`[stills] skipped: ${e?.message || e}`)).finally(() => process.exit(0));
}
