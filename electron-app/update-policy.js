// update-policy.js — WHEN the app is allowed to update itself.
//
// electron-updater handles the mechanism (check, download, install on quit).
// The decisions around it are ours, and they're the part worth testing without
// a desktop — which is why they live here rather than inline in main.js. The
// hand-rolled updates.js it replaced made the same call for the same reason.
//
// Three questions, three functions:
//   canAutoUpdate  — is this build even updatable in place?
//   shouldCheck    — is THIS instance the one that should check?
//   canInstallNow  — is it safe to restart right now?

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

// One updater per machine, not one per bot. Every profile is its own process
// with its own updater; left alone, N running bots would each check, each
// download the same hundred megabytes, and each ask about the same release —
// then race to install it into the one app bundle they share. The default
// instance is already the single writer for the machine-global Claude
// integration; reuse that election rather than inventing a second one.
function shouldCheck({ isDefaultInstance = true, ...rest } = {}) {
  const updatable = canAutoUpdate(rest);
  if (!updatable.ok) return updatable;
  if (!isDefaultInstance) return { ok: false, reason: 'not-default-instance' };
  return { ok: true, reason: null };
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

module.exports = { canAutoUpdate, shouldCheck, canInstallNow, firstCheckDelayMs };
