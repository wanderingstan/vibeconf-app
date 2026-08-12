// wizard-settings-parity.test.mjs — anything the setup wizard asks, you can change later.
//
// The wizard is a one-time flow. A preference it sets and no settings screen
// exposes is set once and then unreachable, which is how remoteLogging ended up
// answerable exactly once, at install, forever.
//
// Deliberately NOT "every preference needs a UI": most of the schema is tuning
// knobs (bargeInGraceMs, probe*, thinkingHoldMs) reachable through set_preference
// and the agent, and surfacing all of them would bury the handful that matter.
// The rule is narrower and defensible: if the WIZARD asks, settings must answer.
//
// Run: node --test tests/wizard-settings-parity.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { PREFERENCES } = require('../electron-app/preferences-schema.js');
const { isAppLevel } = require('../electron-app/config-scope.js');

const onboardingJs = readFileSync(join(root, 'electron-app/renderer/onboarding.js'), 'utf8');
const panelHtml = readFileSync(join(root, 'electron-app/renderer/panel.html'), 'utf8');
const appSettingsHtml = readFileSync(join(root, 'electron-app/renderer/app-settings.html'), 'utf8');

// What the wizard writes, read from the wizard itself rather than a list here —
// a hand-maintained list would go stale the moment someone adds a step.
function wizardPrefs() {
  const keys = new Set();
  for (const m of onboardingJs.matchAll(/set-config',\s*'([a-zA-Z]+)'/g)) keys.add(m[1]);
  return [...keys];
}

// Reachable afterwards: rendered by App Settings (app-level schema prefs), or
// present by id in either settings page's markup.
function reachableLater(key) {
  const def = PREFERENCES[key];
  const inAppSettingsSchema = !!def && typeof def === 'object' && 'type' in def
    && isAppLevel(key) && !def.hiddenInSettingsUI;
  return inAppSettingsSchema
    || panelHtml.includes(`id="${key}"`)
    || appSettingsHtml.includes(`id="${key}"`);
}

test('the wizard actually writes something we can find', () => {
  // Guard on the guard: if the scrape breaks, every assertion below passes
  // vacuously and the parity check quietly stops checking anything.
  const keys = wizardPrefs();
  assert.ok(keys.length >= 4, `only found ${keys.length} wizard prefs — the scrape is probably broken`);
  assert.ok(keys.includes('remoteLogging'), 'expected the logging question to be found');
});

test('every preference the wizard asks about can be changed later', () => {
  const orphans = wizardPrefs().filter((k) => !reachableLater(k));
  assert.deepEqual(orphans, [],
    `set by the wizard with no way to change it afterwards: ${orphans.join(', ')}`);
});

test('remoteLogging is machine-wide, matching how the wizard asks it', () => {
  // "The app can send its own diagnostic logs… which can include transcript
  // text" is a question about the machine. Per-profile, answering "no" bound the
  // answer to the Default profile and every later bot shipped transcripts.
  assert.equal(isAppLevel('remoteLogging'), true);
  const { MIGRATE_OPT_OUTS } = require('../electron-app/config-scope.js');
  assert.ok(MIGRATE_OPT_OUTS.includes('remoteLogging'),
    'promoting it without carrying existing opt-outs would silently resume logging');
});

test('the skill tells the bot to announce logging changes', () => {
  // remoteLogging decides whether transcript text leaves the machine, it is
  // app-level (so a per-call request silently changes it for every bot,
  // permanently), and it is invisible from inside the room. Silence is the wrong
  // default for all three reasons.
  const skill = readFileSync(join(root, 'mcp-server/join-call-skill.md'), 'utf8');
  assert.match(skill, /Say it out loud if you change logging/);
  assert.match(skill, /MACHINE-WIDE and permanent/);
  // Both directions — turning it ON is the one people would actually mind.
  assert.match(skill, /say it when you turn it ON as well/);
  assert.match(skill, /only when\s+asked/, 'not on its own initiative');
});
