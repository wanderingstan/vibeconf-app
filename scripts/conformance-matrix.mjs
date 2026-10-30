#!/usr/bin/env node
// conformance-matrix.mjs: the calls library's nightly canary (Phase 5).
//
// Runs the conformance suite (packages/calls/conformance/suite.js, through
// scripts/provider-test.mjs) for every platform on both hosts, records one row
// per cell in ~/vibeconf-test-results/conformance-results.jsonl, and posts a
// summary with the green streak to Telegram. The public launch waits on 14
// green nights in a row; a night is green when every cell that ran passed.
//
// Cells that need a private meeting link (Zoom, Teams) read it from the
// environment or from ~/.config/vibeconf/canary.env (KEY=value lines, chmod
// 600, never committed). Without it the cell records "not configured" rather
// than failing, and doesn't count against the streak. Links are never printed.
//
//   VIBECONF_ZOOM_URL, VIBECONF_TEAMS_URL   the standing test meetings
//   VIBECONF_CANARY_SLACK_PLAYWRIGHT=1      run Slack on Playwright (needs the
//                                           Alice/Bob Playwright profiles signed in)
//   VIBECONF_CANARY_CELLS=meet/playwright,… run only these cells
//   VIBECONF_CANARY_CHAT=<id>               Telegram chat for the summary (unset: skip)
//
// Exit code is non-zero when any cell failed.

import { spawn } from 'node:child_process';
import { readFileSync, appendFileSync, mkdirSync, existsSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const RESULTS = process.env.VIBECONF_RESULTS_DIR || join(homedir(), 'vibeconf-test-results');
const ENV_FILE = join(homedir(), '.config', 'vibeconf', 'canary.env');

// KEY=value lines; quotes around the value are dropped. Values never echoed.
function loadEnvFile(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
const env = { ...loadEnvFile(ENV_FILE), ...process.env };

// Order matters: Zoom's guest reCAPTCHA trips after ~4 joins in 10 minutes, so
// its two cells are kept apart.
const CELLS = [
  { platform: 'zoom', host: 'electron', script: 'test:zoom:ci', needs: ['VIBECONF_ZOOM_URL'] },
  { platform: 'meet', host: 'electron', script: 'test:meet:conformance' },
  { platform: 'meet', host: 'playwright', script: 'test:meet:playwright' },
  { platform: 'teams', host: 'electron', script: 'test:teams:ci', needs: ['VIBECONF_TEAMS_URL'] },
  { platform: 'slack', host: 'electron', script: 'test:slack:conformance' },
  { platform: 'teams', host: 'playwright', script: 'test:teams:playwright', needs: ['VIBECONF_TEAMS_URL'] },
  { platform: 'zoom', host: 'playwright', script: 'test:zoom:playwright', needs: ['VIBECONF_ZOOM_URL'] },
  { platform: 'slack', host: 'playwright', script: 'test:slack:playwright', needs: ['VIBECONF_CANARY_SLACK_PLAYWRIGHT'] },
];
const only = (env.VIBECONF_CANARY_CELLS || '').split(',').map((s) => s.trim()).filter(Boolean);
const cellName = (c) => `${c.platform}/${c.host}`;

const SUMMARY_RE = /(?:PASS|FAIL) — (\d+) passed, (\d+) failed, (\d+) skipped/;

function runCell(cell, logFile) {
  return new Promise((resolve) => {
    const log = createWriteStream(logFile);
    const child = spawn('pnpm', [cell.script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const onData = (d) => {
      process.stdout.write(d);
      log.write(d);
      tail = (tail + d.toString()).slice(-4000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      log.end();
      const m = tail.match(SUMMARY_RE);
      const failedSteps = tail.split('\n').filter((l) => l.startsWith('❌')).map((l) => l.slice(0, 120)).slice(0, 4);
      resolve({
        exit: code,
        passed: m ? Number(m[1]) : null,
        failed: m ? Number(m[2]) : null,
        skipped: m ? Number(m[3]) : null,
        failedSteps,
      });
    });
  });
}

function sh(cmd, args) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', () => resolve(out.trim()));
  });
}

// Consecutive green nights, newest first. A night is green when at least one
// cell ran and every cell that ran passed; "not configured" cells don't count.
function streak(rows) {
  const nights = new Map(); // date -> { ran, failed }
  for (const r of rows) {
    const day = String(r.ts).slice(0, 10);
    const n = nights.get(day) || { ran: 0, failed: 0 };
    if (r.status === 'pass' || r.status === 'fail') n.ran++;
    if (r.status === 'fail') n.failed++;
    nights.set(day, n);
  }
  let count = 0;
  for (const day of [...nights.keys()].sort().reverse()) {
    const n = nights.get(day);
    if (!n.ran || n.failed) break;
    count++;
  }
  return count;
}

async function notify(text) {
  const chat = env.VIBECONF_CANARY_CHAT;
  if (!chat) { console.log('(no VIBECONF_CANARY_CHAT, summary not sent)'); return; }
  let token = '';
  try {
    const m = readFileSync(join(homedir(), '.claude/channels/telegram/.env'), 'utf8').match(/^TELEGRAM_BOT_TOKEN=(.*)$/m);
    token = m ? m[1].trim().replace(/^(['"])(.*)\1$/, '$2') : '';
  } catch { /* no token file */ }
  if (!token) { console.log('(no Telegram token, summary not sent)'); return; }
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
  } catch (e) { console.log('Telegram send failed:', e.message); }
}

async function main() {
  mkdirSync(RESULTS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const ts = new Date().toISOString();
  const sha = await sh('git', ['rev-parse', '--short', 'HEAD']);
  const rowsFile = join(RESULTS, 'conformance-results.jsonl');
  const tonight = [];

  for (const cell of CELLS) {
    const name = cellName(cell);
    if (only.length && !only.includes(name)) continue;
    const missing = (cell.needs || []).filter((k) => !env[k]);
    let row;
    if (missing.length) {
      row = { ts, sha, platform: cell.platform, host: cell.host, status: 'not-configured', note: `needs ${missing.join(', ')}` };
      console.log(`\n=== ${name}: not configured (${row.note}) ===`);
    } else {
      console.log(`\n=== ${name}: pnpm ${cell.script} ===`);
      const logFile = join(RESULTS, `conformance-${cell.platform}-${cell.host}-${stamp}.log`);
      const r = await runCell(cell, logFile);
      row = { ts, sha, platform: cell.platform, host: cell.host, status: r.exit === 0 ? 'pass' : 'fail',
        passed: r.passed, failed: r.failed, skipped: r.skipped, failedSteps: r.failedSteps, log: logFile };
    }
    appendFileSync(rowsFile, JSON.stringify(row) + '\n');
    tonight.push(row);
  }

  const all = readFileSync(rowsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const n = streak(all);
  const ICON = { pass: '✅', fail: '🔴', 'not-configured': '⚪️' };
  const lines = tonight.map((r) => {
    const counts = r.passed != null ? ` ${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped` : '';
    const why = r.status === 'not-configured' ? ' not configured' : '';
    return `${ICON[r.status]} ${r.platform}/${r.host}${counts}${why}` +
      (r.failedSteps && r.failedSteps.length ? '\n   ' + r.failedSteps.join('\n   ') : '');
  });
  const failed = tonight.filter((r) => r.status === 'fail').length;
  const head = `${failed ? '🔴' : '🟢'} calls conformance @ ${sha}: green streak ${n} of 14 nights`;
  const text = [head, ...lines].join('\n');
  console.log('\n' + text);
  await notify(text);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('conformance-matrix error:', e.message); process.exit(1); });
