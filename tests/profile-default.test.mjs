// profile-default.test.mjs — the default profile is now just a profile under
// profiles/<name> named by a pointer, with no special BASE-root home. These
// cover the two pure pieces that make that work:
//   • resolveDefaultProfileName — pointer → dir name, case-insensitive reuse
//   • readConfigFields — reads the #305 agent-dir config, falls back to loose
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pm = require('../electron-app/profile-manager.js');

function withProfilesRoot(fn) {
  const base = mkdtempSync(join(tmpdir(), 'profiles-'));
  const root = join(base, 'profiles');
  mkdirSync(root, { recursive: true });
  try { return fn(root); } finally { rmSync(base, { recursive: true, force: true }); }
}

test('resolveDefaultProfileName: unset pointer falls back to "default"', () => {
  withProfilesRoot((root) => {
    assert.equal(pm.resolveDefaultProfileName(root, undefined), 'default');
    assert.equal(pm.resolveDefaultProfileName(root, ''), 'default');
    assert.equal(pm.resolveDefaultProfileName(root, '   '), 'default');
  });
});

test('resolveDefaultProfileName: an explicit pointer names the profile', () => {
  withProfilesRoot((root) => {
    assert.equal(pm.resolveDefaultProfileName(root, 'jimmy'), 'jimmy');
  });
});

test('resolveDefaultProfileName: reuses an existing dir case-insensitively', () => {
  // A legacy 'Default' dir must be reused, not shadowed by a colliding 'default'
  // on a case-insensitive filesystem.
  withProfilesRoot((root) => {
    mkdirSync(join(root, 'Default'));
    assert.equal(pm.resolveDefaultProfileName(root, 'default'), 'Default');
    assert.equal(pm.resolveDefaultProfileName(root, undefined), 'Default');
  });
});

test('resolveDefaultProfileName: pointer to a differently-cased existing name', () => {
  withProfilesRoot((root) => {
    mkdirSync(join(root, 'Jimmy'));
    assert.equal(pm.resolveDefaultProfileName(root, 'jimmy'), 'Jimmy');
  });
});

test('readConfigFields: prefers the agent-dir config over a loose one', () => {
  withProfilesRoot((root) => {
    const dir = join(root, 'bot');
    mkdirSync(join(dir, 'agent'), { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ botName: 'Loose' }));
    writeFileSync(join(dir, 'agent', 'config.json'), JSON.stringify({ botName: 'Agent' }));
    assert.equal(pm.readConfigFields(dir).botName, 'Agent');
  });
});

test('readConfigFields: falls back to the loose config for legacy profiles', () => {
  withProfilesRoot((root) => {
    const dir = join(root, 'legacy');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ botName: 'Legacy', profileIcon: 'x' }));
    const f = pm.readConfigFields(dir);
    assert.equal(f.botName, 'Legacy');
    assert.equal(f.profileIcon, 'x');
  });
});

test('readConfigFields: empty when neither config exists', () => {
  withProfilesRoot((root) => {
    const dir = join(root, 'blank');
    mkdirSync(dir, { recursive: true });
    assert.deepEqual(pm.readConfigFields(dir), {
      botName: null, meetAccountEmail: null, lastMeetName: null,
      lastSlackName: null, profileIcon: null,
    });
  });
});
