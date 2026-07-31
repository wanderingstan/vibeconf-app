// voice-uri.js — one URI-like string for the bot's voice (#150).
//
// Today a voice is FOUR denormalized keys (ttsProvider + ttsVoiceId +
// macosVoice + voiceboxProfileId + voiceboxEngine) because the three providers
// don't share an identifier space. This collapses them into a single value:
//
//   elevenlabs:<voiceId>                     e.g. elevenlabs:nPczCjzI2devNBz1zQrb
//   system:<voiceName>                       e.g. system:Ava (Premium)
//   voicebox:<profileId>?engine=<engine>     e.g. voicebox:abc123?engine=kokoro
//   ""                                       empty = AUTO (ElevenLabs if a key is
//                                            set, else the OS built-in voice)
//
// Scheme = provider, path = identifier, query params carry provider-specifics.
// `system:` is the canonical scheme for the OS built-in voice (macOS `say`,
// Windows SAPI, Linux espeak — it's cross-platform now); `macos:` is accepted as
// an alias on parse for the form in the issue. The persisted provider id stays
// `macos-say` (what existing configs + code use) via the legacy mappers below,
// so this can land read-side-only with no destructive rewrite.
//
// Pure, dependency-light (uses the global URLSearchParams). Unit-tested in
// tests/voice-uri.test.mjs.

'use strict';

// scheme (lowercased) → the persisted ttsProvider value.
const SCHEME_TO_PROVIDER = {
  elevenlabs: 'elevenlabs',
  system: 'macos-say',
  macos: 'macos-say', // alias for the issue's `macos:` form
  voicebox: 'voicebox',
};
// persisted ttsProvider → canonical scheme for output.
const PROVIDER_TO_SCHEME = {
  elevenlabs: 'elevenlabs',
  'macos-say': 'system',
  system: 'system',
  voicebox: 'voicebox',
};

// Parse a voice URI into { provider, id, engine }. Empty/whitespace → auto
// ({ provider:'' }). An unknown scheme returns { provider:'', invalid:true }.
function parseVoiceUri(uri) {
  const s = String(uri == null ? '' : uri).trim();
  if (!s) return { provider: '', id: '', engine: '' };
  const m = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/s);
  if (!m) return { provider: '', id: '', engine: '', invalid: true, raw: s };
  const scheme = m[1].toLowerCase();
  let path = m[2];
  let engine = '';
  const q = path.indexOf('?');
  if (q !== -1) {
    const query = path.slice(q + 1);
    path = path.slice(0, q);
    try { engine = new URLSearchParams(query).get('engine') || ''; } catch { /* ignore */ }
  }
  const provider = SCHEME_TO_PROVIDER[scheme] || '';
  const out = { provider, id: path, engine, scheme };
  if (!provider) out.invalid = true;
  return out;
}

// Format { provider, id, engine } → a voice URI. Empty/unknown provider → ''.
function formatVoiceUri({ provider, id, engine } = {}) {
  const scheme = PROVIDER_TO_SCHEME[String(provider || '')];
  if (!scheme) return '';
  const path = String(id == null ? '' : id);
  if (scheme === 'voicebox' && engine) {
    return `voicebox:${path}?engine=${encodeURIComponent(engine)}`;
  }
  return `${scheme}:${path}`;
}

// Read-side migration: the legacy four/five keys → one voice URI.
function voiceUriFromLegacy(cfg = {}) {
  const p = String(cfg.ttsProvider || '');
  if (p === 'elevenlabs') return formatVoiceUri({ provider: 'elevenlabs', id: cfg.ttsVoiceId });
  if (p === 'voicebox') return formatVoiceUri({ provider: 'voicebox', id: cfg.voiceboxProfileId, engine: cfg.voiceboxEngine });
  if (p === 'macos-say' || p === 'system') return formatVoiceUri({ provider: 'macos-say', id: cfg.macosVoice });
  return ''; // '' / unknown → auto
}

// Transition helper: a voice URI → the legacy field shape existing code still
// reads. Only sets the keys relevant to the URI's provider (so callers can
// spread it over defaults). Auto ('') yields { ttsProvider: '' }.
function voiceUriToLegacy(uri) {
  const { provider, id, engine } = parseVoiceUri(uri);
  const out = { ttsProvider: provider };
  if (provider === 'elevenlabs') out.ttsVoiceId = id;
  else if (provider === 'voicebox') { out.voiceboxProfileId = id; out.voiceboxEngine = engine; }
  else if (provider === 'macos-say') out.macosVoice = id;
  return out;
}

module.exports = {
  parseVoiceUri,
  formatVoiceUri,
  voiceUriFromLegacy,
  voiceUriToLegacy,
  SCHEME_TO_PROVIDER,
  PROVIDER_TO_SCHEME,
};
