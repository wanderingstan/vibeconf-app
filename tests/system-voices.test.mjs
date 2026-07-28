// Tests for electron-app/system-voices.js — the parsing and PowerShell-quoting
// half of the built-in-voice path (#18). Pure, so both platforms' formats can be
// exercised from one machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseSayVoices,
  parseSapiVoices,
  psQuote,
  sapiRenderScript,
  encodePowerShellCommand,
  powerShellArgs,
  systemVoiceLabel,
  macosTier,
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
  assert.equal(systemVoiceLabel('linux'), 'system');
});
