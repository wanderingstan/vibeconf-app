// voice-status.js — can this bot actually speak, and with what?
//
// One question, asked from three places that used to answer it differently:
//   · the panel's warning banner (was: "no ElevenLabs key" — see below)
//   · main.js, to announce in-call that the bot has no voice
//   · tests, to pin the one platform where silence is real
//
// The banner used to fire on `!ttsApiKey` alone, which is not the same question.
// A keyless bot on macOS or Windows speaks perfectly well through the OS voice,
// and a Voicebox user has local TTS — both got told "Voice is off" while their
// voice was on. Worse, someone who deliberately picked a built-in voice with
// set_voice was nagged about a key that their own choice had made irrelevant.
//
// The honest condition is "nothing here can produce audio", which is only true
// on a platform with no built-in voice (Linux, #21) and no ElevenLabs key and no
// Voicebox profile.

// Platforms that ship a usable TTS voice out of the box: `say` on macOS, SAPI
// through PowerShell on Windows (#18). Linux has neither until #21 lands, which
// is why it is the documented mute platform.
const BUILT_IN_VOICE_PLATFORMS = new Set(['darwin', 'win32']);

function hasBuiltInVoice(platform) {
  return BUILT_IN_VOICE_PLATFORMS.has(String(platform || ''));
}

const set = (v) => !!(v && String(v).trim());

// → { canSpeak, provider, usingBuiltIn, reason }
//
// `provider` is what will actually render speech, which is NOT always the
// configured ttsProvider: an explicit provider whose credential is missing still
// falls through to the built-in voice at synthesis time (main.js retries there
// when the primary throws), so reporting the configured value would claim a
// voice the bot doesn't have.
function resolveVoice({ ttsApiKey, ttsProvider, voiceboxProfileId, platform } = {}) {
  const key = set(ttsApiKey);
  const voicebox = set(voiceboxProfileId);
  const builtIn = hasBuiltInVoice(platform);
  const configured = String(ttsProvider || '').trim();

  // An explicitly chosen provider wins when it's actually usable. This is the
  // case the old check got backwards: choosing a built-in voice with set_voice
  // sets ttsProvider='macos-say', at which point the ElevenLabs key is beside
  // the point and warning about it is noise.
  if (configured === 'elevenlabs' && key) return ok('elevenlabs');
  if (configured === 'voicebox' && voicebox) return ok('voicebox');
  if (configured === 'macos-say' && builtIn) return ok('macos-say', { usingBuiltIn: true });

  // Otherwise resolve the way tts.js's 'auto' does — key first, then whatever
  // else can carry it.
  if (key) return ok('elevenlabs');
  if (voicebox) return ok('voicebox');
  if (builtIn) return ok('macos-say', { usingBuiltIn: true });

  return {
    canSpeak: false,
    provider: null,
    usingBuiltIn: false,
    reason: `No text-to-speech available on ${platform || 'this platform'}: it has no built-in voice, `
      + 'and neither an ElevenLabs key nor a Voicebox profile is configured.',
  };
}

function ok(provider, { usingBuiltIn = false } = {}) {
  return { canSpeak: true, provider, usingBuiltIn, reason: '' };
}

module.exports = { BUILT_IN_VOICE_PLATFORMS, hasBuiltInVoice, resolveVoice };
