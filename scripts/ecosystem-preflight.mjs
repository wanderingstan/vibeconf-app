#!/usr/bin/env node
// ecosystem-preflight.mjs — before the suite runs, ask whether the world it
// depends on is standing up. Website, Redis, GitHub releases, the EC2 box, the
// vibeconferencing.com session, Claude Code auth, disk, and the notifier itself.
//
// WHY THIS EXISTS. On 2026-09-01 two whiteboard lanes went red. Finding out the
// product was fine and Upstash was not took a screenshot, a version-counter
// comparison across three runs, and a live API probe. Every bit of that was
// downstream of one fact — the whiteboard backend was 500ing — which a single
// HTTP request could have reported at the top of the digest.
//
// notify-nightly.mjs already makes this argument for the on-screen-dialog check,
// which it deliberately renders ABOVE the lane results: "if a dialog owned the
// screen, that reframes every red line below it, and reading it after the fact is
// how a night gets misdiagnosed as a product regression." A dead dependency
// reframes the night exactly the same way. This is that check, for the world
// outside the machine.
//
// IT DOES NOT ABORT THE RUN, on purpose. If Upstash is down, the DMG-meet, Slack,
// codex and displacement lanes still carry real signal about the app; killing the
// run throws that away and you learn less than you would have. The value is not
// skipping work, it is LABELLING it — "whiteboard lanes red, preflight says Redis
// is down, expected." Aborting would also hand one flaky 3am DNS lookup the power
// to eat a whole night, which is the failure the global watchdog comment already
// warns about. So: always exit 0, and let the digest carry the warning.
//
// Every check is something that has ACTUALLY caused a bad night in this repo's
// logs. That is the bar for adding one — a preflight that cries wolf gets
// ignored, and an ignored preflight is worse than none.
//
// Env:
//   VIBECONF_RESULTS_DIR   where to write preflight-results.jsonl
//   VIBECONF_PREFLIGHT_ROOM  canary room for the Redis read (default paz-sqoa-npe)
//   VIBECONF_TEST_INSTANCE   EC2 instance for the Linux lane (skipped if unset)
//   VIBECONF_AWS_PROFILE / VIBECONF_AWS_REGION   (default vibeconf-ta / us-east-2)
//   VIBECONF_DISK_MIN_GB   free-space floor before warning (default 15)
//   VIBECONF_TELEGRAM_ENV  bot token .env location
//   CLAUDE_BIN             claude binary override
//
// Usage: node scripts/ecosystem-preflight.mjs [--json]

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFileSync, execSync } from 'child_process';

const RESULTS = process.env.VIBECONF_RESULTS_DIR || join(homedir(), 'vibeconf-test-results');
const JSON_OUT = process.argv.includes('--json');
// The fixed fallback room. Chosen as the canary precisely BECAUSE it is permanent:
// a freshly minted room would 404 on a cold Redis and we could not tell "backend
// broken" from "room genuinely absent" — which is the whole distinction this check
// exists to draw.
const ROOM = process.env.VIBECONF_PREFLIGHT_ROOM || 'paz-sqoa-npe';
const DISK_MIN_GB = Number(process.env.VIBECONF_DISK_MIN_GB || 15);
const ENV_FILE = process.env.VIBECONF_TELEGRAM_ENV || join(homedir(), '.claude/channels/telegram/.env');
const AWS_PROFILE = process.env.VIBECONF_AWS_PROFILE || 'vibeconf-ta';
const AWS_REGION = process.env.VIBECONF_AWS_REGION || 'us-east-2';
const INSTANCE = process.env.VIBECONF_TEST_INSTANCE || '';

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const checks = [];
// status: 'ok' | 'down' | 'warn' | 'skip'. `warn` is for things that degrade the
// night without invalidating it (low disk); `down` is for a dependency the suite
// genuinely needs. Only `down` reframes the lanes below it.
const add = (name, status, detail) => checks.push({ name, status, detail: detail || '' });

function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 }).trim(); }
  catch { return ''; }
}
// One place that knows how to reach a URL, so a hung endpoint can never hold the
// preflight past its own budget — the point of this script is to be the fastest
// thing in the run.
async function http(url, { method = 'GET', headers = {}, timeoutMs = 12000 } = {}) {
  try {
    const r = await fetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    let body = '';
    try { body = (await r.text()).slice(0, 400); } catch { /* headers were enough */ }
    return { ok: true, status: r.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: '', error: e.message?.split('\n')[0] || String(e) };
  }
}

// The app's own config is the source of truth for which site to talk to and which
// session to present — read it the same way scheduled-meet-test.sh does rather
// than hardcoding, so a staging run preflights staging.
function vcConfig() {
  try {
    return JSON.parse(readFileSync(join(homedir(), 'Library/Application Support/Vibeconferencing/config.json'), 'utf8'));
  } catch { return {}; }
}
const CFG = vcConfig();
const SITE = (CFG.websiteUrl || 'https://vibeconferencing.com').replace(/\/$/, '');

// --- 1. the website itself ---------------------------------------------------
async function checkWebsite() {
  const r = await http(`${SITE}/`);
  if (!r.ok) return add('website', 'down', `${SITE} unreachable — ${r.error}`);
  add('website', r.status === 200 ? 'ok' : 'down', `${SITE} → HTTP ${r.status}`);
}

// --- 2. Redis / Upstash ------------------------------------------------------
// TWO requests, because one proves nothing. A real room's state read exercises
// Redis; an unknown room exercises only the Postgres room lookup that precedes it.
// The CONTRAST is the diagnosis: real=500 + unknown=404 means the registry is
// healthy and Redis specifically is not, which is the sentence that would have
// saved an hour on 2026-09-01. Both failing points at the site or the deploy.
async function checkRedis() {
  const real = await http(`${SITE}/api/sync/${ROOM}`);
  const ghost = await http(`${SITE}/api/sync/preflight-no-such-room-${Date.now()}`);
  if (!real.ok) return add('redis (whiteboard state)', 'down', `read of ${ROOM} failed — ${real.error}`);

  if (real.status >= 500) {
    const localized = ghost.status === 404
      ? 'room lookup (Postgres) answers 404 correctly, so REDIS specifically is the fault'
      : `unknown-room probe also returned ${ghost.status}, so this may be the site/deploy, not Redis alone`;
    return add('redis (whiteboard state)', 'down',
      `${SITE}/api/sync/${ROOM} → HTTP ${real.status} ${real.body.slice(0, 80)} — ${localized}`);
  }
  if (real.status === 404) {
    // Not a backend fault, but the canary is gone — say so, or a later "ok" is a lie.
    return add('redis (whiteboard state)', 'warn',
      `canary room ${ROOM} returned 404 — it may have been cleaned up; set VIBECONF_PREFLIGHT_ROOM to a live room`);
  }
  add('redis (whiteboard state)', real.status === 200 ? 'ok' : 'warn', `read of ${ROOM} → HTTP ${real.status}`);
}

// --- 3. the vibeconferencing.com session -------------------------------------
// The precondition for minting a fresh Meet room. When this session dies the
// live lanes silently fall back to the FIXED, publicly-joinable room and report
// GREEN against the wrong target — which happened three nights running in Aug
// 2026 and is worse than a red lane, because nothing looks wrong. The wrapper
// already checks this, but only AFTER the fallback, in the error path. Checking
// it up front is the difference between a warning and a post-mortem.
async function checkSession() {
  const token = CFG.vcSessionToken || '';
  if (!token) return add('vibeconferencing.com session', 'warn', 'no vcSessionToken in the app config — rooms cannot be minted');
  const r = await http(`${SITE}/api/auth/me`, { headers: { Cookie: `vc_session=${token}` } });
  if (!r.ok) return add('vibeconferencing.com session', 'warn', `could not reach /api/auth/me — ${r.error}`);
  if (r.body.includes('"authenticated":true')) return add('vibeconferencing.com session', 'ok', 'machine-wide session authenticates');
  if (r.body.includes('"authenticated":false')) {
    return add('vibeconferencing.com session', 'down',
      'SIGNED OUT — live lanes will fall back to the SHARED public room and report green against the wrong target. Sign in once in the app (the session is shared by every profile)');
  }
  add('vibeconferencing.com session', 'warn', `unexpected /api/auth/me response (HTTP ${r.status})`);
}

// --- 4. GitHub releases ------------------------------------------------------
// The nightly self-updates its DMG from the newest release. If this is
// unreachable the run does not fail — it quietly tests YESTERDAY's build while
// the digest reports a version it did not actually install.
async function checkReleases() {
  const r = await http('https://api.github.com/repos/wanderingstan/vibeconf-app/releases?per_page=1',
    { headers: { 'User-Agent': 'vibeconf-preflight', Accept: 'application/vnd.github+json' } });
  if (!r.ok) return add('github releases', 'down', `unreachable — ${r.error}`);
  if (r.status !== 200) return add('github releases', 'down', `HTTP ${r.status} — the DMG self-update will be skipped`);
  let tag = '';
  try { tag = (JSON.parse(r.body.length < 400 ? r.body : '[]')[0] || {}).tag_name || ''; } catch { /* body truncated */ }
  add('github releases', 'ok', tag ? `reachable, newest ${tag}` : 'reachable');
}

// --- 5. the EC2 box ----------------------------------------------------------
// Skipped rather than failed when unset: the Linux lane refuses to run without an
// instance, so a preflight that went red here would fire on every machine that
// simply does not run that lane.
function checkAws() {
  if (!INSTANCE) return add('aws box (linux lane)', 'skip', 'VIBECONF_TEST_INSTANCE unset — the Linux lane will not run');
  if (!sh('command -v aws')) return add('aws box (linux lane)', 'warn', 'awscli not installed on this runner');
  const env = `AWS_PROFILE=${AWS_PROFILE} AWS_REGION=${AWS_REGION}`;
  const state = sh(`${env} aws ec2 describe-instances --instance-ids ${INSTANCE} --query 'Reservations[0].Instances[0].State.Name' --output text`);
  if (!state || state === 'None') return add('aws box (linux lane)', 'down', `could not describe ${INSTANCE} (credentials or region?)`);

  // `stopped` is the box's NORMAL RESTING STATE — nightly-linux-lane.sh starts it
  // itself and stops it again when done, so it is stopped every hour of the day
  // except during its own lane. Reporting that as DOWN would fire every single
  // night, and a preflight that cries wolf gets ignored, which defeats the whole
  // point. What actually matters here is: do the credentials work, does the
  // instance still exist, and is it in a state the lane can start from.
  if (['terminated', 'shutting-down'].includes(state)) {
    return add('aws box (linux lane)', 'down', `${INSTANCE} is ${state} — the box is gone, the lane cannot run`);
  }
  if (state !== 'running') {
    // Deliberately no SSM probe: SSM is offline whenever the box is, so checking
    // it here would be a second guaranteed false positive stacked on the first.
    return add('aws box (linux lane)', 'ok', `${INSTANCE} is ${state} — normal between runs; the lane starts it`);
  }
  const ping = sh(`${env} aws ssm describe-instance-information --filters "Key=InstanceIds,Values=${INSTANCE}" --query 'InstanceInformationList[0].PingStatus' --output text`);
  if (ping !== 'Online') return add('aws box (linux lane)', 'warn', `${INSTANCE} running but SSM is ${ping || 'unreachable'} — if it stays this way the lane cannot send commands`);
  add('aws box (linux lane)', 'ok', `${INSTANCE} running, SSM Online`);
}

// --- 6. Claude Code auth -----------------------------------------------------
// #556: a bot joined a call perfectly and then sat mute, because its Claude
// session was logged out and nothing checked first. This is the pre-flight that
// issue asks for. Resolve the binary the same way the triage script does — the
// `claude` on PATH here is a shim inside cmux.app.
function checkClaudeAuth() {
  const bin = process.env.CLAUDE_BIN
    || [join(homedir(), '.local/bin/claude'), sh('command -v claude'), '/Applications/cmux.app/Contents/Resources/bin/claude']
      .filter(Boolean).find((c) => { try { statSync(c); return true; } catch { return false; } });
  if (!bin) return add('claude code auth', 'down', 'no claude binary found — nothing will drive the bots');
  let out = '';
  try {
    out = execFileSync(bin, ['auth', 'status'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { return add('claude code auth', 'warn', `could not run \`claude auth status\` — ${e.message?.split('\n')[0]}`); }
  try {
    const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
    if (j.loggedIn === true) return add('claude code auth', 'ok', `signed in (${j.authMethod || '?'}${j.subscriptionType ? ', ' + j.subscriptionType : ''})`);
    return add('claude code auth', 'down', 'SIGNED OUT — bots will join calls and then sit mute (#556)');
  } catch {
    // Unparseable is genuinely unknown, and #556's lesson is that "unknown" and
    // "logged out" are not the same answer. Warn, do not cry wolf.
    add('claude code auth', 'warn', 'could not parse `claude auth status` output');
  }
}

// --- 7. disk -----------------------------------------------------------------
// A failing lane keeps a 144-256MB .mov plus call recordings. Running out of
// space costs the recordings AND the stills — i.e. exactly the evidence needed
// to work out why the night went red.
function checkDisk() {
  const line = sh("df -g / | tail -1");
  const free = Number((line.match(/\s(\d+)\s+\d+%/) || [])[1] ?? (line.split(/\s+/)[3]));
  if (!Number.isFinite(free)) return add('disk space', 'warn', `could not parse df output: ${line.slice(0, 60)}`);
  if (free < DISK_MIN_GB) return add('disk space', 'warn', `${free}GB free, below the ${DISK_MIN_GB}GB floor — recordings and stills may be lost`);
  add('disk space', 'ok', `${free}GB free`);
}

// --- 8. the notifier itself --------------------------------------------------
// Self-referential and worth it: if the bot token is dead, a catastrophic night
// and a night that never ran look identical from the outside. Silent failure of
// the failure-reporter is the one bug that hides all the others.
async function checkTelegram() {
  let tok = null;
  try { tok = (readFileSync(ENV_FILE, 'utf8').match(/^TELEGRAM_BOT_TOKEN=(.+)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, '') || null; } catch { /* below */ }
  if (!tok) return add('telegram notifier', 'warn', `no bot token at ${ENV_FILE} — the digest will not send`);
  const r = await http(`https://api.telegram.org/bot${tok}/getMe`);
  if (!r.ok) return add('telegram notifier', 'warn', `Telegram unreachable — ${r.error}`);
  add('telegram notifier', r.status === 200 ? 'ok' : 'warn',
    r.status === 200 ? 'bot token valid' : `getMe → HTTP ${r.status}; the digest will not send`);
}

// --- run ---------------------------------------------------------------------
// Network checks concurrently (they are independent and the whole point is to be
// quick); local checks are cheap and synchronous.
await Promise.all([checkWebsite(), checkRedis(), checkSession(), checkReleases(), checkTelegram()]);
checkAws();
checkClaudeAuth();
checkDisk();

const down = checks.filter((c) => c.status === 'down');
const warn = checks.filter((c) => c.status === 'warn');
const healthy = down.length === 0;

const result = {
  ts: stamp,
  ok: healthy,
  // `exit` mirrors every other lane's result shape so the digest and the triage
  // survey can read this file with the same code path as the rest.
  exit: healthy ? 0 : 1,
  down: down.map((c) => c.name),
  warn: warn.map((c) => c.name),
  // The single sentence that reframes the lanes below it in the digest.
  note: down.length
    ? `${down.map((c) => c.name).join(', ')} DOWN — lane failures below may be consequences, not regressions`
    : (warn.length ? `${warn.map((c) => c.name).join(', ')} degraded` : 'all dependencies healthy'),
  checks,
};

if (JSON_OUT) { console.log(JSON.stringify(result, null, 2)); process.exit(0); }

const ICON = { ok: '✅', down: '🔴', warn: '⚠️ ', skip: '⚪️' };
console.log(healthy ? '✅ ecosystem preflight: all dependencies healthy' : `🔴 ecosystem preflight: ${down.length} dependency(ies) DOWN`);
for (const c of checks) console.log(`  ${ICON[c.status]} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
if (down.length) {
  console.log('');
  console.log('  ⚠️  Lane failures in this run may be CONSEQUENCES of the above, not product regressions.');
}

try {
  mkdirSync(RESULTS, { recursive: true });
  appendFileSync(join(RESULTS, 'preflight-results.jsonl'), JSON.stringify(result) + '\n');
  writeFileSync(join(RESULTS, 'preflight-latest.json'), JSON.stringify(result, null, 2));
} catch (e) {
  console.log(`  (could not write results: ${e.message})`);
}

// ALWAYS 0 — see the header. This annotates the night, it does not decide it.
process.exit(0);
