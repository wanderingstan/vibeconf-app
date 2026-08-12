#!/usr/bin/env node
// nightly-call-digest.mjs — a nightly summary of real user calls, built from
// the local archive that scripts/archive-logs.mjs (vibeconferencing repo)
// keeps continuously fed from the server's log ring buffer (48h TTL — the
// archive is the only durable copy). Meant to run once a night on the Mac
// mini, after archive-logs.mjs has had a chance to accumulate the day's
// lines; see scripts/scheduled-meet-test.sh for how it's wired in.
//
// What "real user" means here: only instances running the "Default" profile
// count. Every real-world instance seen so far — including Stan's own laptop
// running a demo call — uses Default; every dev/test instance, automated
// fleet or Stan's own one-off manual testing alike, uses some other named
// profile (test-meet-*, tsdemo, corstest, …). This started as a host-based
// exclusion (assume Stan's own machines are never real) but that wrongly
// dropped a real demo call he ran from his own laptop — profile is the
// signal that actually holds up against the data. See REAL_USER_PROFILE.
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
//   VIBECONF_NOTIFY_CHAT     Telegram chat id (default: shared group, matches
//                            notify-nightly.mjs)
//   VIBECONF_TELEGRAM_ENV    override the bot-token .env location
//   VIBECONF_DISK_WARN_PCT   warn if disk use% >= this (default 80)
//   VIBECONF_SESSION_ENV     the vc_session credential archive-logs.mjs uses
//                            (default: ~/.claude/secrets/vibeconf-admin-session.env)
//   VIBECONF_AUTH_WARN_DAYS  warn when the session JWT expires within this
//                            many days (default 7)
//   VIBECONF_MIN_CALL_MINUTES  minimum call length to count (default 5) —
//                            filters out drive-bys and failed joins

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
const CHAT = process.env.VIBECONF_NOTIFY_CHAT || '-5140242529'; // shared group, matches notify-nightly.mjs
const ENV_FILE = process.env.VIBECONF_TELEGRAM_ENV || path.join(homedir(), '.claude/channels/telegram/.env');
const DISK_WARN_PCT = Number(process.env.VIBECONF_DISK_WARN_PCT || 80);
const SESSION_ENV_FILE = process.env.VIBECONF_SESSION_ENV
  || path.join(homedir(), '.claude/secrets/vibeconf-admin-session.env');
const AUTH_WARN_DAYS = Number(process.env.VIBECONF_AUTH_WARN_DAYS || 7);
const MIN_CALL_SECONDS = Number(process.env.VIBECONF_MIN_CALL_MINUTES || 5) * 60;

// Heuristic real-user filter — see module comment. Case-insensitive.
const REAL_USER_PROFILE = 'default';

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
  const { profile } = parseInstanceId(filename);
  return profile.toLowerCase() === REAL_USER_PROFILE;
}

function listRealUserLogFiles() {
  if (!fs.existsSync(ARCHIVE_DIR)) return [];
  return fs.readdirSync(ARCHIVE_DIR)
    .filter((f) => f.endsWith('.log'))
    .filter(isRealUserInstance)
    .map((f) => path.join(ARCHIVE_DIR, f));
}

// --- call counting ------------------------------------------------------

// `HH:MM:SS.mmm [call] id=<id> room=<room> status=<status> started=<iso>` —
// every console.log line gets an auto HH:MM:SS.mmm prefix (see the
// installTimestampedConsole wrapper in local-server.js/main.js), including
// this one, despite the call site not passing ts() itself. `started=` is an
// absolute UTC timestamp (this.callStartedAt = new Date().toISOString()),
// constant across every status-transition line for the same call id.
const TS_RE = /^(\d{2}:\d{2}:\d{2})\.\d{3}\s/;
const CALL_RE = /^(\d{2}:\d{2}:\d{2})\.\d{3}\s.*\[call\] id=(\S+) room=(\S+) status=(\S+) started=(\S+)/;

// A call can log [call] more than once as its status changes (joining →
// navigating → …), always with the same `started=`. This resolves each
// call id to its FIRST-seen line (call start) and an approximate end: the
// next call's start in the same file, or the file's last timestamp if it's
// the last call — a single Electron instance is only ever in one room at a
// time, so "the next call started" is a reasonable proxy for "this one
// ended." Same-day only (no cross-midnight arithmetic) — acceptable for a
// nightly digest; a call spanning midnight would just look short on one
// side, not silently miscounted as two different days.
function localDateOf(isoTimestamp) {
  const d = new Date(isoTimestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function hmsToSeconds(hms) {
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

function countCallsForDate(files, date, minSeconds) {
  const seen = new Map(); // callId -> { startSec, dropped }
  const perFile = new Map();
  const shortCallsSkipped = [];
  for (const f of files) {
    let lines;
    try { lines = fs.readFileSync(f, 'utf-8').split('\n'); } catch { continue; }

    // Last timestamp seen on ANY line (not just [call] lines) — the file's
    // true end-of-activity boundary, used to bound the LAST call in the file.
    // Tracking this only on [call] lines was the bug in the first cut: a call
    // with just one status transition ever logged became its own end too,
    // computing duration 0 regardless of how long the call actually ran.
    let lastSeconds = null;
    const callsInFile = []; // { id, startSec }, in file order (first occurrence only)
    const idsSeenInFile = new Set();
    for (const line of lines) {
      const tsMatch = TS_RE.exec(line);
      if (tsMatch) lastSeconds = hmsToSeconds(tsMatch[1]);

      const m = CALL_RE.exec(line);
      if (!m) continue;
      const [, hms, id, , , started] = m;
      if (idsSeenInFile.has(id)) continue; // only the first status transition marks "start"
      idsSeenInFile.add(id);
      if (localDateOf(started) !== date) continue; // not today's target date — still tracked above for lastSeconds, just not counted
      callsInFile.push({ id, startSec: hmsToSeconds(hms) });
    }

    let fileCount = 0;
    for (let i = 0; i < callsInFile.length; i++) {
      const { id, startSec } = callsInFile[i];
      const endSec = i + 1 < callsInFile.length ? callsInFile[i + 1].startSec : lastSeconds;
      const durationSec = (endSec ?? startSec) - startSec;
      if (durationSec < minSeconds) { shortCallsSkipped.push({ id, file: path.basename(f), durationSec }); continue; }
      if (seen.has(id)) continue; // same call id shipped from >1 instance — dedupe globally
      seen.set(id, { durationSec });
      fileCount++;
    }
    if (fileCount) perFile.set(path.basename(f), fileCount);
  }
  return { total: seen.size, perFile, shortCallsSkipped };
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

// latency-audit.py's table is formatted for a wide terminal (44-char leg
// names + 6 fixed-width numeric columns) — it wraps into an unreadable mess
// in Telegram's narrow message column (see the screenshot that prompted
// this). Pull just the headline legs out of that fixed-width table and
// re-render them as short vertical lines instead of reimplementing the audit.
//
// Row format from latency-audit.py's print: `{name:44s} {n:4d} {avg:7.0f}
// {med:7.0f} {p90:7.0f} {min:6.0f} {max:7.0f}` — fixed column offsets, so a
// straight substring slice is more robust here than a whitespace split (leg
// names contain spaces and arrows).
function parseLatencyRow(line) {
  if (line.length < 88) return null; // shorter = a "—" (no data) row or non-data line
  const name = line.slice(0, 44).trim();
  const n = parseInt(line.slice(45, 49), 10);
  const avg = parseFloat(line.slice(50, 57));
  const med = parseFloat(line.slice(58, 65));
  const p90 = parseFloat(line.slice(66, 73));
  if (!name || !Number.isFinite(n) || !Number.isFinite(avg)) return null;
  return { name, n, avg, med, p90 };
}

const HEADLINE_LEGS = [
  { match: 'TOTAL stop→audio sent', label: '📊 Total stop→audio' },
  { match: 'D claude (resolve→first speak)', label: '🧠 Claude think time' },
  { match: 'TOTAL ours (minus claude)', label: '⚙️ Client-side (ours)' },
];

function formatCompactLatency(rawTable) {
  if (!rawTable) return null;
  const rows = rawTable.split('\n').map(parseLatencyRow).filter(Boolean);
  const lines = [];
  for (const { match, label } of HEADLINE_LEGS) {
    const row = rows.find((r) => r.name === match);
    if (!row) continue;
    lines.push(`${label}: ${(row.avg / 1000).toFixed(1)}s avg / ${(row.p90 / 1000).toFixed(1)}s p90 (n=${row.n})`);
  }
  return lines.length ? lines.join('\n') : null;
}

// --- auth expiry (the vc_session cookie archive-logs.mjs runs on) ---------

// Reads the exp claim straight out of the JWT — no signature check needed,
// we're not authenticating anything here, just reading our own stored value's
// expiry. archive-logs.mjs is what actually authenticates with it.
function decodeJwtExp(jwt) {
  try {
    const payload = jwt.split('.')[1];
    const json = Buffer.from(payload, 'base64url').toString('utf-8');
    const { exp } = JSON.parse(json);
    return typeof exp === 'number' ? exp : null;
  } catch { return null; }
}

function authStatus() {
  let raw;
  try { raw = fs.readFileSync(SESSION_ENV_FILE, 'utf-8'); }
  catch { return { missing: true }; }
  const m = raw.match(/^VIBECONF_VC_SESSION=(.+)$/m);
  if (!m) return { missing: true };
  const exp = decodeJwtExp(m[1].trim());
  if (exp == null) return { unparseable: true };
  const daysLeft = (exp * 1000 - Date.now()) / 86_400_000;
  return { daysLeft, expiresAt: new Date(exp * 1000).toISOString().slice(0, 10), warn: daysLeft <= AUTH_WARN_DAYS };
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

  const { total: callCount, perFile: callsPerFile, shortCallsSkipped } = countCallsForDate(realFiles, targetDate, MIN_CALL_SECONDS);
  const activeInstances = [...callsPerFile.keys()];

  const latencyReport = runLatencyAudit(realFiles);
  const compactLatency = formatCompactLatency(latencyReport);
  const disk = diskStatus();
  const auth = authStatus();

  const summary = {
    date: targetDate,
    generatedAt: new Date().toISOString(),
    archiveDir: ARCHIVE_DIR,
    instancesInArchive: allFiles.length,
    instancesExcluded: excludedCount,
    instancesWithCallsToday: activeInstances.length,
    callCount,
    callsPerInstance: Object.fromEntries(callsPerFile),
    minCallMinutes: MIN_CALL_SECONDS / 60,
    shortCallsSkipped,
    disk,
    auth,
  };

  fs.mkdirSync(path.join(DIGEST_DIR, targetDate), { recursive: true });
  fs.writeFileSync(path.join(DIGEST_DIR, targetDate, 'summary.json'), JSON.stringify(summary, null, 2));
  if (latencyReport) fs.writeFileSync(path.join(DIGEST_DIR, targetDate, 'latency-audit.txt'), latencyReport);

  const lines = [];
  lines.push(`<b>Vibeconferencing nightly call digest — ${targetDate}</b>`);
  lines.push(`${callCount} call${callCount === 1 ? '' : 's'} ≥${MIN_CALL_SECONDS / 60}min across ${activeInstances.length} instance${activeInstances.length === 1 ? '' : 's'} (${realFiles.length} real-user instances in archive, ${excludedCount} test/dev excluded${shortCallsSkipped.length ? `, ${shortCallsSkipped.length} shorter call${shortCallsSkipped.length === 1 ? '' : 's'} filtered out` : ''})`);
  if (disk.error) {
    lines.push(`\n⚠️ Disk check failed: ${disk.error}`);
  } else {
    const flag = disk.warn ? '⚠️ ' : '';
    lines.push(`${flag}Disk: ${disk.used} used / ${disk.size} (${disk.pct}%), ${disk.avail} free`);
    if (disk.warn) lines.push(`<i>Above the ${DISK_WARN_PCT}% warning threshold — logs-archive/ and the Redis-shipped buffers are the fastest-growing consumer here.</i>`);
  }
  if (callCount === 0) {
    lines.push(`\n(no real-user calls found for ${targetDate} — check summary.json if this is unexpected)`);
  } else if (compactLatency) {
    lines.push(`\n${compactLatency}`);
  }
  // Auth-expiry reminder — the vc_session cookie archive-logs.mjs runs on is a
  // 30-day JWT borrowed from Stan's own login, not a durable service credential
  // (LOGS_TOKEN would be that, but it's been 401ing server-side — see #). Once
  // this expires, archiving silently stops until someone notices and refreshes
  // it by hand, so nag ahead of that rather than after logs go quiet.
  if (auth.missing) {
    lines.push(`\n⚠️ <b>No vc_session credential found</b> at ${SESSION_ENV_FILE} — archive-logs.mjs can't authenticate. Also worth fixing LOGS_TOKEN server-side so this doesn't depend on a personal login at all.`);
  } else if (auth.unparseable) {
    lines.push(`\n⚠️ vc_session credential is present but its JWT didn't parse — check ${SESSION_ENV_FILE}.`);
  } else if (auth.warn) {
    const already = auth.daysLeft <= 0;
    lines.push(`\n⚠️ <b>${already ? 'vc_session has expired' : `vc_session expires in ${Math.floor(auth.daysLeft)}d (${auth.expiresAt})`}</b> — archiving ${already ? 'has stopped' : 'will stop'} until it's refreshed (browser devtools → vc_session cookie → paste into ${SESSION_ENV_FILE}). Also: get LOGS_TOKEN working server-side so this doesn't keep depending on a personal login expiring under us.`);
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
