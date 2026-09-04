// Tests for electron-app/system-voices.js — the parsing and PowerShell-quoting
// half of the built-in-voice path (#18, #575). Pure, so every platform's format
// can be exercised from one machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseSayVoices,
  parseSapiVoices,
  parseEspeakVoices,
  psQuote,
  sapiRenderScript,
  encodePowerShellCommand,
  powerShellArgs,
  systemVoiceLabel,
  macosTier,
  SYSTEM_VOICE_PLATFORMS,
  ESPEAK_LIST_ARGS,
} = require('../electron-app/system-voices.js');

// --- macOS `say -v '?'` ----------------------------------------------------

test('parseSayVoices reads the plain two-column form', () => {
  const out = parseSayVoices('Samantha            en_US    # Hello, my name is Samantha.\n');
  assert.deepEqual(out, [{ name: 'Samantha', locale: 'en_US', sample: 'Hello, my name is Samantha.', tier: 2 }]);
});

test('parseSayVoices handles parenthetical names and numeric locales', () => {
  const out = parseSayVoices([
    'Eddy (English (US))  en_US    # Hi there.',
    'Majed               ar_001   # مرحبا',
  ].join('\n'));
  assert.deepEqual(out.map((v) => v.name), ['Eddy (English (US))', 'Majed']);
  assert.equal(out[1].locale, 'ar_001');
});

test('parseSayVoices sorts Premium, then Enhanced, then English, then name', () => {
  const out = parseSayVoices([
    'Zoe                 en_US    # z',
    'Anna                de_DE    # a',
    'Ava (Enhanced)      en_US    # e',
    'Zoe (Premium)       en_US    # p',
  ].join('\n'));
  assert.deepEqual(out.map((v) => v.name), ['Zoe (Premium)', 'Ava (Enhanced)', 'Zoe', 'Anna']);
});

test('parseSayVoices drops junk lines and duplicate names', () => {
  const out = parseSayVoices([
    '',
    'not a voice line',
    'Daniel              en_GB    # one',
    'Daniel              en_GB    # again',
  ].join('\n'));
  assert.deepEqual(out.map((v) => v.name), ['Daniel']);
});

test('macosTier reads the quality suffix', () => {
  assert.equal(macosTier('Ava (Premium)'), 0);
  assert.equal(macosTier('Ava (Enhanced)'), 1);
  assert.equal(macosTier('Ava'), 2);
});

// --- Windows SAPI ----------------------------------------------------------

test('parseSapiVoices reads the pipe-delimited form and normalizes the locale', () => {
  const out = parseSapiVoices([
    'Microsoft David Desktop|en-US|Male',
    'Microsoft Zira Desktop|en-US|Female',
  ].join('\r\n'));
  assert.deepEqual(out, [
    { name: 'Microsoft David Desktop', locale: 'en_US', sample: 'Male', tier: 1 },
    { name: 'Microsoft Zira Desktop', locale: 'en_US', sample: 'Female', tier: 1 },
  ]);
});

test('parseSapiVoices puts every SAPI voice in the recommended tier', () => {
  // Tier 1, not 2 — David/Zira are all most machines have, so the picker's
  // "lower quality" group must not swallow them.
  const out = parseSapiVoices('Microsoft Hazel Desktop|en-GB|Female');
  assert.equal(out[0].tier, 1);
});

test('parseSapiVoices tolerates a missing gender and blank lines', () => {
  const out = parseSapiVoices('\nMicrosoft Hazel Desktop|en-GB\n\nBroken\n');
  assert.deepEqual(out, [{ name: 'Microsoft Hazel Desktop', locale: 'en_GB', sample: '', tier: 1 }]);
});

test('parseSapiVoices sorts non-English after English', () => {
  const out = parseSapiVoices([
    'Microsoft Hedda Desktop|de-DE|Female',
    'Microsoft Zira Desktop|en-US|Female',
  ].join('\n'));
  assert.deepEqual(out.map((v) => v.name), ['Microsoft Zira Desktop', 'Microsoft Hedda Desktop']);
});

// --- Linux `espeak-ng --voices` (#575) --------------------------------------

// The real header + a representative slice of espeak-ng 1.51's output, spacing
// and all: a plain code, a hyphenated one, a name with parens and underscores,
// a numeric region, a three-part code, and a trailing "Other Languages" column.
const ESPEAK_VOICES_OUTPUT = [
  'Pty Language       Age/Gender VoiceName          File                 Other Languages',
  ' 5  af             --/M      Afrikaans            gmw/af',
  ' 5  en-gb          --/M      English_(Great_Britain) gmw/en           (en 2)',
  ' 5  en-us          --/M      English_(America)    gmw/en-US            (en 2)',
  ' 5  en-029         --/M      English_(Caribbean)  gmw/en-029           (en 10)',
  ' 2  en-gb-scotland --/M      English_(Scotland)   gmw/en-GB-scotland   (en 4)',
  ' 5  fr             --/F      French_(France)      roa/fr               (fr-fr 5)',
  '',
].join('\n');

test('parseEspeakVoices reads the columns and normalizes the locale', () => {
  const out = parseEspeakVoices(ESPEAK_VOICES_OUTPUT);
  const byName = Object.fromEntries(out.map((v) => [v.name, v]));
  assert.deepEqual(byName['English_(America)'], {
    name: 'English_(America)', locale: 'en_US', sample: 'Male', tier: 1,
  });
  // A 2-letter region is uppercased to the macOS en_US form; numeric and word
  // tails are left alone.
  assert.equal(byName['English_(Caribbean)'].locale, 'en_029');
  assert.equal(byName['English_(Scotland)'].locale, 'en_GB_scotland');
  assert.equal(byName['Afrikaans'].locale, 'af');
  assert.equal(byName['French_(France)'].sample, 'Female');
});

test('parseEspeakVoices keeps the VoiceName verbatim — it is what -v matches', () => {
  const out = parseEspeakVoices(ESPEAK_VOICES_OUTPUT);
  // Underscores and parens intact: espeak's SelectVoiceByName compares against
  // exactly this string, so a name from the picker can go straight back as -v.
  assert.ok(out.some((v) => v.name === 'English_(Great_Britain)'));
  assert.ok(!out.some((v) => v.name.includes(' ')));
});

test('parseEspeakVoices drops the header and any other non-voice line', () => {
  const out = parseEspeakVoices(ESPEAK_VOICES_OUTPUT);
  assert.ok(!out.some((v) => v.name === 'VoiceName'));
  assert.equal(out.length, 6);
  assert.deepEqual(parseEspeakVoices(''), []);
  assert.deepEqual(parseEspeakVoices(undefined), []);
  assert.deepEqual(parseEspeakVoices('total nonsense\n\n'), []);
});

test('parseEspeakVoices puts every espeak voice in the recommended tier', () => {
  // Same call as SAPI's: espeak's languages are all a Linux box has, so
  // demoting them would leave the picker's main built-in group empty.
  const out = parseEspeakVoices(ESPEAK_VOICES_OUTPUT);
  assert.ok(out.every((v) => v.tier === 1));
});

test('parseEspeakVoices sorts English first, then by name', () => {
  const out = parseEspeakVoices(ESPEAK_VOICES_OUTPUT).map((v) => v.name);
  assert.deepEqual(out.slice(0, 4), [
    'English_(America)', 'English_(Caribbean)', 'English_(Great_Britain)', 'English_(Scotland)',
  ]);
  assert.deepEqual(out.slice(4), ['Afrikaans', 'French_(France)']);
});

test('parseEspeakVoices tolerates a missing gender', () => {
  const out = parseEspeakVoices(' 5  af             --/-      Afrikaans            gmw/af\n');
  assert.deepEqual(out, [{ name: 'Afrikaans', locale: 'af', sample: '', tier: 1 }]);
});

test('ESPEAK_LIST_ARGS is the only enumeration espeak offers', () => {
  assert.deepEqual(ESPEAK_LIST_ARGS, ['--voices']);
});

// --- PowerShell quoting ----------------------------------------------------

test("psQuote doubles the single quote — the only escape PowerShell honors there", () => {
  assert.equal(psQuote("O'Brien"), "'O''Brien'");
  assert.equal(psQuote(''), "''");
  assert.equal(psQuote(undefined), "''");
});

test('psQuote leaves $ and backticks inert (single-quoted strings do not expand)', () => {
  assert.equal(psQuote('$env:PATH `x'), "'$env:PATH `x'");
});

test('sapiRenderScript never embeds the utterance — only the file path', () => {
  const script = sapiRenderScript({
    textPath: 'C:\\Temp\\in.txt',
    wavPath: 'C:\\Temp\\out.wav',
    voice: 'Microsoft Zira Desktop',
  });
  assert.match(script, /ReadAllText\('C:\\Temp\\in\.txt'/);
  assert.match(script, /SetOutputToWaveFile\('C:\\Temp\\out\.wav'/);
  assert.match(script, /SelectVoice\(\$voice\)/);
  // 16-bit 22.05kHz mono, matching what afconvert hands back on macOS.
  assert.match(script, /SpeechAudioFormatInfo\(22050/);
  assert.match(script, /AudioBitsPerSample\]::Sixteen/);
  assert.match(script, /AudioChannel\]::Mono/);
});

test('sapiRenderScript survives a quote-bearing voice name and path', () => {
  const script = sapiRenderScript({
    textPath: "C:\\Users\\O'Brien\\in.txt",
    wavPath: "C:\\Users\\O'Brien\\out.wav",
    voice: "Some' Voice",
  });
  assert.match(script, /\$voice = 'Some'' Voice'/);
  assert.match(script, /C:\\Users\\O''Brien\\in\.txt/);
});

test('sapiRenderScript swallows an unknown voice rather than going silent', () => {
  const script = sapiRenderScript({ textPath: 'a', wavPath: 'b', voice: 'Nope' });
  // SelectVoice throws on a voice that is not installed; the fallback is SAPI's
  // default voice, which always exists.
  assert.match(script, /try \{ \$synth\.SelectVoice\(\$voice\) \} catch \{ \}/);
});

test('an empty voice name skips SelectVoice entirely (SAPI default)', () => {
  const script = sapiRenderScript({ textPath: 'a', wavPath: 'b', voice: '' });
  assert.match(script, /\$voice = ''/);
  assert.match(script, /if \(\$voice\)/);
});

test('encodePowerShellCommand emits base64 of UTF-16LE, as -EncodedCommand wants', () => {
  const encoded = encodePowerShellCommand('echo hi');
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), 'echo hi');
});

test('powerShellArgs runs non-interactively with no profile', () => {
  const args = powerShellArgs('echo hi');
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(Buffer.from(args[3], 'base64').toString('utf16le'), 'echo hi');
});

test('systemVoiceLabel names the platform for user-facing copy', () => {
  assert.equal(systemVoiceLabel('darwin'), 'macOS');
  assert.equal(systemVoiceLabel('win32'), 'Windows');
  assert.equal(systemVoiceLabel('linux'), 'Linux');
  assert.equal(systemVoiceLabel('freebsd'), 'system');
});

test('every enumerable platform has a label and vice versa (#575)', () => {
  // The list and the label drifted apart before: Linux could speak, so it
  // reached the copy, but was never enumerable, so the picker stayed empty.
  for (const platform of SYSTEM_VOICE_PLATFORMS) {
    assert.notEqual(systemVoiceLabel(platform), 'system', `${platform} needs a label`);
  }
  assert.deepEqual(SYSTEM_VOICE_PLATFORMS, ['darwin', 'win32', 'linux']);
});
