// claude-install.test.mjs — the official Claude Code install command per platform, and
// the known-paths list detection falls back to. (detectClaude() itself is environment-
// dependent — it shells out and checks the real filesystem — so it isn't unit-tested here;
// the pure, deterministic pieces are.)
//
// Run: node --test tests/claude-install.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installCommandFor, knownClaudePaths, claudeShellWord, shellQuote } from '../electron-app/claude-install.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('installCommandFor: macOS/Linux run the curl native installer first, and only then touch PATH', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.match(installCommandFor(platform), /^curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash && \{/, platform);
  }
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

// ── #915: macOS "successfully installed" and then "command not found" ──
// The installer puts claude in ~/.local/bin and only prints a note about PATH;
// a new macOS user has no rc file that adds it.

// The part after the installer, run for real in a throwaway HOME.
function runPathSetup(platform, shell, home) {
  const tail = installCommandFor(platform).replace(/^curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash && /, '');
  return execFileSync('/bin/sh', ['-c', `${tail}; echo "$PATH"`], { env: { HOME: home, SHELL: shell, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
}

test('#915: zsh (the macOS default) gets the PATH line in ~/.zshrc, once, however often it is run', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-path-'));
  const out = runPathSetup('darwin', '/bin/zsh', home);
  runPathSetup('darwin', '/bin/zsh', home);
  const rc = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
  assert.equal(rc, 'export PATH="$HOME/.local/bin:$PATH"\n', 'written literally ($HOME unexpanded), exactly once');
  assert.ok(out.trim().startsWith(`${home}/.local/bin:`), 'and the current window has it too');
});

test('#915: bash gets ~/.bash_profile on macOS and ~/.bashrc on Linux; an rc that already has it is left alone', () => {
  const mac = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-path-'));
  runPathSetup('darwin', '/bin/bash', mac);
  assert.match(fs.readFileSync(path.join(mac, '.bash_profile'), 'utf8'), /\.local\/bin/);
  assert.equal(fs.existsSync(path.join(mac, '.zshrc')), false);

  const linux = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-path-'));
  runPathSetup('linux', '/bin/bash', linux);
  assert.match(fs.readFileSync(path.join(linux, '.bashrc'), 'utf8'), /\.local\/bin/);

  const done = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-path-'));
  fs.writeFileSync(path.join(done, '.zshrc'), 'path+=(~/.local/bin)\n');
  runPathSetup('darwin', '/bin/zsh', done);
  assert.equal(fs.readFileSync(path.join(done, '.zshrc'), 'utf8'), 'path+=(~/.local/bin)\n');
});

test('#915: the command has no backslashes, so AppleScript `do script` escaping only has to handle quotes', () => {
  assert.equal(installCommandFor('darwin').includes('\\'), false);
});

test('#915: claudeShellWord is the first known install that exists, quoted; bare claude otherwise', () => {
  assert.equal(claudeShellWord({ paths: ['/nope/claude', '/Users/a b/.local/bin/claude'], exists: (p) => !p.startsWith('/nope') }), "'/Users/a b/.local/bin/claude'");
  assert.equal(claudeShellWord({ paths: ['/nope/claude'], exists: () => false }), 'claude');
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

test('#915: nothing the app runs itself calls claude by bare name when it knows where it is', () => {
  const main = fs.readFileSync(new URL('../electron-app/main.js', import.meta.url), 'utf8');
  const install = fs.readFileSync(new URL('../electron-app/claude-install.js', import.meta.url), 'utf8');
  assert.match(main, /const claudeCmd = `\$\{claudeWord\}/, 'the agent Terminal');
  assert.match(main, /innerCmd: require\('\.\/claude-install\.js'\)\.claudeShellWord\(\)/, 'the sign-in Terminal');
  assert.match(main, /\$\{require\('\.\/claude-install\.js'\)\.claudeShellWord\(\)\} -p "ok"/, 'the verify run');
  assert.match(install, /\$\{claudeShellWord\(\)\} auth status/, 'the auth check');
  assert.doesNotMatch(main, /do script "\$\{cmd\}"\\nend tell`;\n\s*require\('child_process'\)\.execFile\('osascript', \['-e', script\], \(\) => \{\}\);\n\s*return \{ ok: true \};\n\s*\}\);\n\s*ipcMain\.handle\('onboarding:copy-install-command'/,
    'the wizard\'s install button escapes the command for AppleScript');
});
