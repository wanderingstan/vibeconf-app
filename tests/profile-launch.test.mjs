// profile-launch.test.mjs — how another bot profile gets spawned, per platform.
//
// #746: this was a single macOS code path (`open -n <bundle> --args …`) used on
// every platform. Switching bots therefore could not work on Linux at all — on
// Ubuntu `open` is an alternatives symlink to xdg-open, which rejects `-n`. It
// failed in ~30ms and reached the user as an 8-second "did not come up in time".
//
// The regression that matters is not "does Linux produce some argv" but the two
// macOS-isms leaking off macOS: the literal `open` command, and the `--args`
// separator. Both are asserted against below.
//
// #301: the supervisor window launches bots too, so the profile flags
// (spawnArgsForProfile) live here as well, with ONE copy shared by both callers.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { profileLaunchCommand, spawnArgsForProfile } = require('../electron-app/profile-launch.js');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

const MAC_EXE = '/Applications/Vibeconferencing.app/Contents/MacOS/Vibeconferencing';
const LINUX_EXE = '/opt/Vibeconferencing/vibeconferencing-agent';
const WIN_EXE = 'C:\\Program Files\\Vibeconferencing\\Vibeconferencing.exe';
const ARGS = ['--profile=jimmy', '--local-port=7871'];

test('macOS: opens the .app BUNDLE with -n, flags after --args', () => {
  const { cmd, argv, detached } = profileLaunchCommand({
    platform: 'darwin', isPackaged: true, exePath: MAC_EXE, args: ARGS,
  });
  assert.equal(cmd, 'open');
  assert.deepEqual(argv, [
    '-n', '/Applications/Vibeconferencing.app', '--args',
    '--profile=jimmy', '--local-port=7871',
  ]);
  // open(1) returns immediately; the launched app is not our child.
  assert.equal(detached, false);
});

test('macOS: no args means no --args separator at all', () => {
  // open(1) treats a trailing `--args` with nothing after it as malformed.
  const { argv } = profileLaunchCommand({
    platform: 'darwin', isPackaged: true, exePath: MAC_EXE, args: [],
  });
  assert.deepEqual(argv, ['-n', '/Applications/Vibeconferencing.app']);
  assert.ok(!argv.includes('--args'));
});

test('#746 Linux: execs the binary directly — never open(1), never --args', () => {
  const { cmd, argv, detached } = profileLaunchCommand({
    platform: 'linux', isPackaged: true, exePath: LINUX_EXE, args: ARGS,
  });
  assert.equal(cmd, LINUX_EXE);
  assert.deepEqual(argv, ['--profile=jimmy', '--local-port=7871']);
  // Must outlive us: switch-profile quits this process once the new one binds.
  assert.equal(detached, true);
});

test('#746 Windows: same shape as Linux', () => {
  const { cmd, argv, detached } = profileLaunchCommand({
    platform: 'win32', isPackaged: true, exePath: WIN_EXE, args: ARGS,
  });
  assert.equal(cmd, WIN_EXE);
  assert.deepEqual(argv, ARGS);
  assert.equal(detached, true);
});

test('#746 the macOS-isms never appear off macOS', () => {
  // The actual bug, stated directly: `open` and `--args` are open(1) conventions
  // and are meaningless — worse, actively breaking — anywhere else.
  for (const platform of ['linux', 'win32', 'freebsd']) {
    const exePath = platform === 'win32' ? WIN_EXE : LINUX_EXE;
    const { cmd, argv } = profileLaunchCommand({
      platform, isPackaged: true, exePath, args: ARGS,
    });
    assert.notEqual(cmd, 'open', `${platform} must not shell out to open(1)`);
    assert.ok(!argv.includes('--args'), `${platform} must not use the --args separator`);
    assert.ok(!argv.includes('-n'), `${platform} must not pass -n`);
    // The flags have to actually reach the new instance.
    assert.ok(argv.includes('--profile=jimmy'), `${platform} must forward the profile flag`);
  }
});

test('#746 the bundle regex does not mangle a non-macOS path', () => {
  // It silently no-ops off macOS, which is how the raw ELF path ended up being
  // handed to xdg-open. Pin that the Linux branch passes the path through whole.
  const { cmd } = profileLaunchCommand({
    platform: 'linux', isPackaged: true, exePath: LINUX_EXE, args: ARGS,
  });
  assert.equal(cmd, LINUX_EXE);
  assert.ok(!cmd.includes('Contents/MacOS'));
});

test('dev (unpackaged): re-runs Electron against the app dir, on every platform', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const { cmd, argv, detached } = profileLaunchCommand({
      platform,
      isPackaged: false,
      exePath: '/repo/node_modules/.bin/electron',
      appPath: '/repo/electron-app',
      args: ARGS,
    });
    assert.equal(cmd, '/repo/node_modules/.bin/electron');
    assert.deepEqual(argv, ['/repo/electron-app', ...ARGS]);
    assert.equal(detached, true);
  }
});

test('a named profile carries its name and its port', () => {
  assert.deepEqual(spawnArgsForProfile({ name: 'bot9', port: 7890 }),
    ['--profile=bot9', '--local-port=7890']);
});

test('the default seat is launched bare', () => {
  // No --profile and no --local-port: the default owns DEFAULT_PORT and the
  // global Claude MCP config, and naming it explicitly would make it arrive
  // looking like an ordinary named profile.
  assert.deepEqual(spawnArgsForProfile({ name: 'Default', isDefault: true }), []);
});

test('a named profile without a port is refused, not launched portless', () => {
  // Launching with no --local-port silently lands the bot on DEFAULT_PORT,
  // where it collides with the default seat — one bot answering another bot's
  // MCP calls (#517). Failing here is the whole reason this is a function.
  assert.throws(() => spawnArgsForProfile({ name: 'bot9' }), /needs a local port/);
  assert.throws(() => spawnArgsForProfile({ name: 'bot9', port: 0 }), /needs a local port/);
  assert.throws(() => spawnArgsForProfile({ port: 7890 }), /needs a name/);
});

test('a new bot opens on Settings', () => {
  const args = spawnArgsForProfile({ name: 'bot9', port: 7890, openSettings: true });
  assert.ok(args.includes('--open-settings=true'));
});

test('window position is forwarded only when it is real', () => {
  assert.deepEqual(
    spawnArgsForProfile({ name: 'b', port: 7871, windowPos: { x: 12, y: 34 } }),
    ['--profile=b', '--local-port=7871', '--window-x=12', '--window-y=34'],
  );
  // Undefined/NaN bounds must not become "--window-x=undefined", which Electron
  // parses as a position and puts the window somewhere nobody can find.
  for (const bad of [null, {}, { x: 1 }, { x: NaN, y: 2 }]) {
    const args = spawnArgsForProfile({ name: 'b', port: 7871, windowPos: bad });
    assert.ok(!args.some((a) => a.startsWith('--window-')), `leaked a window flag for ${JSON.stringify(bad)}`);
  }
});

test('both launchers use this module — there is not a second copy', () => {
  // main.js's launchOrFocusProfile and the supervisor both build their command
  // line here. If either grows its own inline copy, they drift.
  const supervisor = readFileSync(join(root, 'electron-app/supervisor-app.js'), 'utf8');
  for (const [label, src] of [['main.js', main], ['supervisor-app.js', supervisor]]) {
    assert.match(src, /require\('\.\/profile-launch\.js'\)/, `${label} must use the shared launcher`);
    assert.ok(!/`--profile=\$\{name\}`, `--local-port=/.test(src),
      `${label} still builds the profile args inline`);
    // #746: and both go through the per-platform command, not a bare open(1).
    assert.match(src, /profileLaunchCommand\(/, `${label} must use the per-platform launch command`);
    assert.ok(!/execFile\('open'/.test(src), `${label} still shells out to open(1) directly`);
  }
});

test('--supervisor returns before any of main.js runs', () => {
  // The supervisor must not inherit a bot's userData or port. The branch is only
  // a guarantee if it sits above everything with a side effect — so assert on
  // its POSITION, not just its presence.
  //
  // Scanned with line comments stripped: the branch's own explanation names the
  // very calls it must precede, so a raw text search finds them in the prose
  // above it and reports a failure that is only a description of the fix.
  const code = main.split('\n').map((line) => line.replace(/^\s*\/\/.*$/, '')).join('\n');
  const branch = code.indexOf("process.argv.includes('--supervisor')");
  assert.ok(branch > 0, 'main.js has no --supervisor branch');
  for (const sideEffect of ['app.setPath(', 'app.whenReady(', 'app.commandLine.appendSwitch(', 'new Store(']) {
    const at = code.indexOf(sideEffect);
    if (at === -1) continue;
    assert.ok(branch < at, `the --supervisor branch must come before ${sideEffect}`);
  }
  // And it must actually return, or main.js carries on underneath it.
  const body = code.slice(branch, branch + 200);
  assert.match(body, /require\('\.\/supervisor-app\.js'\)\.start\(\);\s*\n\s*return;/);
});
