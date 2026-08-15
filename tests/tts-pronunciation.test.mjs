// tts-pronunciation.test.mjs — the TTS pronunciation substitution table (#383).
// "vibeconferencing" gets mangled by every engine ("vibey-conferencing"); a
// hyphen inserted at the synthesize()/sayFallback() choke points fixes the
// pronunciation without touching what main.js records as the bot's words.
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../electron-app/tts.js'); // registers on globalThis (extension-context module)
const applyTtsPronunciationFixes = globalThis.applyTtsPronunciationFixes;
const TTSProvider = globalThis.TTSProvider;

test('rewrites vibeconferencing to vibe-conferencing, case-insensitively, preserving case', () => {
  assert.equal(
    applyTtsPronunciationFixes('Welcome to vibeconferencing!'),
    'Welcome to vibe-conferencing!'
  );
  assert.equal(
    applyTtsPronunciationFixes('Vibeconferencing is live.'),
    'Vibe-conferencing is live.'
  );
  assert.equal(
    applyTtsPronunciationFixes('VIBECONFERENCING'),
    'VIBE-CONFERENCING'
  );
});

test('replaces every occurrence, leaves other text alone', () => {
  assert.equal(
    applyTtsPronunciationFixes('vibeconferencing and vibeconferencing'),
    'vibe-conferencing and vibe-conferencing'
  );
  const untouched = 'Nothing to fix here, not even video conferencing.';
  assert.equal(applyTtsPronunciationFixes(untouched), untouched);
  assert.equal(applyTtsPronunciationFixes(''), '');
  assert.equal(applyTtsPronunciationFixes(null), null);
});

test('synthesize() applies the fix before the engine sees the text', async () => {
  const tts = new TTSProvider({ provider: 'elevenlabs', apiKey: 'x' });
  let seen = null;
  tts._doSynthesize = async (t) => { seen = t; return new ArrayBuffer(1); };
  await tts.synthesize('This long sentence mentions vibeconferencing so nobody caches it accidentally.');
  assert.match(seen, /vibe-conferencing/);
  assert.doesNotMatch(seen, /vibeconferencing/);
});

test('sayFallback() applies the fix too (it bypasses synthesize)', async () => {
  const tts = new TTSProvider({ provider: 'macos-say' });
  let seen = null;
  tts._systemSay = async (t) => { seen = t; return new ArrayBuffer(1); };
  await tts.sayFallback('Try vibeconferencing today.');
  assert.equal(seen, 'Try vibe-conferencing today.');
});
