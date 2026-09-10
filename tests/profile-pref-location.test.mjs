// profile-pref-location.test.mjs — the fleet scripts must write per-profile
// prefs where the APP reads them (<profile>/agent/config.json, #305), not the
// legacy loose <profile>/config.json.
//
// This failure mode is silent by construction: writing the loose path succeeds,
// the file reads back correctly, and the app — which migrates that file once and
// then ignores it — loads none of it. On 2026-09-09 that meant every test bot's
// voice and name had been pinned into a file nothing read; the bots booted as
// "Unnamed bot" on the system default voice while the config on disk said
// otherwise. Source assertions, because the real check needs a running Electron.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(join(root, p), 'utf8');

const fleet = read('scripts/spawn-test-fleet.sh');
const setup = read('scripts/setup-test-profiles.sh');
const helper = read('scripts/profile-pref.mjs');

test('both fleet scripts write prefs through the helper', () => {
  for (const [name, src] of [['spawn-test-fleet.sh', fleet], ['setup-test-profiles.sh', setup]]) {
    assert.match(src, /profile-pref\.mjs/, `${name} must route pref writes through profile-pref.mjs`);
  }
});

test('neither script writes a bare <profile>/config.json again', () => {
  // The exact shape of the old bug: a node one-liner concatenating a profile dir
  // with "/config.json" and writing it.
  for (const [name, src] of [['spawn-test-fleet.sh', fleet], ['setup-test-profiles.sh', setup]]) {
    assert.doesNotMatch(
      src, /writeFileSync\([^)]*config\.json/,
      `${name} must not write a profile config.json directly — use profile-pref.mjs`,
    );
  }
});

test('the helper targets the agent dir, not the loose path', () => {
  assert.match(helper, /agentDirFor/, 'must resolve the target with the app\'s own agentDirFor');
  assert.match(helper, /agent-workdir\.js/);
  // The write target is built from agentDirFor(...), never from profileDir directly.
  assert.match(helper, /const target = join\(agentDir, 'config\.json'\)/);
});

test('the helper seeds a pre-#305 profile instead of blanking it', () => {
  // Creating the agent config suppresses main.js's own one-time migration, so
  // the helper has to carry the loose values over itself or the profile silently
  // loses every pref it had.
  assert.match(helper, /perProfileSubset/);
  assert.match(helper, /APP_LEVEL_KEYS/);
});
