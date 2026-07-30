// voice-prefs.test.mjs — settings a bot changes mid-call have to actually stick.
//
// The bug these pin: set_voice wrote the config file directly, at a hardcoded
// macOS path pointing at the APP-LEVEL config. The voice keys are per-profile,
// so the app read none of them from there. A voice change during a call looked
// saved, said "applies on next restart", and was silently ignored forever —
// while the two files drifted apart.
//
// The rule now is: a setting that should outlive the call is a preference, and
// preferences are written through the app's /api/preferences. Nothing in the
// MCP server may write a config file.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PREFERENCES, validate } = require('../electron-app/preferences-schema.js');
const { isAppLevel } = require('../electron-app/config-scope.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const server = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');
const mcp = readFileSync(join(root, 'mcp-server/server.js'), 'utf8');

const codeOnly = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// Every key that describes the bot's voice. set_voice writes some combination
// of these; all of them must be settable through the preferences API.
const VOICE_KEYS = ['ttsProvider', 'ttsVoiceId', 'macosVoice', 'voiceboxProfileId', 'voiceboxEngine'];

test('every voice key is a real preference', () => {
  // Not schema keys = POST /api/preferences rejects them = set_voice cannot
  // route through the app at all. This is why the private config file existed.
  for (const key of VOICE_KEYS) {
    assert.ok(PREFERENCES[key], `${key} must be in the preference schema`);
    assert.equal(PREFERENCES[key].type, 'string');
  }
});

test('voice keys are per-profile, not machine-wide', () => {
  // The whole bug was writing them to the app-level config. A bot's voice is
  // part of its identity — two profiles must be able to sound different.
  for (const key of VOICE_KEYS) {
    assert.ok(!isAppLevel(key), `${key} must NOT be app-level`);
  }
  // The ElevenLabs key is the opposite case: one secret per machine.
  assert.ok(isAppLevel('ttsApiKey'), 'ttsApiKey should stay app-level');
});

test('ttsProvider only accepts providers that exist', () => {
  for (const ok of ['elevenlabs', 'macos-say', 'voicebox', '']) {
    assert.ok(validate('ttsProvider', ok).ok, `${ok || '(empty)'} should be valid`);
  }
  assert.ok(!validate('ttsProvider', 'festival').ok, 'unknown providers must be rejected');
});

test('the MCP server never writes a config file', () => {
  // The regression guard. Adding a key here means adding it to the schema, not
  // reaching for the filesystem again.
  assert.ok(!/writeConfig\s*\(/.test(mcp), 'mcp-server must not write config files');
  assert.ok(!/writeFileSync/.test(codeOnly(mcp)), 'mcp-server must not write config files');
});

test('set_voice writes through the preferences API', () => {
  const fn = mcp.slice(mcp.indexOf('"set_voice"'));
  const body = fn.slice(0, fn.indexOf('\n);'));
  assert.ok(!/readConfig\(\)\.macosVoice|config\.ttsProvider\s*=/.test(body),
    'set_voice must not mutate a config object');
  // One batched call per branch, not a sequence of single writes.
  const calls = [...body.matchAll(/setPrefs\(\[/g)];
  assert.equal(calls.length, 3, 'expected one batched write per provider branch');
  for (const key of ['macosVoice', 'voiceboxProfileId', 'voiceboxEngine', 'ttsVoiceId', 'ttsProvider']) {
    assert.ok(body.includes(`key: '${key}'`), `set_voice should be able to write ${key}`);
  }
});

test('each set_voice branch writes its provider together with its identifier', () => {
  // A provider without its matching id is a bot that cannot speak. They must
  // never be written as separate requests.
  const fn = mcp.slice(mcp.indexOf('"set_voice"'));
  const body = fn.slice(0, fn.indexOf('\n);'));
  for (const [id, provider] of [
    ['macosVoice', 'macos-say'],
    ['voiceboxProfileId', 'voicebox'],
    ['ttsVoiceId', 'elevenlabs'],
  ]) {
    const batch = body.slice(body.indexOf(`key: '${id}'`));
    const end = batch.indexOf(']);');
    assert.ok(end > 0 && batch.slice(0, end).includes(`value: '${provider}'`),
      `${id} must be written in the same batch as ttsProvider: ${provider}`);
  }
});

test('the preferences endpoint validates the whole batch before writing any of it', () => {
  const route = server.slice(server.indexOf("url.pathname === '/api/preferences' && req.method === 'POST'"));
  const body = route.slice(0, route.indexOf('\n    if (!pathMatch)'));
  assert.match(body, /parsed\?\.updates/, 'must accept a batch');
  // Validation loop has to complete before the write loop starts — otherwise a
  // bad third key leaves the first two applied.
  const validateLoop = body.indexOf('prefsSchema.validate(upd?.key');
  const writeLoop = body.indexOf('this.setPref(key, value)');
  assert.ok(validateLoop > 0 && writeLoop > validateLoop,
    'all updates must be validated before any is written');
  // And a single-key POST keeps working — the panel and set_preference use it.
  assert.match(body, /\{ key: parsed\?\.key, value: parsed\?\.value \}/);
});

test('persisting comes before live-applying', () => {
  // applyPref only mirrors a change into the running app. If a throwing hook
  // ran first, the change could be applied but never saved — which is the exact
  // class of bug this whole change is fixing.
  const route = server.slice(server.indexOf("url.pathname === '/api/preferences' && req.method === 'POST'"));
  const body = route.slice(0, route.indexOf('\n    if (!pathMatch)'));
  assert.ok(body.indexOf('this.setPref(key, value)') < body.indexOf('this.applyPref(key, value)'),
    'setPref must run before applyPref');
});

test('every voice key applies live, not just on restart', () => {
  // Persisting the provider but applying only the id left the engine on its old
  // provider until the next launch: saved, but the bot kept its old voice.
  const fn = main.slice(main.indexOf('applyPref: (key, value) =>'));
  const body = fn.slice(0, fn.indexOf("\n  },\n"));
  for (const key of VOICE_KEYS) {
    assert.ok(body.includes(`key === '${key}'`), `applyPref must handle ${key}`);
  }
});

test('the app-level config path is resolved per platform', () => {
  // Hardcoded to macOS, this returned {} on Windows and Linux — so the bot
  // there believed no ElevenLabs key was set and fell back to an OS voice.
  const fn = mcp.slice(mcp.indexOf('function getConfigPath'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /win32/, 'must handle Windows');
  assert.match(body, /APPDATA/, 'Windows userData lives under APPDATA');
  assert.match(body, /darwin/, 'must handle macOS');
  assert.match(body, /XDG_CONFIG_HOME|\.config/, 'must handle Linux');
});

test('set_caption_language saves the language it applied', () => {
  const fn = mcp.slice(mcp.indexOf('"set_caption_language"'));
  const body = fn.slice(0, fn.indexOf('\n);'));
  assert.match(body, /setPrefs\(\[\{ key: 'captionLanguage', value: result\.language \}\]\)/,
    "must persist the tag Meet resolved to, not the one that was asked for");
  // Failing to save must not report the change itself as failed — it did apply.
  const save = body.slice(body.indexOf("key: 'captionLanguage'"));
  assert.match(save, /catch/, 'a failed save should degrade to a note, not an error');
});

test('a language that is already live is not applied twice', () => {
  // set_caption_language now applies AND saves, so the preference write lands
  // immediately after the work is done. Without this guard, applyPref would
  // re-walk Meet's Settings dialog — covering the caption region and making the
  // bot briefly deaf — to reach the state it is already in.
  const apply = main.slice(main.indexOf("} else if (key === 'captionLanguage')"));
  const block = apply.slice(0, apply.indexOf("} else if (key === 'studioSound')"));
  assert.match(block, /captionLanguageAlreadyApplied\(localServer\.roomId, want\)/);
  assert.match(block, /_captionLanguageInFlight/);
  // Still applies when it genuinely is a change.
  assert.match(block, /callStatus === 'in-call'/);
  assert.match(block, /onSetCaptionLanguage/);
});

test('the already-applied check matches either spelling of the tag', () => {
  // Meet resolves loose tags: ask for "es" and it selects "es-ES". A later
  // request may use either form and must still count as already-applied.
  const fn = main.slice(main.indexOf('function captionLanguageAlreadyApplied'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /a\.requested === language \|\| a\.resolved === language/);
  assert.match(body, /a\.room !== room/, 'the latch must not leak across calls');
});
