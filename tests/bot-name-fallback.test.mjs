// bot-name-fallback.test.mjs — the resolver's fallback chain.
//
// Pins the two things that made this worth changing AND the thing that must NOT
// change: launched/named bots get a real, DISTINCT name (so a room of bots can
// address each other by name), while a genuinely unconfigured bot still reads as
// "Unnamed bot" — the stray-instance safety from bot-name-default.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveBotName, resolveBotNameWithSource, botNameForAppUI, humanizeProfileName } = require('../electron-app/bot-name.js');
const { DEFAULT_BOT_NAME } = require('../electron-app/preferences-schema.js');

test('a stored panel name wins over everything', () => {
  assert.equal(
    resolveBotName({ storedName: 'Seth', cliName: 'Alice', profileName: 'test-meet-guest-1' }),
    'Seth',
  );
});

test('a launched --bot-name is used when nothing is stored', () => {
  assert.equal(
    resolveBotName({ storedName: null, cliName: 'Alice', profileName: 'test-meet-guest-1' }),
    'Alice',
  );
});

test('a named profile is humanized when there is no stored or launch name', () => {
  assert.equal(
    resolveBotName({ storedName: null, cliName: null, profileName: 'test-meet-guest-1' }),
    'Test Meet Guest 1',
  );
});

test('a genuinely unconfigured bot stays "Unnamed bot" (stray-instance safety)', () => {
  // No stored name, no --bot-name, and the DEFAULT profile passes profileName:null
  // — it must NOT borrow a name, so a stray default instance is visibly unset.
  assert.equal(resolveBotName({ storedName: null, cliName: null, profileName: null }), DEFAULT_BOT_NAME);
  assert.equal(resolveBotName({}), DEFAULT_BOT_NAME);
});

test('distinct launched bots resolve to DISTINCT names (name-addressing works)', () => {
  const names = ['Alice', 'Jimmy', 'Cosmo'].map((n) => resolveBotName({ cliName: n }));
  assert.equal(new Set(names).size, 3, 'each --bot-name must stay distinct');
});

test('humanize turns a slug into Meet-transcribable words', () => {
  assert.equal(humanizeProfileName('test-bot'), 'Test Bot');
  assert.equal(humanizeProfileName('test_meet_guest_2'), 'Test Meet Guest 2');
  assert.equal(humanizeProfileName('Default'), 'Default');
  assert.equal(humanizeProfileName(''), null);
  assert.equal(humanizeProfileName(null), null);
});

test('blank/whitespace inputs are treated as absent, not as a name', () => {
  assert.equal(resolveBotName({ storedName: '   ', cliName: 'Alice' }), 'Alice');
  assert.equal(resolveBotName({ storedName: '', cliName: '', profileName: '   ' }), DEFAULT_BOT_NAME);
});

test('resolveBotNameWithSource reports where the name came from', () => {
  assert.deepEqual(resolveBotNameWithSource({ storedName: 'Seth' }), { name: 'Seth', source: 'stored' });
  assert.deepEqual(resolveBotNameWithSource({ cliName: 'Alice' }), { name: 'Alice', source: 'cli' });
  assert.deepEqual(resolveBotNameWithSource({ profileName: 'test-bot' }), { name: 'Test Bot', source: 'profile' });
  assert.deepEqual(resolveBotNameWithSource({}), { name: DEFAULT_BOT_NAME, source: 'default' });
});

test('the app-UI name tags launch/profile fallbacks but not a real or default name', () => {
  // A launched or named-profile bot is flagged so it is not mistaken for a saved
  // profile; a real stored name and the plain "Unnamed bot" carry no tag.
  assert.equal(botNameForAppUI({ cliName: 'Alice' }), 'Alice [CLI name]');
  assert.equal(botNameForAppUI({ profileName: 'test-meet-guest-1' }), 'Test Meet Guest 1 [profile]');
  assert.equal(botNameForAppUI({ storedName: 'Seth' }), 'Seth');
  assert.equal(botNameForAppUI({}), DEFAULT_BOT_NAME);
});

test('the Meet name stays PLAIN even when the app-UI name is tagged', () => {
  // Same inputs: participants/other bots see "Alice"; the app UI shows the tag.
  const inputs = { cliName: 'Alice' };
  assert.equal(resolveBotName(inputs), 'Alice');
  assert.equal(botNameForAppUI(inputs), 'Alice [CLI name]');
});
