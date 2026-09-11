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

module.exports = { profileLaunchCommand };
