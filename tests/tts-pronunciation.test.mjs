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

// --- a dot between digits is spoken, not punctuation ------------------------

test('a version number is said as "point", not guessed at', () => {
  // Stan, on a call 2026-09-09, hearing the bot say one aloud: "your
  // pronunciation of version numbers is really weird, it doesn't even really
  // sound like English." Engines treat "0.8.51" as a single token and guess.
  assert.equal(applyTtsPronunciationFixes('0.8.51'), '0 point 8 point 51');
  assert.equal(applyTtsPronunciationFixes('version 0.8.51 is out'),
    'version 0 point 8 point 51 is out');
});

test('BOTH dots of a three-part version are replaced', () => {
  // The reason this row is a function rather than a capture-group string: a
  // pattern like '$1 point $2' replaces one dot and leaves the other, which
  // reads worse than doing nothing.
  const out = applyTtsPronunciationFixes('1.2.3');
  assert.equal(out, '1 point 2 point 3');
  assert.ok(!out.includes('.'), 'no dot may survive inside the number');
});

test('a plain decimal gets the same treatment', () => {
  assert.equal(applyTtsPronunciationFixes('1.4 seconds'), '1 point 4 seconds');
});

// --- and the things it must NOT touch ---------------------------------------

test('sentence punctuation is left alone', () => {
  // The rule is "between digits". A full stop has a letter on at least one
  // side, so ordinary prose is untouched — which is most of what the bot says.
  assert.equal(applyTtsPronunciationFixes('Ready. Next one.'), 'Ready. Next one.');
  assert.equal(applyTtsPronunciationFixes('Done. Merged.'), 'Done. Merged.');
});

test('domains and file extensions survive', () => {
  assert.match(applyTtsPronunciationFixes('see vibeconferencing.com'), /\.com$/);
  assert.match(applyTtsPronunciationFixes('0.8.51.dmg'), /\.dmg$/,
    'the extension keeps its dot; only the digit-to-digit ones change');
});

test('issue numbers are not decimals and are untouched', () => {
  assert.equal(applyTtsPronunciationFixes('issue #711'), 'issue #711');
});

test('the fix does not disturb the existing vibeconferencing rule', () => {
  // Both rows run over the same string; adding one must not break the other.
  assert.equal(applyTtsPronunciationFixes('vibeconferencing 0.8.51'),
    'vibe-conferencing 0 point 8 point 51');
});
