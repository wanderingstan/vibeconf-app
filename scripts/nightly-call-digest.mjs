#!/usr/bin/env node
// nightly-call-digest.mjs — a nightly summary of real user calls, built from
// the local archive that scripts/archive-logs.mjs (vibeconferencing repo)
// keeps continuously fed from the server's log ring buffer (48h TTL — the
// archive is the only durable copy). Meant to run once a night on the Mac
// mini, after archive-logs.mjs has had a chance to accumulate the day's
// lines; see scripts/scheduled-meet-test.sh for how it's wired in.
//
// What "real user" means here: every instance that has ever shipped logs
// shows up in the archive, including the automated test fleet and Stan's own
// ad-hoc dev-testing profiles. Excluded from the digest (see EXCLUDE_* below):
//   - profiles the fleet always uses (test-meet-*, test-slack-*, …)
//   - hosts that are Stan's own dev machines, not a real user's
// This is a heuristic, not a ground truth — tune the lists below as new
// dev/test patterns show up in real data.
//
// Usage:
//   node scripts/nightly-call-digest.mjs                 # yesterday (local date)
//   node scripts/nightly-call-digest.mjs --date 2026-08-03
//   node scripts/nightly-call-digest.mjs --dry-run        # compose, don't send
//
// Env (mirrors notify-nightly.mjs's flags):
//   VIBECONF_ARCHIVE_DIR     archive dir (default: ../vibeconferencing/logs-archive
//                            relative to this repo, i.e. the sibling checkout)
//   VIBECONF_DIGEST_DIR      where to write summary.json + digest.txt
//                            (default: ~/vibeconf-call-digests)
//   VIBECONF_NOTIFY=0        disable Telegram entirely (still computes + writes)
//   VIBECONF_NOTIFY_DRYRUN=1 same as --dry-run
//   VIBECONF_NOTIFY_CHAT     Telegram chat id (default: Stan's DM, matches
//                            notify-nightly.mjs)
//   VIBECONF_TELEGRAM_ENV    override the bot-token .env location
//   VIBECONF_DISK_WARN_PCT   warn if disk use% >= this (default 80)

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

const args = process.argv.slice(2);
const opt = (flags, def = null) => {
  for (const f of flags) { const i = args.indexOf(f); if (i !== -1) return args[i + 1] ?? true; }
  return def;
};
const has = (flags) => flags.some((f) => args.includes(f));
const DRY_RUN = has(['--dry-run']) || process.env.VIBECONF_NOTIFY_DRYRUN === '1';
const NOTIFY_DISABLED = process.env.VIBECONF_NOTIFY === '0';

// --- config -----------------------------------------------------------------

const ARCHIVE_DIR = path.resolve(
  process.env.VIBECONF_ARCHIVE_DIR || path.join(REPO_ROOT, '..', 'vibeconferencing', 'logs-archive')
);
const DIGEST_DIR = path.resolve(process.env.VIBECONF_DIGEST_DIR || path.join(homedir(), 'vibeconf-call-digests'));
const CHAT = process.env.VIBECONF_NOTIFY_CHAT || '6785998012'; // Stan's DM, matches notify-nightly.mjs
const ENV_FILE = process.env.VIBECONF_TELEGRAM_ENV || path.join(homedir(), '.claude/channels/telegram/.env');
const DISK_WARN_PCT = Number(process.env.VIBECONF_DISK_WARN_PCT || 80);

// Heuristic real-user filter — see module comment. Case-insensitive.
const EXCLUDE_PROFILE_PREFIX = /^test-/i;
const EXCLUDE_HOSTS = new Set(['stans-macbook-pro', 'stans-mac-mini', 'mac', 'smoketest']);

// The date this digest covers: --date, or "yesterday" in local time (this
// runs at 3am, so "yesterday" is the day that just fully completed).
const targetDate = opt(['--date'], null) || (() => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
})();

// --- instance filtering -------------------------------------------------

// Archive filenames are `safeName(instanceId)` from archive-logs.mjs:
// non-alnum/._- collapsed to `_`. instanceId itself is `${host}--${profile}`.
// We don't have the original registry meta here (that's server-side and
// gone after 48h) — so recover host/profile straight from the filename.
function parseInstanceId(filename) {
  const id = filename.replace(/\.log$/, '');
  const sepIdx = id.indexOf('--');
  if (sepIdx === -1) return { host: id, profile: '' };
  return { host: id.slice(0, sepIdx), profile: id.slice(sepIdx + 2) };
}

function isRealUserInstance(filename) {
  const { host, profile } = parseInstanceId(filename);
  if (EXCLUDE_PROFILE_PREFIX.test(profile)) return false;
  if (EXCLUDE_HOSTS.has(host.toLowerCase())) return false;
  return true;
}

function listRealUserLogFiles() {
  if (!fs.existsSync(ARCHIVE_DIR)) return [];
  return fs.readdirSync(ARCHIVE_DIR)
    .filter((f) => f.endsWith('.log'))
    .filter(isRealUserInstance)
    .map((f) => path.join(ARCHIVE_DIR, f));
}

// --- call counting ------------------------------------------------------

// `[call] id=<id> room=<room> status=<status> started=<iso>` — no timestamp
// prefix on this line (unlike most), but it carries its own absolute ISO
// timestamp, so no relative-time reconstruction is needed to bucket by day.
const CALL_RE = /\[call\] id=(\S+) room=(\S+) status=(\S+) started=(\S+)/g;

function countCallsForDate(files, date) {
  const seen = new Set(); // dedupe by call id (a call can log [call] more than once as status changes)
  const perFile = new Map();
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf-8'); } catch { continue; }
    let m;
    CALL_RE.lastIndex = 0;
    let fileCount = 0;
    while ((m = CALL_RE.exec(text))) {
      const [, id, , , started] = m;
      if (!started.startsWith(date)) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      fileCount++;
    }
    if (fileCount) perFile.set(path.basename(f), fileCount);
  }
  return { total: seen.size, perFile };
}

// --- latency (reuses scripts/latency-audit.py directly on the archive) -----

function runLatencyAudit(files) {
  if (!files.length) return null;
  try {
    return execFileSync('python3', [path.join(__dirname, 'latency-audit.py'), ...files], {
      encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    return `(latency-audit.py failed: ${e.message})`;
  }
}

// --- disk space -----------------------------------------------------------

function diskStatus() {
  try {
    const out = execSync(`df -h "${homedir()}"`, { encoding: 'utf-8' });
    const line = out.trim().split('\n')[1];
    const cols = line.trim().split(/\s+/);
    // Filesystem Size Used Avail Capacity iused ifree %iused Mounted-on
    const [, size, used, avail, capacity] = cols;
    const pct = parseInt(capacity, 10);
    return { size, used, avail, pct, warn: Number.isFinite(pct) && pct >= DISK_WARN_PCT };
  } catch (e) {
    return { error: e.message };
  }
}

// --- telegram (raw Bot API — this runs outside any Claude session) --------

function botToken() {
  try {
    const m = fs.readFileSync(ENV_FILE, 'utf-8').match(/^TELEGRAM_BOT_TOKEN=(.+)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch { return null; }
}

async function sendTelegram(text) {
  const token = botToken();
  if (!token) { console.error('[nightly-call-digest] no Telegram bot token found, skipping send'); return; }
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML' }),
  });
  if (!resp.ok) console.error('[nightly-call-digest] Telegram send failed:', resp.status, await resp.text());
}

// --- main -------------------------------------------------------------

async function main() {
  const allFiles = fs.existsSync(ARCHIVE_DIR)
    ? fs.readdirSync(ARCHIVE_DIR).filter((f) => f.endsWith('.log'))
    : [];
  const realFiles = listRealUserLogFiles();
  const excludedCount = allFiles.length - realFiles.length;

  const { total: callCount, perFile: callsPerFile } = countCallsForDate(realFiles, targetDate);
  const activeInstances = [...callsPerFile.keys()];

  const latencyReport = runLatencyAudit(realFiles);
  const disk = diskStatus();

  const summary = {
    date: targetDate,
    generatedAt: new Date().toISOString(),
    archiveDir: ARCHIVE_DIR,
    instancesInArchive: allFiles.length,
    instancesExcluded: excludedCount,
    instancesWithCallsToday: activeInstances.length,
    callCount,
    callsPerInstance: Object.fromEntries(callsPerFile),
    disk,
  };

  fs.mkdirSync(path.join(DIGEST_DIR, targetDate), { recursive: true });
  fs.writeFileSync(path.join(DIGEST_DIR, targetDate, 'summary.json'), JSON.stringify(summary, null, 2));
  if (latencyReport) fs.writeFileSync(path.join(DIGEST_DIR, targetDate, 'latency-audit.txt'), latencyReport);

  const lines = [];
  lines.push(`<b>Vibeconferencing nightly call digest — ${targetDate}</b>`);
  lines.push(`${callCount} call${callCount === 1 ? '' : 's'} across ${activeInstances.length} instance${activeInstances.length === 1 ? '' : 's'} (${realFiles.length} real-user instances in archive, ${excludedCount} test/dev excluded)`);
  if (disk.error) {
    lines.push(`\n⚠️ Disk check failed: ${disk.error}`);
  } else {
    const flag = disk.warn ? '⚠️ ' : '';
    lines.push(`${flag}Disk: ${disk.used} used / ${disk.size} (${disk.pct}%), ${disk.avail} free`);
    if (disk.warn) lines.push(`<i>Above the ${DISK_WARN_PCT}% warning threshold — logs-archive/ and the Redis-shipped buffers are the fastest-growing consumer here.</i>`);
  }
  if (callCount === 0) {
    lines.push(`\n(no real-user calls found for ${targetDate} — check summary.json if this is unexpected)`);
  } else if (latencyReport) {
    lines.push(`\n<pre>${latencyReport.trim().slice(0, 3200)}</pre>`);
  }
  const digestText = lines.join('\n');
  fs.writeFileSync(path.join(DIGEST_DIR, targetDate, 'digest.txt'), digestText.replace(/<\/?[^>]+>/g, ''));

  console.log(digestText.replace(/<\/?[^>]+>/g, ''));
  console.log(`\nWrote ${path.join(DIGEST_DIR, targetDate)}`);

  if (NOTIFY_DISABLED) console.log('[nightly-call-digest] VIBECONF_NOTIFY=0, not sending');
  else if (!DRY_RUN) await sendTelegram(digestText);
  else console.log('[nightly-call-digest] dry-run, not sending');
}

main().catch((e) => { console.error('[nightly-call-digest] fatal:', e); process.exitCode = 1; });
