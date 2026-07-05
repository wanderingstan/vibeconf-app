// config-scope.test.mjs — unit tests for #366 preference scoping: the
// app-level/per-profile routing (ScopedStore), the one-time migration that
// heals existing installs, and the fresh (shared-file) Store mode that keeps
// concurrent profile instances from clobbering each other's writes.
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const Store = require('../electron-app/store.js');
const {
  APP_LEVEL_KEYS,
  MIGRATE_KEYS,
  isAppLevel,
  ScopedStore,
  migrateAppLevelKeys,
} = require('../electron-app/config-scope.js');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vibeconf-scope-'));
const readConfig = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));

test('scope map: the decided app-level keys, everything else per-profile', () => {
  for (const k of ['ttsApiKey', 'vcSessionToken', 'vcSessionLoggedOutToken', 'syncBaseUrl', 'websiteUrl', 'dangerousMode']) {
    assert.equal(isAppLevel(k), true, `${k} should be app-level`);
  }
  for (const k of ['botName', 'ttsVoiceId', 'meetAccountEmail', 'bargeInGraceMs', 'claudeModel', 'remoteLogging', 'profileIcon']) {
    assert.equal(isAppLevel(k), false, `${k} should be per-profile`);
  }
});

test('ScopedStore routes writes: app keys land in the base config, profile keys in the profile config', () => {
  const base = tmpDir();
  const prof = tmpDir();
  const scoped = new ScopedStore(new Store(base, { fresh: true }), new Store(prof));

  scoped.set('ttsApiKey', 'sk_secret');
  scoped.set('botName', 'Samantha');

  assert.equal(readConfig(base).ttsApiKey, 'sk_secret');
  assert.equal(readConfig(base).botName, undefined);
  assert.equal(readConfig(prof).botName, 'Samantha');
  assert.equal(readConfig(prof).ttsApiKey, undefined);
  assert.equal(scoped.get('ttsApiKey'), 'sk_secret');
  assert.equal(scoped.get('botName'), 'Samantha');
});

test('ScopedStore.getMultiple merges across scopes', () => {
  const base = tmpDir();
  const prof = tmpDir();
  const scoped = new ScopedStore(new Store(base, { fresh: true }), new Store(prof));
  scoped.set('websiteUrl', 'https://preview.example');
  scoped.set('botName', 'Jimmy');
  assert.deepEqual(scoped.getMultiple(['websiteUrl', 'botName', 'unset']), {
    websiteUrl: 'https://preview.example',
    botName: 'Jimmy',
  });
});

test('set-once in one profile is visible from a second profile instance', () => {
  const base = tmpDir();
  const profA = tmpDir();
  const profB = tmpDir();
  const a = new ScopedStore(new Store(base, { fresh: true }), new Store(profA));
  a.set('ttsApiKey', 'sk_once');
  // Profile B constructs its stores later (separate instance, same base).
  const b = new ScopedStore(new Store(base, { fresh: true }), new Store(profB));
  assert.equal(b.get('ttsApiKey'), 'sk_once');
});

test('migration copies ONLY the migratable keys up (ttsApiKey), never dangerousMode / URL overrides', () => {
  const base = tmpDir();
  const prof = tmpDir();
  fs.writeFileSync(
    path.join(prof, 'config.json'),
    JSON.stringify({
      ttsApiKey: 'sk_migrate_me',
      botName: 'Jimmy',
      dangerousMode: true, // must NOT be promoted (machine-wide --dangerously-skip-permissions)
      websiteUrl: 'https://stale-preview.vercel.app', // must NOT be promoted (points machine at a dead host)
    }),
  );
  const appStore = new Store(base, { fresh: true });
  const profileStore = new Store(prof);
  migrateAppLevelKeys(appStore, profileStore, () => {});

  assert.equal(readConfig(base).ttsApiKey, 'sk_migrate_me');
  assert.equal(readConfig(base).dangerousMode, undefined);
  assert.equal(readConfig(base).websiteUrl, undefined);
  // Migrated profile copy healed away; identity and non-migratable copies stay on disk.
  assert.equal(readConfig(prof).ttsApiKey, undefined);
  assert.equal(readConfig(prof).botName, 'Jimmy');
  // …but the leftover app-level copies are ignored by routing: effective
  // values come from the (unset) app store, not the profile file.
  const scoped = new ScopedStore(appStore, profileStore);
  assert.equal(scoped.get('dangerousMode'), undefined);
  assert.equal(scoped.get('websiteUrl'), undefined);
});

test('MIGRATE_KEYS is exactly [ttsApiKey] (guard against accidental auto-promotion)', () => {
  assert.deepEqual(MIGRATE_KEYS, ['ttsApiKey']);
});

test('migration never clobbers an existing app-level value; differing profile copy is kept but unreachable', () => {
  const base = tmpDir();
  const prof = tmpDir();
  fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({ ttsApiKey: 'sk_app_wins' }));
  fs.writeFileSync(path.join(prof, 'config.json'), JSON.stringify({ ttsApiKey: 'sk_stale_profile' }));
  const appStore = new Store(base, { fresh: true });
  const profileStore = new Store(prof);
  migrateAppLevelKeys(appStore, profileStore, () => {});

  assert.equal(readConfig(base).ttsApiKey, 'sk_app_wins');
  assert.equal(readConfig(prof).ttsApiKey, 'sk_stale_profile'); // left in place (differs)
  // …but routing makes the app value the effective one.
  const scoped = new ScopedStore(appStore, profileStore);
  assert.equal(scoped.get('ttsApiKey'), 'sk_app_wins');
});

test('migration is a no-op when app and profile stores are the same (default instance)', () => {
  const base = tmpDir();
  const only = new Store(base, { fresh: true });
  only.set('ttsApiKey', 'sk_default');
  migrateAppLevelKeys(only, only, () => {});
  assert.equal(readConfig(base).ttsApiKey, 'sk_default');
});

test('fresh store: concurrent instances read-merge-write instead of clobbering', () => {
  const base = tmpDir();
  const a = new Store(base, { fresh: true });
  const b = new Store(base, { fresh: true }); // second process, same shared file
  a.set('ttsApiKey', 'sk_from_a');
  b.set('websiteUrl', 'https://from-b.example'); // b loaded before a's write? fresh reload protects
  assert.deepEqual(readConfig(base), { ttsApiKey: 'sk_from_a', websiteUrl: 'https://from-b.example' });
  assert.equal(a.get('websiteUrl'), 'https://from-b.example'); // a sees b's write on next read
});

test("cached (per-profile) store keeps today's behavior: no reload on read", () => {
  const dir = tmpDir();
  const s = new Store(dir);
  s.set('botName', 'Jimmy');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ botName: 'External' }));
  assert.equal(s.get('botName'), 'Jimmy'); // cached — single-owner semantics
});

test('whole-config get(): merged view with app-level winning over stale profile leftovers', () => {
  const base = tmpDir();
  const prof = tmpDir();
  fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({ ttsApiKey: 'sk_app' }));
  fs.writeFileSync(path.join(prof, 'config.json'), JSON.stringify({ ttsApiKey: 'sk_stale', botName: 'Jimmy' }));
  const scoped = new ScopedStore(new Store(base, { fresh: true }), new Store(prof));
  const all = scoped.get();
  assert.equal(all.ttsApiKey, 'sk_app');
  assert.equal(all.botName, 'Jimmy');
});

test('APP_LEVEL_KEYS is exactly the decided set (guard against accidental promotion)', () => {
  assert.deepEqual(
    [...APP_LEVEL_KEYS].sort(),
    ['claudeIntegrationRemoved', 'dangerousMode', 'syncBaseUrl', 'ttsApiKey', 'vcSessionLoggedOutToken', 'vcSessionToken', 'websiteUrl'],
  );
});

test('fresh store: atomic save leaves no temp file and survives a garbage config (keeps last-known-good)', () => {
  const dir = tmpDir();
  const s = new Store(dir, { fresh: true });
  s.set('ttsApiKey', 'sk_good');
  // Simulate a torn/corrupt file written by another process.
  fs.writeFileSync(path.join(dir, 'config.json'), '{"ttsApiKey": "sk_go'); // truncated JSON
  assert.equal(s.get('ttsApiKey'), 'sk_good'); // kept last-known-good, no reset to {}
  // A subsequent write persists the good data, not an empty object.
  s.set('websiteUrl', 'https://x.example');
  assert.deepEqual(readConfig(dir), { ttsApiKey: 'sk_good', websiteUrl: 'https://x.example' });
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});
