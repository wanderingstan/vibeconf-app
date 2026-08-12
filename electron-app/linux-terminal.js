// linux-terminal.js — build the Linux agent-terminal invocation (#329).
//
// macOS hosts the driving agent by writing an AppleScript that TYPES a shell
// command into Terminal.app. Linux has no equivalent, and the whole path is
// osascript-only today, so on Linux the visible-terminal hosting option
// silently does nothing (#317: Gabriel's bot sat with "no agent activity" and
// Claude was never started).
//
// TMUX IS AN UPGRADE, NOT A REQUIREMENT.
//
// An earlier draft of this made tmux mandatory. That was wrong, and wrong in a
// way that would have reproduced #317 with a new cause: tmux is not installed
// by default on a stock Ubuntu desktop or on a minimal server image, so
// "requires tmux" means "silently no agent" on the very machines we are trying
// to fix. For an ordinary Linux desktop user a plain terminal is all that is
// wanted, and it is what macOS already gives them.
//
// So there are two shapes, and the caller picks by what is actually installed:
//
//   DIRECT (the common case, no tmux needed):
//     <emulator> -e <claude> <args…>            cwd via spawn options
//
//   TMUX (when tmux is present, and REQUIRED when there is no emulator):
//     tmux new-session -d -s <session> -c <workdir> <claude> <args…>
//     <emulator> -e tmux attach -t <session>     ← skipped when headless
//
// What tmux buys, which is why it wins when available:
//
//   1. The session outlives the window. Close the viewport, crash X, drop an
//      SSH connection: the agent keeps running and you reattach.
//   2. You can attach over plain SSH with `tmux attach`. No VNC, no
//      framebuffer. This is how #324's cloud box gets debugged with no human
//      at the keyboard, and with NO emulator installed it is the only way to
//      have a visible, typeable session at all.
//   3. Scrollback survives for post-mortems.
//
// That third tier is the one that actually blocks #324. Unlike headless
// hosting, you can TYPE at a tmux session: the only known recovery from the
// `navigating` wedge in #324 was a human issuing join_call with force: true,
// and headless wires agent stdout into a read-only activity feed, so it can
// show that the agent is stuck but cannot unstick it.
//
// NO SHELL QUOTING ANYWHERE. This is a deliberate property, and the reason this
// module does not reuse launch-command.js: that exists solely to survive
// AppleScript's double-quoting layer (`asQuoted`), which is macOS-specific and
// has already caused one real bug (the workdir moving to a path with spaces).
// Both shapes above pass argv ARRAYS and set the working directory out of band
// (spawn's `cwd`, or tmux's `-c`), so a bot name containing a quote, a space or
// a dollar sign is just another array element.
//
// Verified against tmux 3.6a: `tmux new-session … cmd arg1 arg2` with MULTIPLE
// arguments execs the argv array directly rather than joining them and handing
// the result to a shell. Probed by passing a final argument containing spaces
// and confirming the child saw ONE token, not three. tmux only involves a shell
// when given a SINGLE command argument, so every builder below emits multiple,
// deliberately. Do not "simplify" one into a joined string; that reintroduces
// exactly the quoting class this avoids.
//
// Pure and separately testable: every function is argv-in, argv-out with no
// process launching, so the awkward parts (session-name sanitizing, the
// per-emulator exec flag) are covered by tests/linux-terminal.test.mjs without
// needing tmux, an X display, or Claude Code installed.

// Terminal emulators we know how to drive, in preference order, with the flag
// each one uses to mean "run this argv instead of a shell".
//
// xterm is FIRST on purpose. It is tiny, always packageable, present on
// essentially every X install, and it behaves: a real child process with a pid
// we own, which is what makes viewport teardown reliable.
//
// gnome-terminal is deliberately ABSENT. It is a thin client to a
// dbus-activated server, so it forks, returns immediately, and hands back a pid
// that is not the terminal. We would have nothing to kill.
//
// x-terminal-emulator (Debian/Ubuntu's alternatives symlink) is included but
// ranked LAST, because it can resolve to anything in the alternatives group and
// we cannot know what. On the Ubuntu 24.04 test box it pointed at zutty (which
// does honour -e, verified); on a desktop install it may equally be
// gnome-terminal. Ranking it last means we only fall back to "whatever this box
// calls a terminal" after the options we have actually tested are gone.
//
// Note the blast radius differs by shape. On the tmux path a badly-behaved
// emulator costs only the viewport handle: the agent still runs and `tmux
// attach` still reaches it. On the direct path the emulator IS the agent's
// host, so a fork-and-return emulator means we cannot reap it — one more
// reason xterm leads the list.
// `reapable: false` means the binary forks and returns, so the pid we get back
// is not the terminal and killing it does nothing. That is only safe in the
// tmux shape, where teardown is kill-session and never depended on the pid. In
// the DIRECT shape it means an agent we cannot stop — the orphan hazard.
//
// EVERY ENTRY HERE WAS RUN ON A REAL BOX. That rule is the whole policy, and it
// came from getting it wrong: an earlier version of this list also carried
// konsole, alacritty and kitty, added from memory "for coverage". They were
// removed, because an unverified entry is not neutral — it RANKS ABOVE the
// generic x-terminal-emulator fallback, so a wrong exec flag would preempt a
// working path with a broken one. The xfce4-terminal result below is exactly
// that failure caught in time: the flag this list originally gave it runs
// NOTHING, which would have presented as a terminal opening to a bare shell
// with no agent — #317 again, with us as the cause.
//
// The remaining three cover the machines that matter: xterm is on essentially
// every graphical Linux install, x-terminal-emulator is Debian/Ubuntu's pointer
// at whatever terminal a box actually uses, and the cloud-TA box (#324) has no
// emulator at all and takes the detached shape. If someone turns up on a box
// none of these handle, that is a bug report with a machine attached, which is
// a better basis for a new entry than recollection.
//
// Measured on Ubuntu 24.04 (tmux 3.4, Xvfb):
//   xterm            -e   reapable; argv passed through intact
//   xfce4-terminal   -x   NOT reapable, even with --disable-server; and -e does
//                         not run the command at all (it takes a single string)
//   x-terminal-emulator -e resolved to zutty here, which honours -e and argv
const TERMINAL_EMULATORS = [
  { bin: 'xterm', execFlag: '-e', reapable: true },
  // -x, NOT -e: verified that -e silently runs nothing here. Marked unreapable
  // from a live probe: the spawned pid exits immediately whether or not
  // --disable-server is passed, so only the tmux shape can clean it up.
  //
  // Worth keeping even though x-terminal-emulator would resolve to it on an
  // XFCE box: this entry exists to carry the measured `reapable: false`. Reached
  // through the symlink instead, it would be assumed reapable and the agent
  // would be orphaned silently.
  { bin: 'xfce4-terminal', execFlag: '-x', reapable: false },
  { bin: 'x-terminal-emulator', execFlag: '-e', reapable: true },
];

// tmux target names are parsed, not opaque: `:` separates session from window
// and `.` separates window from pane, so a session literally named "bot.2" or
// "bot:1" cannot be addressed later — kill-session would miss it and leak the
// agent. Whitespace breaks the same way in practice.
//
// Replace rather than reject: the inputs are a profile name and a port, both of
// which we would rather sanitize than refuse a call over.
function sanitizeSessionName(name) {
  return String(name == null ? '' : name).replace(/[:.\s]/g, '-').replace(/-+/g, '-') || 'bot';
}

// One session per app instance, not per call.
//
// The port is what actually makes it unique: profile bots each own a port
// (7865, 7866, …) and that is precisely the thing that must not collide, since
// two agents pinned to one app is the failure launchClaudeHeadless already
// guards against. The profile name is included only so a human running
// `tmux ls` over SSH can tell which bot is which.
function tmuxSessionName({ profile, port } = {}) {
  const p = sanitizeSessionName(profile || 'default');
  return `vibeconf-${p}-${port}`;
}

// DIRECT shape: the emulator hosts the agent itself. No tmux involved.
//
// The working directory is NOT part of this command — the caller passes it as
// spawn's `cwd`. That is what keeps the macOS `cd "<dir>" &&` prefix, and the
// bug it caused when the workdir gained spaces, from ever existing here.
function buildDirectCommand({ emulator, argv }) {
  if (!emulator) return null;
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('buildDirectCommand: argv must be a non-empty array');
  }
  const args = emulator.execFlag ? [emulator.execFlag, ...argv] : [...argv];
  return { command: emulator.bin, args };
}

// `tmux new-session -d -s <session> -c <workdir> <argv…>`
//
// -d so the session starts detached and the agent begins working immediately,
// whether or not a viewport ever opens. On a headless server (no X, no
// emulator) that is the entire point: the agent runs and we attach later.
//
// -c sets the working directory, replacing the macOS path's `cd "<dir>" &&`
// prefix — one argv element, nothing to split.
function buildTmuxNewSessionArgs({ session, workdir, argv }) {
  if (!session) throw new Error('buildTmuxNewSessionArgs: session is required');
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('buildTmuxNewSessionArgs: argv must be a non-empty array');
  }
  const args = ['new-session', '-d', '-s', session];
  if (workdir) args.push('-c', workdir);
  // Spread, never join. See the header note on multi-arg exec.
  return args.concat(argv);
}

// The tmux viewport: an emulator whose only job is to run `tmux attach`.
//
// Returns null when there is no emulator, which is a NORMAL outcome (a stock
// server image has none) and not an error — the detached session above keeps
// running and is reachable over SSH. That is the #324 case.
function buildViewportCommand({ emulator, session }) {
  if (!emulator || !session) return null;
  const attach = ['tmux', 'attach', '-t', session];
  const args = emulator.execFlag ? [emulator.execFlag, ...attach] : attach;
  return { command: emulator.bin, args };
}

// Teardown for the tmux shape. Killing the SESSION is what ends the agent;
// closing the viewport only hides it.
//
// This is strictly better than the macOS teardown it mirrors. There we track
// Terminal *window IDs* and ask AppleScript to find and close them, which is
// why main.js carries a hazard note about orphaned agents still holding an MCP
// connection and continuing to act. Here the session name is ours, so the kill
// is direct and does not depend on a window still existing.
//
// The DIRECT shape needs none of this: we own the emulator's pid and kill it.
function buildKillSessionArgs({ session }) {
  if (!session) throw new Error('buildKillSessionArgs: session is required');
  return ['kill-session', '-t', session];
}

// Find a usable emulator. `exists` is injected so this is testable without
// caring what is installed on the machine running the tests.
function detectTerminalEmulator({ exists, candidates = TERMINAL_EMULATORS } = {}) {
  if (typeof exists !== 'function') throw new Error('detectTerminalEmulator: exists(bin) is required');
  for (const c of candidates) {
    try { if (exists(c.bin)) return c; } catch { /* probe failure is a miss, not a crash */ }
  }
  return null;
}

// Decide the shape from what is installed. Single place so the policy is
// testable and stated once, rather than smeared through main.js.
//
//   emulator + tmux  → 'tmux'    (best: visible AND survives/reattaches)
//   emulator, no tmux→ 'direct'  (the ordinary desktop case)
//   tmux, no emulator→ 'tmux-detached' (#324's box: no window, SSH-attachable)
//   neither          → null      (caller falls back to headless, then errors)
//
// Preferring tmux when BOTH exist is a judgement call worth stating: the user
// sees the same window either way, and the difference only shows up when
// something goes wrong (window closed by accident, X restarted), where the
// tmux shape recovers and the direct one does not.
function chooseAgentTerminalPlan({ emulator, hasTmux }) {
  if (emulator && hasTmux) return 'tmux';
  if (emulator) return 'direct';
  if (hasTmux) return 'tmux-detached';
  return null;
}

module.exports = {
  TERMINAL_EMULATORS,
  sanitizeSessionName,
  tmuxSessionName,
  buildDirectCommand,
  buildTmuxNewSessionArgs,
  buildViewportCommand,
  buildKillSessionArgs,
  detectTerminalEmulator,
  chooseAgentTerminalPlan,
};
