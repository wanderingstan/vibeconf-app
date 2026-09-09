#!/usr/bin/env node
// fleet-lock.mjs — one holder at a time for the shared test fleet (#720).
//
// The test profiles and their ports are a SINGLE machine-wide resource. Two
// things reach for them independently: the 03:00 nightly, and the app-health
// smoke that the self-hosted runner starts on every push to main. Both run
// `spawn-test-fleet.sh`, which means the same test-meet-guest-1 profile on the
// same port 7901 — so a push landing during the nightly does not merely share a
// port, it rewrites that profile's prefs and resets its CLAUDE.md mid-run.
//
// GitHub's own `concurrency:` cannot help: it only sees other workflow runs, not
// a launchd job on the same box.
//
// Contract:
//   acquire <owner> --pid <pid> [--wait <seconds>]   0 = held, 75 = timed out
//   release <owner> --pid <pid>                      never fails
//   status                                           prints the holder, if any
//
// --pid is the PID that will OUTLIVE this process — the calling shell's $$ —
// because this helper exits immediately and a lock owned by a dead pid is
// exactly what stale detection looks for. Acquire and release must therefore
// happen in the SAME shell.
//
// Two independent staleness rules, because the failure that matters most here is
// a lock nobody will ever release: the nightly's own watchdog SIGKILLs a wedged
// run, and the CI runner can be cancelled mid-step (cancel-in-progress). Either
// leaves the file behind, and a lock that outlives its owner would silently
// cancel every future night — a far worse outcome than the collision it exists
// to prevent. So: a holder whose pid is gone is stale immediately, and ANY
// holder older than the max age is stale regardless of pid (guards pid reuse and
// a genuinely hung holder).
import { openSync, writeSync, closeSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';

const LOCK = process.env.VIBECONF_FLEET_LOCK || '/tmp/vibeconf-fleet.lock';
// Deliberately NOT TMPDIR: macOS gives processes a private per-user TMPDIR, and
// a launchd job and the Actions runner would then take two different "shared"
// locks and never see each other. A fixed path is the whole point.
const MAX_AGE_MS = Number(process.env.VIBECONF_FLEET_LOCK_MAX_AGE_MS || 2 * 60 * 60 * 1000);
const POLL_MS = 5000;

const argv = process.argv.slice(2);
const cmd = argv[0];
const owner = argv[1] && !argv[1].startsWith('--') ? argv[1] : '';
const flag = (name, def = '') => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
};
const pid = Number(flag('pid', String(process.ppid)));
const waitSec = Number(flag('wait', '0'));

const readHolder = () => {
  try { return JSON.parse(readFileSync(LOCK, 'utf8')); } catch { return null; }
};
const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };

// Why a holder can be ignored — returns a reason string, or '' if it is valid.
function staleReason(h) {
  if (!h || !h.pid) return 'unreadable lock file';
  if (!alive(h.pid)) return `holder pid ${h.pid} is gone`;
  const age = Date.now() - Date.parse(h.startedAt || 0);
  if (Number.isFinite(age) && age > MAX_AGE_MS) {
    return `holder pid ${h.pid} has held it for ${Math.round(age / 60000)}m (max ${Math.round(MAX_AGE_MS / 60000)}m)`;
  }
  return '';
}

function tryTake() {
  try {
    const fd = openSync(LOCK, 'wx');           // O_CREAT|O_EXCL — atomic
    writeSync(fd, JSON.stringify({ owner, pid, host: hostname(), startedAt: new Date().toISOString() }, null, 2) + '\n');
    closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const h = readHolder();
    const why = staleReason(h);
    if (!why) return false;
    console.error(`[fleet-lock] breaking stale lock (${why})`);
    try { unlinkSync(LOCK); } catch { /* someone else got there first */ }
    return tryTake();
  }
}

if (cmd === 'status') {
  const h = readHolder();
  if (!h) { console.log('fleet lock: free'); process.exit(0); }
  const why = staleReason(h);
  console.log(`fleet lock: held by ${h.owner} (pid ${h.pid}, since ${h.startedAt})${why ? ` — STALE: ${why}` : ''}`);
  process.exit(0);
}

if (!owner) { console.error('usage: fleet-lock.mjs acquire|release <owner> --pid <pid> [--wait <seconds>]'); process.exit(2); }

if (cmd === 'release') {
  const h = readHolder();
  // Only the owner may release. Releasing someone else's lock would hand the
  // fleet to a third party while its real user is mid-run.
  if (h && h.pid === pid) { try { unlinkSync(LOCK); } catch { /* already gone */ } console.error(`[fleet-lock] released by ${owner}`); }
  else if (h) console.error(`[fleet-lock] not releasing: held by ${h.owner} (pid ${h.pid}), not us (pid ${pid})`);
  process.exit(0);
}

if (cmd !== 'acquire') { console.error(`unknown command: ${cmd}`); process.exit(2); }

const deadline = Date.now() + waitSec * 1000;
let announced = false;
while (true) {
  if (tryTake()) { console.error(`[fleet-lock] acquired by ${owner} (pid ${pid})`); process.exit(0); }
  const h = readHolder();
  if (!announced) {
    console.error(`[fleet-lock] held by ${h?.owner || '?'} (pid ${h?.pid}) since ${h?.startedAt}`
      + (waitSec > 0 ? ` — waiting up to ${waitSec}s` : ''));
    announced = true;
  }
  if (Date.now() >= deadline) {
    console.error(`[fleet-lock] TIMED OUT after ${waitSec}s — ${owner} did not get the fleet`);
    process.exit(75);   // EX_TEMPFAIL: the caller decides whether that is fatal
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
}
