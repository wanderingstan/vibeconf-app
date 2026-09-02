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
//   VIBECONF_NOTIFY_CHAT=<id>    recipient chat_id (REQUIRED to send; unset = skip, no group fallback)
//   VIBECONF_RESULTS_DIR=<path>  override results dir
//   VIBECONF_TELEGRAM_ENV=<path> override the token .env location

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync, execFileSync } from 'child_process';

const RESULTS = process.env.VIBECONF_RESULTS_DIR || join(homedir(), 'vibeconf-test-results');
// No fallback chat_id ON PURPOSE. This used to default to the shared group
// (-5140242529), so any run that forgot to set VIBECONF_NOTIFY_CHAT — every
// manual/ad-hoc wrapper run — silently spammed that group. The nightly
// LaunchAgent sets VIBECONF_NOTIFY_CHAT explicitly (Stan's DM), so it's
// unaffected; when it's unset we now SKIP the post (guard below) rather than
// pick a loud default. Set VIBECONF_NOTIFY_CHAT to route somewhere.
const CHAT = process.env.VIBECONF_NOTIFY_CHAT || '';
const ENV_FILE = process.env.VIBECONF_TELEGRAM_ENV || join(homedir(), '.claude/channels/telegram/.env');

function lastLine(file) {
  try {
    const lines = readFileSync(join(RESULTS, file), 'utf8').trim().split('\n').filter(Boolean);
    return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
  } catch { return null; }
}
function allLines(file) {
  try {
    return readFileSync(join(RESULTS, file), 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
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
// The Linux lane carries a `note` the other lanes don't, because its failures
// split into two kinds that want telling apart at a glance: the app broke, or
// the orchestration did (box would not start, SSM never came Online, no awscli
// on the runner). Both are worth seeing, but only one is a product regression,
// and a digest that renders them identically sends you to read the wrong log.
function linuxLine(r) {
  if (!r) return '⚪️ linux agent-terminal: no result';
  const ok = String(r.exit) === '0';
  const bits = [];
  if (r.fails !== undefined && Number(r.fails) > 0) bits.push(`${r.fails} fail${Number(r.fails) === 1 ? '' : 's'}`);
  // Infrastructure exits are numbered 70+ by nightly-linux-lane.sh precisely so
  // they can be labelled rather than blamed on the app.
  const infra = Number(r.exit) >= 70;
  if (infra) bits.push('infra, not the app');
  const note = r.note && !ok ? ` — ${r.note}` : '';
  return `${ok ? '🟢' : '🔴'} linux agent-terminal: exit ${r.exit}`
    + `${bits.length ? ` (${bits.join(', ')})` : ''}${note}`;
}
// agent-fuzz has a different shape: {ok:true/false, mission}.
function fuzzLine(r) {
  if (!r) return '⚪️ agent-fuzz: no result';
  return `${icon(r.ok === true)} agent-fuzz: ${r.ok ? 'pass' : 'fail'}${r.mission ? ` (${r.mission})` : ''}`;
}
// #334: fold the per-agent exit outcomes into the digest so a fuzz FAIL says WHY at
// a glance. spawn-agents.mjs logs a `[agent-exit NAME: code=X signal=Y after Zs
// (attempt N/M)]` line per attempt, so we can distinguish a launch flake that
// burned its retries (code≠0, ⟳3/3) from a hang killed at teardown (signal=SIGTERM
// after minutes) from a clean agent that ran the mission (code=0, no retry). The
// agent logs are reused + appended each night, so the LAST exit line per bot is
// tonight's; only count logs touched in the last hour (notify runs minutes after
// the fuzz lane).
function fuzzAgentSummary() {
  let files = [];
  try { files = readdirSync(join(RESULTS, 'agent-fuzz')).filter((n) => /^agent-.*\.log$/.test(n)); }
  catch { return []; }
  const cutoff = Date.now() - 60 * 60 * 1000;
  const parts = [];
  for (const f of files.sort()) {
    const p = join(RESULTS, 'agent-fuzz', f);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.mtimeMs < cutoff) continue;
    let tail = ''; try { tail = readFileSync(p, 'utf8').slice(-4000); } catch { continue; }
    const m = [...tail.matchAll(/\[agent-exit (\w+): code=(\S+) signal=(\S+) after ([\d.]+)s \(attempt (\d+)\/(\d+)\)\]/g)];
    if (!m.length) continue;
    const [, name, code, signal, secs, attempt, max] = m[m.length - 1];
    const retry = Number(attempt) > 1 ? ` ⟳${attempt}/${max}` : '';
    const state = code === '0'
      ? `ran ${secs}s`
      : `code=${code}${signal !== 'null' ? `/${signal}` : ''} ${secs}s`;
    parts.push(`${name} ${state}${retry}`);
  }
  return parts;
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
const displacement = lastLine('displacement-results.jsonl');
const fuzz = lastLine('agent-fuzz/results.jsonl');
// #329: the Linux agent-terminal lane, run on the cloud-TA EC2 box over SSM.
// The only lane that does not run on this mac, and the only coverage anywhere of
// Electron actually spawning an agent terminal on Linux — CI can run the unit
// suite on ubuntu (#363) but cannot start a display, a call, or an agent.
const linux = lastLine('linux-results.jsonl');
// Recording preflight: did screencapture actually produce a non-empty file? (null
// = recording disabled → nothing to say.) A broken recorder isn't a product RED —
// it's an observability gap — so it warns + pushes like the fallback-room notice
// rather than counting as a lane failure.
// Ecosystem preflight (scripts/ecosystem-preflight.mjs) — the dependency check
// that runs before everything. Read here so the digest can lead with it: a dead
// dependency reframes every red line below it, exactly like blockedBy does.
const preflight = lastLine('preflight-results.jsonl');
const recHealth = lastLine('recording-health-results.jsonl');
const recBroken = recHealth ? recHealth.ok === false : false;

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
  // #518: the only lane covering two bots at once. Its failure mode is a bot
  // going SILENT, which is exactly the kind that goes unnoticed without a line here.
  statusLine('multi-bot displacement', displacement),
  fuzzLine(fuzz),
  linuxLine(linux),
];
// #334: per-agent exit codes under the fuzz line (launch flake vs hang vs clean run).
const fuzzAgents = fuzzAgentSummary();
if (fuzzAgents.length) lines.push(`   ↳ agents: ${fuzzAgents.join(' · ')}`);
const anyRed = lines.some((l) => l.startsWith('🔴'));
const anyYellow = lines.some((l) => l.startsWith('🟡'));
const stamp = dmg?.ts || main?.ts || slack?.ts || '(unknown)';
// Recording links uploaded to Drive THIS run (rec_run → rclone). Only failing
// lanes keep recordings (REC_KEEP=fails), so this is naturally the interesting set
// — a red night's digest links straight to the .mov of what went wrong.
const recLinks = allLines('recording-uploads.jsonl').filter((r) => r.ts === stamp && r.link);
// Per-participant call recordings kept+uploaded THIS run (collect_call_recordings →
// rclone). Same keep=fails logic as the .mov, so on a red night this links straight
// to the actual call audio/video of what went wrong.
const callRecLinks = allLines('call-recording-uploads.jsonl').filter((r) => r.ts === stamp && r.link);
// Stills pulled from THIS run's failing lanes, plus the vision read of whether
// something was sitting on top of the app (scripts/failure-stills.mjs). This is
// the class of cause logs cannot report: on 2026-08-13 a macOS Automation prompt
// covered the screen for a whole lane and triage spent an hour in the logs
// concluding the wrong thing. A blocked screen outranks everything else in the
// message, so it goes directly under the header.
const stills = allLines('failure-stills.jsonl').filter((r) => r.ts === stamp);
const blockedBy = stills.find((r) => r.blocked && r.detail);

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
    '- Tag it: [code regression] / [environment/platform flakiness] / [test-infra] / [unknown].',
    '  For the platform tag, name the ACTUAL platform that failed — e.g. Slack, Google Meet,',
    '  network, Upstash. Do NOT default to "Google Meet": a Slack-lane failure is Slack flakiness.',
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
if (recBroken) ctx.push(`⚠️ screen-recording is BROKEN on the runner — the preflight capture produced ${recHealth?.bytes ?? 0} bytes (Screen Recording permission missing for the launchd shell). Any kept .mov is empty; grant the permission or set VIBECONF_RECORD=0.`);
// Above the lane results on purpose: if a dialog owned the screen, that reframes
// every red line below it, and reading it after the fact is how a night gets
// misdiagnosed as a product regression.
// Above the lanes for the same reason blockedBy is: when Redis or the site is
// down, every whiteboard/sync failure below is a consequence. Reading this after
// the lane list is how 2026-09-01 got investigated as a product regression for an
// hour before anyone probed the backend.
if (preflight && preflight.ok === false) {
  ctx.push(`🚨 ECOSYSTEM PREFLIGHT: ${esc(preflight.note || 'a dependency is down')}`);
  for (const c of (preflight.checks || []).filter((c) => c.status === 'down')) {
    ctx.push(`   🔴 ${esc(c.name)}${c.detail ? ` — ${esc(c.detail)}` : ''}`);
  }
} else if (preflight && (preflight.warn || []).length) {
  ctx.push(`⚠️ preflight: ${esc((preflight.warn || []).join(', '))} degraded`);
}
if (blockedBy) ctx.push(`🚨 SOMETHING WAS ON SCREEN during ${esc(blockedBy.lane)} — ${esc(blockedBy.detail)}. Treat the failures below as suspect until this is cleared (someone may need to dismiss it on the runner).`);
const analysisBlock = analysis ? ['', '🔎 <b>Claude analysis</b>', esc(analysis)] : [];
// Keep under Telegram's 4096-char hard limit — the status lines are the priority,
// so trim the analysis tail (not the digest) if the whole thing runs long.
const recBlock = (recLinks.length || callRecLinks.length)
  ? ['', '📹 <b>Recordings</b>',
     ...recLinks.map((r) => `<a href="${esc(r.link)}">▶ ${esc(r.lane)} (screen)</a>`),
     ...callRecLinks.map((r) => `<a href="${esc(r.link)}">🎙️ ${esc(r.lane)} (call ×${esc(String(r.files ?? ''))})</a>`)]
  : [];
let text = [header, ...ctx, ...lines.map(esc), ...recBlock, ...analysisBlock].join('\n');
if (text.length > 4090) text = text.slice(0, 4087) + '…';

if (process.env.VIBECONF_NOTIFY === '0') { console.log('[notify] disabled'); process.exit(0); }
if (process.env.VIBECONF_NOTIFY_DRYRUN === '1') { console.log('[notify] DRY-RUN — would send:\n' + text); process.exit(0); }
if (!CHAT) {
  console.log('[notify] VIBECONF_NOTIFY_CHAT not set, skipping Telegram post '
    + '(refusing to fall back to the shared group). Set VIBECONF_NOTIFY_CHAT to a chat_id to enable.');
  process.exit(0);
}

const tok = botToken();
if (!tok) { console.log(`[notify] no telegram token at ${ENV_FILE} — skipping`); process.exit(0); }

try {
  const resp = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML', disable_notification: !(anyRed || meetRoomFallback || recBroken || preflight?.ok === false) }),
    signal: AbortSignal.timeout(20000),
  });
  console.log(resp.ok ? '[notify] telegram sent' : `[notify] telegram failed: ${resp.status} ${await resp.text().catch(() => '')}`);
} catch (e) {
  console.log(`[notify] telegram error: ${e.message}`);
}

// Then the pictures. A link to a 145MB .mov on Drive is a thing you open later
// (i.e. never, at 3am); a still is a thing you glance at on a phone and know.
// One frame per failing lane, capped — the digest is an alert, not an album.
// Strictly after the text send, and each one best-effort, so a photo hiccup can
// never cost us the message that actually carries the results.
const photos = stills.flatMap((r) => (r.files || []).slice(0, 1).map((f) => ({ lane: r.lane, file: f, blocked: r.blocked, detail: r.detail })));
for (const p of photos.slice(0, 3)) {
  if (!tok) break;
  try {
    const bytes = readFileSync(p.file);
    const form = new FormData();
    form.append('chat_id', CHAT);
    form.append('caption', p.blocked ? `🚨 ${p.lane} — ${p.detail}`.slice(0, 1024) : `${p.lane} — screen at time of failure`);
    form.append('disable_notification', 'true');
    form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), p.file.split('/').pop());
    const r = await fetch(`https://api.telegram.org/bot${tok}/sendPhoto`, {
      method: 'POST', body: form, signal: AbortSignal.timeout(30000),
    });
    console.log(r.ok ? `[notify] still sent (${p.lane})` : `[notify] still failed (${p.lane}): ${r.status}`);
  } catch (e) {
    console.log(`[notify] still error (${p.lane}): ${e.message}`);
  }
}
process.exit(0);
