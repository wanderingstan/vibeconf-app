// agent-workdir.test.mjs — the per-profile trusted working dir (#305).
//
// The bug: Join Call launches `claude` in /tmp, which isn't a trusted workspace,
// so Claude Code drops the bot's permissions.allow allowlist and can prompt
// mid-call. The fix marks a per-profile dir trusted in ~/.claude.json (exactly as
// a manual trust-dialog accept would) and cd's there. These pin the pure pieces;
// the filesystem + ~/.claude.json writes are the thin wrapper in main.js.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { agentDirFor, defaultBotSettings, withTrustedProject, isProjectTrusted } =
  require('../electron-app/agent-workdir.js');

test('the agent dir is <userData>/agent, per profile', () => {
  assert.equal(agentDirFor('/Users/x/Library/Application Support/Vibeconferencing'),
    '/Users/x/Library/Application Support/Vibeconferencing/agent');
  assert.equal(agentDirFor('/Users/x/Library/Application Support/Vibeconferencing/profiles/samantha'),
    '/Users/x/Library/Application Support/Vibeconferencing/profiles/samantha/agent');
  // Two profiles get two distinct homes.
  assert.notEqual(agentDirFor('/base/profiles/a'), agentDirFor('/base/profiles/b'));
});

test('the seeded settings carry a permissions.allow list', () => {
  const s = defaultBotSettings();
  assert.ok(Array.isArray(s.permissions.allow));
  assert.ok(s.permissions.allow.includes('mcp__vibeconferencing__*'));
});

test('withTrustedProject sets the trust flag exactly like an accepted dialog', () => {
  const out = withTrustedProject({}, '/base/agent');
  assert.equal(out.projects['/base/agent'].hasTrustDialogAccepted, true);
});

test('it is non-destructive: other projects and top-level keys survive', () => {
  const before = {
    mcpServers: { vibeconferencing: { command: 'node' } },
    projects: {
      '/other': { hasTrustDialogAccepted: true, history: [1, 2] },
      '/base/agent': { history: ['x'] }, // pre-existing entry, not yet trusted
    },
  };
  const after = withTrustedProject(before, '/base/agent');
  // Target dir: trust set, existing fields kept.
  assert.equal(after.projects['/base/agent'].hasTrustDialogAccepted, true);
  assert.deepEqual(after.projects['/base/agent'].history, ['x'], 'existing project fields preserved');
  // Everything else untouched.
  assert.deepEqual(after.projects['/other'], before.projects['/other']);
  assert.deepEqual(after.mcpServers, before.mcpServers);
  // And it did not mutate the input.
  assert.equal(before.projects['/base/agent'].hasTrustDialogAccepted, undefined, 'input not mutated');
});

test('withTrustedProject copes with a missing/empty claude.json', () => {
  for (const input of [null, undefined, {}, { projects: null }]) {
    const out = withTrustedProject(input, '/base/agent');
    assert.equal(out.projects['/base/agent'].hasTrustDialogAccepted, true);
  }
});

test('isProjectTrusted reports the flag, and lets the caller skip a rewrite', () => {
  const j = withTrustedProject({}, '/base/agent');
  assert.equal(isProjectTrusted(j, '/base/agent'), true);
  assert.equal(isProjectTrusted(j, '/base/other'), false);
  assert.equal(isProjectTrusted({}, '/base/agent'), false);
  assert.equal(isProjectTrusted({ projects: { '/base/agent': {} } }, '/base/agent'), false,
    'present but not accepted is not trusted');
});

// --- Integration: the fs + ~/.claude.json sequence main.js runs -----------------
// ensureAgentWorkdir() itself uses Electron's app.getPath and can't be required
// here, but its body is a thin loop over these pure helpers plus mkdir/writeFile.
// This drives that exact sequence against temp dirs so the non-clobbering merge
// and idempotence can't silently regress.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// agentDirFor / defaultBotSettings / withTrustedProject / isProjectTrusted are
// already imported at the top of this file — reuse them.

function ensure(claudeJsonPath, userData) {
  const agentDir = agentDirFor(userData);
  mkdirSync(join(agentDir, '.claude'), { recursive: true });
  const sp = join(agentDir, '.claude', 'settings.local.json');
  if (!existsSync(sp)) writeFileSync(sp, JSON.stringify(defaultBotSettings(), null, 2) + '\n');
  let j = {};
  try { j = JSON.parse(readFileSync(claudeJsonPath, 'utf8')); } catch { /* fresh */ }
  if (!isProjectTrusted(j, agentDir)) writeFileSync(claudeJsonPath, JSON.stringify(withTrustedProject(j, agentDir), null, 2) + '\n');
  return agentDir;
}

test('integration: creates + trusts the dir, preserves the rest of ~/.claude.json', () => {
  const home = mkdtempSync(join(tmpdir(), 'awhome-'));
  const userData = mkdtempSync(join(tmpdir(), 'awud-'));
  const claudeJsonPath = join(home, '.claude.json');
  writeFileSync(claudeJsonPath, JSON.stringify({
    mcpServers: { vibeconferencing: { command: 'node' } },
    projects: { '/existing': { hasTrustDialogAccepted: true, history: [1, 2] } },
    someOtherKey: 42,
  }, null, 2));
  try {
    const dir = ensure(claudeJsonPath, userData);
    const j = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
    assert.ok(existsSync(join(dir, '.claude', 'settings.local.json')), 'settings seeded');
    assert.equal(j.projects[dir].hasTrustDialogAccepted, true, 'dir trusted');
    assert.deepEqual(j.projects['/existing'], { hasTrustDialogAccepted: true, history: [1, 2] }, 'existing project intact');
    assert.ok(j.mcpServers.vibeconferencing, 'mcpServers intact');
    assert.equal(j.someOtherKey, 42, 'unrelated keys intact');
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(userData, { recursive: true, force: true }); }
});

test('integration: idempotent, and never clobbers user-edited settings', () => {
  const home = mkdtempSync(join(tmpdir(), 'awhome-'));
  const userData = mkdtempSync(join(tmpdir(), 'awud-'));
  const claudeJsonPath = join(home, '.claude.json');
  try {
    const dir = ensure(claudeJsonPath, userData);
    const mtime = statSync(claudeJsonPath).mtimeMs;
    ensure(claudeJsonPath, userData); // second run
    assert.equal(statSync(claudeJsonPath).mtimeMs, mtime, 'already-trusted → no rewrite');

    // User edits the allowlist; a later ensure must leave it alone.
    const sp = join(dir, '.claude', 'settings.local.json');
    writeFileSync(sp, JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }, null, 2));
    ensure(claudeJsonPath, userData);
    assert.deepEqual(JSON.parse(readFileSync(sp, 'utf8')).permissions.allow, ['Bash(ls)'], 'user settings preserved');
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(userData, { recursive: true, force: true }); }
});
