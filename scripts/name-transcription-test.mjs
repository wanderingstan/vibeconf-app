#!/usr/bin/env node
// name-transcription-test.mjs — audit the recommended bot names (electron-app/
// bot-names.js) for how well GOOGLE MEET transcribes them.
//
// The onboarding wizard offers users a random bot name. A name is only a good
// suggestion if Meet's live captions transcribe it correctly — otherwise the bot
// is addressed by, and answers to, a mangled name. This tool speaks each name in
// a short sentence through a bot's virtual mic (macOS `say` — an intentionally
// IMPERFECT, average voice, not ElevenLabs), and reads back what the OTHER bot's
// Meet captions heard. It's an AUDIT, not a gate: the point is a report of which
// names survive transcription so we can prune the bad ones from the pool.
//
// Cross-bot on purpose: bot A speaks, bot B reads B's captions — so we measure
// what Meet actually transcribed of A's audio, from a real viewer.
//
//   scripts/spawn-test-fleet.sh 2
//   node scripts/name-transcription-test.mjs --bots Alice:7901,Jimmy:7902
//     [--category feminine|masculine|robotic|all]   (default all)
//     [--limit N]            cap the count (quick pass / one chunk of a chunked run)
//     [--names "Elena,Milo"] audit an explicit list
//     [--voice "Samantha"]   macOS `say` voice (default: system voice)
//     [--skip-done]          skip names already carrying a real verdict in the
//                            JSONL (resume a chunked run; NO-CAPTION is retried)
//
// Results stream to ~/vibeconf-test-results/name-transcription-results.jsonl
// ({name, category, heard, transcribedName, verdict}) so a long run (all ~418
// names ≈ an hour) is resumable/inspectable if interrupted.
//
// CHUNKED RUNS (the source app crashes after ~10-15 min, too short for 418 names
// in one shot): run in small batches, each a FRESH fleet, with --skip-done so the
// batch picks up where the last left off, e.g.
//   for i in $(seq 1 30); do
//     scripts/spawn-test-fleet.sh 2   # fresh app pair
//     node scripts/name-transcription-test.mjs --bots Alice:7901,Jimmy:7902 \
//       --category all --skip-done --limit 15
//     scripts/spawn-test-fleet.sh 2 --kill
//   done
// Each batch audits ≤15 NEW names, well under the crash window, and the JSONL
// accretes the full dataset across batches.
//
// PRONUNCIATION CHECK: macOS `say` is an imperfect voice — for a tricky name
// (C-3PO, R2D2) a bad caption could be `say` MISpronouncing it, not Meet
// MIStranscribing it. For every suspicious verdict (CLOSE/MISS/NO-CAPTION) we
// render the same `say` audio to ~/vibeconf-test-results/name-audio/<name>.aiff
// so it can be judged BY EAR whether `say` or Meet is at fault.

import { createRequire } from 'module';
import { homedir } from 'os';
import { join } from 'path';
import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { Bot, sleep } from './meet-test-lib.mjs';

const require = createRequire(import.meta.url);
const { FEMININE, MASCULINE, ROBOTIC } = require('../electron-app/bot-names.js');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const ROOM = arg('room', 'paz-sqoa-npe');
const BOTS = arg('bots', 'Alice:7901,Jimmy:7902').split(',').map((s) => { const [name, port] = s.split(':'); return new Bot(name, Number(port), ROOM); });
const VOICE = arg('voice', '');                 // '' → the profile's default macOS voice
const LIMIT = Number(arg('limit', '0')) || 0;
const SKIP_DONE = process.argv.includes('--skip-done');

// Build the (name, category) work list.
const CATEGORY = arg('category', 'all').toLowerCase();
const CATS = { feminine: FEMININE, masculine: MASCULINE, robotic: ROBOTIC };
let work;
if (arg('names', '')) {
  work = arg('names', '').split(',').map((n) => ({ name: n.trim(), category: 'custom' })).filter((w) => w.name);
} else {
  const pick = CATEGORY === 'all' ? Object.entries(CATS) : [[CATEGORY, CATS[CATEGORY] || []]];
  work = pick.flatMap(([cat, list]) => list.map((name) => ({ name, category: cat })));
}

const RESULTS_DIR = process.env.VIBECONF_RESULTS_DIR || join(homedir(), 'vibeconf-test-results');
try { mkdirSync(RESULTS_DIR, { recursive: true }); } catch { /* exists */ }
const RESULTS_FILE = join(RESULTS_DIR, 'name-transcription-results.jsonl');
// Where suspicious names' `say` audio is saved for the by-ear pronunciation check.
const AUDIO_DIR = join(RESULTS_DIR, 'name-audio');

// --skip-done: resume a chunked run by dropping names that ALREADY have a real
// verdict (EXACT/CLOSE/MISS) in the JSONL. NO-CAPTION is intentionally NOT
// counted as done — those are inconclusive (often a crash tail) and get retried.
if (SKIP_DONE) {
  const done = new Set();
  try {
    for (const line of readFileSync(RESULTS_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r.name && r.verdict && r.verdict !== 'NO-CAPTION') done.add(r.name); } catch { /* skip bad line */ }
    }
  } catch { /* no prior file — nothing done */ }
  const before = work.length;
  work = work.filter((w) => !done.has(w.name));
  console.log(`--skip-done: ${done.size} name(s) already verdicted; ${before - work.length} skipped, ${work.length} remain`);
}

// LIMIT applies AFTER skip-done so each chunk audits up to LIMIT *new* names.
if (LIMIT) work = work.slice(0, LIMIT);

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

// Meet packs many sentences into ONE rolling caption paragraph, so isolate the
// CURRENT utterance: the text after the LAST "name is" (we speak "…my name is X").
function lastNameTail(heard) {
  const nH = norm(heard);
  const marker = 'name is ';
  const idx = nH.lastIndexOf(marker);
  return idx === -1 ? '' : nH.slice(idx + marker.length).trim();
}

// Given the isolated tail (already just this name's utterance) decide the verdict
// and what Meet actually put where the name should be.
function judge(name, tail) {
  const nName = norm(name);                 // may be multi-word ("optimus prime")
  const nTail = norm(tail);
  if (!nTail) return { verdict: 'NO-CAPTION', transcribedName: '' };
  if (nTail === nName || nTail.startsWith(nName + ' ') || nTail.includes(nName)) return { verdict: 'EXACT', transcribedName: name };
  // The name sits at the end of the sentence; the tail's LEADING words are the
  // (mis)heard name — trailing words would be a merged next fragment.
  const words = nTail.split(' ');
  const nw = nName.split(' ').length;
  const lead = words.slice(0, Math.max(nw, 1)).join(' ');
  const tol = Math.max(1, Math.round(nName.length * 0.34));   // ~1/3 of the name
  const dist = Math.min(levenshtein(nTail, nName), levenshtein(lead, nName));
  return { verdict: dist <= tol ? 'CLOSE' : 'MISS', transcribedName: lead };
}

// Pronunciation check: render this name's `say` audio to an .aiff so a human can
// hear whether `say` MISpronounced it (its fault) vs Meet MIStranscribing a
// correct utterance (Meet's fault). Same voice the bot spoke with, so it's the
// SAME audio Meet heard. Only called for suspicious verdicts — cheap, best-effort.
function saveSayAudio(name, category) {
  try {
    mkdirSync(AUDIO_DIR, { recursive: true });
    const safe = String(name).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '');
    const out = join(AUDIO_DIR, `${category}-${safe}.aiff`);
    const args = [];
    if (VOICE) args.push('-v', VOICE);
    args.push('-o', out, String(name));   // just the NAME — that's what we're judging
    execFileSync('say', args, { stdio: 'ignore', timeout: 20000 });
    return out;
  } catch (e) {
    console.log(`    (couldn't save audio for ${name}: ${e.message?.split('\n')[0] || e})`);
    return null;
  }
}

async function warmUp(bot) {
  await bot.join();
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    try { if ((await bot.status()).callStatus === 'in-call') break; } catch { /* retry */ }
    await sleep(1000);
  }
  await sleep(3000); // let the caption pipeline come online
}

// Drain any backlog so the NEXT waitForSpeech reads THIS name, not an old line.
async function drain(listener) {
  for (let i = 0; i < 6; i++) { const d = await listener.waitForSpeech({ wait: 4, silence: 2 }); if (d.timedOut) return true; }
  return false;
}

async function run() {
  const [speaker, listener] = BOTS;
  if (!listener) { console.error('need two bots: a speaker and a listener'); process.exit(2); }
  console.log(`name-transcription audit → ${work.length} name(s), room ${ROOM}`);
  console.log(`  speaker=${speaker.name}:${speaker.port}  listener=${listener.name}:${listener.port}  voice=${VOICE || '(default macOS)'}`);

  await Promise.all([warmUp(speaker), warmUp(listener)]);
  await drain(listener);

  const summary = { EXACT: 0, CLOSE: 0, MISS: 0, 'NO-CAPTION': 0 };
  const flagged = [];
  let prevTail = '';
  let consecutiveEmpty = 0;
  for (let i = 0; i < work.length; i++) {
    const { name, category } = work[i];
    let tail = '';
    // RESILIENCE for a ~2h unattended run: a single transient `fetch failed`
    // (a bot's local-server blips) must NOT abort the whole audit — catch it and
    // move on. And if captures keep coming up empty, the bots probably dropped
    // out of the call, so RE-WARM them (rejoin) before continuing.
    try {
      if (consecutiveEmpty >= 3) {
        console.log('    … re-warming bots (captures were dropping — likely fell out of the call)');
        await Promise.all([warmUp(speaker), warmUp(listener)]);
        await drain(listener);
        consecutiveEmpty = 0;
      }
      // Speak the name in a short, natural sentence — leading "my name is" primes
      // the recogniser that a NAME follows; the name ends it for a clean cut. RETRY
      // on an empty capture: Meet occasionally drops a caption, and over ~418 names
      // those transient misses would masquerade as NO-CAPTION. Re-speak (up to 3×)
      // so NO-CAPTION means the name is genuinely un-heard.
      for (let attempt = 0; attempt < 3 && !tail; attempt++) {
        if (attempt > 0) await drain(listener);   // settle before the retry
        await speaker.speak(`Hi everyone, my name is ${name}.`, VOICE ? { voice: VOICE } : {});
        for (let k = 0; k < 6; k++) {
          const d = await listener.waitForSpeech({ wait: 8, silence: 2 });
          const joined = (d.transcript || []).map((e) => e.text || '').join(' ');
          const t = lastNameTail(joined);
          if (t && t !== prevTail) tail = t;      // captured this name's utterance
          if (d.timedOut) break;                  // room quiet — caption finalized
        }
      }
    } catch (e) {
      console.log(`    ⚠️ ${name}: capture error (${e.message}) — recording NO-CAPTION, continuing`);
      await sleep(2000);
    }
    if (tail) prevTail = tail;
    consecutiveEmpty = tail ? 0 : consecutiveEmpty + 1;
    const { verdict, transcribedName } = judge(name, tail);
    summary[verdict] = (summary[verdict] || 0) + 1;
    const icon = verdict === 'EXACT' ? '✅' : verdict === 'CLOSE' ? '⚠️' : '❌';
    console.log(`  [${i + 1}/${work.length}] ${icon} ${name} (${category}) → ${verdict}${verdict !== 'EXACT' ? `  heard: "${transcribedName}"` : ''}`);
    // Save the `say` audio for any non-EXACT verdict so pronunciation vs
    // transcription can be judged by ear (the C-3PO problem).
    let audio = null;
    if (verdict !== 'EXACT') { audio = saveSayAudio(name, category); flagged.push({ name, category, verdict, transcribedName, audio }); }
    try { appendFileSync(RESULTS_FILE, JSON.stringify({ ts: new Date().toISOString(), name, category, verdict, transcribedName, tail: tail.slice(0, 60), ...(audio ? { audio } : {}) }) + '\n'); } catch { /* best-effort */ }
    await drain(listener); // settle the room before the next name
  }

  console.log('\n──────── name-transcription summary ────────');
  console.log(`  ✅ EXACT: ${summary.EXACT}   ⚠️ CLOSE: ${summary.CLOSE}   ❌ MISS: ${summary.MISS}   ∅ NO-CAPTION: ${summary['NO-CAPTION']}   (of ${work.length})`);
  if (flagged.length) {
    console.log('  Names to reconsider (not transcribed EXACTly) — play the .aiff to hear if `say` or Meet is at fault:');
    for (const f of flagged) console.log(`    ${f.verdict === 'CLOSE' ? '⚠️' : f.verdict === 'MISS' ? '❌' : '∅'} ${f.name} → "${f.transcribedName}"${f.audio ? `   🔊 ${f.audio}` : ''}`);
    console.log(`  Audio for the flagged names: ${AUDIO_DIR}`);
  }
  console.log(`  Full results: ${RESULTS_FILE}`);
  // Non-zero only on a hard error; a MISS is DATA, not a test failure (this is an audit).
  process.exit(0);
}

run().catch((err) => { console.error('name-transcription-test error:', err && err.message); process.exit(1); });
