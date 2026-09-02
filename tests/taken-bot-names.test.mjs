// taken-bot-names.test.mjs — name-collision detection sees MODERN profiles (#447).
//
// Why this is worth a test file of its own: the failure has no symptom at the
// point it happens. main.js used to read `<profile>/config.json` directly to
// build the taken-names list, but identity moved to `<profile>/agent/config.json`
// at #305. For every profile created since, the read threw, the throw was
// swallowed by a `catch { return null }`, and the null was dropped by
// `.filter(Boolean)` — so the list came back SHORT rather than erroring. On an
// eight-profile machine it held two names; "Pepper" and "Hemma" read as free.
//
// What that costs is not cosmetic. MCP routes by name, and join_call refuses a
// display name shared by several running instances rather than guess (guessing
// wrong pulls a bot out of a live call). So letting a second "Pepper" be created
// hands the user a bot they cannot drive, with nothing anywhere saying why.
//
// These pin the reading of identity — both layouts and the precedence between
// them — plus the fact that main.js asks profile-manager instead of re-deriving
// the path, since re-deriving it is precisely how the bug got in.
//
// Run: node --test tests/taken-bot-names.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pm = require('../electron-app/profile-manager.js');
const { randomBotName } = require('../electron-app/bot-names.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function withProfilesRoot(fn) {
  const base = mkdtempSync(join(tmpdir(), 'taken-names-'));
  const dir = join(base, 'profiles');
  mkdirSync(dir, { recursive: true });
  try { return fn(dir); } finally { rmSync(base, { recursive: true, force: true }); }
}

// A profile as the app writes them TODAY: config in the agent dir (#305).
function modernProfile(profilesRoot, name, botName) {
  const agent = join(profilesRoot, name, 'agent');
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, 'config.json'), JSON.stringify({ botName }));
}

// A profile from before #305: config loose at the profile root.
function legacyProfile(profilesRoot, name, botName) {
  mkdirSync(join(profilesRoot, name), { recursive: true });
  writeFileSync(join(profilesRoot, name, 'config.json'), JSON.stringify({ botName }));
}

test('modern (agent-dir) profiles are counted as taken — the whole bug', () => {
  withProfilesRoot((profiles) => {
    modernProfile(profiles, 'Default', 'Pepper');
    modernProfile(profiles, 'Hemma', 'Hemma');
    legacyProfile(profiles, 'solienne', 'SOLIENNE');
    // Before the fix this returned ['SOLIENNE'] alone: the two agent-dir names
    // were invisible, so a SECOND bot could be named Pepper.
    assert.deepEqual(pm.takenBotNames(profiles).sort(), ['Hemma', 'Pepper', 'SOLIENNE']);
  });
});

test('legacy loose configs still count — old installs must not regress', () => {
  // The fallback is why the old code appeared to work at all: the only profiles
  // it could see were the legacy ones. Those have to keep being seen.
  withProfilesRoot((profiles) => {
    legacyProfile(profiles, 'sal', 'SAL');
    assert.deepEqual(pm.takenBotNames(profiles), ['SAL']);
  });
});

test('a stale loose config does not shadow the agent-dir name', () => {
  // A renamed bot leaves the ORIGINAL name behind in the pre-#305 file forever
  // (bot8 read "Diego" long after becoming Taylor). Reporting the stale name as
  // taken would reserve a name nobody answers to and free the one that is live.
  withProfilesRoot((profiles) => {
    modernProfile(profiles, 'bot8', 'Taylor');
    writeFileSync(join(profiles, 'bot8', 'config.json'), JSON.stringify({ botName: 'Diego' }));
    assert.deepEqual(pm.takenBotNames(profiles), ['Taylor']);
  });
});

test('unnamed, config-less and corrupt profiles drop out instead of throwing', () => {
  // Half-created profiles are normal on a real machine (the switcher makes the
  // dir before the bot is named). One of them must not take the whole list down
  // — that would be the same silent-short-list failure with a different cause.
  withProfilesRoot((profiles) => {
    modernProfile(profiles, 'real', 'Bender');
    mkdirSync(join(profiles, 'blank'), { recursive: true });          // no config at all
    modernProfile(profiles, 'unnamed', undefined);                    // config, no botName
    mkdirSync(join(profiles, 'broken', 'agent'), { recursive: true });
    writeFileSync(join(profiles, 'broken', 'agent', 'config.json'), '{ not json');
    assert.deepEqual(pm.takenBotNames(profiles), ['Bender']);
  });
});

test('no profiles dir yet returns an empty list, not an error', () => {
  // First run. The setup call asks for name candidates before anything exists.
  assert.deepEqual(pm.takenBotNames(join(tmpdir(), 'vibeconf-no-such-profiles-root')), []);
});

test('the names it reports are actually excluded from the suggestion pool', () => {
  // The end the caller cares about: a taken name must never be offered. Names
  // are returned verbatim and randomBotName folds case itself, so a profile
  // storing "pepper" still has to block the pool's "Pepper".
  withProfilesRoot((profiles) => {
    modernProfile(profiles, 'p', 'pepper');
    const taken = pm.takenBotNames(profiles);
    const drawn = new Set(Array.from({ length: 300 }, () => randomBotName({ taken })));
    assert.ok(drawn.size > 1, 'sanity: the pool should be offering many names');
    assert.ok(!drawn.has('Pepper'), 'a name already in use must not be suggested');
  });
});

test('main.js asks profile-manager rather than re-deriving the config path', () => {
  // main.js cannot be imported, and this is the invariant that actually keeps
  // the bug fixed: one place knows where identity lives. A hand-rolled read here
  // is how collision detection went blind for every profile made after #305.
  const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
  const fn = main.slice(main.indexOf('function takenBotNames()'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.match(body, /profile-manager\.js'\)\.takenBotNames\(PROFILES_ROOT\)/);
  assert.ok(!/readFileSync/.test(body), 'must not read a config path of its own');
});
