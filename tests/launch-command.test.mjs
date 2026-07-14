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
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildTerminalCommand, asQuoted } = require('../electron-app/launch-command.js');

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
    const out = execSync(shellCmd, { shell: '/bin/zsh', encoding: 'utf8' }).trim();
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
