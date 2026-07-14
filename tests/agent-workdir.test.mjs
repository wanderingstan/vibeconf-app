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
const { agentDirFor, defaultBotSettings, withTrustedProject, isProjectTrusted, defaultClaudeMd } =
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

// --- perProfileSubset + the config→agent migration -----------------------------
// The bot's per-profile config moved into <agentDir>/config.json (a clean
// "this is the bot" file). App-level keys stay in the shared base config.json.
// These pin the filter and drive the real Store + ScopedStore through the exact
// migration main.js runs, for both a NAMED profile (separate old file) and the
// DEFAULT profile (old file IS the base config).

import { createRequire as _cr2 } from 'node:module';
const require2 = _cr2(import.meta.url);
const Store = require2('../electron-app/store.js');
const { APP_LEVEL_KEYS, ScopedStore, migrateAppLevelKeys } = require2('../electron-app/config-scope.js');
const { perProfileSubset } = require2('../electron-app/agent-workdir.js');

test('perProfileSubset drops app-level keys, keeps the rest, does not mutate', () => {
  const cfg = { botName: 'Jimmy', ttsVoiceId: 'v1', dangerousMode: true, ttsApiKey: 'sk', websiteUrl: 'x' };
  const out = perProfileSubset(cfg, APP_LEVEL_KEYS);
  assert.deepEqual(out, { botName: 'Jimmy', ttsVoiceId: 'v1' });
  assert.equal(cfg.dangerousMode, true, 'input untouched');
  assert.deepEqual(perProfileSubset(null, APP_LEVEL_KEYS), {});
});

// Replicates the store-init migration in main.js against temp dirs.
function initStore({ base, userData }) {
  const appLevelStore = new Store(base, { fresh: true });
  const agentDir = agentDirFor(userData);
  const newCfg = join(agentDir, 'config.json');
  const oldCfg = join(userData, 'config.json');
  mkdirSync(agentDir, { recursive: true });
  if (!existsSync(newCfg) && existsSync(oldCfg)) {
    if (userData !== base) migrateAppLevelKeys(appLevelStore, new Store(userData));
    const old = JSON.parse(readFileSync(oldCfg, 'utf-8'));
    writeFileSync(newCfg, JSON.stringify(perProfileSubset(old, APP_LEVEL_KEYS), null, 2) + '\n');
  }
  const profileStore = (agentDir === base) ? appLevelStore : new Store(agentDir);
  migrateAppLevelKeys(appLevelStore, profileStore);
  return { store: new ScopedStore(appLevelStore, profileStore), agentDir, newCfg, oldCfg };
}

test('named profile: per-profile config → clean agent/config.json; app-level stays in base', () => {
  const base = mkdtempSync(join(tmpdir(), 'awbase-'));
  const userData = mkdtempSync(join(tmpdir(), 'awpr-'));
  writeFileSync(join(base, 'config.json'), JSON.stringify({ dangerousMode: true }));
  // A named profile's config holds per-profile keys, and (edge) an un-promoted ttsApiKey.
  writeFileSync(join(userData, 'config.json'), JSON.stringify({ botName: 'Samantha', ttsVoiceId: 'v9', ttsApiKey: 'sk-old' }));
  try {
    const { store, newCfg } = initStore({ base, userData });
    const agentCfg = JSON.parse(readFileSync(newCfg, 'utf-8'));
    assert.deepEqual(agentCfg, { botName: 'Samantha', ttsVoiceId: 'v9' }, 'agent config is the clean per-profile subset');
    // Routing: per-profile from agent, app-level from base.
    assert.equal(store.get('botName'), 'Samantha');
    assert.equal(store.get('dangerousMode'), true);
    // The un-promoted ttsApiKey was carried UP to base before filtering — not lost.
    assert.equal(store.get('ttsApiKey'), 'sk-old');
  } finally { rmSync(base, { recursive: true, force: true }); rmSync(userData, { recursive: true, force: true }); }
});

test('default profile: old config IS base; agent gets per-profile only, base untouched', () => {
  const base = mkdtempSync(join(tmpdir(), 'awbase-'));
  // Default: everything is in the base config.json (app-level + per-profile).
  const baseCfg = { dangerousMode: true, websiteUrl: 'https://x', botName: 'Jimmy', ttsVoiceId: 'v1' };
  writeFileSync(join(base, 'config.json'), JSON.stringify(baseCfg));
  try {
    const { store, newCfg } = initStore({ base, userData: base });
    const agentCfg = JSON.parse(readFileSync(newCfg, 'utf-8'));
    assert.deepEqual(agentCfg, { botName: 'Jimmy', ttsVoiceId: 'v1' }, 'no app-level keys leak into the agent config');
    // Base config.json is untouched — still holds everything (safety net + app-level source).
    assert.deepEqual(JSON.parse(readFileSync(join(base, 'config.json'), 'utf-8')), baseCfg);
    // Routing still correct.
    assert.equal(store.get('botName'), 'Jimmy');
    assert.equal(store.get('dangerousMode'), true);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('migration is idempotent and a fresh install starts in the agent dir', () => {
  const base = mkdtempSync(join(tmpdir(), 'awbase-'));
  const userData = mkdtempSync(join(tmpdir(), 'awpr-'));
  try {
    // Fresh: no configs anywhere. First run creates the agent store; writes land there.
    const first = initStore({ base, userData });
    first.store.set('botName', 'Newbie');
    assert.equal(JSON.parse(readFileSync(first.newCfg, 'utf-8')).botName, 'Newbie', 'fresh writes go to agent/config.json');

    // Second run must NOT re-migrate over the now-populated agent config.
    writeFileSync(join(userData, 'config.json'), JSON.stringify({ botName: 'StaleOld' }));
    const second = initStore({ base, userData });
    assert.equal(second.store.get('botName'), 'Newbie', 'existing agent config wins; no re-migration');
  } finally { rmSync(base, { recursive: true, force: true }); rmSync(userData, { recursive: true, force: true }); }
});

test('defaultClaudeMd is name-neutral (no baked-in identity to drift)', () => {
  const md = defaultClaudeMd();
  assert.match(md, /## /, 'has section headings');
  assert.match(md, /personality/i, 'describes itself as the personality file');
  // Must NOT hardcode any known bot name — the name is dynamic (Bot Name setting /
  // call display name), so it can't live here.
  for (const name of ['Jimmy', 'Samantha', 'Coltrane']) {
    assert.doesNotMatch(md, new RegExp(name), `no baked-in "${name}"`);
  }
  // And it should say so, so a user editing it doesn't re-introduce one.
  assert.match(md, /name/i);
});
