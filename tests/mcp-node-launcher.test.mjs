// mcp-node-launcher.test.mjs — the MCP server must not need Node on PATH.
//
// The bug: both places that write an MCP config hardcoded `command: 'node'`.
// macOS ships no Node, and Claude Code's native installer
// (~/.local/share/claude/versions/…) doesn't bring one — so a user who did
// everything right got `spawn node ENOENT` and a bot that never appeared, with
// nothing on screen explaining why.
//
// It never showed up in testing because every machine we test on has Homebrew
// node at /opt/homebrew/bin — and that is machine-wide, so even a fresh macOS
// *account* (which is how the stranger drill was run) still sees it. The drill
// passed and the bug was still there.
//
// The fix: Electron already contains a Node runtime, so spawn ourselves with
// ELECTRON_RUN_AS_NODE=1. These tests pin that down at both write sites.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

test('no MCP config hardcodes the bare `node` command', () => {
  assert.doesNotMatch(
    main,
    /command:\s*['"]node['"]/,
    'a bare `node` command requires Node on PATH — macOS has none by default',
  );
});

test('the launcher uses Electron\'s own Node runtime', () => {
  const helper = main.slice(main.indexOf('function mcpNodeLauncher'));
  const body = helper.slice(0, helper.indexOf('\n}'));
  assert.match(body, /process\.execPath/, 'must spawn the app binary itself');
  assert.match(body, /ELECTRON_RUN_AS_NODE:\s*['"]1['"]/, 'which only behaves as node with this set');
});

test('both write sites go through the launcher', () => {
  // the per-profile pinned config (--mcp-config) and the durable ~/.claude.json entry
  const uses = main.match(/mcpNodeLauncher\(\)|nodeLauncher\./g) || [];
  assert.ok(uses.length >= 4, `expected both sites to use command + env from the launcher, saw ${uses.length}`);
});

test('an install written by an older build gets repaired, not left broken', () => {
  // Without `command` in the comparison, everyone who already has a working-by-
  // luck 'node' entry keeps it — including the users who later lose Node.
  const idx = main.indexOf('const needsUpdate =');
  assert.ok(idx > 0, 'needsUpdate check must exist');
  const check = main.slice(idx, main.indexOf(';', idx));
  assert.match(check, /currentMcp\.command !== nodeLauncher\.command/,
    'the durable config must be rewritten when the command is stale');
});
