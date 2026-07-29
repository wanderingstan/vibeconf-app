// bot-name-default.test.mjs — an unconfigured bot must not look configured.
//
// "Jimmy" was the default botName for a long time. It reads as a real, chosen
// name, which made three different things indistinguishable from someone's
// actual bot: a fresh profile nobody had named, a test profile, and a stray
// instance left running by mistake.
//
// That cost a live call on 2026-07-29. A leftover test app was still running
// under the `uitest` profile, whose botName was also "Jimmy". Its window was
// identical to the real bot's, so "Call Jimmy now" went to it — but it was on a
// different port from the one the agent's MCP server targets, so the agent had
// nothing to drive, guessed, and spawned a second instance into the call.
//
// The fix is a default nobody would ever choose on purpose, so the mistake is
// visible the moment it appears on screen or in a participant list.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const schema = require('../electron-app/preferences-schema.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the default bot name is exported, and the schema uses that export', () => {
  // One source of truth. The old pattern repeated the literal in six places,
  // and a default in six places is a default nobody can change.
  assert.equal(typeof schema.DEFAULT_BOT_NAME, 'string');
  assert.ok(schema.DEFAULT_BOT_NAME.trim().length > 0);
  assert.equal(schema.PREFERENCES.botName.default, schema.DEFAULT_BOT_NAME);
});

test('the default is not a plausible personal name', () => {
  const d = schema.DEFAULT_BOT_NAME.toLowerCase();
  // The names that have actually been defaults or test-fleet identities here.
  // If one of these ever becomes the default again, an unconfigured bot goes
  // back to being indistinguishable from a real one.
  for (const name of ['jimmy', 'alice', 'samantha', 'cosmo', 'dizzy', 'coltrane']) {
    assert.notEqual(d, name, `${name} reads as a configured bot, not an unset one`);
  }
  // It should say, in plain words, that nobody named it.
  assert.match(d, /unnamed|unconfigured|no name|nameless/,
    'the default should announce itself as unset');
});

test('no shipping fallback hardcodes a personal name', () => {
  // `store.get('botName') || 'Jimmy'` was copy-pasted across main.js. Those must
  // read DEFAULT_BOT_NAME (or the schema) instead, or the schema default becomes
  // a lie the moment a store read returns empty.
  for (const rel of [
    'electron-app/main.js',
    'electron-app/local-server.js',
    'electron-app/google-meet-provider.js',
    'electron-app/renderer/panel.js',
    'mcp-server/server.js',
  ]) {
    const src = readFileSync(join(root, rel), 'utf8');
    // Strip line comments: several files discuss "Jimmy" historically, and that
    // prose is worth keeping.
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/\|\|\s*['"]Jimmy['"]/.test(code),
      `${rel} still falls back to a hardcoded "Jimmy"`);
    assert.ok(!/=\s*['"]Jimmy['"]\s*;/.test(code),
      `${rel} still initialises a bot name to "Jimmy"`);
  }
});

test('the panel and onboarding fields do not ship a personal name', () => {
  // The Bot Settings field used to carry value="Jimmy" in the markup, so a
  // config that failed to load left a real-looking name on screen.
  const panel = readFileSync(join(root, 'electron-app/renderer/panel.html'), 'utf8');
  assert.ok(!/id="botName"[^>]*value="Jimmy"/.test(panel));
  const onboarding = readFileSync(join(root, 'electron-app/renderer/onboarding.html'), 'utf8');
  assert.ok(!/id="botName"[^>]*placeholder="Jimmy"/.test(onboarding),
    'the placeholder should show what an unnamed bot actually gets called');
});
