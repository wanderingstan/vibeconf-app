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
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { profileLaunchCommand } = require('../electron-app/profile-launch.js');

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
