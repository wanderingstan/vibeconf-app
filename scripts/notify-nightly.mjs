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
//   VIBECONF_NOTIFY_CHAT=<id>    override recipient (default: Stan's DM)
//   VIBECONF_RESULTS_DIR=<path>  override results dir
//   VIBECONF_TELEGRAM_ENV=<path> override the token .env location

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

const RESULTS = process.env.VIBECONF_RESULTS_DIR || join(homedir(), 'vibeconf-test-results');
const CHAT = process.env.VIBECONF_NOTIFY_CHAT || '6785998012'; // Stan's DM
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
  const repo = process.env.VIBECONF_REPO || join(homedir(), 'Developer/vibeconferencing');
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

// meet/slack/codex results share {exit[,stalls,fails]}: exit 0 = green.
function statusLine(label, r) {
  if (!r) return `⚪️ ${label}: no result`;
  const ok = String(r.exit) === '0';
  const bits = [];
  if (r.stalls !== undefined) bits.push(`${r.stalls} stall${r.stalls === '1' ? '' : 's'}`);
  if (r.fails !== undefined) bits.push(`${r.fails} fail${r.fails === '1' ? '' : 's'}`);
  return `${icon(ok)} ${label}: exit ${r.exit}${bits.length ? ` (${bits.join(', ')})` : ''}`;
}
// agent-fuzz has a different shape: {ok:true/false, mission}.
function fuzzLine(r) {
  if (!r) return '⚪️ agent-fuzz: no result';
  return `${icon(r.ok === true)} agent-fuzz: ${r.ok ? 'pass' : 'fail'}${r.mission ? ` (${r.mission})` : ''}`;
}

const dmg = lastLine('results.jsonl');
const main = lastLine('results-main.jsonl');
const slack = lastLine('slack-results.jsonl');
const codex = lastLine('codex-smoke-results.jsonl');
const fuzz = lastLine('agent-fuzz/results.jsonl');

const lines = [
  statusLine('DMG meet (gating)', dmg),
  statusLine('main meet', main),
  statusLine('Slack', slack),
  statusLine('codex', codex),
  fuzzLine(fuzz),
];
const anyRed = lines.some((l) => l.startsWith('🔴'));
const stamp = dmg?.ts || main?.ts || slack?.ts || '(unknown)';

// Bold title (Telegram HTML), then two context lines: the DMG version (DMG-meet
// lane) and the main commit (all source lanes).
const header = `<b>${esc(`${anyRed ? '🔴' : '🌙'} Nightly ${stamp}`)}</b>`;
const ctx = [];
const dver = dmgVersion(); if (dver) ctx.push(`🖥 DMG ${esc(dver)}`);
const mc = mainCommit(); if (mc) ctx.push(`🔧 main ${esc(mc)}`);
const text = [header, ...ctx, ...lines.map(esc)].join('\n');

if (process.env.VIBECONF_NOTIFY === '0') { console.log('[notify] disabled'); process.exit(0); }
if (process.env.VIBECONF_NOTIFY_DRYRUN === '1') { console.log('[notify] DRY-RUN — would send:\n' + text); process.exit(0); }

const tok = botToken();
if (!tok) { console.log(`[notify] no telegram token at ${ENV_FILE} — skipping`); process.exit(0); }

try {
  const resp = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML', disable_notification: !anyRed }),
    signal: AbortSignal.timeout(20000),
  });
  console.log(resp.ok ? '[notify] telegram sent' : `[notify] telegram failed: ${resp.status} ${await resp.text().catch(() => '')}`);
} catch (e) {
  console.log(`[notify] telegram error: ${e.message}`);
}
process.exit(0);
