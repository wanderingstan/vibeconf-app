#!/usr/bin/env node
/**
 * check-remote-log-shipping.mjs — does a COMPLETE log actually reach the server?
 *
 * #619 shipped the first few seconds of every session and then stopped, for
 * weeks, and nothing noticed: the pref read `true`, the app logged
 * `Remote logging ENABLED`, and no error was ever produced because no request
 * was ever attempted again. It cost three investigations (#417, the "first ~96
 * seconds of a 54-minute call" note in session-log.js, and 2026-08-31 when a
 * user's bug report turned out to have no log behind it).
 *
 * The fix is easy to write and easy to regress, and a unit test cannot see the
 * thing that matters — whether lines from a REAL session, over a REAL network,
 * from a REAL long-running app, are on the server at the end of the night.
 *
 * WHAT IT ACTUALLY CHECKS, and why it is shaped this way:
 *
 * The failure is never "no log at all" — it is "the beginning of the log". So a
 * check that only asks "is anything there?" passes happily against the exact bug
 * it exists to catch. This compares the NEWEST line on the server against the
 * NEWEST line on disk, and reports the LAG between them.
 *
 * That also separates the two failure modes that look identical from outside,
 * which is the thing that cost the most time on 2026-08-31:
 *
 *   nothing on the server at all     → not authorized / not enabled  (#440)
 *   early lines only, then a gap     → shipping stopped              (#619)
 *   newest line is recent            → healthy
 *
 * Usage:
 *   node scripts/check-remote-log-shipping.mjs [--profile Default] [--max-lag-sec 300] [--json]
 *
 * Auth, in order of preference:
 *   VIBECONF_LOGS_TOKEN      (x-vibe-logs-token header) — from the environment,
 *                            or ~/.claude/secrets/vibeconf-logs.env, because a
 *                            LaunchAgent inherits neither an interactive shell
 *                            nor that variable
 *
 * READS AND WRITES ARE AUTHORIZED SEPARATELY, which the fallback below does not
 * survive. Measured on the mini 2026-08-31, with a session valid until the next
 * day:
 *
 *     app's vc_session (jimmy@spiritprotocol.io)  ->  HTTP 401
 *     shared x-vibe-logs-token                    ->  HTTP 200
 *
 * The app's session is what the SHIPPER posts with; it is not a read credential.
 * On the first real nightly run this check therefore answered 'unauthorized' —
 * correctly refusing to guess, but answering nothing. Hence reading the token
 * from its file.
 *   the app's own vc_session (app-level config.json) — the SAME credential the
 *                            shipper uses, so a check that passes proves the
 *                            app's own path works, not merely that some path does
 *
 * Exit: 0 healthy · 1 shipping is broken · 2 could not check (records WHY —
 * a skipped check must never read as a passing one).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PROFILE = argOf('--profile', 'Default');
const MAX_LAG_SEC = Number(argOf('--max-lag-sec', '300'));
const AS_JSON = args.includes('--json');

const sanitize = (s) => String(s || '').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
const INSTANCE = `${sanitize(os.hostname().split('.')[0])}--${sanitize(PROFILE)}`;

function appSupportDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library/Application Support/Vibeconferencing');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || '', 'Vibeconferencing');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Vibeconferencing');
}

function done(status, verdict, detail, extra = {}) {
  const row = { ts: new Date().toISOString(), instance: INSTANCE, verdict, detail, ...extra };
  if (AS_JSON) console.log(JSON.stringify(row));
  else console.log(`${status === 0 ? '✅' : status === 1 ? '🔴' : '⚠️ '} remote-log ${verdict}: ${detail}`);
  process.exit(status);
}

// --- the local side: what the app believes it wrote -------------------------

const base = appSupportDir();
const logsDir = path.join(base, 'profiles', PROFILE, 'logs');
let localFile, localNewest = null, localLines = 0;
try {
  const files = fs.readdirSync(logsDir)
    .filter((f) => f.startsWith('session-') && f.endsWith('.log'))
    .map((f) => ({ f, m: fs.statSync(path.join(logsDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!files.length) done(2, 'no-local-log', `no session log in ${logsDir} — the app has never run for this profile`);
  localFile = path.join(logsDir, files[0].f);
} catch (e) {
  done(2, 'no-local-log', `cannot read ${logsDir}: ${e.message}`);
}

// The log's own filename carries the session start date; lines carry only
// HH:MM:SS, so the date has to come from the name to build a timestamp at all.
const dayMatch = path.basename(localFile).match(/session-(\d{4})-(\d{2})-(\d{2})T/);
if (!dayMatch) done(2, 'unparseable-log-name', `cannot get a date out of ${path.basename(localFile)}`);

const TIME_RE = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})/;
function stampsIn(text, [, Y, M, D]) {
  // A session can cross midnight; roll the date forward whenever the clock goes
  // backwards, or a 23:xx start would make every line after midnight look a day
  // stale and this check would cry wolf on exactly the longest sessions.
  const out = [];
  let day = new Date(Date.UTC(+Y, +M - 1, +D));
  let prev = -1;
  for (const line of text.split('\n')) {
    const m = TIME_RE.exec(line);
    if (!m) continue;
    const secs = (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000 + +m[4];
    if (prev >= 0 && secs < prev - 3600_000) day = new Date(day.getTime() + 86400_000);
    prev = secs;
    out.push(day.getTime() + secs);
  }
  return out;
}

try {
  const text = fs.readFileSync(localFile, 'utf8');
  localLines = text.split('\n').length;
  const st = stampsIn(text, dayMatch);
  localNewest = st.length ? st[st.length - 1] : null;
} catch (e) {
  done(2, 'unreadable-local-log', `${localFile}: ${e.message}`);
}
if (localNewest == null) done(2, 'no-timestamps', `no timestamped lines in ${path.basename(localFile)}`);

// --- is the app even asked to ship? -----------------------------------------

let remoteLogging = null, sessionToken = '';
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(base, 'config.json'), 'utf8'));
  remoteLogging = cfg.remoteLogging === true;
  sessionToken = cfg.vcSessionToken || '';
} catch { /* app-level config may not exist yet */ }
if (remoteLogging === false) {
  done(2, 'disabled', 'remoteLogging is not on for this machine — nothing to check', { remoteLogging: false });
}

// --- the server side --------------------------------------------------------

const WEBSITE = process.env.VIBECONF_WEBSITE_URL || 'https://vibeconferencing.com';
const headers = {};
// A LaunchAgent gets neither an interactive shell nor this variable, so read it
// from where it lives. NOT copied into the plist: that file is in the repo and
// this is a real credential.
function tokenFromSecretsFile() {
  try {
    const f = path.join(os.homedir(), '.claude/secrets/vibeconf-logs.env');
    const m = fs.readFileSync(f, 'utf8')
      .match(/^\s*(?:export\s+)?VIBECONF_LOGS_TOKEN\s*=\s*["']?([^"'\s]+)/m);
    return m ? m[1] : null;
  } catch { return null; }
}

const logsToken = process.env.VIBECONF_LOGS_TOKEN || tokenFromSecretsFile();
if (logsToken) headers['x-vibe-logs-token'] = logsToken;
else if (sessionToken) headers['Cookie'] = `vc_session=${sessionToken}`;
else done(2, 'no-credential', 'no VIBECONF_LOGS_TOKEN (env or ~/.claude/secrets/vibeconf-logs.env) and no app login');

let content = '';
try {
  const resp = await fetch(`${WEBSITE}/api/logs/${encodeURIComponent(INSTANCE)}?lines=20000`, { headers });
  if (resp.status === 401 || resp.status === 403) {
    done(2, 'unauthorized',
      `the logs API refused this credential (HTTP ${resp.status}) — cannot tell healthy from broken. `
      + (logsToken
        ? 'The shared logs token was rejected; it may have been rotated.'
        : "No shared logs token was found, so this fell back to the app's own session — a WRITE "
          + 'credential, which reads are refused with. Set VIBECONF_LOGS_TOKEN or populate '
          + '~/.claude/secrets/vibeconf-logs.env.'));
  }
  if (!resp.ok) done(2, 'api-error', `logs API returned HTTP ${resp.status}`);
  const body = await resp.json();
  content = body.content || '';
} catch (e) {
  done(2, 'api-unreachable', `${WEBSITE}: ${e.message}`);
}

// The server buffer holds MANY sessions — up to 20,000 lines, days of them —
// while the local log is one. stampsIn() rolls the date forward on every
// backwards clock jump, which is right within a session and accumulates a
// spurious day per midnight across a multi-day buffer.
//
// Observed: a server "newest" of 2026-09-01 against a local newest of
// 2026-08-31, i.e. a lag of MINUS 24 hours, reported as healthy — because a
// negative number passes a `> threshold` test without comment.
//
// Only the newest lines matter here, so parse only the tail: too short a window
// to contain a midnight, and the rollover cannot fire.
const serverTail = content ? content.split('\n').slice(-200).join('\n') : '';
const serverStamps = serverTail ? stampsIn(serverTail, dayMatch) : [];
const serverLines = content ? content.split('\n').filter(Boolean).length : 0;
const serverNewest = serverStamps.length ? Math.max(...serverStamps) : null;

const common = {
  serverLines, localLines,
  localNewest: new Date(localNewest).toISOString(),
  serverNewest: serverNewest ? new Date(serverNewest).toISOString() : null,
};

// Nothing at all. Almost always a credential problem (#440), and distinct from
// the stall this check is really hunting.
if (!serverLines) {
  done(1, 'nothing-shipped',
    `the server has NO lines for ${INSTANCE}, while the local log has ${localLines}. `
    + 'Enabled but not authorized (#440), or shipping never started.', common);
}

const lagSec = Math.round((localNewest - serverNewest) / 1000);

// A NEGATIVE lag means the server is ahead of the machine that wrote the lines,
// which cannot happen. Something is wrong with the comparison, not the shipping
// — and reporting "healthy" on data that cannot be true is worse than reporting
// nothing, because it is the answer nobody re-checks. A small negative is clock
// jitter between the app writing and the server stamping; a large one is not.
if (lagSec < -120) {
  done(2, 'not-comparable',
    `the server's newest line is ${-lagSec}s AHEAD of the local log's, which cannot happen. `
    + 'The two are being read on different clocks or different days — this check cannot say '
    + 'anything about shipping until that is understood.', { ...common, lagSec });
}

// THE #619 SIGNATURE: the server has the start of the session and then stops.
if (lagSec > MAX_LAG_SEC) {
  done(1, 'shipping-stalled',
    `the server's newest line is ${lagSec}s behind the local log's (${serverLines} lines there vs ${localLines} here). `
    + 'Shipping started and then stopped — the #619 signature. Check for [remote-log] lines in the local log: '
    + 'none at all means it stopped ATTEMPTING rather than being refused.',
    { ...common, lagSec });
}

done(0, 'healthy',
  `newest server line is ${lagSec}s behind local (${serverLines} lines on the server, ${localLines} locally)`,
  { ...common, lagSec });
