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

const { app, BrowserWindow, WebContentsView, ipcMain, shell, dialog, Menu, Notification, clipboard } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

const Store = require('./store.js');
const profileManager = require('./profile-manager.js');
const { decideWakeups, readFleet, detectedCalls, mergeTargets, launchThenAct, callPhase, upcomingForFleet, decideReaping, pickResumeBot } = require('./supervisor.js');
const { spawnArgsForProfile, allowedLaunchArgs } = require('./profile-launch.js');
const { supervisorPort } = require('./supervisor-port.js');
const { scanBrowsers, isAutomationDenied } = require('./browser-call-scan.js');
const { createBotChildren } = require('./bot-children.js');

// The app window relays every bot's log lines to its own stdout. When whatever
// was reading that stdout goes away (the terminal or launcher that started it),
// the next write fails with EPIPE, and unhandled that is an "Uncaught
// Exception" dialog over the app (seen 2026-10-23, from bot-children's
// emitLine). Nobody is left to read the line, so drop it, as main.js and
// session-log.js do. (No logging here: it would write to the same dead pipe.)
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.('error', () => { /* dead pipe: nowhere to report it */ });
}

// The bots this window started, as its own child processes (bot-children.js):
// their PIDs, exits and output. A bot asking to be shown ('select') comes in
// here too, and so does every exit, expected or not.
const botChildren = createBotChildren({
  spawn,
  onMessage: (name, msg) => {
    if (msg.type !== 'select') return;
    console.log(`[supervisor] bot "${name}" asked to be shown`);
    showBot(name).catch(() => {});
  },
  onExit: (info) => {
    statusSince.delete(info.name);
    pushState({ botExited: info });
    if (!info.expected && !quitting && Notification.isSupported()) {
      // A bot leaving on its own is news, even more so mid-call.
      try {
        new Notification({
          title: `${info.name} stopped`,
          body: info.signal ? `Its process was killed (${info.signal}).` : `It exited unexpectedly (code ${info.code}).`,
        }).show();
      } catch { /* notifications unavailable */ }
    }
  },
});

const POLL_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 350;
// This user's port block (port-layout.js): 7865 and friends unless the port base
// moved it. main.js resolved env + config into process.env before we got here.
const PORT_LAYOUT = require('./port-layout.js').layoutFromEnv();
const DEFAULT_PORT = PORT_LAYOUT.defaultBot;

let win = null;
let store = null;
let pollTimer = null;
let paths = null;
let directory = null;
// Set once a quit is genuinely intended, so the close handler stops intercepting.
let quitting = false;
// Set once the bots have been asked to stop, by the quit itself or by an
// update install, so before-quit lets the quit through.
let botsStopped = false;

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
      // Started by this app (no window of its own), so the reaper may stop it.
      headless: !!status.headless,
      roomId: body?.roomId || null,
      // Meet tabs this bot found in the browser. For the window only; the
      // directory strips it (see startDirectory).
      detectedMeetUrls: Array.isArray(body?.detectedMeetUrls) ? body.detectedMeetUrls : [],
      // The call this bot is in, so another bot can be merged into it. A
      // capability like the Meet links above: the directory strips it too.
      currentUrl: typeof body?.currentMeetUrl === 'string' ? body.currentMeetUrl : null,
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
  for (let p = PORT_LAYOUT.profileFirst; p <= PORT_LAYOUT.profileLast; p++) ports.push(p);
  for (let p = PORT_LAYOUT.fleetFirst; p <= PORT_LAYOUT.fleetLast; p++) ports.push(p);
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
      lastCallAt: p.lastCallAt || null,
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
  // What a bot can be merged into: those browser calls, and calls other bots
  // are in (the merge button on each row).
  const merge = mergeTargets({ instances: [...running.values()], detected: calls });
  return { bots, orphans, calls, merge, selected: relay.name || stageOutdated, defaultProfile: paths.defaultProfile };
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

// Who is signed in to vibeconferencing.com, for the sidebar's footer. The login
// is app-level (one sign-in covers every bot), and its token is in the base
// config this process reads, so no bot needs to be running to answer.
function websiteBase() {
  return (store.get('websiteUrl') || store.get('syncBaseUrl') || 'https://vibeconferencing.com').replace(/\/$/, '');
}

async function fetchAccount() {
  const baseUrl = websiteBase();
  const token = store.get('vcSessionToken');
  if (!token) return { signedIn: false };
  try {
    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: `vc_session=${token}` },
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.json().catch(() => ({}));
    if (!body?.authenticated) return { signedIn: false };
    // avatarUrl: the Google picture the website shows in its own header.
    const avatar = /^https:\/\//.test(body.user?.avatarUrl || '') ? body.user.avatarUrl : null;
    return { signedIn: true, email: body.user?.email || null, name: body.user?.name || null, avatarUrl: avatar };
  } catch {
    return { signedIn: null }; // could not tell (offline); the footer says nothing rather than "signed out"
  }
}

// ── Stopping bots: the reaper, and the app quitting ─────────────────────────

const REAP_EVERY_MS = 30 * 1000;
let reapTimer = null;
let lastEvents = [];      // the calendar as of the last tick, for the reaper's meeting guard
let idleSince = {};       // profile -> when it was first seen idle and unselected

// Ask one bot to stop (panel-relay's /api/panel/quit). A bot from an older
// build has no such route and is left running: better than killing it blind.
async function stopBot(port, timeoutMs = 2000, reason = 'unspecified', name = null) {
  console.log(`[supervisor] stopping the bot on port ${port}: ${reason}`);
  // Our own child: over its channel, and we see it exit.
  const child = name && botChildren.has(name) ? name : botChildren.nameForPort(port);
  if (child) return botChildren.quit(child, `supervisor: ${reason}`, timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/panel/quit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...botAuthHeaders(port) },
      body: JSON.stringify({ reason: `supervisor: ${reason}` }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function reapTick() {
  const running = await scanRunning().catch(() => null);
  if (!running) return;
  const { quit, idleSince: next } = decideReaping({
    instances: [...running.values()],
    selected: relay.name,
    fleet: readFleet(paths.profilesRoot),
    events: lastEvents,
    idleSince,
    now: Date.now(),
    // Test hook: a shorter idle limit, so the reaper can be exercised live.
    ...(Number(process.env.VIBECONF_REAP_IDLE_MS) > 0 ? { idleMs: Number(process.env.VIBECONF_REAP_IDLE_MS) } : {}),
  });
  idleSince = next;
  for (const name of quit) {
    const ok = await stopBot(running.get(name).port, 2000, `reaper ("${name}" idle)`, name);
    console.log(`[supervisor] reaper: "${name}" idle for ${Math.round((Number(process.env.VIBECONF_REAP_IDLE_MS) || 300000) / 1000)}s${ok ? ', stopped it' : ', but it would not stop (an older build?)'}`);
  }
  if (quit.length) pushState({ reaped: quit });
}

// Quitting the app stops every bot it can reach, its own and any opened by
// hand: the app is the bots. Capped, so a wedged bot cannot hold the quit.
async function stopAllBots(capMs = 3000) {
  const running = await scanRunning().catch(() => new Map());
  // Our children, including any still starting up and not yet on a port.
  const names = new Set([...running.keys(), ...botChildren.names()]);
  if (!names.size) return;
  console.log(`[supervisor] quitting: stopping ${names.size} bot${names.size > 1 ? 's' : ''}`);
  await Promise.race([
    Promise.allSettled([...names].map((name) => (botChildren.has(name)
      ? botChildren.quit(name, 'supervisor: the app is quitting', capMs)
      : stopBot(running.get(name).port, capMs, 'the app is quitting', name)))),
    new Promise((r) => setTimeout(r, capMs + 1500)),
  ]);
}

// One tick: who is up, what is coming, who needs waking.
async function tick() {
  const now = Date.now();
  const [{ events, signedIn, error }, running] = await Promise.all([fetchUpcomingEvents(), scanRunning()]);
  lastEvents = events;

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
function launchProfile(name, { openSettings = false, extraArgs = [] } = {}) {
  if (!profileManager.isValidProfileName(name)) return { ok: false, error: 'invalid profile name' };
  const isDefault = name === paths.defaultProfile;

  let port = null;
  if (!isDefault) {
    try { port = profileManager.portForProfile(paths.baseUserData, name); }
    catch (err) { return { ok: false, error: err.message }; }
  }

  let args;
  // Headless: its UI is the panel on this window's stage, so it gets no
  // window or Dock icon of its own.
  try { args = spawnArgsForProfile({ name, isDefault, port, openSettings, headless: true }); }
  catch (err) { return { ok: false, error: err.message }; }
  args.push(...extraArgs);

  // Our own child process, not a detached launch: see bot-children.js. The
  // executable itself, even in a packaged Mac build. `open -n` existed to give
  // each copy its own Dock identity, which a hosted bot must not have; and the
  // child shares the app's bundle, so camera, mic and screen permissions are
  // the app's.
  if (botChildren.has(name)) return { ok: true, port, pid: botChildren.get(name).pid, already: true };
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // inherited from a dev shell, it would start the bot as plain Node
  const argv = app.isPackaged ? args : [app.getAppPath(), ...args];
  const started = botChildren.start(name, app.getPath('exe'), argv, { env });
  if (!started.ok) return { ok: false, error: started.error };
  return { ok: true, port, pid: started.pid };
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

// ── The machine-wide agent setup ────────────────────────────────────────────
//
// The skills in ~/.claude/skills, the agent-activity hook and the user-scoped
// MCP registration (agent-integration.js) belong to the app, not to any one
// bot, so the app window installs them, as the single writer, on start. Before
// it existed the default bot did, as an election among bots; a bot running
// hidden inside this window now leaves it to us, and only a default bot in its
// own window (classic mode, development) still writes it.
//
// Two of the default bot's settings still gate it, read off disk the way the
// rest of the fleet is: agentBackend (codex sets up its own integration) and
// claudeIntegrationRemoved ("leave no trace" after a menu uninstall).
function installAgentIntegration() {
  try {
    const name = paths.defaultProfile;
    let cfg = {};
    try { cfg = JSON.parse(require('fs').readFileSync(path.join(paths.profilesRoot, name, 'agent', 'config.json'), 'utf8')); } catch { /* first run */ }
    if ((cfg.agentBackend || 'claude') !== 'claude') {
      console.log('[supervisor] agent integration: the default bot uses', cfg.agentBackend, '- leaving it to that bot');
      return;
    }
    if (cfg.claudeIntegrationRemoved === true) {
      console.log('[supervisor] agent integration: uninstalled on purpose (leave-no-trace) - not reinstalling');
      return;
    }
    const { resolveBotName } = require('./bot-name.js');
    const botName = resolveBotName({ storedName: cfg.botName, cliName: undefined, profileName: null });
    require('./agent-integration.js').ensureClaudeIntegration({ defaultPort: DEFAULT_PORT, botName });
  } catch (err) {
    console.warn('[supervisor] agent integration install failed:', err.message);
  }
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

// ── A bot's row menu: Show in Finder, Stop, Delete ───────────────────────────

function botLabel(name) {
  const bot = readFleet(paths.profilesRoot).find((b) => b.name === name);
  return (bot && bot.botName) || name;
}

// Stop a running bot now, rather than waiting for the reaper.
async function stopBotNow(name) {
  const inst = (await scanRunning()).get(name);
  if (!inst && !botChildren.has(name)) return { ok: true, already: true };
  if (inst && require('@vibeconferencing/calls/core/call-phase.js').isBusy(inst.callStatus)) return { ok: false, error: `${botLabel(name)} is in a call. Leave it first.` };
  if (relay.name === name) deselectBot();
  const ok = await stopBot(inst ? inst.port : null, 4000, 'stopped from its menu', name);
  return { ok: !!ok };
}

// Restart a bot started by an older build (one with no panel relay, so the
// stage can't show it: selectBot's 'outdated'). Such a process predates the
// child channel and /api/panel/quit, so it is stopped the way a person would:
// SIGTERM to the process listening on its port, which Electron turns into an
// ordinary quit. Then it starts fresh, as this window's child, and comes onto
// the stage. Never while it is in a call.
async function restartOutdatedBot(name) {
  if (!profileManager.isValidProfileName(name)) return { ok: false, error: 'invalid bot' };
  const label = botLabel(name);
  const inst = (await scanRunning()).get(name);
  if (inst) {
    if (require('@vibeconferencing/calls/core/call-phase.js').isBusy(inst.callStatus)) return { ok: false, error: `${label} is in a call. Restart it after the call.` };
    let pid = null;
    try {
      const out = require('child_process').execFileSync('lsof', ['-nP', `-iTCP:${inst.port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 4000 });
      pid = Number(String(out).trim().split('\n')[0]) || null;
    } catch { /* lsof found nothing */ }
    if (!pid || pid === process.pid) return { ok: false, error: `Couldn't find ${label}'s process to stop it.` };
    console.log(`[supervisor] restarting outdated bot "${name}": SIGTERM to pid ${pid} on port ${inst.port}`);
    try { process.kill(pid, 'SIGTERM'); } catch (err) { return { ok: false, error: `Couldn't stop ${label}: ${err.message}` }; }
    for (let i = 0; i < 40 && (await scanRunning()).has(name); i++) await new Promise((r) => setTimeout(r, 250));
    if ((await scanRunning()).has(name)) return { ok: false, error: `${label} didn't stop. Quit it by hand, then select it again.` };
  }
  stageOutdated = null;
  return openBot(name);
}

// Delete a bot: its whole folder (settings, agent memory, call recordings and
// notes) goes to the Trash, so it can be restored, never erased. Asks first,
// naming the bot. Not the default bot, and never one in a call; a running one
// is stopped first. A bot made from a Claude Code session leaves the session
// itself alone: that lives under ~/.claude, not in the bot's folder.
async function deleteBot(name) {
  if (!profileManager.isValidProfileName(name)) return { ok: false, error: 'invalid bot' };
  const label = botLabel(name);
  if (name === paths.defaultProfile) return { ok: false, error: `${label} is the default bot, which can't be deleted.` };
  const inst = (await scanRunning()).get(name);
  if (inst && require('@vibeconferencing/calls/core/call-phase.js').isBusy(inst.callStatus)) return { ok: false, error: `${label} is in a call. Leave it first.` };
  const { response } = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
    type: 'warning',
    buttons: ['Move to Trash', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `Delete ${label}?`,
    detail: `${label}'s folder, with its settings, notes and call recordings, moves to the Trash. You can restore it from there.`,
  });
  if (response !== 0) return { ok: false, cancelled: true };
  if (relay.name === name) deselectBot();
  if (inst || botChildren.has(name)) {
    await stopBot(inst ? inst.port : null, 4000, 'being deleted', name);
    // Wait for it to be gone: trashing a folder a live process writes to
    // would leave it writing into the Trash.
    for (let i = 0; i < 20 && (botChildren.has(name) || (await scanRunning()).has(name)); i++) await new Promise((r) => setTimeout(r, 250));
    if (botChildren.has(name) || (await scanRunning()).has(name)) return { ok: false, error: `${label} would not stop, so nothing was deleted.` };
  }
  try {
    await shell.trashItem(path.join(paths.profilesRoot, name));
  } catch (err) {
    return { ok: false, error: `Could not move ${label} to the Trash: ${err.message}` };
  }
  try {
    const reg = profileManager.loadPortRegistry(paths.baseUserData) || {};
    if (reg[name] !== undefined) { delete reg[name]; profileManager.savePortRegistry(paths.baseUserData, reg); }
  } catch { /* the registry only reserves a port; a stale entry is harmless */ }
  if (store.get('lastSelectedBot') === name) store.delete('lastSelectedBot');
  console.log(`[supervisor] deleted bot "${name}" (${label}): moved to the Trash`);
  pushState({ deleted: name });
  return { ok: true };
}

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
    // The API explorer probes this directory to find the user's bots, from
    // vibeconferencing.com or from a bot's own /docs page (docs-origins.js).
    // The running bots' origins are allowed so /docs on any port can ask.
    const botOrigins = botChildren.names().map((n) => botChildren.get(n)).map((c) => c && c.port).filter(Boolean).map((p) => `http://127.0.0.1:${p}`);
    require('./docs-origins.js').applyCors(req, res, { extra: botOrigins });
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    try {
      if (url.pathname === '/api/instances') {
        // Probed live rather than served from a memory of what we launched: a
        // bot started by hand, or one that died since, has to show up
        // truthfully. The supervisor is the authority on what SHOULD be there,
        // which is not a substitute for looking at what is.
        const running = await scanRunning();
        // Meet links are capabilities, and agents resolving a bot have no use
        // for them, so they stay in the window.
        const instances = [...running.values()].map(({ detectedMeetUrls, currentUrl, ...inst }) => inst);
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
      // Debug only: pictures of the sidebar and the hosted panel, for checking
      // the shell without access to the screen. Off unless asked for.
      // Stop one bot the way the reaper does (its child channel when it is ours).
      if (url.pathname === '/api/debug/stop' && req.method === 'POST' && process.env.VIBECONF_SUPERVISOR_DEBUG === '1') {
        const name = url.searchParams.get('profile');
        const inst = (await scanRunning()).get(name);
        if (!inst && !botChildren.has(name)) return send(404, { ok: false, error: 'not running' });
        return send(200, { ok: await stopBot(inst ? inst.port : null, 3000, 'debug stop', name), child: botChildren.get(name) });
      }
      if (url.pathname === '/api/debug/capture' && process.env.VIBECONF_SUPERVISOR_DEBUG === '1') {
        const dir = url.searchParams.get('dir') || require('os').tmpdir();
        const fs = require('fs');
        const out = {};
        if (win && !win.isDestroyed()) {
          fs.writeFileSync(path.join(dir, 'shell-sidebar.png'), (await win.webContents.capturePage()).toPNG());
          out.sidebar = path.join(dir, 'shell-sidebar.png');
        }
        if (panelHost && relay.name) {
          fs.writeFileSync(path.join(dir, 'shell-panel.png'), (await panelHost.webContents.capturePage()).toPNG());
          out.panel = path.join(dir, 'shell-panel.png');
        }
        return send(200, { ok: true, ...out });
      }
      // Debug only, like capture: run a snippet in the window's own page (to
      // click its controls in tests). Off unless asked for.
      if (url.pathname === '/api/debug/eval' && req.method === 'POST' && process.env.VIBECONF_SUPERVISOR_DEBUG === '1') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const js = Buffer.concat(chunks).toString('utf8');
        // ?target=panel runs it in the hosted bot panel instead of the sidebar page.
        const target = url.searchParams.get('target') === 'panel' && panelHost ? panelHost.webContents : win.webContents;
        const value = await target.executeJavaScript(js);
        return send(200, { ok: true, value: value === undefined ? null : value });
      }
      // Put a running bot's panel on the window's stage (#301 one-window spike).
      if (url.pathname === '/api/select' && req.method === 'POST') {
        // No profile means the default bot: what /join-call asks for when the
        // user named none and no bot is running (mcp-server/join-call-skill.md).
        const name = url.searchParams.get('profile') || paths.defaultProfile;
        if (!name) return send(400, { ok: false, error: 'profile is required' });
        return send(200, await showBot(name));
      }
      if (url.pathname === '/api/launch' && req.method === 'POST') {
        const name = url.searchParams.get('profile');
        if (!name) return send(400, { ok: false, error: 'profile is required' });
        const body = await new Promise((resolve, reject) => {
          let data = '';
          req.on('data', (chunk) => { data += chunk; });
          req.on('end', () => resolve(data));
          req.on('error', reject);
        });
        let extraArgs = [];
        try { extraArgs = allowedLaunchArgs(JSON.parse(body || '{}').extraArgs); } catch { /* no args */ }
        const result = launchProfile(name, { openSettings: url.searchParams.has('open-settings'), extraArgs });
        // Not awaited: showBot waits for the bot to come up, and the caller only
        // needs to know it started.
        if (result.ok && url.searchParams.has('show')) {
          showBot(name).catch((err) => console.warn(`[supervisor] could not show "${name}":`, err.message));
        }
        return send(200, result);
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

// ── The shell: one window, a sidebar of bots, the selected bot's panel ─────
//
// #301 one-window spike. The window's own page (supervisor.html) is the
// sidebar plus an empty stage; the selected bot's REAL panel (panel.html, the
// same file the bot's own window loads) sits on the stage in a
// WebContentsView, talking to that bot through panel-relay.js:
//
//   panel.js → preload-panel-relay.js → relay:invoke/relay:send (here)
//            → POST http://127.0.0.1:<bot port>/api/panel/{invoke,send}
//   bot's webContents.send → GET /api/panel/events (SSE) → here → panel view
//
// The bot stays its own process; only its UI is shown here. A bot that
// crashes takes its panel with it, not the window.

const SIDEBAR_W = 320;
const RAIL_W = 56; // the collapsed sidebar
// What the sidebar takes right now: SIDEBAR_W, or RAIL_W when collapsed. The
// window's page reports it (supervisor:layout) whenever it changes.
let sidebarWidth = SIDEBAR_W;
const PANEL_W = 380; // the bot window's column width (WINDOW_WIDTH in main.js)

let panelHost = null;           // WebContentsView showing the selected bot's panel
const relay = { name: null, port: null, req: null, retry: null };
// A selected bot that cannot be hosted (an older build), so its row stays
// highlighted while the stage explains why.
let stageOutdated = null;

// The stage is exactly one bot panel wide (Stan, 2026-10-18): the panel was
// designed as a 380px column, and at that width it fills the stage with no
// gaps to paint. So the window's width is fixed at sidebar + panel, and only
// its height is the user's. Collapsing the sidebar shrinks the window by the
// sidebar's width (its left edge stays put), which leaves almost exactly the
// old single-bot window: the beginner's view, one click away.
function fitWindowWidth() {
  if (!win || win.isDestroyed()) return;
  const contentW = sidebarWidth + PANEL_W;
  const [, contentH] = win.getContentSize();
  const frameW = win.getSize()[0] - win.getContentSize()[0];
  // Unlock, resize, then pin the width again: min = max is how Electron
  // allows vertical resizing only.
  win.setMinimumSize(0, 0);
  win.setMaximumSize(10000, 10000);
  win.setContentSize(contentW, contentH);
  win.setMinimumSize(contentW + frameW, 520);
  win.setMaximumSize(contentW + frameW, 10000);
}

function layoutShell() {
  if (!win || win.isDestroyed() || !panelHost) return;
  const [w, h] = win.getContentSize();
  const stageW = Math.max(0, w - sidebarWidth);
  const pw = Math.min(PANEL_W, stageW);
  panelHost.setBounds({ x: sidebarWidth + Math.floor((stageW - pw) / 2), y: 0, width: pw, height: h });
}

function closeRelayStream() {
  if (relay.retry) { clearTimeout(relay.retry); relay.retry = null; }
  if (relay.req) { try { relay.req.destroy(); } catch { /* already closed */ } relay.req = null; }
}

// Subscribe to the selected bot's pushes and replay each one onto the panel
// view, as if the bot had sent it there itself.
function openRelayStream() {
  const http = require('http');
  const { name, port } = relay;
  const req = http.get({
    host: '127.0.0.1', port, path: '/api/panel/events',
    headers: { Accept: 'text/event-stream', ...botAuthHeaders(port) },
  }, (res) => {
    if (res.statusCode !== 200) {
      console.warn(`[supervisor] ${name}'s panel relay answered HTTP ${res.statusCode}${res.statusCode === 404 ? ' (a build without /api/panel)' : ''}`);
      res.resume();
      return;
    }
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
        if (!data) continue; // a ': ping' comment
        let msg;
        try { msg = JSON.parse(data); } catch { continue; }
        if (panelHost && !panelHost.webContents.isDestroyed() && relay.name === name) {
          panelHost.webContents.send(msg.channel, ...(Array.isArray(msg.args) ? msg.args : []));
        }
      }
    });
    res.on('end', () => onRelayDropped(name));
  });
  req.on('error', () => onRelayDropped(name));
  relay.req = req;
}

// The stream ended: the bot quit, crashed or restarted. Re-resolve it by
// profile (a restart can land on another port) and resubscribe, or clear
// the stage if it is gone.
function onRelayDropped(name) {
  if (relay.name !== name) return;
  relay.req = null;
  relay.retry = setTimeout(async () => {
    relay.retry = null;
    if (relay.name !== name) return;
    const inst = (await scanRunning().catch(() => new Map())).get(name);
    if (!inst) { deselectBot(); return; }
    const moved = inst.port !== relay.port;
    relay.port = inst.port;
    openRelayStream();
    if (moved && panelHost) panelHost.webContents.reload();
  }, 2000);
}

function deselectBot() {
  closeRelayStream();
  relay.name = null;
  relay.port = null;
  if (panelHost) panelHost.setVisible(false);
  pushState({ selected: null });
  installMenu();
}

// Does this bot carry the panel relay? A bot started by an older build does
// not, and its panel would load and then fail on every call.
async function canHost(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/panel/ping`, {
      headers: botAuthHeaders(port), signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function selectBot(name, { startScreen = null } = {}) {
  const inst = (await scanRunning()).get(name);
  if (!inst) return { ok: false, error: 'not running' };
  // Already on the stage and connected: leave the panel be. A headless bot
  // asks to be shown during a join (its window "coming forward"), and
  // reloading here threw away the panel's in-call view mid-call.
  if (relay.name === name && relay.port === inst.port && relay.req && panelHost && !panelHost.webContents.isDestroyed()) {
    panelHost.setVisible(true);
    return { ok: true, port: inst.port, already: true };
  }
  if (!(await canHost(inst.port))) {
    // Say so on the stage instead of hosting a panel that cannot reach its bot.
    closeRelayStream();
    relay.name = null;
    relay.port = null;
    if (panelHost) panelHost.setVisible(false);
    stageOutdated = name;
    pushState({ selected: null, outdated: name });
    return { ok: false, code: 'outdated', error: 'running an older version of the app' };
  }
  closeRelayStream();
  stageOutdated = null;
  relay.name = name;
  relay.port = inst.port;
  // Stream first, then load, so nothing the bot pushes while the panel boots
  // is lost. The panel asks for its initial state itself, over invoke.
  openRelayStream();
  // startScreen: the panel's own ?startScreen= (a new bot opens on Settings).
  panelHost.webContents.loadFile(path.join(__dirname, 'renderer', 'panel.html'),
    startScreen ? { search: `startScreen=${startScreen}` } : undefined);
  panelHost.setVisible(true);
  layoutShell();
  pushState({ selected: name });
  installMenu();
  // Where the app reopens next time (resumeLastBot).
  try { store.set('lastSelectedBot', name); } catch { /* best-effort */ }
  return { ok: true, port: inst.port };
}

// A sidebar click. A bot that is not up yet is started behind the scenes; the
// previous bot's panel comes off the stage at once, so the window's own
// "Waking up…" placeholder (drawn by supervisor.html from the bot's face and
// name, already on disk) shows until the new panel replaces it.
// "Show me this bot": from a hosted bot's notification, focus request or
// relaunch (over its child channel, or /api/select from a bot we did not
// start), and from agents. So the window comes forward too.
async function showBot(name) {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  app.focus({ steal: true });
  return openBot(name); // same as a sidebar click
}

async function openBot(name) {
  const up = (await scanRunning()).has(name);
  if (!up) {
    closeRelayStream();
    relay.name = null;
    relay.port = null;
    if (panelHost) panelHost.setVisible(false);
    pushState({ waking: name });
  }
  const result = await whenUp(name, () => selectBot(name));
  // An outdated bot already explained itself on the stage (selectBot).
  if (!result?.ok && result?.code !== 'outdated') pushState({ waking: null, wakeFailed: name, error: result?.error || null });
  return result;
}

// The sidebar's "New bot": made the same way a bot's own "New bot…" makes one
// (new-bot.js: the first free botN folder, a random name and background), then
// started headless and put on the stage, opened on its Settings page, which
// is a new bot's next step (name, voice, face).
// ── Sessions: your Claude Code sessions, any of which can become a bot ──────
//
// Seth's idea: a session you already have carries context about real work, so
// giving it a face means a bot that can talk about that work from the start.
// The list is claude-sessions.js; making the bot reuses the adopt path every
// bot creation already has (new-bot.js seedNewBot's `adopt`): the new profile
// resumes THAT session, in its folder, instead of opening one of its own.

const EMOJI_SETS = [
  { id: 'fluent3d', label: 'Fluent 3D' },
  { id: 'redpanda', label: 'Red Panda' },
  { id: 'noto', label: 'Noto' },
  { id: 'twemoji', label: 'Twemoji' },
  { id: 'openmoji', label: 'OpenMoji' },
  { id: 'native', label: 'System' },
];

let lastSessions = new Map(); // id -> session, from the last list drawn

// Which bot already resumes this session, if any (a bot pinned to it by id).
function botsBySession() {
  const out = new Map();
  for (const bot of readFleet(paths.profilesRoot)) {
    try {
      const cfgPath = path.join(paths.profilesRoot, bot.name, 'agent', 'config.json');
      const cfg = JSON.parse(require('fs').readFileSync(cfgPath, 'utf8'));
      if (cfg.agentSession) out.set(String(cfg.agentSession).trim(), bot.botName || bot.name);
    } catch { /* no config yet */ }
  }
  return out;
}

function listSessions() {
  const { listRecentSessions } = require('./claude-sessions.js');
  // A bot's own session is a bot already; and this app's profiles hold nothing else.
  const profiles = paths.profilesRoot + path.sep;
  const sessions = listRecentSessions({ limit: 8, exclude: (cwd) => (cwd + path.sep).startsWith(profiles) });
  const owners = botsBySession();
  lastSessions = new Map(sessions.map((x) => [x.id, x]));
  return sessions.map((x) => ({
    id: x.id, title: x.title, lastPrompt: x.lastPrompt, cwd: x.cwd, mtimeMs: x.mtimeMs,
    bot: owners.get(x.id) || null,
  }));
}

// Every voice a bot could speak in (voice-catalog.js): ElevenLabs with the
// machine's key, a running Voicebox, and the good built-in ones. Cached for a
// few minutes: listing calls ElevenLabs and runs `say`, and the pane asks on
// every click.
let voiceCache = { at: 0, voices: [] };
async function listVoices() {
  if (Date.now() - voiceCache.at < 5 * 60 * 1000 && voiceCache.voices.length) return voiceCache.voices;
  const { listAllVoices } = require('./voice-catalog.js');
  const voices = await listAllVoices({ elevenLabsKey: store.get('ttsApiKey') || '' }).catch(() => []);
  voiceCache = { at: Date.now(), voices };
  return voices;
}

// What the pane needs for one session: its last lines, and suggestions for
// the bot it could become (randomised the way a new bot is, but changeable).
async function sessionDetail(id) {
  const s = lastSessions.get(id);
  if (!s) return { ok: false, error: 'That session is no longer in the list.' };
  const { sessionExcerpt } = require('./claude-sessions.js');
  const voices = await listVoices();
  return { ok: true, session: { id: s.id, title: s.title, lastPrompt: s.lastPrompt, cwd: s.cwd, mtimeMs: s.mtimeMs },
    excerpt: sessionExcerpt(s.file, { max: 6 }), suggestion: await suggestBot(s), emojiSets: EMOJI_SETS,
    voices: voices.map((v) => ({ id: v.id, label: v.label, group: v.group })) };
}

// The bot a session would become, picked at random the way a new bot is:
//   name   a human one, or (App Settings > "Names for bots made from
//          sessions") the session's own, tidied, when it can be said and heard
//          in a call; else a human one, with a note saying why
//   face   a random emoji set
//   voice  a random voice from the best provider there is (ElevenLabs, then
//          Voicebox, then the good built-in voices only)
async function suggestBot(s) {
  const { randomBotName } = require('./bot-names.js');
  const { botNameFromSession } = require('./addressable-name.js');
  let taken = [];
  try { taken = profileManager.takenBotNames(paths.profilesRoot); } catch { /* none */ }
  let name = null;
  let nameNote = null;
  if ((store.get('sessionBotNames') || 'human') === 'session' && s) {
    const fromSession = botNameFromSession(s.title);
    if (fromSession && !taken.includes(fromSession)) name = fromSession;
    else nameNote = fromSession
      ? `Another bot is already called ${fromSession}, so this is a human name instead.`
      : "This session's name would be hard to say and hear in a call, so this is a human name instead.";
  }
  if (!name) name = randomBotName({ taken });
  const sets = EMOJI_SETS.filter((e) => e.id !== 'native');
  const { pickRandomVoice } = require('./voice-catalog.js');
  const voice = pickRandomVoice(await listVoices());
  return { name, nameNote, emojiSet: sets[Math.floor(Math.random() * sets.length)].id, voice: voice ? voice.id : '' };
}

async function createBotFromSession({ id, name, emojiSet, voice } = {}) {
  const s = lastSessions.get(id);
  if (!s) return { ok: false, error: 'That session is no longer in the list.' };
  const { nextBotProfileName, seedNewBot } = require('./new-bot.js');
  const profile = nextBotProfileName(paths.profilesRoot);
  const overrides = {};
  if (name && String(name).trim()) overrides.botName = String(name).trim().slice(0, 40);
  if (EMOJI_SETS.some((e) => e.id === emojiSet)) overrides.emojiSet = emojiSet;
  const picked = voice ? (await listVoices()).find((v) => v.id === voice) : null;
  if (picked) Object.assign(overrides, picked.config);
  seedNewBot(paths.profilesRoot, profile, { adopt: { workdir: s.cwd, session: s.id, botName: overrides.botName || s.title }, overrides });
  console.log(`[supervisor] new bot "${profile}" from session ${s.id} (${JSON.stringify(s.title)}) in ${s.cwd}`);
  closeRelayStream();
  relay.name = null;
  relay.port = null;
  if (panelHost) panelHost.setVisible(false);
  pushState({ created: profile, waking: profile });
  const result = await launchThenAct({
    isRunning: async () => (await scanRunning()).has(profile),
    launch: () => launchProfile(profile),
    act: () => selectBot(profile),
  });
  if (!result?.ok) pushState({ waking: null, wakeFailed: profile, error: result?.error || null });
  return { ...result, name: profile };
}

async function createBot() {
  const { nextBotProfileName, seedNewBot } = require('./new-bot.js');
  const name = nextBotProfileName(paths.profilesRoot);
  seedNewBot(paths.profilesRoot, name);
  closeRelayStream();
  relay.name = null;
  relay.port = null;
  if (panelHost) panelHost.setVisible(false);
  pushState({ created: name, waking: name });
  const result = await launchThenAct({
    isRunning: async () => (await scanRunning()).has(name),
    launch: () => launchProfile(name, { openSettings: true }),
    act: () => selectBot(name, { startScreen: 'settings' }),
  });
  if (!result?.ok) pushState({ waking: null, wakeFailed: name, error: result?.error || null });
  return { ...result, name };
}

async function relayPost(pathname, body) {
  if (!relay.port) throw new Error('no bot selected');
  const res = await fetch(`http://127.0.0.1:${relay.port}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...botAuthHeaders(relay.port) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function installRelayIpc() {
  const fromPanel = (e) => panelHost && e.sender === panelHost.webContents;
  // The pane's own "Delete <bot>" (bottom of its Edit page) acts on the bot it
  // shows: deleting is the app window's job, not the bot's.
  ipcMain.handle('relay:delete-bot', async (e) => {
    if (!fromPanel(e)) throw new Error('relay:delete-bot is for the hosted panel only');
    if (!relay.name) return { ok: false, error: 'no bot selected' };
    return deleteBot(relay.name);
  });
  ipcMain.handle('relay:can-delete-bot', (e) => {
    if (!fromPanel(e)) throw new Error('relay:can-delete-bot is for the hosted panel only');
    if (!relay.name) return { ok: false };
    return relay.name === paths.defaultProfile ? { ok: false, reason: 'default' } : { ok: true };
  });
  ipcMain.handle('relay:invoke', async (e, channel, args) => {
    if (!fromPanel(e)) throw new Error('relay:invoke is for the hosted panel only');
    return (await relayPost('/api/panel/invoke', { channel, args })).result;
  });
  ipcMain.on('relay:send', (e, channel, args) => {
    if (!fromPanel(e)) return;
    relayPost('/api/panel/send', { channel, args })
      .catch((err) => console.warn(`[supervisor] relay send "${channel}" failed:`, err.message));
  });
  ipcMain.on('relay:copy', (e, text) => { if (fromPanel(e)) clipboard.writeText(text); });
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
  const busy = [...running.values()].filter((i) => i.callStatus && i.callStatus !== 'idle').length;
  const detail = [
    running.size
      ? `This stops ${running.size === 1 ? 'the 1 bot' : `all ${running.size} bots`} that ${running.size === 1 ? 'is' : 'are'} running.`
      : 'No bots are running right now.',
    ...(busy ? ['', `${busy === 1 ? '1 bot is' : `${busy} bots are`} in a call, and will leave it.`] : []),
    '',
    'Scheduled meetings will not auto-join while the app is closed.',
  ].join('\n');

  const { response, checkboxChecked } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Keep running', 'Quit anyway'],
    defaultId: 0,
    cancelId: 0,
    title: 'Quit Vibeconferencing?',
    message: 'Quit Vibeconferencing?',
    detail,
    checkboxLabel: "Don't ask again",
    checkboxChecked: false,
    noLink: true,
  }).catch(() => ({ response: 0, checkboxChecked: false }));

  if (checkboxChecked) store.set('confirmSupervisorQuit', false);
  if (response !== 1) return;
  appQuitCause = 'the user quit, confirmed in the dialog';
  quitting = true;
  app.quit();
}

// A person asking to quit: the window's ✕, or Cmd+Q from the menu below. Both
// get the dialog. Guarded so a second Cmd+Q while it is up does not stack a
// second one.
let confirming = false;
// Why the app is quitting, for the log (#301: bots vanished mid-call and nothing said why).
let appQuitCause = null;
async function requestQuit() {
  if (quitting || store.get('confirmSupervisorQuit') === false) { appQuitCause = appQuitCause || 'the user quit (Cmd+Q or closing the window; no confirmation asked)'; quitting = true; app.quit(); return; }
  if (confirming) return;
  confirming = true;
  try { await confirmQuit(); } finally { confirming = false; }
}

// On macOS the default menu's Quit calls app.quit() directly, which is the same
// 'before-quit' a SIGTERM, a logout or Dock → Quit produces, and those must NOT
// wait on a dialog (see the before-quit handler in start()). So Cmd+Q gets its
// own item that asks first. Elsewhere there is no app menu; closing the window
// is the gesture, and the close handler covers it.
//
// There is no Bot menu. It ran the SELECTED bot's items, and with several bots
// in one window "Bot" no longer says which one; everything it held is on the
// bot's own panel (gear, 👀, brain, ⓘ) except Navigate Webview, which is in
// the bot's … menu in the sidebar (navigateWebview below).

// Navigate Webview… for one bot, from its row menu. The URL prompt is that
// bot's panel, so the bot comes on stage first; then its own menu item runs.
async function navigateWebview(name) {
  if (relay.name !== name) await selectBot(name);
  if (!relay.port) return { ok: false, error: 'that bot is not running' };
  try {
    await relayPost('/api/panel/invoke', { channel: 'bot-menu-click', args: ['Navigate Webview…'] });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Updates belong to the installed app, so the app window owns them, once for
// the machine; the bots it hosts don't check (#301, app-updater.js). Installing
// waits for every bot to be out of its call, and stops them first.
let appUpdater = null;
function startAppUpdates() {
  appUpdater = require('./app-updater.js').createAppUpdater({
    app,
    baseUserData: paths.baseUserData,
    profile: 'app window',
    updateChannel: () => store.get('updateChannel') || 'release',
    dialogParent: () => win,
    bringForward: () => { try { app.focus({ steal: true }); } catch { /* not here */ } },
    installBlocked: async () => {
      const busy = [...(await scanRunning()).values()].some((inst) => require('@vibeconferencing/calls/core/call-phase.js').isBusy(inst.callStatus));
      return busy ? 'in-call' : null;
    },
    beforeInstall: async () => {
      appQuitCause = 'installing an update';
      quitting = true;
      await stopAllBots();
      botsStopped = true;
    },
    log: (...a) => console.log('[supervisor] [updates]', ...a),
    warn: (...a) => console.warn('[supervisor] [updates]', ...a),
  });
  appUpdater.start();
}

// App settings are machine-wide, but the window that edits them lives in the
// bots' code, so the selected bot opens it.
function openAppSettings() {
  if (!relay.port) return;
  relayPost('/api/panel/invoke', { channel: 'open-app-settings', args: [] })
    .catch((err) => console.warn('[supervisor] could not open App Settings:', err.message));
}

function installMenu() {
  if (process.platform !== 'darwin') return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => { if (appUpdater) appUpdater.check({ silentWhenCurrent: false }); } },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Command+,', enabled: !!relay.port, click: () => openAppSettings() },
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
  // A window means a Dock icon, even for a supervisor that started in the background.
  // The app's own icon, not Electron's: a packaged build gets it from the
  // bundle, but run from source the Dock shows Electron's (the bot sets the
  // same in main.js).
  if (app.dock) {
    app.dock.show();
    try { app.dock.setIcon(require('electron').nativeImage.createFromPath(path.join(__dirname, 'icon.png'))); } catch { /* keep the default */ }
  }
  win = new BrowserWindow({
    // Sized by content, so the stage is exactly PANEL_W; see fitWindowWidth.
    useContentSize: true,
    width: SIDEBAR_W + PANEL_W,
    height: 760,
    minHeight: 520,
    backgroundColor: '#FFF4DA', // --cream, so nothing flashes dark before the page paints
    title: 'Vibeconferencing',
    icon: path.join(__dirname, 'icon.png'), // Windows / Linux taskbar
    webPreferences: {
      preload: path.join(__dirname, 'preload-supervisor.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'supervisor.html'));

  panelHost = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-panel-relay.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  panelHost.setBackgroundColor('#FFF4DA');
  // The hosted panel's own warnings and errors, in the supervisor's log: the
  // first place a relay gap (a call that did not cross) shows up.
  panelHost.webContents.on('console-message', (e) => {
    const level = e.level ?? e.params?.level;
    if (level === 'warning' || level === 'error' || level === 2 || level === 3) {
      console.log(`[panel:${relay.name || '-'}] ${e.message ?? e.params?.message}`);
    }
  });
  panelHost.setVisible(false);
  win.contentView.addChildView(panelHost);
  win.on('resize', layoutShell);
  fitWindowWidth();
  layoutShell();

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
  win.on('closed', () => { win = null; panelHost = null; closeRelayStream(); relay.name = null; relay.port = null; });
}

// ── Entry ───────────────────────────────────────────────────────────────────

// Reopen where you left off: the bot last on the stage, else the one most
// recently in a call, else the default bot (which also covers a first run,
// before any bot has been selected or used).
function resumeLastBot() {
  const target = pickResumeBot({
    fleet: readFleet(paths.profilesRoot),
    last: store.get('lastSelectedBot'),
    defaultProfile: paths.defaultProfile,
  });
  if (!target) return;
  openBot(target).catch((err) => console.warn('[supervisor] could not reopen the last bot:', err.message));
}

// --background: started by a bot someone launched by hand, so no window (and
// no Dock icon) until it is asked for: a second launch, a "show me" from a bot,
// a notification. A plain launch of the app is the opposite: the window, now.
const BACKGROUND = process.argv.includes('--background');

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
  app.on('before-quit', (event) => {
    quitting = true;
    if (botsStopped) return;
    // Hold the quit until the bots have been asked to stop, then quit for real.
    event.preventDefault();
    console.log(`[supervisor] QUITTING: ${appQuitCause || 'unattributed (a signal, Dock > Quit, logout or shutdown)'}`);
    stopAllBots().finally(() => { botsStopped = true; app.quit(); });
  });
  app.on('second-instance', () => {
    // A second launch can arrive before this one is ready (it was started
    // --background, or is still booting): creating the window then throws
    // "Cannot create BrowserWindow before app is ready" as a modal error in the
    // main process (seen 2026-10-23). Wait for ready instead.
    app.whenReady().then(() => {
      if (!win || win.isDestroyed()) { createWindow(); resumeLastBot(); return; }
      if (win.isMinimized()) win.restore();
      win.focus();
    });
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
    ipcMain.handle('supervisor:select', (_e, name) => selectBot(name));
    ipcMain.handle('supervisor:account', () => fetchAccount());
    ipcMain.handle('supervisor:app-settings', () => { openAppSettings(); return { ok: true }; });
    ipcMain.handle('supervisor:navigate-webview', (_e, name) => navigateWebview(name));
    // The account line opens your page on the website. Built here from the
    // configured site, never from a URL the page hands over.
    ipcMain.handle('supervisor:open-account', () => { shell.openExternal(`${websiteBase()}/me`); return { ok: true }; });
    ipcMain.handle('supervisor:new-bot', () => createBot());
    ipcMain.handle('supervisor:sessions', () => listSessions());
    ipcMain.handle('supervisor:session-detail', (_e, id) => sessionDetail(id));
    ipcMain.handle('supervisor:suggest-bot', (_e, id) => suggestBot(lastSessions.get(id)));
    ipcMain.handle('supervisor:create-bot-from-session', (_e, opts) => createBotFromSession(opts));
    // A session on the stage: the bot panel steps aside for it.
    ipcMain.handle('supervisor:clear-stage', () => { deselectBot(); return { ok: true }; });
    // Signing in is a bot's job today (it owns the browser-based login flow), so
    // the footer's Sign in goes through whichever bot is on the stage.
    ipcMain.handle('supervisor:sign-in', async () => {
      if (!relay.port) return { ok: false, error: 'select a bot first' };
      await relayPost('/api/panel/invoke', { channel: 'login', args: [] });
      return { ok: true };
    });
    ipcMain.handle('supervisor:layout', (_e, { sidebarWidth: w } = {}) => {
      sidebarWidth = w === RAIL_W ? RAIL_W : SIDEBAR_W; // only the two widths the page has
      fitWindowWidth();
      layoutShell();
      return { ok: true };
    });
    // A sidebar click: show the bot, starting it first if it is closed.
    ipcMain.handle('supervisor:open', (_e, name) => openBot(name));
    installRelayIpc();
    ipcMain.handle('supervisor:focus', (_e, name) => focusProfile(name));
    ipcMain.handle('supervisor:call', (_e, name) => startCall(name));
    ipcMain.handle('supervisor:add', (_e, name, url) => addToCall(name, url));
    ipcMain.handle('supervisor:stop-bot', (_e, name) => stopBotNow(name));
    ipcMain.handle('supervisor:delete-bot', (_e, name) => deleteBot(name));
    ipcMain.handle('supervisor:restart-bot', (_e, name) => restartOutdatedBot(name));
    ipcMain.handle('supervisor:reveal', (_e, name) => {
      // A profile name, never a path: nothing outside the profiles folder.
      if (!profileManager.isValidProfileName(name)) return { ok: false, error: 'invalid bot' };
      shell.openPath(path.join(profilesRoot, String(name || ''), 'agent'));
      return { ok: true };
    });

    startDirectory();
    startBrowserScan();
    installAgentIntegration();
    reapTimer = setInterval(() => { reapTick().catch((err) => console.warn('[supervisor] reaper failed:', err.message)); }, REAP_EVERY_MS);
    startAppUpdates();
    installMenu();
    if (BACKGROUND) {
      if (app.dock) app.dock.hide();
    } else {
      createWindow();
      resumeLastBot();
    }
    tick().catch((err) => console.warn('[supervisor] first tick failed:', err.message));
    pollTimer = setInterval(() => {
      tick().catch((err) => console.warn('[supervisor] tick failed:', err.message));
      // A build staged mid-call is offered once every bot is out (no-op otherwise).
      if (appUpdater && appUpdater.staged) appUpdater.offerStaged().catch(() => {});
    }, POLL_MS);
  });

  app.on('window-all-closed', () => {
    if (pollTimer) clearInterval(pollTimer);
    if (scanTimer) clearInterval(scanTimer);
    if (reapTimer) clearInterval(reapTimer);
    if (directory) directory.close();
    app.quit();
  });
}

module.exports = { start, tick, fleetStatus, launchProfile, scanRunning };
