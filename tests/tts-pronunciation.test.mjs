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

// --- version numbers are spelled out as words ------------------------------
// #728 (call 2026-09-09) turned "0.8.51" into "0 point 8 point 51", but
// ElevenLabs still read the trailing digits as an ordinal ("fifty-eighth"),
// heard on the Teams call teams-9361264884308-20261017T125734Z. Words leave
// nothing for the engine to guess.

test('a three-part version is spelled out in words', () => {
  assert.equal(applyTtsPronunciationFixes('0.8.58'), 'zero point eight point fifty-eight');
  assert.equal(applyTtsPronunciationFixes('The installed app really is 0.8.58.'),
    'The installed app really is zero point eight point fifty-eight.');
  assert.equal(applyTtsPronunciationFixes('1.2.3'), 'one point two point three');
  assert.equal(applyTtsPronunciationFixes('10.15.7'), 'ten point fifteen point seven');
});

test('no digit or inner dot survives in a spelled version', () => {
  const out = applyTtsPronunciationFixes('version 0.8.61 is out');
  assert.equal(out, 'version zero point eight point sixty-one is out');
  assert.doesNotMatch(out, /\d/);
});

test('a "v" prefix is dropped and makes two groups count as a version', () => {
  assert.equal(applyTtsPronunciationFixes('v0.8.61'), 'zero point eight point sixty-one');
  assert.equal(applyTtsPronunciationFixes('tagged V2.0 today'), 'tagged two point zero today');
});

test('several versions in one sentence are all spelled', () => {
  assert.equal(applyTtsPronunciationFixes('from 0.8.58 to v0.8.61'),
    'from zero point eight point fifty-eight to zero point eight point sixty-one');
});

test('group wording: hundreds, leading zeros and long build numbers', () => {
  assert.equal(applyTtsPronunciationFixes('192.168.1.1'),
    'one hundred ninety-two point one hundred sixty-eight point one point one');
  assert.equal(applyTtsPronunciationFixes('1.02.3'), 'one point zero two point three');
  assert.equal(applyTtsPronunciationFixes('1.2.20261017'),
    'one point two point two zero two six one zero one seven');
  assert.equal(applyTtsPronunciationFixes('2026.10.17'),
    'two thousand twenty-six point ten point seventeen');
});

test('a pre-release suffix is left after the spelled part', () => {
  assert.equal(applyTtsPronunciationFixes('0.7.0-beta60'), 'zero point seven point zero-beta60');
});

// --- and the things it must NOT touch ---------------------------------------

test('single-dot decimals and prices are left to the engine', () => {
  // Engines say these correctly; #728's blanket rule had made "$1.25" into
  // "$1 point 25". Only "v"-prefixed two-part numbers count as versions.
  for (const s of ['1.4 seconds', 'costs $1.25', 'about 3.5 times', 'Node 22.4']) {
    assert.equal(applyTtsPronunciationFixes(s), s);
  }
});

test('sentence punctuation is left alone', () => {
  assert.equal(applyTtsPronunciationFixes('Ready. Next one.'), 'Ready. Next one.');
  assert.equal(applyTtsPronunciationFixes('Done. Merged.'), 'Done. Merged.');
});

test('domains, extensions and times survive', () => {
  assert.match(applyTtsPronunciationFixes('see vibeconferencing.com'), /\.com$/);
  assert.equal(applyTtsPronunciationFixes('0.8.51.dmg'), 'zero point eight point fifty-one.dmg');
  assert.equal(applyTtsPronunciationFixes('at 12:30'), 'at 12:30');
});

test('a dotted number glued to letters is not a version', () => {
  assert.equal(applyTtsPronunciationFixes('a1.2.3'), 'a1.2.3');
  assert.equal(applyTtsPronunciationFixes('1.2.3x'), '1.2.3x');
});

test('issue numbers are untouched', () => {
  assert.equal(applyTtsPronunciationFixes('issue #711'), 'issue #711');
});

test('the version rule does not disturb the vibeconferencing rule', () => {
  assert.equal(applyTtsPronunciationFixes('vibeconferencing 0.8.51'),
    'vibe-conferencing zero point eight point fifty-one');
});

test('synthesize() hands the engine the spelled version', async () => {
  const tts = new TTSProvider({ provider: 'elevenlabs', apiKey: 'x' });
  let seen = null;
  tts._doSynthesize = async (t) => { seen = t; return new ArrayBuffer(1); };
  await tts.synthesize('The installed app really is 0.8.58 and the updater is still running now.');
  assert.match(seen, /zero point eight point fifty-eight/);
  assert.doesNotMatch(seen, /0\.8\.58/);
});
