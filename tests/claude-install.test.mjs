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

test('installCommandFor: Windows uses the PowerShell installer', () => {
  assert.equal(installCommandFor('win32'), 'irm https://claude.ai/install.ps1 | iex');
});

test('knownClaudePaths includes the native-installer location and only claude binaries', () => {
  const paths = knownClaudePaths('/home/tester');
  assert.ok(paths.includes('/home/tester/.local/bin/claude'), 'native installer path (~/.local/bin/claude) present');
  assert.ok(paths.length >= 3, 'covers several install locations');
  assert.ok(paths.every((p) => p.endsWith('/claude')), 'every entry points at a claude binary');
});
