// adopt-session-as-bot.test.mjs — giving an existing Claude session a face.
//
// The ordinary "new bot" path creates a blank profile that then starts a FRESH
// session. A power user may already have a session carrying months of context on
// a piece of work, and the more interesting move is to give THAT a face — it can
// already answer questions about what it has been doing.
//
// Mechanically that is the same profile creation with two settings seeded before
// first launch. Before first launch specifically: the bot's first act IS resuming
// its session, so there is no later moment to apply them.
//
// These pin the seeding contract against main.js, which cannot be imported.
//
// Run: node --test tests/adopt-session-as-bot.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

test('there is a handler for adopting a session', () => {
  assert.match(main, /ipcMain\.handle\('adopt-session-as-bot'/);
});

test('the seed carries BOTH the workdir and the session', () => {
  // Sessions are stored per working directory, so the pair is the identity — a
  // session name means nothing without the directory it was recorded in.
  assert.match(main, /seeded\.claudeWorkDir = adopt\.workdir/);
  assert.match(main, /seeded\.agentSession = adopt\.session/);
});

test('seeding happens in seedNewBotName, i.e. BEFORE launchOrFocusProfile', () => {
  const handler = main.slice(main.indexOf("ipcMain.handle('adopt-session-as-bot'"));
  const seedAt = handler.indexOf('seedNewBotName(name,');
  const launchAt = handler.indexOf('launchOrFocusProfile(name');
  assert.ok(seedAt > 0 && launchAt > 0, 'both calls are present');
  assert.ok(seedAt < launchAt, 'the settings exist before the bot boots and resumes');
});

test('a missing directory is refused, not silently made into a blank bot', () => {
  const handler = main.slice(main.indexOf("ipcMain.handle('adopt-session-as-bot'"));
  assert.match(handler, /if \(!dir\) return \{ ok: false/);
  assert.match(handler, /fs\.existsSync\(dir\)/);
});

test('the session name goes through the same sanitizer the launcher uses', () => {
  // It reaches a shell command inside an AppleScript string on the macOS path.
  const handler = main.slice(main.indexOf("ipcMain.handle('adopt-session-as-bot'"));
  assert.match(handler, /resolveSessionName/);
});

test('the adopted name must be addressable, or the random pool takes over', () => {
  assert.match(main, /isAddressableBotName\(adopt\.botName\)/);
  assert.match(main, /const botName = adopted \|\| randomBotName/);
});

test('adopting does not skip onboarding — the bot still introduces itself', () => {
  // Seeded false for every new bot, adopted or not: an adopted session has
  // context but has never chosen a voice, emoji or background.
  assert.match(main, /onboardingCallComplete: false/);
});

test('an existing config is never clobbered by a reused profile directory', () => {
  // nextBotProfileName picks the first GAP, so the directory may have been used
  // before and still hold something the user cares about.
  assert.match(main, /if \(existing\.botName\) return;/);
});
