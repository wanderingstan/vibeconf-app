#!/usr/bin/env node
// notify-nightly.mjs — post a one-message digest of the latest nightly results to
// Telegram. The 3am cron (scheduled-meet-test.sh) is a plain launchd shell job, NOT
// a Claude session, so it can't use the reply tool — it hits the Bot API directly
// with the existing bot token (the Claude telegram channel's .env). Best-effort:
// prints a status line and ALWAYS exits 0, so a notify hiccup never fails the run.
//
// Env:
//   VIBECONF_NOTIFY=0            disable entirely
//   VIBECONF_NOTIFY_DRYRUN=1     compose + print, don't send
//   VIBECONF_NOTIFY_CHAT=<id>    override recipient (default: shared group)
//   VIBECONF_RESULTS_DIR=<path>  override results dir
//   VIBECONF_TELEGRAM_ENV=<path> override the token .env location

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync, execFileSync } from 'child_process';

const RESULTS = process.env.VIBECONF_RESULTS_DIR || join(homedir(), 'vibeconf-test-results');
const CHAT = process.env.VIBECONF_NOTIFY_CHAT || '-1003818025476'; // shared group
const ENV_FILE = process.env.VIBECONF_TELEGRAM_ENV || join(homedir(), '.claude/channels/telegram/.env');

function lastLine(file) {
  try {
    const lines = readFileSync(join(RESULTS, file), 'utf8').trim().split('\n').filter(Boolean);
    return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
  } catch { return null; }
}
function botToken() {
  try {
    const m = readFileSync(ENV_FILE, 'utf8').match(/^TELEGRAM_BOT_TOKEN=(.+)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch { return null; }
}

function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}
// The installed DMG's version — the artifact the DMG-meet lane tests.
function dmgVersion() {
  return sh('defaults read /Applications/Vibeconferencing.app/Contents/Info.plist CFBundleShortVersionString') || null;
}
// The checked-out main commit — what every SOURCE lane (main meet, Slack, codex,
// agent-fuzz) actually ran against. So a DMG-lane fail vs a source-lane fail points
// at the version vs the commit at a glance.
function mainCommit() {
  const repo = process.env.VIBECONF_REPO || join(homedir(), 'Developer/vibeconf-app');
  const line = sh(`git -C "${repo}" log -1 "--format=%h|%cr|%s"`);
  if (!line) return null;
  const [hash, age, ...rest] = line.split('|');
  const subj = rest.join('|').slice(0, 60);
  return `${hash} · ${age}${subj ? ' · ' + subj : ''}`;
}
// Telegram HTML parse_mode: only these three chars need escaping (a commit subject
// could contain them). Emojis/status text never do.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const icon = (ok) => (ok ? '✅' : '🔴');

// A "real stall" (see meet-test-lib.mjs's realStalls/quiet-room split) still
// isn't necessarily OUR bug — it's already filtered down from raw
// wait_for_speech timeouts to ones that overlap another bot's speech, but
// that can still be a one-off Google Meet audio/caption glitch rather than a
// code regression. A night with stalls but zero fails reads as 🟡 provisional
// here, not 🔴 — red is reserved for an actual failed step. This is a
// reporting-only reclassification: the underlying exit codes ($CODE in
// scheduled-meet-test.sh, meet-test.mjs's own exit) are untouched, so nothing
// upstream that reads those changes behavior — only what gets displayed here.
function verdict(r) {
  if (!r) return 'none';
  if (String(r.exit) === '0') return 'green';
  const fails = Number(r.fails);
  if (Number.isFinite(fails) && fails === 0) return 'yellow'; // stalls-only — provisional, not our code
  return 'red'; // fails > 0, or fails unparseable — never silently downgrade an unknown
}
const VERDICT_ICON = { green: '✅', yellow: '🟡', red: '🔴', none: '⚪️' };

// meet/slack/codex results share {exit[,stalls,fails]}: exit 0 = green.
function statusLine(label, r) {
  if (!r) return `⚪️ ${label}: no result`;
  const v = verdict(r);
  const bits = [];
  if (r.stalls !== undefined) bits.push(`${r.stalls} stall${r.stalls === '1' ? '' : 's'}`);
  if (r.fails !== undefined) bits.push(`${r.fails} fail${r.fails === '1' ? '' : 's'}`);
  const note = v === 'yellow' ? ' — provisional (Meet flakiness, not our code)' : '';
  return `${VERDICT_ICON[v]} ${label}: exit ${r.exit}${bits.length ? ` (${bits.join(', ')})` : ''}${note}`;
}
// agent-fuzz has a different shape: {ok:true/false, mission}.
function fuzzLine(r) {
  if (!r) return '⚪️ agent-fuzz: no result';
  return `${icon(r.ok === true)} agent-fuzz: ${r.ok ? 'pass' : 'fail'}${r.mission ? ` (${r.mission})` : ''}`;
}

const dmg = lastLine('results.jsonl');
const main = lastLine('results-main.jsonl');
const wbRoundtrip = lastLine('whiteboard-roundtrip-results.jsonl');
// Did the live lanes run on the FIXED, publicly-joinable fallback room? (mint
// failed → exposure risk.) Warned even on a green night — see scheduled-meet-test.
const meetRoomFallback = (lastLine('meet-room-source.json') || {}).source === 'fallback';
const slack = lastLine('slack-results.jsonl');
const whiteboardE2e = lastLine('whiteboard-e2e-results.jsonl');
const codex = lastLine('codex-smoke-results.jsonl');
const joinRoute = lastLine('join-route-results.jsonl');
const fuzz = lastLine('agent-fuzz/results.jsonl');

const lines = [
  statusLine('DMG meet (gating)', dmg),
  statusLine('main meet', main),
  statusLine('whiteboard round-trip', wbRoundtrip),
  statusLine('Slack', slack),
  statusLine("whiteboard e2e", whiteboardE2e),
  statusLine('codex', codex),
  // #105: the /join-call + /call routes. A lane that runs and records but never
  // reports is a lane nobody reads — the whole point is being TOLD when the
  // route users take is broken.
  statusLine('join/call routes', joinRoute),
  fuzzLine(fuzz),
];
const anyRed = lines.some((l) => l.startsWith('🔴'));
const anyYellow = lines.some((l) => l.startsWith('🟡'));
const stamp = dmg?.ts || main?.ts || slack?.ts || '(unknown)';

// --- Claude analysis (only on a red night) ---------------------------------
// When something failed, hand the failing log lines to `claude -p` for a short
// root-cause read and fold it into the alert, so the Telegram ping says WHY, not
// just THAT. Best-effort: any hiccup (no claude binary, no API creds in the cron
// env, a timeout) is swallowed and the digest sends without it. Off with
// VIBECONF_ANALYZE=0; model via VIBECONF_ANALYZE_MODEL; binary via CLAUDE_BIN.
function newestRunLog() {
  try {
    const f = readdirSync(RESULTS).filter((n) => /^run-.*\.log$/.test(n)).sort();
    return f.length ? join(RESULTS, f[f.length - 1]) : null;
  } catch { return null; }
}
function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const onPath = sh('command -v claude');
  if (onPath) return onPath;
  const known = '/Applications/cmux.app/Contents/Resources/bin/claude';
  try { readFileSync(known); return known; } catch { return null; }
}
// A compact, failure-focused digest of the run log — section headers plus the
// lines that actually carry a failure/error — so the model gets signal, not the
// whole 20KB transcript.
function failingDigest(logPath) {
  let raw = '';
  try { raw = readFileSync(logPath, 'utf8'); } catch { return ''; }
  const keep = /(^=== .* ===| ❌ |🔴|failed steps:|REAL STALL|real stall|not in-call|error|unauthorized|exit code: [1-9]|exit: [1-9])/i;
  const picked = raw.split('\n').filter((l) => keep.test(l));
  return picked.join('\n').slice(0, 12000);
}
function analyzeFailures() {
  if (process.env.VIBECONF_ANALYZE === '0') return null;
  const bin = resolveClaudeBin();
  const logPath = newestRunLog();
  if (!bin || !logPath) return null;
  const digest = failingDigest(logPath);
  if (!digest.trim()) return null;
  const model = process.env.VIBECONF_ANALYZE_MODEL || 'sonnet';
  const prompt = [
    'You are triaging an automated nightly test run for "Vibeconferencing", an',
    'Electron app where AI bots join Google Meet + Slack calls, driven by an HTTP',
    'test harness. Below (via stdin) is a FAILURE DIGEST — only the failing lines',
    'from tonight\'s run log.',
    '',
    'Write a SHORT root-cause read for a Telegram alert:',
    '- 2-4 sentences on the single most likely root cause (identify the COMMON',
    '  cause; do not restate every failed step).',
    '- Tag it: [code regression] / [environment/Google-Meet flakiness] / [test-infra] / [unknown].',
    '- One line for the most useful next step, if obvious.',
    'Plain text only, no markdown, under ~120 words.',
  ].join('\n');
  try {
    const out = execFileSync(bin, ['-p', prompt, '--model', model], {
      input: digest,
      encoding: 'utf8',
      timeout: 180000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const trimmed = (out || '').trim();
    return trimmed ? trimmed.slice(0, 2500) : null;
  } catch (e) {
    console.log(`[notify] analysis skipped: ${e.message?.split('\n')[0] || e}`);
    return null;
  }
}
// Analysis runs for yellow nights too (not just red) — the Claude triage read
// is exactly what tells a stalls-only night apart from a real regression, so
// skipping it just because it's not red would throw away the useful part.
const analysis = (anyRed || anyYellow) ? analyzeFailures() : null;

// Bold title (Telegram HTML), then two context lines: the DMG version (DMG-meet
// lane) and the main commit (all source lanes).
const header = `<b>${esc(`${anyRed ? '🔴' : anyYellow ? '🟡' : '🌙'} Nightly ${stamp}`)}</b>`;
const ctx = [];
const dver = dmgVersion(); if (dver) ctx.push(`🖥 DMG ${esc(dver)}`);
const mc = mainCommit(); if (mc) ctx.push(`🔧 main ${esc(mc)}`);
if (meetRoomFallback) ctx.push('⚠️ live lanes ran on the SHARED fallback Meet room — /call mint failed (sign the test profile into vibeconferencing.com); a fixed, publicly-joinable code appears in logs.');
const analysisBlock = analysis ? ['', '🔎 <b>Claude analysis</b>', esc(analysis)] : [];
// Keep under Telegram's 4096-char hard limit — the status lines are the priority,
// so trim the analysis tail (not the digest) if the whole thing runs long.
let text = [header, ...ctx, ...lines.map(esc), ...analysisBlock].join('\n');
if (text.length > 4090) text = text.slice(0, 4087) + '…';

if (process.env.VIBECONF_NOTIFY === '0') { console.log('[notify] disabled'); process.exit(0); }
if (process.env.VIBECONF_NOTIFY_DRYRUN === '1') { console.log('[notify] DRY-RUN — would send:\n' + text); process.exit(0); }

const tok = botToken();
if (!tok) { console.log(`[notify] no telegram token at ${ENV_FILE} — skipping`); process.exit(0); }

try {
  const resp = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML', disable_notification: !(anyRed || meetRoomFallback) }),
    signal: AbortSignal.timeout(20000),
  });
  console.log(resp.ok ? '[notify] telegram sent' : `[notify] telegram failed: ${resp.status} ${await resp.text().catch(() => '')}`);
} catch (e) {
  console.log(`[notify] telegram error: ${e.message}`);
}
process.exit(0);
