// update-policy.js — WHEN the app is allowed to update itself.
//
// electron-updater handles the mechanism (check, download, install on quit).
// The decisions around it are ours, and they're the part worth testing without
// a desktop — which is why they live here rather than inline in main.js. The
// hand-rolled updates.js it replaced made the same call for the same reason.
//
// Three questions, three functions:
//   canAutoUpdate  — is this build even updatable in place?
//   shouldCheck    — is THIS instance the one that should check, right now?
//   canInstallNow  — is it safe to restart right now?
//
// canAutoUpdate is a property of the build and never changes, so it's asked once
// at launch. shouldCheck is asked on every check, because its answer depends on
// which other instances happen to be running at that moment.

// Linux ships two ways and only one of them can update itself. electron-updater
// self-updates an AppImage; there is no deb updater, and a .deb is owned by the
// system package manager anyway — rewriting files under /opt behind apt's back
// would be wrong even if it worked. AppImage sets APPIMAGE in the environment,
// which is how the running process can tell which one it is.
//
// A dev run (not packaged) has nothing to update either — the "installed app" is
// a checkout.
function canAutoUpdate({ platform = process.platform, packaged = true, env = process.env } = {}) {
  if (!packaged) return { ok: false, reason: 'dev-build' };
  if (platform === 'linux' && !env.APPIMAGE) return { ok: false, reason: 'linux-not-appimage' };
  return { ok: true, reason: null };
}

// One updater per machine, not one per bot — but ANY instance can be the one.
//
// The hazard is concurrency, not identity: left alone, N running bots would each
// check, each download the same hundred megabytes, and each ask about the same
// release, then race to install it into the one app bundle they share. This used
// to be solved by electing the default instance, reusing the election that makes
// it the single writer for the machine-global Claude integration.
//
// That conflated "is privileged" with "is present". Someone whose shortcut always
// launches --profile=bot2 has no default instance running, so nothing on that
// machine ever checked and the app could never update — silently, forever. A
// fleet is the rare case; a single named profile is not.
//
// So: a lease in the shared app-level directory, claimed by whoever gets there
// first. One updater at a time, no matter which profile it happens to be.
const UPDATER_LEASE_MS = 30 * 60_000;

// Is that pid still running? EPERM means it exists but isn't ours to signal,
// which still counts as alive. Anything else (ESRCH) means it's gone.
function processAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }
}

// Claim or renew the machine-wide updater lease. Returns the lease to persist
// when ok; the incumbent otherwise.
//
// A lease rather than a lock because a lock needs a release that a crash, a
// SIGKILL, or a power cut will never run — and a lock nobody can release is a
// machine that can never update again. Two independent ways out: the holder's
// pid is gone, or the lease simply aged out. Either alone would do; both means
// pid reuse can't wedge it permanently, and a paused process can't either.
//
// The window must comfortably exceed a download — it's renewed on every check,
// so it only ever has to outlive one.
function claimUpdaterLease({
  lease = null, now = Date.now(), pid = process.pid, profile = null,
  leaseMs = UPDATER_LEASE_MS, isAlive = processAlive,
} = {}) {
  const mine = { pid, profile, at: now };
  if (!lease || typeof lease.pid !== 'number') return { ok: true, reason: null, lease: mine };
  if (lease.pid === pid) return { ok: true, reason: null, lease: mine };   // ours already — renew
  if (typeof lease.at !== 'number' || (now - lease.at) >= leaseMs) return { ok: true, reason: null, lease: mine };
  if (!isAlive(lease.pid)) return { ok: true, reason: null, lease: mine }; // holder died mid-lease
  return { ok: false, reason: 'another-instance-updating', lease };
}

// Whether THIS instance should run a check right now. Re-evaluated per check,
// not once at launch: the instance holding the lease can quit at any time, and
// whoever is still running should take over at its next tick rather than the
// machine going quiet until someone restarts the right window.
function shouldCheck({ lease, now, pid, profile, leaseMs, isAlive, ...rest } = {}) {
  const updatable = canAutoUpdate(rest);
  if (!updatable.ok) return { ...updatable, lease: null };
  return claimUpdaterLease({ lease, now, pid, profile, leaseMs, isAlive });
}

// Never restart out from under a live call. The app is a headless worker while
// the bot is in a meeting: quitting to install would drop it mid-sentence, and
// the user watching the call has no idea the app was even thinking about it.
// `joining` and `waiting-to-be-admitted` count as live — the bot is on its way
// in, and losing it there is just as bad.
function canInstallNow({ callStatus = 'idle' } = {}) {
  const live = !!callStatus && callStatus !== 'idle' && callStatus !== 'left';
  return live ? { ok: false, reason: 'in-call' } : { ok: true, reason: null };
}

// Spread the first check out. Every instance launching at once (a reboot, a test
// fleet) would otherwise hit GitHub together, and the unauthenticated API allows
// 60 requests/hour per IP.
function firstCheckDelayMs({ base = 45_000, jitter = 60_000, random = Math.random } = {}) {
  return Math.round(base + random() * jitter);
}

module.exports = {
  canAutoUpdate, shouldCheck, canInstallNow, firstCheckDelayMs,
  claimUpdaterLease, processAlive, UPDATER_LEASE_MS,
};
