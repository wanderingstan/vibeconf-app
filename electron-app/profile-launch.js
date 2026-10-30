// profile-launch.js — how to spawn a SECOND instance of this app for another
// bot profile, per platform.
//
// Extracted from main.js as part of #746. It lived inline as a single macOS
// code path — `open -n <bundle> --args …` — which meant switching bots could
// never work on Linux or Windows: `open` is macOS-specific, and on Ubuntu the
// name resolves to xdg-open, which rejects `-n` outright. It failed in ~30ms
// on every box and surfaced to the user as an 8-second timeout.
//
// The point of pulling it out is that this is the part worth testing, and an
// Electron main file is not importable from `node --test`. Keep it pure: no
// `app`, no `process.platform`, no spawning — callers pass what they know and
// get back an argv to run.
//
// #301: the supervisor window launches bots too, so the profile flags are
// built here as well (spawnArgsForProfile) — two copies of "how a bot is
// started" is exactly the drift that lands a bot on the wrong port.

/**
 * Build the command that launches another profile instance.
 *
 * @param {object}   o
 * @param {string}   o.platform    process.platform of the CURRENT process
 * @param {boolean}  o.isPackaged  app.isPackaged
 * @param {string}   o.exePath     app.getPath('exe')
 * @param {string}   o.appPath     app.getAppPath() — only used unpackaged
 * @param {string[]} o.args        profile flags, e.g. ['--profile=jimmy', '--local-port=7871']
 * @returns {{ cmd: string, argv: string[], detached: boolean }}
 */
function profileLaunchCommand({ platform, isPackaged, exePath, appPath, args = [] }) {
  if (!isPackaged) {
    // Dev: re-run this Electron binary against the same app directory.
    return { cmd: exePath, argv: [appPath, ...args], detached: true };
  }

  if (platform === 'darwin') {
    // The unit to launch is the .app BUNDLE, and `open -n` is the only way to
    // get a second instance of one. Exec'ing the inner Mach-O directly does
    // run, but detached from the bundle — no LaunchServices registration, no
    // Dock identity — so open(1) stays.
    //
    // `--args` is open(1)'s separator between the bundle and the arguments
    // handed to it; with no arguments it must be omitted entirely.
    const appBundle = exePath.replace(/\/Contents\/MacOS\/[^/]+$/, '');
    return {
      cmd: 'open',
      argv: args.length ? ['-n', appBundle, '--args', ...args] : ['-n', appBundle],
      detached: false, // open(1) returns immediately; the app is not our child
    };
  }

  // Linux / Windows: no bundle, no open(1). Run the executable itself and pass
  // the profile flags as ordinary argv — there is no `--args` convention here,
  // and forwarding one would make the flags invisible to the new instance.
  return { cmd: exePath, argv: [...args], detached: true };
}

// The command line for a bot instance.
//
// `isDefault`: the default profile takes NO --profile and NO --local-port — it
// is the privileged seat that owns DEFAULT_PORT and the global Claude MCP
// config, and passing its name explicitly would make it look like a named
// profile to the receiving process.
//
// `windowPos`: #379 — open the new window where the launching one is, rather
// than centred. Position only; size is not ours to hand over, since the window
// is a fixed-width column with a content-derived height.
function spawnArgsForProfile({ name, isDefault = false, port = null, openSettings = false, windowPos = null, headless = false } = {}) {
  const args = [];
  if (!isDefault) {
    if (!name) throw new Error('a named profile needs a name');
    if (!port) throw new Error(`profile "${name}" needs a local port`);
    args.push(`--profile=${name}`, `--local-port=${port}`);
  }
  // A newly created bot lands on Settings rather than "Call now" — it has no
  // name, voice or face yet, so that page IS its next step.
  if (openSettings) args.push('--open-settings=true');
  // #301: a bot whose UI lives in the supervisor's window. No window of its
  // own, no Dock icon; see HEADLESS in main.js. Spelled --hosted because
  // --headless is Chromium's own switch, which stops windows drawing at all.
  if (headless) args.push('--hosted=true');
  if (windowPos && Number.isFinite(windowPos.x) && Number.isFinite(windowPos.y)) {
    args.push(`--window-x=${windowPos.x}`, `--window-y=${windowPos.y}`);
  }
  return args;
}

// Is a supervisor answering? One request to its fixed address (#301).
//
// Short timeout on purpose: this runs on a bot's startup path, and a bot must
// never be slower to appear because the coordinator is wedged. Unreachable is
// answered as "no", which costs a duplicate launch attempt that the
// single-instance lock then refuses — the cheap direction to be wrong in.
async function supervisorIsRunning({ url, fetchImpl = fetch, timeoutMs = 700 } = {}) {
  try {
    const res = await fetchImpl(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = await res.json();
    return !!body?.ok;
  } catch {
    return false;
  }
}

// A bot starting another bot: ask the app window to do it, so the new bot lives in
// that window like one started from the sidebar, instead of floating free in a
// window of its own. Null means nobody answered, so the caller launches it itself.
//
// `show` puts the new bot on the window's stage, for a launch someone asked for.
// A calendar wake-up leaves it off, so it doesn't take over what's on screen.
async function launchThroughSupervisor({ url, name, openSettings = false, extraArgs = [], show = false, fetchImpl = fetch, timeoutMs = 2000 } = {}) {
  const query = new URLSearchParams({ profile: name });
  if (openSettings) query.set('open-settings', '1');
  if (show) query.set('show', '1');
  let res;
  try {
    // The args go in the body because a join link can carry a passcode.
    res = await fetchImpl(`${url}/api/launch?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extraArgs }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }
  const body = await res.json().catch(() => null);
  if (!body) return null;
  if (!body.ok) return { ok: false, error: body.error || `the app window answered ${res.status}` };
  if (body.already) return { ok: true, focused: true, port: body.port };
  return { ok: true, launched: true, port: body.port };
}

// What a bot may ask the app window to pass to the bot it starts. The endpoint is
// on localhost but has no token, so it must not become a way to set any flag.
function allowedLaunchArgs(extraArgs) {
  return (Array.isArray(extraArgs) ? extraArgs : [])
    .filter((a) => typeof a === 'string' && (a.startsWith('--join-url=') || a === '--summoned=true'));
}

module.exports = { profileLaunchCommand, spawnArgsForProfile, supervisorIsRunning, launchThroughSupervisor, allowedLaunchArgs };
