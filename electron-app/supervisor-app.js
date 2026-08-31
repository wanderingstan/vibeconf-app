// supervisor-app.js — the supervisor process (#301).
//
// A window that outlives every bot: it lists the fleet, shows what is coming up,
// launches bot instances, and — the thing #301 is actually about — keeps
// watching the calendar when no bot window is open at all.
//
// Reached by `--supervisor`, branched at the very top of main.js so that NONE of
// main.js runs here. That is deliberate: main.js is ~13,600 lines built around
// one implicit bot (101 module-level `let`s, a process-global
// `app.setPath('userData')`, 142 IPC handlers that mean "the bot in this
// process"). A supervisor mode sharing that file would inherit a bot's identity,
// its userData, and its port — the exact state it exists to be independent of.
//
// So this file talks to the fleet the same way an outsider would: profiles are
// read off disk, liveness is a port probe, and starting a bot is spawning a
// process. Nothing here reaches into a bot's memory, because it cannot.
//
// Shape, per Stan on 2026-08-31: a full window app that can later collapse to a
// menulet. The menulet is deliberately NOT built yet — a macOS `Tray` has no
// honest equivalent on Windows or Linux, and committing to it before the window
// works would make the cross-platform story an afterthought. The window is the
// product; the menulet is a way to hide it.

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { execFile } = require('child_process');

const Store = require('./store.js');
const profileManager = require('./profile-manager.js');
const { decideWakeups, readFleet } = require('./supervisor.js');
const { matchesCalendarEvent, ownerHasConfirmed } = require('./calendar-auto-join.js');
const { spawnArgsForProfile, profileLaunchCommand } = require('./profile-launch.js');

const POLL_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 350;
const DEFAULT_PORT = 7865;

let win = null;
let store = null;
let pollTimer = null;
let paths = null;

// ── The fleet, as seen from outside ─────────────────────────────────────────

// Is anything listening on `port`, and if so which profile is it?
//
// The same probe main.js uses. A bot answers /api/sync/no-room with its own
// profile name, which is the only reliable way to say WHICH bot a port belongs
// to — the registry says which port a profile *should* have, not what is
// actually up, and those disagree precisely when something has gone wrong.
async function probe(port) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(`http://127.0.0.1:${port}/api/sync/no-room`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = await res.json();
    return {
      port,
      profile: body?.status?.localProfile || null,
      callStatus: body?.status?.callStatus || 'idle',
      roomId: body?.roomId || null,
    };
  } catch {
    return null; // not listening, or too slow to be useful to a UI
  }
}

// Every port a bot could be on: the default seat, the registry range, and the
// test fleet's range. Probed in parallel — serially this is 50 × 350ms of dead
// time on every refresh.
async function scanRunning() {
  const ports = [DEFAULT_PORT];
  for (let p = profileManager.PROFILE_PORT_BASE; p <= profileManager.PROFILE_PORT_MAX; p++) ports.push(p);
  for (let p = 7901; p <= 7916; p++) ports.push(p);
  const found = (await Promise.all(ports.map(probe))).filter(Boolean);
  const byProfile = new Map();
  for (const inst of found) {
    // An instance on the default port that reports no profile is an old build;
    // it is still a running bot, so name it rather than dropping it.
    const name = inst.profile || (inst.port === DEFAULT_PORT ? paths.defaultProfile : null);
    if (name) byProfile.set(name, inst);
  }
  return byProfile;
}

// The whole picture the window renders: who exists, who is up, what they are
// doing. One call so the renderer never shows a half-refreshed fleet.
async function fleetStatus() {
  const configured = readFleet(paths.profilesRoot);
  const running = await scanRunning();
  const registry = (() => {
    try { return profileManager.loadPortRegistry(paths.baseUserData) || {}; }
    catch { return {}; }
  })();

  const bots = configured.map((p) => {
    const live = running.get(p.name) || null;
    return {
      name: p.name,
      botName: p.botName || '',
      calendarIdentityEmail: p.calendarIdentityEmail || '',
      isDefault: p.name === paths.defaultProfile,
      running: !!live,
      port: live ? live.port : (registry[p.name] || null),
      callStatus: live ? live.callStatus : null,
      roomId: live ? live.roomId : null,
    };
  });

  // A port answering for a profile that has no config on disk is a real thing
  // to surface, not a rounding error: an orphan (#511) looks exactly like this,
  // and today nothing tells you it is there.
  const known = new Set(configured.map((p) => p.name));
  const orphans = [...running.values()].filter((i) => i.profile && !known.has(i.profile));

  return { bots, orphans, defaultProfile: paths.defaultProfile };
}

// ── Calendar ────────────────────────────────────────────────────────────────

// The upcoming events for the whole machine.
//
// One authenticated call, and the supervisor can make it with no bot running:
// the website session token is APP-LEVEL (config-scope.js), shared by every
// profile, so it lives in the base config this process already reads.
async function fetchUpcomingEvents() {
  const baseUrl = (store.get('websiteUrl') || store.get('syncBaseUrl') || 'https://vibeconferencing.com').replace(/\/$/, '');
  const token = store.get('vcSessionToken');
  if (!token) return { events: [], signedIn: false };
  try {
    const res = await fetch(`${baseUrl}/api/calendar/upcoming`, {
      headers: { Cookie: `vc_session=${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { events: [], signedIn: res.status !== 401, error: `HTTP ${res.status}` };
    const body = await res.json();
    return { events: Array.isArray(body?.events) ? body.events : [], signedIn: true };
  } catch (err) {
    // A failed poll is not a failed supervisor. Report it and tick again.
    return { events: [], signedIn: true, error: err.message };
  }
}

// One tick: who is up, what is coming, who needs waking.
async function tick() {
  const now = Date.now();
  const [{ events, signedIn, error }, running] = await Promise.all([fetchUpcomingEvents(), scanRunning()]);

  const { wakeups, launched } = decideWakeups({
    profiles: readFleet(paths.profilesRoot),  // re-read every tick: a bot added or renamed since the last one counts
    events,
    now,
    running: new Set(running.keys()),
    launched: store.get('supervisorWokeForEventIds') || {},
  });
  // Persisted BEFORE the launches, not after. A crash between the two costs a
  // missed wake-up; the other order costs an unbounded relaunch loop against a
  // profile that will not come up.
  store.set('supervisorWokeForEventIds', launched);

  for (const wake of wakeups) {
    console.log(`[supervisor] "${wake.event.summary || wake.event.id}" is ${Math.round(wake.msUntilStart / 1000)}s out`
      + ` and belongs to "${wake.profile}", which is not running — launching it.`);
    const result = launchProfile(wake.profile);
    if (!result.ok) console.warn(`[supervisor] could not launch "${wake.profile}":`, result.error);
  }

  // Attribute each event to the bots it would wake, for the window. An upcoming
  // meeting with no bot behind it is the failure worth SEEING — it looks
  // identical to a scheduled one right up until nobody joins — so this is
  // computed for display even though the wake-up decision above ignores it.
  const fleet = readFleet(paths.profilesRoot);
  const annotated = events.map((event) => ({
    ...event,
    forProfile: fleet
      .filter((p) => (p.calendarIdentityEmail || p.botName)
        && matchesCalendarEvent(event, { calendarIdentityEmail: p.calendarIdentityEmail, botName: p.botName }))
      .map((p) => p.botName || p.name)
      .join(', ') || null,
    ownerConfirmed: ownerHasConfirmed(event),
  }));

  pushState({ events: annotated, signedIn, calendarError: error || null, lastTick: now });
  return { wakeups, events: annotated };
}

// ── Launching a bot ─────────────────────────────────────────────────────────

// Start a bot instance, or focus it if it is already up. This is what the
// window's "open" button does, and what a calendar wake-up does — one path, so
// they cannot diverge.
function launchProfile(name, { openSettings = false } = {}) {
  if (!profileManager.isValidProfileName(name)) return { ok: false, error: 'invalid profile name' };
  const isDefault = name === paths.defaultProfile;

  let port = null;
  if (!isDefault) {
    try { port = profileManager.portForProfile(paths.baseUserData, name); }
    catch (err) { return { ok: false, error: err.message }; }
  }

  let args;
  try { args = spawnArgsForProfile({ name, isDefault, port, openSettings }); }
  catch (err) { return { ok: false, error: err.message }; }

  try {
    // Same per-platform argv as main.js's launcher (#746) — `open -n` only on
    // macOS; elsewhere the executable itself, detached so it outlives us.
    const { cmd, argv, detached } = profileLaunchCommand({
      platform: process.platform,
      isPackaged: app.isPackaged,
      exePath: app.getPath('exe'),
      appPath: app.isPackaged ? null : app.getAppPath(),
      args,
    });
    const onError = (err) => { if (err) console.error('[supervisor] launch failed:', err.message); };
    const child = detached
      ? execFile(cmd, argv, { detached: true, stdio: 'ignore' })
      : execFile(cmd, argv, onError);
    child.on('error', onError);
    if (detached) child.unref();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true, port };
}

// Focus a running bot by asking it to raise itself — the supervisor has no
// handle on another process's windows, but every instance serves /api/focus.
async function focusProfile(name) {
  const running = await scanRunning();
  const inst = running.get(name);
  if (!inst) return launchProfile(name);
  try {
    await fetch(`http://127.0.0.1:${inst.port}/api/focus`, { method: 'POST', signal: AbortSignal.timeout(2000) });
    return { ok: true, focused: true, port: inst.port };
  } catch (err) {
    return { ok: false, error: `running on ${inst.port} but would not focus: ${err.message}` };
  }
}

// ── Window ──────────────────────────────────────────────────────────────────

function pushState(extra = {}) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('supervisor-state', extra);
}

function createWindow() {
  win = new BrowserWindow({
    width: 520,
    height: 720,
    title: 'Vibeconferencing',
    webPreferences: {
      preload: path.join(__dirname, 'preload-supervisor.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'supervisor.html'));

  // Closing the supervisor window quits the supervisor — for now. Once it
  // collapses to a menulet this becomes "hide", and that is the ONE line that
  // changes: an always-on process you cannot see or quit is the thing to avoid
  // shipping by accident, so it stays quittable until there is a menu-bar item
  // to quit it FROM.
  win.on('closed', () => { win = null; });
}

// ── Entry ───────────────────────────────────────────────────────────────────

function start() {
  // One supervisor per machine, unconditionally — unlike the bots, where named
  // profiles bypass the lock on purpose because each is a separate seat. Two
  // supervisors would both wake profiles for the same event, and the dedupe map
  // that prevents exactly that is per-process state on top of a shared file.
  if (!app.requestSingleInstanceLock()) {
    console.log('[supervisor] another supervisor is already running — focusing it and quitting this one.');
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return createWindow();
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    const baseUserData = app.getPath('userData');
    const profilesRoot = path.join(baseUserData, 'profiles');
    store = new Store(baseUserData, { fresh: true });
    paths = {
      baseUserData,
      profilesRoot,
      defaultProfile: profileManager.resolveDefaultProfileName(profilesRoot, store.get('defaultProfile')),
    };

    ipcMain.handle('supervisor:fleet', () => fleetStatus());
    ipcMain.handle('supervisor:tick', () => tick());
    ipcMain.handle('supervisor:launch', (_e, name) => launchProfile(name));
    ipcMain.handle('supervisor:focus', (_e, name) => focusProfile(name));
    ipcMain.handle('supervisor:reveal', (_e, name) => {
      shell.openPath(path.join(profilesRoot, String(name || ''), 'agent'));
      return { ok: true };
    });

    createWindow();
    tick().catch((err) => console.warn('[supervisor] first tick failed:', err.message));
    pollTimer = setInterval(() => {
      tick().catch((err) => console.warn('[supervisor] tick failed:', err.message));
    }, POLL_MS);
  });

  app.on('window-all-closed', () => {
    if (pollTimer) clearInterval(pollTimer);
    app.quit();
  });
}

module.exports = { start, tick, fleetStatus, launchProfile, scanRunning };
