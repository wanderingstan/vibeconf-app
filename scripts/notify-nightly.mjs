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
const text = [`${anyRed ? '🔴' : '🌙'} Nightly ${stamp}`, ...lines].join('\n');

if (process.env.VIBECONF_NOTIFY === '0') { console.log('[notify] disabled'); process.exit(0); }
if (process.env.VIBECONF_NOTIFY_DRYRUN === '1') { console.log('[notify] DRY-RUN — would send:\n' + text); process.exit(0); }

const tok = botToken();
if (!tok) { console.log(`[notify] no telegram token at ${ENV_FILE} — skipping`); process.exit(0); }

try {
  const resp = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text, disable_notification: !anyRed }),
    signal: AbortSignal.timeout(20000),
  });
  console.log(resp.ok ? '[notify] telegram sent' : `[notify] telegram failed: ${resp.status} ${await resp.text().catch(() => '')}`);
} catch (e) {
  console.log(`[notify] telegram error: ${e.message}`);
}
process.exit(0);
