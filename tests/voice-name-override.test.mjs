// voice-name-override.test.mjs — speak(voice: 'George') must work.
//
// Measured live 2026-08-04, three dead utterances in one guided setup call:
//   ElevenLabs API error 404: voice_id 'Chris' was not found
//   ElevenLabs API error 404: voice_id 'River' was not found
//   ElevenLabs API error 404: voice_id 'George' was not found
//
// speak()'s voice override matched macOS voices BY NAME and Voicebox profiles
// BY NAME, then passed anything else through as an ElevenLabs voice_id. So the
// two providers a bot is least likely to use accepted names, and the default
// one silently required an opaque 20-character token.
//
// The bot went silent rather than erring anywhere the user could see it, which
// is the failure shape this codebase keeps having to design against.
//
// Run: node --test tests/voice-name-override.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

test('the ElevenLabs branch resolves a name, like the other two providers', () => {
  const block = main.slice(main.indexOf('if (systemVoiceNameSet.has(voice))'));
  const body = block.slice(0, block.indexOf('\n    }'));
  assert.match(body, /systemVoiceNameSet\.has\(voice\)/, 'macOS matches by name');
  assert.match(body, /voiceboxProfileNameSet\.has\(voice\)/, 'Voicebox matches by name');
  assert.match(body, /voiceId: resolveElevenLabsVoice\(voice\)/,
    'and ElevenLabs must too — it was the only one that did not');
  assert.doesNotMatch(body, /voiceId: voice\b/, 'no raw pass-through left');
});

test('a name that is not known falls back to treating it as an id', () => {
  // Ids are opaque 20-character tokens that cannot collide with a readable
  // name, so a miss is safe and keeps working for anyone passing a real id —
  // including every existing stored preference.
  const fn = main.slice(main.indexOf('function resolveElevenLabsVoice'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /elevenLabsIdByName\.get\(String\(voice\)\.toLowerCase\(\)\) \|\| voice/);
});

test('the lookup is case-insensitive', () => {
  // "george" is what someone says out loud; "George" is what the API lists.
  const fn = main.slice(main.indexOf('function warmElevenLabsVoiceNames'));
  assert.match(fn.slice(0, 500), /String\(v\.name\)\.toLowerCase\(\)/);
});

test('the name cache is warmed at startup, beside the other two', () => {
  // The other two name sets are warmed in the same place. Missing this one is
  // exactly how the asymmetry survived.
  assert.match(main, /warmElevenLabsVoiceNames\(\);/);
  const warm = main.indexOf('warmElevenLabsVoiceNames();');
  const vb = main.indexOf('voiceboxProfileNameSet = new Set(ps.map');
  assert.ok(Math.abs(warm - vb) < 1200, 'warmed alongside the Voicebox names, not somewhere unrelated');
});

test('an empty cache cannot make things worse', () => {
  // Warming is async and best-effort: if it fails or has not finished, resolve
  // returns the input unchanged, which is precisely the old behaviour.
  const fn = main.slice(main.indexOf('async function warmElevenLabsVoiceNames'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /if \(voices && voices\.length\)/, 'never install an empty map');
  assert.match(body, /catch/, 'a failed warm must not throw at startup');
});
