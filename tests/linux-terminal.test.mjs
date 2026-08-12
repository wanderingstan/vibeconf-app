// linux-terminal.test.mjs — the Linux agent-terminal invocation (#329).
//
// The point of the module under test is that NOTHING here crosses a shell, so
// most of these assert the absence of the quoting class that made
// launch-command.js necessary on macOS. A bot name with a quote in it is the
// recurring adversary.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  TERMINAL_EMULATORS, sanitizeSessionName, tmuxSessionName, buildDirectCommand,
  buildTmuxNewSessionArgs, buildViewportCommand, buildKillSessionArgs,
  detectTerminalEmulator, chooseAgentTerminalPlan,
} = require(join(root, 'electron-app/linux-terminal.js'));

// A name carrying every character that has ever broken a launcher here.
const NASTY = 'Bot "Quotes" $HOME; rm -rf /  && echo';

test('tmux is an upgrade, not a requirement — an emulator alone still yields a plan', () => {
  // The whole correction behind this module: requiring tmux would reproduce
  // #317 (silently no agent) on stock desktops, which do not ship it.
  assert.equal(chooseAgentTerminalPlan({ emulator: TERMINAL_EMULATORS[0], hasTmux: false }), 'direct');
});

test('tmux wins when both are present — it recovers where direct cannot', () => {
  assert.equal(chooseAgentTerminalPlan({ emulator: TERMINAL_EMULATORS[0], hasTmux: true }), 'tmux');
});

test('no emulator but tmux is the #324 box: detached, not a failure', () => {
  // The cloud TA machine has no X and no terminal emulator. A detached session
  // is the ONLY way to get something a human can later type at over SSH, which
  // is what headless hosting cannot offer.
  assert.equal(chooseAgentTerminalPlan({ emulator: null, hasTmux: true }), 'tmux-detached');
});

test('neither available returns null, so the caller can fall back loudly', () => {
  // null, not a throw: #317's lesson is that the failure must be reported, and
  // #329 asks for terminal → headless → loud error, never a silent no-agent.
  assert.equal(chooseAgentTerminalPlan({ emulator: null, hasTmux: false }), null);
});

test('gnome-terminal is not in the emulator list', () => {
  // It is a dbus-activated thin client: forks, returns immediately, and hands
  // back a pid that is not the terminal, so there is nothing to reap.
  assert.equal(TERMINAL_EMULATORS.some((e) => e.bin === 'gnome-terminal'), false);
});

test('xterm is preferred over the Debian alternatives symlink', () => {
  // x-terminal-emulator frequently points AT gnome-terminal on Ubuntu desktop,
  // so it must rank below the emulators we know behave.
  const names = TERMINAL_EMULATORS.map((e) => e.bin);
  assert.equal(names[0], 'xterm');
  assert.ok(names.indexOf('xterm') < names.indexOf('x-terminal-emulator'));
});

test('xfce4-terminal uses -x, not -e', () => {
  // -e on xfce4-terminal takes a SINGLE string and would re-introduce quoting;
  // -x takes the rest of argv. Getting this backwards is silent breakage.
  assert.equal(TERMINAL_EMULATORS.find((e) => e.bin === 'xfce4-terminal').execFlag, '-x');
});

test('an emulator with no exec flag gets the command directly, with no stray flag', () => {
  const kitty = TERMINAL_EMULATORS.find((e) => e.bin === 'kitty');
  const cmd = buildDirectCommand({ emulator: kitty, argv: ['claude', '--model', 'opus'] });
  assert.deepEqual(cmd, { command: 'kitty', args: ['claude', '--model', 'opus'] });
});

test('direct: a nasty bot name stays exactly ONE argv element', () => {
  const cmd = buildDirectCommand({
    emulator: TERMINAL_EMULATORS[0],
    argv: ['claude', '-p', `/join-call abc ${NASTY}`],
  });
  assert.deepEqual(cmd, { command: 'xterm', args: ['-e', 'claude', '-p', `/join-call abc ${NASTY}`] });
  // The real assertion: nothing anywhere escaped, wrapped or joined it.
  assert.equal(cmd.args.filter((a) => a.includes(NASTY)).length, 1);
  assert.equal(cmd.args.some((a) => a.includes('\\"')), false, 'no AppleScript-style escaping should appear');
});

test('direct carries no working directory — that belongs to spawn cwd', () => {
  // macOS prefixes `cd "<dir>" &&`, which broke when the agent dir moved under
  // "Application Support". There is no cd here to break.
  const cmd = buildDirectCommand({ emulator: TERMINAL_EMULATORS[0], argv: ['claude'] });
  assert.equal(cmd.args.some((a) => a.startsWith('cd ') || a.includes('&&')), false);
});

test('tmux new-session passes argv as separate elements, never joined', () => {
  // Verified against tmux 3.6a: MULTIPLE arguments are exec'd directly; a
  // SINGLE argument goes through a shell. Joining would silently re-introduce
  // the quoting bug class this module exists to avoid.
  const args = buildTmuxNewSessionArgs({
    session: 'vibeconf-default-7865',
    workdir: '/home/u/Application Support/agent',
    argv: ['claude', '-p', `/join-call abc ${NASTY}`],
  });
  assert.deepEqual(args, [
    'new-session', '-d', '-s', 'vibeconf-default-7865',
    '-c', '/home/u/Application Support/agent',
    'claude', '-p', `/join-call abc ${NASTY}`,
  ]);
  // The workdir with a space is one element, so nothing can split it.
  assert.equal(args.filter((a) => a === '/home/u/Application Support/agent').length, 1);
});

test('tmux new-session is always detached, so the agent starts without a window', () => {
  // This is what makes the no-emulator (#324) case work at all.
  const args = buildTmuxNewSessionArgs({ session: 's', argv: ['claude'] });
  assert.ok(args.includes('-d'));
});

test('a workdir is optional and simply omitted, not passed as empty', () => {
  const args = buildTmuxNewSessionArgs({ session: 's', argv: ['claude'] });
  assert.equal(args.includes('-c'), false);
  assert.equal(args.includes(''), false);
});

test('an empty argv is rejected rather than launching a bare shell', () => {
  // A session that silently opens a shell instead of the agent is #317 again:
  // it looks alive and does nothing.
  assert.throws(() => buildTmuxNewSessionArgs({ session: 's', argv: [] }), /non-empty/);
  assert.throws(() => buildDirectCommand({ emulator: TERMINAL_EMULATORS[0], argv: [] }), /non-empty/);
});

test('session names strip tmux target punctuation', () => {
  // ':' separates session from window and '.' separates window from pane, so a
  // session containing either cannot be addressed later and kill-session would
  // miss it, leaking an agent that still holds an MCP connection.
  assert.equal(sanitizeSessionName('bot.2'), 'bot-2');
  assert.equal(sanitizeSessionName('bot:1'), 'bot-1');
  assert.equal(sanitizeSessionName('my bot'), 'my-bot');
  assert.equal(sanitizeSessionName(''), 'bot');
  assert.equal(sanitizeSessionName(null), 'bot');
});

test('the session name is keyed on the port, which is the thing that collides', () => {
  // Profile bots each own a port; two agents pinned to one app is the failure
  // launchClaudeHeadless already guards against.
  assert.notEqual(tmuxSessionName({ profile: 'default', port: 7865 }),
    tmuxSessionName({ profile: 'default', port: 7866 }));
  assert.match(tmuxSessionName({ profile: 'Sam.Bot', port: 7866 }), /^vibeconf-Sam-Bot-7866$/);
});

test('kill targets the session, and a name round-trips through it', () => {
  const s = tmuxSessionName({ profile: 'Sam Bot', port: 7866 });
  assert.deepEqual(buildKillSessionArgs({ session: s }), ['kill-session', '-t', s]);
  // Nothing in a sanitized name can be read as a different target.
  assert.equal(/[:.]/.test(s), false);
});

test('missing a session is a programming error, not a silent no-op', () => {
  assert.throws(() => buildKillSessionArgs({}), /session is required/);
  assert.throws(() => buildTmuxNewSessionArgs({ argv: ['claude'] }), /session is required/);
});

test('the viewport only attaches — it never carries the agent command', () => {
  // If the viewport re-ran the agent, closing and reopening a window would
  // start a SECOND agent on the same bot.
  const cmd = buildViewportCommand({ emulator: TERMINAL_EMULATORS[0], session: 'vibeconf-default-7865' });
  assert.deepEqual(cmd, { command: 'xterm', args: ['-e', 'tmux', 'attach', '-t', 'vibeconf-default-7865'] });
  assert.equal(cmd.args.includes('claude'), false);
});

test('no emulator means no viewport, and that is not an error', () => {
  assert.equal(buildViewportCommand({ emulator: null, session: 's' }), null);
});

test('detection walks the preference order and tolerates a probe that throws', () => {
  const seen = [];
  const found = detectTerminalEmulator({
    exists: (bin) => {
      seen.push(bin);
      if (bin === 'xterm') throw new Error('which exploded');
      return bin === 'konsole';
    },
  });
  assert.equal(found.bin, 'konsole');
  assert.equal(seen[0], 'xterm', 'must probe in preference order');
});

test('detection returns null when nothing is installed', () => {
  assert.equal(detectTerminalEmulator({ exists: () => false }), null);
});

test('detection requires an exists probe rather than guessing', () => {
  assert.throws(() => detectTerminalEmulator({}), /exists/);
});

test('emulators that fork-and-return are flagged unreapable', () => {
  // Measured on Ubuntu 24.04, not assumed: xfce4-terminal's spawned pid exits
  // immediately whether or not --disable-server is passed, so killing it does
  // nothing. Safe in the tmux shape (kill-session does the work), an
  // un-stoppable agent in the direct shape — hence the warning at the call site.
  assert.equal(TERMINAL_EMULATORS.find((e) => e.bin === 'xfce4-terminal').reapable, false);
  assert.equal(TERMINAL_EMULATORS.find((e) => e.bin === 'xterm').reapable, true);
});

test('every emulator entry declares reapability explicitly', () => {
  // An undefined here reads as "reapable" at the call site and would silently
  // skip the warning. Force the question to be answered per entry.
  for (const e of TERMINAL_EMULATORS) {
    assert.equal(typeof e.reapable, 'boolean', `${e.bin} must declare reapable`);
  }
});

test('xfce4-terminal keeps -x, which is the flag that actually runs anything', () => {
  // Verified live: with -e the command did not run AT ALL (it takes a single
  // string), which would present as a terminal that opens to a bare shell and
  // an agent that never starts — #317 all over again.
  assert.equal(TERMINAL_EMULATORS.find((e) => e.bin === 'xfce4-terminal').execFlag, '-x');
});
