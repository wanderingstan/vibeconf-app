// claude-install.test.mjs — the official Claude Code install command per platform, and
// the known-paths list detection falls back to. (detectClaude() itself is environment-
// dependent — it shells out and checks the real filesystem — so it isn't unit-tested here;
// the pure, deterministic pieces are.)
//
// Run: node --test tests/claude-install.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installCommandFor, knownClaudePaths } from '../electron-app/claude-install.js';

test('installCommandFor: macOS/Linux use the curl native installer', () => {
  const expected = 'curl -fsSL https://claude.ai/install.sh | bash';
  assert.equal(installCommandFor('darwin'), expected);
  assert.equal(installCommandFor('linux'), expected);
});

test('installCommandFor: Windows installs AND puts it on PATH', () => {
  const cmd = installCommandFor('win32');
  assert.match(cmd, /^irm https:\/\/claude\.ai\/install\.ps1 \| iex;/, 'still the official installer, first');

  // Without this the install "succeeds" and nothing works: the installer drops
  // claude.exe in %USERPROFILE%\.local\bin and only TELLS the user to add it to
  // PATH. `where claude` then fails, so the wizard reports not-installed, and the
  // app later launches `claude` by name to drive a call, so the bot won't start.
  assert.match(cmd, /USERPROFILE.*\.local.*bin/, 'targets the install dir');
  assert.match(cmd, /SetEnvironmentVariable\('Path'/, 'writes PATH');
  assert.match(cmd, /'User'\)/, 'USER scope — persists without admin rights');
  assert.match(cmd, /\$env:PATH \+=/, 'and the current session, so it works without reopening the window');

  // Re-running must not append duplicates, and must no-op if the official
  // installer ever starts doing this itself.
  assert.match(cmd, /-not \(\(\$env:PATH -split ';'\) -contains \$b\)/, 'guarded against duplicates');
});

test('knownClaudePaths includes the native-installer location and only claude binaries', () => {
  const paths = knownClaudePaths('/home/tester', 'darwin');
  assert.ok(paths.includes('/home/tester/.local/bin/claude'), 'native installer path (~/.local/bin/claude) present');
  assert.ok(paths.length >= 3, 'covers several install locations');
  assert.ok(paths.every((p) => p.endsWith('/claude')), 'every entry points at a claude binary');
});

test('knownClaudePaths looks for claude.EXE on Windows', () => {
  // The bug this pins: the list was Unix-only, so on Windows the fast check could
  // never match — path.join(home,'.local','bin','claude') has no .exe, and every
  // other entry was a /opt or /usr path. Detection then fell through to
  // `where claude`, which also fails because the installer does not set PATH. Both
  // routes failed on an install that had just succeeded, and the wizard said
  // "not installed".
  const paths = knownClaudePaths('C:\\Users\\tester', 'win32');
  assert.ok(paths.some((p) => p.endsWith('claude.exe')), 'the native installer drops claude.exe');
  assert.ok(!paths.some((p) => p.startsWith('/opt') || p.startsWith('/usr')),
    'Unix paths can never match on Windows and only slow the check');
  assert.ok(paths.every((p) => /claude(\.exe|\.cmd)$/.test(p)), 'every entry is a Windows claude binary');
});
