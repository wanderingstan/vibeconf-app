// voice-uri.test.mjs — the single-string voice format (#150): parse/format and
// the legacy round-trip mappers. Run: node --test tests/voice-uri.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVoiceUri, formatVoiceUri, voiceUriFromLegacy, voiceUriToLegacy,
} from '../electron-app/voice-uri.js';

test('parse: elevenlabs', () => {
  assert.deepEqual(parseVoiceUri('elevenlabs:nPczCjzI2devNBz1zQrb'),
    { provider: 'elevenlabs', id: 'nPczCjzI2devNBz1zQrb', engine: '', scheme: 'elevenlabs' });
});

test('parse: system + macos alias both → macos-say provider', () => {
  assert.equal(parseVoiceUri('system:Ava (Premium)').provider, 'macos-say');
  assert.equal(parseVoiceUri('system:Ava (Premium)').id, 'Ava (Premium)');
  assert.equal(parseVoiceUri('macos:Daniel').provider, 'macos-say');
  assert.equal(parseVoiceUri('macos:Daniel').id, 'Daniel');
});

test('parse: voicebox with engine query param', () => {
  const p = parseVoiceUri('voicebox:abc123?engine=kokoro');
  assert.equal(p.provider, 'voicebox');
  assert.equal(p.id, 'abc123');
  assert.equal(p.engine, 'kokoro');
});

test('parse: empty = auto', () => {
  assert.deepEqual(parseVoiceUri(''), { provider: '', id: '', engine: '' });
  assert.deepEqual(parseVoiceUri('   '), { provider: '', id: '', engine: '' });
  assert.deepEqual(parseVoiceUri(null), { provider: '', id: '', engine: '' });
});

test('parse: unknown scheme flagged invalid, not silently accepted', () => {
  const p = parseVoiceUri('bogus:whatever');
  assert.equal(p.provider, '');
  assert.equal(p.invalid, true);
});

test('format: round-trips each provider', () => {
  assert.equal(formatVoiceUri({ provider: 'elevenlabs', id: 'v1' }), 'elevenlabs:v1');
  assert.equal(formatVoiceUri({ provider: 'macos-say', id: 'Ava (Premium)' }), 'system:Ava (Premium)');
  assert.equal(formatVoiceUri({ provider: 'voicebox', id: 'abc', engine: 'kokoro' }), 'voicebox:abc?engine=kokoro');
  assert.equal(formatVoiceUri({ provider: 'voicebox', id: 'abc' }), 'voicebox:abc'); // engine optional
  assert.equal(formatVoiceUri({ provider: '' }), ''); // auto
  assert.equal(formatVoiceUri({}), '');
});

test('parse∘format is stable for canonical forms', () => {
  for (const uri of ['elevenlabs:v1', 'system:Daniel', 'voicebox:p1?engine=kokoro', '']) {
    const back = formatVoiceUri(parseVoiceUri(uri));
    assert.equal(back, uri, `round-trip ${uri}`);
  }
});

test('legacy → uri migration (read-side)', () => {
  assert.equal(voiceUriFromLegacy({ ttsProvider: 'elevenlabs', ttsVoiceId: 'v1' }), 'elevenlabs:v1');
  assert.equal(voiceUriFromLegacy({ ttsProvider: 'macos-say', macosVoice: 'Ava (Premium)' }), 'system:Ava (Premium)');
  assert.equal(voiceUriFromLegacy({ ttsProvider: 'voicebox', voiceboxProfileId: 'p1', voiceboxEngine: 'kokoro' }), 'voicebox:p1?engine=kokoro');
  assert.equal(voiceUriFromLegacy({ ttsProvider: '' }), ''); // auto
  assert.equal(voiceUriFromLegacy({}), '');
});

test('uri → legacy fields (transition helper) only sets relevant keys', () => {
  assert.deepEqual(voiceUriToLegacy('elevenlabs:v1'), { ttsProvider: 'elevenlabs', ttsVoiceId: 'v1' });
  assert.deepEqual(voiceUriToLegacy('system:Daniel'), { ttsProvider: 'macos-say', macosVoice: 'Daniel' });
  assert.deepEqual(voiceUriToLegacy('voicebox:p1?engine=kokoro'),
    { ttsProvider: 'voicebox', voiceboxProfileId: 'p1', voiceboxEngine: 'kokoro' });
  assert.deepEqual(voiceUriToLegacy(''), { ttsProvider: '' });
});

test('full round-trip: legacy → uri → legacy preserves the fields', () => {
  const legacy = { ttsProvider: 'voicebox', voiceboxProfileId: 'p1', voiceboxEngine: 'kokoro' };
  const uri = voiceUriFromLegacy(legacy);
  assert.deepEqual(voiceUriToLegacy(uri), legacy);
});
