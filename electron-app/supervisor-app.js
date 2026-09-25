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

const { app, BrowserWindow, ipcMain, shell, dialog, Menu, Notification } = require('electron');
const path = require('path');
const { execFile } = require('child_process');

const Store = require('./store.js');
const profileManager = require('./profile-manager.js');
const { decideWakeups, readFleet, detectedCalls, launchThenAct, callPhase, upcomingForFleet } = require('./supervisor.js');
const { spawnArgsForProfile, profileLaunchCommand } = require('./profile-launch.js');
const { supervisorPort } = require('./supervisor-port.js');
const { scanBrowsers, isAutomationDenied } = require('./browser-call-scan.js');

const POLL_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 350;
const DEFAULT_PORT = 7865;

let win = null;
let store = null;
let pollTimer = null;
let paths = null;
let directory = null;
// Set once a quit is genuinely intended, so the close handler stops intercepting.
let quitting = false;

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
    const status = body?.status || {};
    return {
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      profile: status.localProfile || null,
      // Exactly the fields mcp-server/instance-routing.js resolves against, under
      // exactly those names. The directory is a drop-in for that module's input,
      // so the resolver itself does not change — only where its input came from.
      botName: status.currentCallBotName || status.configuredBotName || null,
      configuredBotName: (status.configuredBotName || '').trim() || null,
      callStatus: status.callStatus || null,
      roomId: body?.roomId || null,
      // Meet tabs this bot found in the browser. For the window only; the
      // directory strips it (see startDirectory).
      detectedMeetUrls: Array.isArray(body?.detectedMeetUrls) ? body.detectedMeetUrls : [],
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

// When each running bot entered the callStatus it is in now, keyed by
// profile. Only this process can know it: a bot reports its state, not its
// age. Reset whenever the status changes, and dropped when the bot stops.
const statusSince = new Map();

function trackStatus(name, callStatus, now) {
  const prev = statusSince.get(name);
  if (!prev || prev.status !== callStatus) statusSince.set(name, { status: callStatus, since: now });
  return statusSince.get(name).since;
}

// The last thing a bot reported going wrong, for a row that looks stuck. On
// the room's sync endpoint, which wants the bot's token; fetched only for
// stuck bots, so a healthy fleet costs nothing extra.
async function lastError(inst) {
  if (!inst.roomId) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${inst.port}/api/sync/${encodeURIComponent(inst.roomId)}`, {
      headers: botAuthHeaders(inst.port), signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const errors = body?.status?.errors || body?.errors || [];
    return errors.length ? String(errors[errors.length - 1].message || '') || null : null;
  } catch {
    return null;
  }
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

  const now = Date.now();
  for (const name of [...statusSince.keys()]) if (!running.has(name)) statusSince.delete(name);

  const bots = await Promise.all(configured.map(async (p) => {
    const live = running.get(p.name) || null;
    const { phase, busy } = live
      ? callPhase(live.callStatus, trackStatus(p.name, live.callStatus, now), now)
      : { phase: null, busy: false };
    return {
      name: p.name,
      botName: p.botName || '',
      avatarThumb: p.avatarThumb || null,
      lastUsedAt: p.lastUsedAt || null,
      calendarIdentityEmail: p.calendarIdentityEmail || '',
      isDefault: p.name === paths.defaultProfile,
      running: !!live,
      port: live ? live.port : (registry[p.name] || null),
      callStatus: live ? live.callStatus : null,
      roomId: live ? live.roomId : null,
      phase,
      busy,
      error: phase === 'stuck' ? await lastError(live) : null,
    };
  }));

  // A port answering for a profile that has no config on disk is a real thing
  // to surface, not a rounding error: an orphan (#511) looks exactly like this,
  // and today nothing tells you it is there.
  const known = new Set(configured.map((p) => p.name));
  const orphans = [...running.values()].filter((i) => i.profile && !known.has(i.profile));

  // Our own scan when it is working; otherwise what the bots found (an older
  // bot build, or a supervisor without Automation access).
  const calls = browserScan.scanning
    ? detectedCalls([{ callStatus: 'idle', detectedMeetUrls: browserScan.meetUrls }])
    : detectedCalls([...running.values()]);
  return { bots, orphans, calls, defaultProfile: paths.defaultProfile };
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

  // The window's Upcoming list: only meetings some bot would join, by the
  // bot's own display rule (see upcomingForFleet). The wake-up decision above
  // is unaffected; this is what a person sees.
  const annotated = upcomingForFleet(events, readFleet(paths.profilesRoot), now);

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

// Every bot's local API wants its per-launch token, except discovery
// (/api/sync/no-room). Each instance writes it to
// ~/.vibeconferencing/local-tokens/<port>.token, readable only by this user;
// read per request, like the MCP does, because a restarted bot has a new one.
function botAuthHeaders(port) {
  try {
    const os = require('os');
    const fs = require('fs');
    const tok = fs.readFileSync(path.join(os.homedir(), '.vibeconferencing', 'local-tokens', `${port}.token`), 'utf8').trim();
    return tok ? { Authorization: `Bearer ${tok}` } : {};
  } catch {
    return {}; // auth disabled on that bot, or no token yet: let it answer 401 if it minds
  }
}

// Focus a running bot by asking it to raise itself — the supervisor has no
// handle on another process's windows, but every instance serves /api/focus.
async function focusProfile(name) {
  const running = await scanRunning();
  const inst = running.get(name);
  if (!inst) return launchProfile(name);
  try {
    const res = await fetch(`http://127.0.0.1:${inst.port}/api/focus`, {
      method: 'POST', headers: botAuthHeaders(inst.port), signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return { ok: false, error: `running on ${inst.port} but would not focus: HTTP ${res.status}` };
    return { ok: true, focused: true, port: inst.port };
  } catch (err) {
    return { ok: false, error: `running on ${inst.port} but would not focus: ${err.message}` };
  }
}

// ── The browser scan ────────────────────────────────────────────────────────
//
// The machine's one look at which calls are open in the user's browser (#301
// step 3). Bots ask for this at /api/detected-calls instead of each running
// its own AppleScript scan, so N bots cost one scan and one pop-up, and "Add"
// works even with no bot running or every bot in a call.
//
// Keeps scanning while bots are in calls, unlike the per-bot scan it replaces:
// a call one bot is in is exactly the call the others might be Added to.

const SCAN_MS = 5000;
const browserScan = {
  scanning: false,       // true once a scan has succeeded; false while failing
  meetUrls: [],
  slackHuddleUrl: null,
  lastFailKey: null,
  notifiedCodes: new Set(), // Meet codes already announced; cleared when the tab goes
  automationPromptShown: false,
};
let scanTimer = null;
let scanInFlight = false;

const meetCodeOf = (url) => String(url || '').match(/meet\.google\.com\/([a-z]+-[a-z]+-[a-z]+)/)?.[1] || null;

// "Google Meet Detected", once per tab, for the whole fleet. Skipped when a bot
// is already in that call: that tab is the one Call just opened, or the user
// joining a call their bot is in, and neither is news.
async function announceNewCalls(meetUrls) {
  const codes = new Set(meetUrls.map(meetCodeOf).filter(Boolean));
  for (const code of [...browserScan.notifiedCodes]) if (!codes.has(code)) browserScan.notifiedCodes.delete(code);
  const fresh = [...codes].filter((c) => !browserScan.notifiedCodes.has(c));
  if (!fresh.length) return;
  fresh.forEach((c) => browserScan.notifiedCodes.add(c));
  const running = await scanRunning().catch(() => new Map());
  const busyRooms = new Set([...running.values()].filter((i) => i.callStatus && i.callStatus !== 'idle').map((i) => i.roomId));
  const news = fresh.filter((c) => !busyRooms.has(c));
  if (!news.length || !Notification.isSupported() || process.env.VIBECONF_NO_NOTIFICATIONS) return;
  const n = new Notification({
    title: 'Google Meet Detected',
    body: `Found call: ${news[0]}. Add a bot to it from Vibeconferencing.`,
    silent: false,
  });
  n.on('click', () => {
    if (!win || win.isDestroyed()) createWindow();
    else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });
  n.show();
}

async function scanTick() {
  if (scanInFlight) return;
  scanInFlight = true;
  try {
    const scan = await scanBrowsers();
    if (!scan.ok) {
      browserScan.scanning = false;
      if (scan.failKey !== browserScan.lastFailKey) {
        browserScan.lastFailKey = scan.failKey;
        console.log('[supervisor] browser scan failed:', scan.failKey, '(bots fall back to scanning for themselves; further identical failures suppressed)');
      }
      // Same one-time nudge the bot gives, since the supervisor is now the one
      // asking macOS for Automation access.
      if (isAutomationDenied(scan.stderr) && !browserScan.automationPromptShown) {
        browserScan.automationPromptShown = true;
        dialog.showMessageBox({
          type: 'warning',
          title: 'Permission needed to detect Google Meet',
          message: 'Vibeconferencing needs Automation permission to find your active Google Meet call.',
          detail: 'Open System Settings → Privacy & Security → Automation, then enable the checkbox under Vibeconferencing for your browser (Google Chrome / Brave / Safari).',
          buttons: ['Open System Settings', 'Later'],
          defaultId: 0,
          cancelId: 1,
        }).then(({ response }) => {
          if (response === 0) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation');
        }).catch(() => {});
      }
      return;
    }
    if (browserScan.lastFailKey !== null) {
      console.log('[supervisor] browser scan recovered');
      browserScan.lastFailKey = null;
    }
    if (scan.elapsedMs >= 2000) console.log(`[supervisor] browser scan slow (${(scan.elapsedMs / 1000).toFixed(1)}s)`);
    const changed = scan.meetUrls.join('|') !== browserScan.meetUrls.join('|');
    browserScan.scanning = true;
    browserScan.meetUrls = scan.meetUrls;
    browserScan.slackHuddleUrl = scan.slackHuddleUrl;
    if (changed) {
      announceNewCalls(scan.meetUrls).catch(() => {});
      pushState({ callsChanged: true }); // the window refreshes on any push
    }
  } finally {
    scanInFlight = false;
  }
}

function startBrowserScan() {
  // AppleScript is macOS-only; elsewhere there is nothing to scan with, and the
  // bots' own fallback already says so in their logs.
  if (process.platform !== 'darwin') return;
  scanTick();
  scanTimer = setInterval(scanTick, SCAN_MS);
}

// ── Calls ───────────────────────────────────────────────────────────────────
//
// "Call" and "Add" on a RUNNING bot. Both are the bot's own panel buttons,
// reached over its local API: /api/call/start is "Call <bot> now" (a fresh Meet,
// opened in the user's browser too), /api/call/join is Join on a detected tab.
// spawnAgent:true because a person clicked, exactly as with the panel buttons;
// without it the bot sits in the call with nobody driving it.
//
// A closed bot is launched first and acted on once it answers (launchThenAct).
async function botRequest(name, pathname, body) {
  const inst = (await scanRunning()).get(name);
  if (!inst) return { ok: false, error: 'not running' };
  try {
    const res = await fetch(`http://127.0.0.1:${inst.port}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...botAuthHeaders(inst.port) },
      body: JSON.stringify(body),
      // Creating a Meet is a round trip to Google through the website.
      signal: AbortSignal.timeout(20_000),
    });
    // An older build of the bot has no /api/call/join. Say that, rather than
    // "HTTP 404", since the fix is updating that bot.
    if (res.status === 404) return { ok: false, error: 'this bot\'s build is too old for this; update it' };
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) {
      const why = { 'signed-out': 'not signed in to vibeconferencing.com', 'rate-limited': 'too many new calls, try again shortly' }[json.code];
      return { ok: false, error: why || json.detail || json.code || `HTTP ${res.status}` };
    }
    return { ok: true, ...json };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'the bot did not answer in time' : err.message };
  }
}

function whenUp(name, act) {
  return launchThenAct({
    isRunning: async () => (await scanRunning()).has(name),
    launch: () => launchProfile(name),
    act,
  });
}

const startCall = (name) => whenUp(name, () => botRequest(name, '/api/call/start', { openBrowser: true, spawnAgent: true }));
const addToCall = (name, url) => whenUp(name, () => botRequest(name, '/api/call/join', { url, spawnAgent: true }));

// ── The directory ───────────────────────────────────────────────────────────
//
// The one fixed address in the system: an agent asks "where is Bramble?" and
// gets a port, then talks to that bot DIRECTLY.
//
// A directory, not a proxy — and that is the load-bearing choice. Routing the
// agents' traffic THROUGH here would put this process in the hot path of every
// utterance, so a wedged supervisor would mute every bot on the machine
// mid-call. That spends crash isolation, which docs/multi-bot-architecture.md
// identifies as the property process-per-bot was chosen to buy. As a directory,
// a supervisor that dies costs new lookups and nothing else: every live call
// carries on, because nothing of theirs was passing through it.
//
// What it replaces is a 46-port scan on every join. A scan can only answer "who
// is listening"; it cannot tell a correctly-bound bot from one that landed on a
// port it should not have — which is exactly #517. The supervisor can, because
// it is the thing that launched them.
function startDirectory() {
  const http = require('http');
  const port = supervisorPort();

  directory = http.createServer(async (req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    try {
      if (url.pathname === '/api/instances') {
        // Probed live rather than served from a memory of what we launched: a
        // bot started by hand, or one that died since, has to show up
        // truthfully. The supervisor is the authority on what SHOULD be there,
        // which is not a substitute for looking at what is.
        const running = await scanRunning();
        // Meet links are capabilities, and agents resolving a bot have no use
        // for them, so they stay in the window.
        const instances = [...running.values()].map(({ detectedMeetUrls, ...inst }) => inst);
        return send(200, { ok: true, instances, supervisor: { port } });
      }
      // What the browser scan found, for the bots (see the scan section).
      // scanning:false tells a bot to scan for itself instead of trusting an
      // empty list that only means "could not look".
      if (url.pathname === '/api/detected-calls') {
        return send(200, {
          ok: true,
          scanning: browserScan.scanning,
          meetUrls: browserScan.meetUrls,
          slackHuddleUrl: browserScan.slackHuddleUrl,
        });
      }
      if (url.pathname === '/api/health') {
        return send(200, { ok: true, supervisor: { port, pid: process.pid, version: app.getVersion() } });
      }
      if (url.pathname === '/api/launch' && req.method === 'POST') {
        const name = url.searchParams.get('profile');
        if (!name) return send(400, { ok: false, error: 'profile is required' });
        return send(200, launchProfile(name));
      }
      return send(404, { ok: false, error: 'not found' });
    } catch (err) {
      return send(500, { ok: false, error: err.message });
    }
  });

  directory.on('error', (err) => {
    // EADDRINUSE means something already has the port. The single-instance lock
    // normally prevents a second supervisor, but not a stale process still
    // holding it — so name which failure this is rather than dying namelessly.
    console.error(`[supervisor] could not listen on ${port}:`, err.message,
      err.code === 'EADDRINUSE' ? '— another supervisor (or something else) already has it.' : '');
  });
  // Loopback only. This lists every bot on the machine and can start processes;
  // it is not something to expose beyond this host.
  directory.listen(port, '127.0.0.1', () => console.log(`[supervisor] directory listening on 127.0.0.1:${port}`));
}

// ── Window ──────────────────────────────────────────────────────────────────

function pushState(extra = {}) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('supervisor-state', extra);
}

// What actually stops when the supervisor does, said in the dialog rather than
// left to be discovered at the start of a meeting.
//
// The count of running bots is deliberately part of it: quitting with three bots
// up is a different act from quitting with none, and only the first one takes
// anything away right now.
async function confirmQuit() {
  const running = await scanRunning().catch(() => new Map());
  const detail = [
    'Bots that are already open keep working, and their calls are not interrupted.',
    '',
    'What stops:',
    '  • Meetings will not auto-join for any bot that is closed.',
    '  • Agents fall back to scanning ports to find a bot.',
    '',
    running.size
      ? `${running.size} bot${running.size > 1 ? 's are' : ' is'} running right now.`
      : 'No bots are running right now.',
    '',
    'Opening any bot starts the supervisor again.',
  ].join('\n');

  const { response, checkboxChecked } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Keep running', 'Quit anyway'],
    defaultId: 0,
    cancelId: 0,
    title: 'Quit Vibeconferencing?',
    message: 'This is the process that watches the calendar for every bot.',
    detail,
    checkboxLabel: "Don't ask again",
    checkboxChecked: false,
    noLink: true,
  }).catch(() => ({ response: 0, checkboxChecked: false }));

  if (checkboxChecked) store.set('confirmSupervisorQuit', false);
  if (response !== 1) return;
  quitting = true;
  app.quit();
}

// A person asking to quit: the window's ✕, or Cmd+Q from the menu below. Both
// get the dialog. Guarded so a second Cmd+Q while it is up does not stack a
// second one.
let confirming = false;
async function requestQuit() {
  if (quitting || store.get('confirmSupervisorQuit') === false) { quitting = true; app.quit(); return; }
  if (confirming) return;
  confirming = true;
  try { await confirmQuit(); } finally { confirming = false; }
}

// On macOS the default menu's Quit calls app.quit() directly, which is the same
// 'before-quit' a SIGTERM, a logout or Dock → Quit produces, and those must NOT
// wait on a dialog (see the before-quit handler in start()). So Cmd+Q gets its
// own item that asks first. Elsewhere there is no app menu; closing the window
// is the gesture, and the close handler covers it.
function installMenu() {
  if (process.platform !== 'darwin') return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: `Quit ${app.name}`, accelerator: 'Command+Q', click: () => { requestQuit(); } },
      ],
    },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
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

  // The Granola model (Stan, 2026-08-31): this wants to be always-on, says so
  // loudly when you go to quit it, and then lets you.
  //
  // Refusing to close would be worse than being absent — nobody can be required
  // to leave an app running. But quitting silently is its own trap, because what
  // stops is invisible: no calendar auto-join for any bot that is not open, and
  // no directory for the agents to resolve a bot through. Both fail later, as
  // "why didn't it join", far from the click that caused them.
  //
  // So the dialog states what stops rather than asking "are you sure", and
  // remembers a "don't ask again" the same way the bot window's quit
  // confirmation does.
  win.on('close', (event) => {
    if (quitting || store.get('confirmSupervisorQuit') === false) return;
    event.preventDefault();
    requestQuit();
  });
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
  // Any quit that reaches 'before-quit' without going through requestQuit is
  // not a person at this window: a kill signal (Electron turns SIGTERM into an
  // ordinary quit, so there is no signal handler to catch it), a logout or
  // shutdown, Dock → Quit, the updater. None of those should park the process
  // on a dialog nobody is there to answer. Same rule as the bot window
  // (appIsQuitting in main.js).
  app.on('before-quit', () => { quitting = true; });
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
    ipcMain.handle('supervisor:call', (_e, name) => startCall(name));
    ipcMain.handle('supervisor:add', (_e, name, url) => addToCall(name, url));
    ipcMain.handle('supervisor:reveal', (_e, name) => {
      shell.openPath(path.join(profilesRoot, String(name || ''), 'agent'));
      return { ok: true };
    });

    startDirectory();
    startBrowserScan();
    installMenu();
    createWindow();
    tick().catch((err) => console.warn('[supervisor] first tick failed:', err.message));
    pollTimer = setInterval(() => {
      tick().catch((err) => console.warn('[supervisor] tick failed:', err.message));
    }, POLL_MS);
  });

  app.on('window-all-closed', () => {
    if (pollTimer) clearInterval(pollTimer);
    if (scanTimer) clearInterval(scanTimer);
    if (directory) directory.close();
    app.quit();
  });
}

module.exports = { start, tick, fleetStatus, launchProfile, scanRunning };
