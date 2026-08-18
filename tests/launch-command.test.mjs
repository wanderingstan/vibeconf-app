// launch-command.test.mjs — the Join Call terminal command quoting.
//
// The bug (#305 follow-on): the working dir moved from /tmp to
// …/Library/Application Support/Vibeconferencing/agent — which has spaces — and
// the unquoted `cd` split it ("cd: string not in pwd: /Users/…/Library/Application").
// The command is double-quoted (AppleScript `do script "…"` then the shell), so
// these drive it through BOTH layers and actually cd the spaces path.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildTerminalCommand, asQuoted, buildTerminalLaunchScript, asShellCommand } = require('../electron-app/launch-command.js');

// The shell to drive the built command through.
//
// zsh where it exists, because that is what macOS Terminal.app actually runs and
// this module only ever feeds Terminal.app. But it is NOT a zsh feature under
// test: the construct is `cd "path" && cmd`, which is plain POSIX, so any sh
// exercises the same quoting.
//
// Hardcoding /bin/zsh made this the ONLY test in the suite that failed on a
// stock Ubuntu box (spawnSync /bin/zsh ENOENT). CI did not catch it because the
// unit-test job ran on macOS ONLY — `node --test` had never executed on Linux
// at all, which is also why the job's own comment estimated "a handful" of
// unportable tests when the real number was this one.
const SHELL = ['/bin/zsh', '/bin/bash', '/bin/sh'].find((s) => existsSync(s)) || '/bin/sh';

// Emulate what the shell finally receives: AppleScript `do script "<cmd>"` parses
// its string literal, turning each \" into a real ". (\\ would become \, but the
// paths here never contain a literal backslash.)
const afterAppleScript = (cmd) => cmd.replace(/\\"/g, '"');

test('the workdir is wrapped in escaped quotes for the AppleScript layer', () => {
  const cmd = buildTerminalCommand({ workdir: '/a/b', port: 7865, innerCmd: 'claude x' });
  assert.equal(cmd, 'cd \\"/a/b\\" && VIBECONF_LOCAL_PORT=7865 claude x');
  // After AppleScript unescapes, the shell sees real quotes around the path.
  assert.equal(afterAppleScript(cmd), 'cd "/a/b" && VIBECONF_LOCAL_PORT=7865 claude x');
});

test('a spaces path actually cd\'s — the reported failure', () => {
  const base = mkdtempSync(join(tmpdir(), 'lc test-'));            // space in the temp name too
  const dir = join(base, 'Application Support', 'Vibeconferencing', 'agent');
  mkdirSync(dir, { recursive: true });
  try {
    const cmd = buildTerminalCommand({ workdir: dir, port: 7865, innerCmd: 'pwd' });
    const shellCmd = afterAppleScript(cmd);
    const out = execSync(shellCmd, { shell: SHELL, encoding: 'utf8' }).trim();
    assert.equal(realpathSync(out), realpathSync(dir), 'cd landed in the spaces path');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('an embedded double quote in the path is escaped, not command-breaking', () => {
  // Pathological but must not break out of the quotes.
  const q = asQuoted('/weird/a"b/agent');
  assert.equal(q, '\\"/weird/a\\"b/agent\\"');
  // After AppleScript: "/weird/a"b/agent" — the inner quote stays escaped at the
  // shell level via the backslash the JS layer kept. (We only assert it doesn't
  // collapse to an unquoted split.)
  assert.ok(afterAppleScript(q).startsWith('"/weird/a'));
});

test('the port is optional and omitted cleanly', () => {
  assert.equal(buildTerminalCommand({ workdir: '/a', innerCmd: 'claude' }), 'cd \\"/a\\" && claude');
  assert.equal(buildTerminalCommand({ workdir: '/a', port: '', innerCmd: 'claude' }), 'cd \\"/a\\" && claude');
  assert.equal(buildTerminalCommand({ workdir: '/a', port: 7866, innerCmd: 'claude' }),
    'cd \\"/a\\" && VIBECONF_LOCAL_PORT=7866 claude');
});

test('main.js uses the helper (no inline unquoted cd)', () => {
  const src = require('node:fs').readFileSync(new URL('../electron-app/main.js', import.meta.url), 'utf8');
  assert.match(src, /buildTerminalCommand\(\{ workdir: claudeDir/);
  assert.doesNotMatch(src, /const cmd = `cd \$\{claudeDir/, 'the old unquoted cd must be gone');
});

// ── buildTerminalLaunchScript ────────────────────────────────────────────────
//
// The 2026-08-17 failure: Terminal was not running, the script took its
// `if not running` branch, and `do script "…" in window 1` raised
//   Terminal got an error: Can't get window 1. (-1728)
// because launching Terminal had produced NO window to reuse. osascript exited
// non-zero, the agent was never spawned, and the bot sat in the call driverless.
//
// String assertions rather than running osascript: this suite runs on Linux CI
// too (see the SHELL note above), and executing it would open real windows on a
// developer's machine. Both branches were exercised by hand against a live
// Terminal in both states when the fix landed.

// Strip AppleScript comments so prose in the script can't satisfy a check meant
// to be about the code — same trick agent-terminal-spawn.test.mjs uses.
const scriptCode = (s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

test('reuse is gated on the window COUNT, not on `running` alone', () => {
  const code = scriptCode(buildTerminalLaunchScript('echo hi'));
  // The precise shape of the old bug: `not running` deciding, by itself, that a
  // window 1 exists to target.
  assert.doesNotMatch(code, /if not running then\s*\n\s*do script .* in window 1/,
    'branching straight from `not running` to `in window 1` is the -1728 bug');
  assert.match(code, /\(count of windows\) > 0/,
    'the reuse branch must confirm a window actually exists');
  assert.match(code, /if \(not wasRunning\) and \(count of windows\) > 0 then/,
    'reuse requires BOTH: we launched Terminal, and a window showed up');
});

test('an already-running Terminal never gets its window 1 hijacked', () => {
  const code = scriptCode(buildTerminalLaunchScript('echo hi'));
  // window 1 of a Terminal the user already had open is the user's shell.
  // Running the agent inside it would be worse than opening another window.
  const reuse = code.indexOf('in window 1');
  assert.ok(reuse > 0, 'the reuse branch should still exist — it prevents a stray empty window');
  assert.match(code.slice(0, reuse), /set wasRunning to running/,
    'wasRunning must be captured before anything can start Terminal');
});

test('the launch window is waited for, not sampled once', () => {
  const code = scriptCode(buildTerminalLaunchScript('echo hi'));
  // Terminal's auto-created window appears asynchronously. Sampling the count
  // immediately would miss it and leave an empty window beside the agent's —
  // reintroducing the double-window that `in window 1` exists to avoid.
  assert.match(code, /repeat 20 times/);
  assert.match(code, /delay 0\.05/);
  assert.match(code, /exit repeat/);
});

test('the returned window id cannot itself raise -1728', () => {
  const code = scriptCode(buildTerminalLaunchScript('echo hi'));
  // A `do script` has run on every path by the time we return, so a window is
  // guaranteed. `front window` says that intent; the old `id of window 1` read
  // as another unguarded index into a possibly-empty window list.
  assert.match(code, /return id of front window/);
  assert.doesNotMatch(code, /return id of window 1/);
});

test('the command is interpolated verbatim, both branches', () => {
  const cmd = buildTerminalCommand({ workdir: '/a b', port: 7866, innerCmd: 'claude x' });
  const script = buildTerminalLaunchScript(cmd);
  const hits = script.split(cmd).length - 1;
  assert.equal(hits, 2, 'both the reuse and the new-window branch run the same command');
});

test('main.js uses the script builder rather than an inline tell block', () => {
  const src = require('node:fs').readFileSync(new URL('../electron-app/main.js', import.meta.url), 'utf8');
  assert.match(src, /buildTerminalLaunchScript\(cmd\)/);
  assert.doesNotMatch(src, /const script = `tell application "Terminal"\n  if not running then/,
    'the old inline -1728 script must be gone');
});

test('a failed osascript warns loudly instead of leaving a driverless bot', () => {
  const src = require('node:fs').readFileSync(new URL('../electron-app/main.js', import.meta.url), 'utf8');
  const at = src.indexOf("console.error('[electron] Failed to launch Claude:'");
  assert.ok(at > 0, 'the launch-failure branch should still exist');
  // The bot has already joined by the time this runs, so logging and returning
  // leaves a face in the room with nothing behind it — the exact invisible
  // failure #317/#329 made the Linux path guard against.
  const branch = src.slice(at, at + 2200);
  assert.match(branch, /dialog\.showMessageBox/, 'the failure must reach the user, not just the log');
  assert.match(branch, /type: 'error'/, 'and as an error, not an FYI');
  assert.match(branch, /asShellCommand\(cmd\)/,
    'the copyable command must be the shell form, not the AppleScript-escaped one');
});

test('the launch-failure path does NOT quietly switch the user to headless', () => {
  // Headless is gated on Dangerous Mode, so an automatic fallback would fire
  // only for users who already enabled it — moving them from a session they can
  // watch and Ctrl-C into an invisible one because the window server hiccuped.
  // That is a hosting decision, and it belongs to the agentHosting preference,
  // not to an error handler.
  const src = require('node:fs').readFileSync(new URL('../electron-app/main.js', import.meta.url), 'utf8');
  const at = src.indexOf("console.error('[electron] Failed to launch Claude:'");
  const branch = src.slice(at, at + 2200);
  assert.doesNotMatch(branch, /launchClaudeHeadless\(/,
    'the osascript failure path must not spawn a headless agent');
});

test('agentHosting: headless is still an explicit opt-in, untouched', () => {
  // Removing the fallback must not have removed the deliberate choice.
  const src = require('node:fs').readFileSync(new URL('../electron-app/main.js', import.meta.url), 'utf8');
  assert.match(src, /store\.get\('agentHosting'\) === 'headless'/);
});

test('asShellCommand undoes the AppleScript layer for a human to paste', () => {
  const cmd = buildTerminalCommand({ workdir: '/a b', port: 7865, innerCmd: 'claude \\"/join-call x Jimmy\\"' });
  assert.match(cmd, /\\"/, 'the AppleScript form is escaped');
  const shell = asShellCommand(cmd);
  assert.equal(shell, 'cd "/a b" && VIBECONF_LOCAL_PORT=7865 claude "/join-call x Jimmy"');
  assert.doesNotMatch(shell, /\\"/, 'no stray backslashes for the user to trip over');
});

test('asShellCommand actually runs — the pasted command is valid shell', () => {
  const base = mkdtempSync(join(tmpdir(), 'ls test-'));
  const dir = join(base, 'Application Support', 'agent');
  mkdirSync(dir, { recursive: true });
  try {
    const cmd = buildTerminalCommand({ workdir: dir, port: 7865, innerCmd: 'pwd' });
    const out = execSync(asShellCommand(cmd), { shell: SHELL, encoding: 'utf8' }).trim();
    assert.equal(realpathSync(out), realpathSync(dir));
  } finally { rmSync(base, { recursive: true, force: true }); }
});
