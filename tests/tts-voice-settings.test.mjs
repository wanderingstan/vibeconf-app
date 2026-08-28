// tts-voice-settings.test.mjs — ElevenLabs voice_settings as preferences (#594).
//
// stability and similarity_boost were hardcoded in tts.js; style, speed and
// use_speaker_boost were never sent, so the API's defaults applied. All five are
// now preferences, and the defaults are ElevenLabs' own, so no existing bot
// changes how it sounds until someone moves a knob.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// tts.js publishes onto globalThis (it also loads in the extension's service
// worker, which has no module system), so requiring it for the side effect is
// how the other suites reach it too.
require('../electron-app/tts.js');
const { TTSProvider } = globalThis;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(join(root, 'electron-app/main.js'), 'utf8');

test('the defaults are ElevenLabs defaults, so nothing changes sound', () => {
  // The whole safety argument for this change: every bot already running keeps
  // its exact voice until someone deliberately moves a setting.
  const v = new TTSProvider({}).voiceSettings();
  assert.equal(v.stability, 0.5);          // was hardcoded to this
  assert.equal(v.similarity_boost, 0.75);  // was hardcoded to this
  assert.equal(v.style, 0);                // API default, previously implicit
  assert.equal(v.use_speaker_boost, true); // API default, previously implicit
  assert.equal(v.speed, 1.0);              // API default, previously implicit
});

test('zero and false survive the constructor', () => {
  // `||` would discard all three of these. They are legal values, and silently
  // replacing them with the defaults is the bug this guards.
  const v = new TTSProvider({ ttsStability: 0, ttsStyle: 0, ttsSpeakerBoost: false }).voiceSettings();
  assert.equal(v.stability, 0);
  assert.equal(v.style, 0);
  assert.equal(v.use_speaker_boost, false);
});

test('zero and false survive updateConfig too', () => {
  // Same trap on the live-apply path, where an agent's set_preference lands.
  const t = new TTSProvider({});
  t.updateConfig({ ttsStability: 0, ttsStyle: 0, ttsSpeakerBoost: false });
  const v = t.voiceSettings();
  assert.equal(v.stability, 0);
  assert.equal(v.style, 0);
  assert.equal(v.use_speaker_boost, false);
});

test('out-of-range values clamp rather than failing the request', () => {
  // ElevenLabs rejects speed outside 0.7-1.2. A rejected request is no audio at
  // all, which in a live call reads as the bot having frozen — much worse than
  // speaking slightly slower than asked. "2" is the plausible mistake: it looks
  // like a reasonable way to ask for double speed.
  assert.equal(new TTSProvider({ ttsSpeed: 2 }).voiceSettings().speed, 1.2);
  assert.equal(new TTSProvider({ ttsSpeed: 0.1 }).voiceSettings().speed, 0.7);
  assert.equal(new TTSProvider({ ttsStability: 5 }).voiceSettings().stability, 1);
  assert.equal(new TTSProvider({ ttsStyle: -1 }).voiceSettings().style, 0);
});

test('a non-numeric value falls back instead of becoming NaN', () => {
  // Prefs arrive from a JSON store and over IPC; '' and 'fast' are both things
  // that can turn up. NaN would reach the API and 422 every single line.
  const v = new TTSProvider({ ttsSpeed: '', ttsStability: 'fast' }).voiceSettings();
  assert.equal(v.speed, 1.0);
  assert.equal(v.stability, 0.5);
  assert.ok(Number.isFinite(v.speed) && Number.isFinite(v.stability));
});

test('a numeric string still works', () => {
  // The store round-trips some values as strings; "0.85" is a real setting.
  assert.equal(new TTSProvider({ ttsSpeed: '0.85' }).voiceSettings().speed, 0.85);
});

test('the audio cache keys on every voice setting', () => {
  // The cache exists to reuse ack phrases. If speed is not in the key, turning
  // the speed up mid-call keeps replaying "Okay." at the old speed forever,
  // while new text renders at the new one — the bot audibly disagrees with
  // itself. Same for the other four.
  const base = { apiKey: 'k' };
  const key = (extra) => new TTSProvider({ ...base, ...extra })._cacheKey('Okay.');
  const original = key({});
  for (const extra of [
    { ttsSpeed: 1.1 },
    { ttsStability: 0.9 },
    { ttsSimilarityBoost: 0.4 },
    { ttsStyle: 0.3 },
    { ttsSpeakerBoost: false },
  ]) {
    assert.notEqual(key(extra), original,
      `changing ${Object.keys(extra)[0]} must miss the cache, not replay stale audio`);
  }
});

test('the request body uses voiceSettings(), not a hardcoded object', () => {
  const tts = fs.readFileSync(join(root, 'electron-app/tts.js'), 'utf8');
  const i = tts.indexOf('async _elevenlabs(');
  const body = tts.slice(i, i + 1200);
  assert.match(body, /voice_settings: this\.voiceSettings\(\)/);
  assert.doesNotMatch(body, /stability: 0\.5/, 'the hardcoded pair is gone');
});

test('main applies them at boot AND live, from one list', () => {
  // A setting that saves, shows in the panel, and does not take effect until a
  // restart is worse than one that is missing: it looks like it worked.
  assert.match(main, /^const VOICE_SETTING_KEYS = \[[^\]]*'ttsSpeed'[^\]]*\]/m);
  assert.match(main, /store\.getMultiple\(\[[^\]]*\.\.\.VOICE_SETTING_KEYS\]\)/);
  assert.match(main, /VOICE_SETTING_KEYS\.includes\(key\)/, 'live-apply branch');
  // Boot-time load must not use truthiness, for the 0/false reason above.
  assert.match(main, /if \(savedConfig\[k\] !== undefined\) tts\.updateConfig\(\{ \[k\]: savedConfig\[k\] \}\)/);
});

test('every key is a real preference with a range', () => {
  const schema = require('../electron-app/preferences-schema.js');
  const prefs = schema.PREFERENCES || schema.preferences || schema;
  const m = main.match(/^const VOICE_SETTING_KEYS = \[([^\]]*)\]/m);
  const keys = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.equal(keys.length, 5);
  for (const k of keys) {
    assert.ok(prefs[k], `${k} is declared in the schema`);
    if (prefs[k].type === 'number') {
      assert.equal(typeof prefs[k].min, 'number', `${k} has a min`);
      assert.equal(typeof prefs[k].max, 'number', `${k} has a max`);
    }
  }
  // The schema range and the clamp must agree, or the panel offers a value the
  // code quietly refuses to honour.
  assert.equal(prefs.ttsSpeed.min, 0.7);
  assert.equal(prefs.ttsSpeed.max, 1.2);
});
