// new-bot-random-background.test.mjs: every new bot gets a random preset.
//
// The bug: startup seeded a random background only when the profile had no
// config.json at all. "New bot…" and /call-new-bot run seedNewBotName first,
// which writes that config.json (the name) before the new instance boots, so
// every bot a user actually created came up on the plain default gradient.
// Reported by Stan in call suc-skmh-yqt-20261015T192124Z.
//
// The fix is a one-shot marker written by seedNewBotName and consumed at
// startup. These pin the decision (behaviourally, against the helper and the
// real Store) and the wiring (by source, since main.js cannot be imported).
//
// Run: node --test tests/new-bot-random-background.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const nbb = require(join(root, 'electron-app/new-bot-background.js'));
const Store = require(join(root, 'electron-app/store.js'));
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

// Mirror of main.js's startup step, driven through the real helper + Store so
// the consume-the-marker contract is exercised end to end on disk.
function startupSeed(store, isBrandNewProfile, rand = () => 0) {
  const marker = store.get(nbb.SEED_BACKGROUND_MARKER);
  if (nbb.shouldSeedRandomBackground({
    isBrandNewProfile, marker, currentSvg: store.get('avatarBackgroundSvg'),
  })) {
    const chosen = nbb.pickBackgroundPreset(['aurora.png', 'dunes.svg', 'README.md'], rand);
    store.set('avatarBackgroundSvg', `<svg data-preset="${chosen}"/>`);
    store.set('avatarBackgroundCaption', nbb.presetCaption(chosen));
  }
  if (marker !== undefined) store.delete(nbb.SEED_BACKGROUND_MARKER);
}

function withProfile(seed, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'nbb-'));
  try {
    if (seed) writeFileSync(join(dir, 'config.json'), JSON.stringify(seed));
    return fn(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('pre-seeded ("New bot…" / /call-new-bot) profile gets a random background', () => {
  // config.json already exists at startup, so isBrandNewProfile is false.
  withProfile({ botName: 'Diego', onboardingCallComplete: false, [nbb.SEED_BACKGROUND_MARKER]: true }, (dir) => {
    const store = new Store(dir);
    startupSeed(store, false, () => 0.99);
    assert.match(store.get('avatarBackgroundSvg'), /dunes\.svg/);
    assert.equal(store.get('avatarBackgroundCaption'), 'dunes');
    assert.equal(store.get(nbb.SEED_BACKGROUND_MARKER), undefined, 'marker consumed');
  });
});

test('a background the user cleared to the default gradient is NOT re-seeded on later launches', () => {
  withProfile({ botName: 'Diego', onboardingCallComplete: false, [nbb.SEED_BACKGROUND_MARKER]: true }, (dir) => {
    startupSeed(new Store(dir), false);
    // User resets to the default gradient. Onboarding is still incomplete,
    // which is exactly the state an inference-based check would re-roll.
    new Store(dir).set('avatarBackgroundSvg', '');
    for (let i = 0; i < 3; i++) startupSeed(new Store(dir), false);
    assert.equal(new Store(dir).get('avatarBackgroundSvg'), '');
  });
});

test('a bare --profile launch (no config.json at all) still gets one', () => {
  withProfile(null, (dir) => {
    const store = new Store(dir);
    startupSeed(store, true);
    assert.match(store.get('avatarBackgroundSvg'), /aurora\.png/);
  });
});

test('an existing bot without the marker is left alone, and a set background is never overwritten', () => {
  assert.equal(nbb.shouldSeedRandomBackground({ isBrandNewProfile: false, marker: undefined, currentSvg: '' }), false);
  assert.equal(nbb.shouldSeedRandomBackground({ isBrandNewProfile: true, marker: true, currentSvg: '<svg/>' }), false);
  assert.equal(nbb.pickBackgroundPreset(['notes.txt']), null);
});

test('main.js: seedNewBotName writes the marker', () => {
  const fn = main.slice(main.indexOf('function seedNewBotName'), main.indexOf('async function launchOrFocusProfile'));
  assert.match(fn, /seeded\[require\('\.\/new-bot-background\.js'\)\.SEED_BACKGROUND_MARKER\] = true/);
});

test('main.js: startup seeds via the helper (not isBrandNewProfile alone) and consumes the marker', () => {
  const block = main.slice(
    main.indexOf("const appLevelStore = new Store(BASE_USER_DATA, { fresh: true });"),
    main.indexOf('#366: inherit'));
  assert.match(block, /nbb\.shouldSeedRandomBackground\(\{\s*isBrandNewProfile,\s*marker,/);
  assert.doesNotMatch(block, /isBrandNewProfile && !profileStore\.get\('avatarBackgroundSvg'\)/,
    'the old filesystem-only gate is what missed pre-seeded bots');
  assert.match(block, /profileStore\.delete\(nbb\.SEED_BACKGROUND_MARKER\)/);
});
