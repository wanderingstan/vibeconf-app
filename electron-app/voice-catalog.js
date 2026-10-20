// voice-catalog.js: every voice a bot can speak in, from every provider, and
// a random good one for a new bot.
//
// The bot's main process (its Settings voice picker) and the app window (the
// Sessions pane, which picks a voice for a bot that does not exist yet) list
// voices the same way, so the listing lives here rather than in main.js.
//
// Providers, best first:
//   ElevenLabs  the account's voices, with the machine's key (app-level ttsApiKey)
//   Voicebox    a locally running Voicebox server's profiles
//   built-in    the OS's own voices (`say` on macOS, SAPI on Windows)
//
// Pure Node (fetch, child_process): no Electron.

const { execFile } = require('child_process');

// The plain macOS voices good enough to offer beside the Premium and Enhanced
// ones. Keep in step with WHITELISTED_MACOS_STANDARD in renderer/panel.js (a
// test checks): the bot's own picker shows the same "good" group.
const WHITELISTED_SYSTEM_STANDARD = ['Daniel', 'Samantha', 'Karen'];

// 0 Premium, 1 Enhanced (or Windows SAPI), 2 plain; `tier` from
// system-voices.js, else read off the name the way older builds did.
function tierOf(v) {
  if (v.tier != null) return v.tier;
  return /\(Premium\)/i.test(v.name) ? 0 : /\(Enhanced\)/i.test(v.name) ? 1 : 2;
}

// The built-in voices worth hearing: Premium, Enhanced, and the whitelisted
// plain ones. The rest are robotic enough that a new bot should never land on
// one by chance.
function goodSystemVoices(voices) {
  const whitelisted = (name) => WHITELISTED_SYSTEM_STANDARD.some((w) => name === w || name.startsWith(w + ' '));
  return (voices || []).filter((v) => tierOf(v) < 2 || whitelisted(v.name));
}

function listSystemVoices({ platform = process.platform } = {}) {
  const { parseSayVoices, parseSapiVoices, powerShellArgs, SAPI_LIST_SCRIPT } = require('./system-voices.js');
  const isWin = platform === 'win32';
  if (!isWin && platform !== 'darwin') return Promise.resolve([]);
  // PowerShell's cold start makes 5s tight on a slow/first run; give it 15s.
  const [cmd, args, opts, parse] = isWin
    ? ['powershell.exe', powerShellArgs(SAPI_LIST_SCRIPT), { timeout: 15000, maxBuffer: 1 << 20 }, parseSapiVoices]
    : ['say', ['-v', '?'], { timeout: 5000, maxBuffer: 1 << 20 }, parseSayVoices];
  return new Promise((resolve) => {
    execFile(cmd, args, opts, (err, stdout) => {
      if (err) { console.error('[voices] listing built-in voices failed:', err.message); return resolve([]); }
      resolve(parse(stdout));
    });
  });
}

// A running Voicebox's profiles, or [] (never throws) when it is not running.
async function listVoiceboxProfiles(url = 'http://127.0.0.1:17493') {
  try {
    const res = await fetch(`${url}/profiles`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const profiles = await res.json();
    return Array.isArray(profiles) ? profiles : [];
  } catch {
    return [];
  }
}

// The account's ElevenLabs voices (GET /v1/voices). Never throws: returns
// { voices, error }, error null on success and an actionable {kind, message}
// otherwise, because a scoped key can speak fine and still lack voices_read
// (see elevenlabs-errors.js). No key is not an error.
async function listElevenLabsVoices(key) {
  const { classifyVoicesError, classifyVoicesNetworkError } = require('./elevenlabs-errors.js');
  if (!key) return { voices: [], error: null };
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': key },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      let body = null;
      try { body = await res.json(); } catch { /* not JSON */ }
      const error = classifyVoicesError(res.status, body);
      console.warn('[elevenlabs] voices list failed:', error.kind, '-', error.message);
      return { voices: [], error };
    }
    const data = await res.json();
    const voices = Array.isArray(data?.voices) ? data.voices : [];
    return { voices: voices.map((v) => ({ id: v.voice_id, name: v.name || v.voice_id, category: v.category || '' })), error: null };
  } catch (err) {
    const error = classifyVoicesNetworkError(err);
    console.warn('[elevenlabs] voices list failed:', error.kind, '-', error.message);
    return { voices: [], error };
  }
}

// Every voice, as one list for a picker: { id, label, group, provider, config }.
// `config` is what a bot's settings need to speak in it.
async function listAllVoices({ elevenLabsKey = '', voiceboxUrl } = {}) {
  const [eleven, voicebox, system] = await Promise.all([
    listElevenLabsVoices(elevenLabsKey), listVoiceboxProfiles(voiceboxUrl), listSystemVoices(),
  ]);
  const out = [];
  for (const v of eleven.voices) {
    out.push({ id: `el:${v.id}`, label: v.category && v.category !== 'premade' ? `${v.name} · ${v.category}` : v.name,
      group: 'ElevenLabs', provider: 'elevenlabs', config: { ttsProvider: 'elevenlabs', ttsVoiceId: v.id, voiceboxProfileId: '' } });
  }
  for (const p of voicebox) {
    const engine = p.preset_engine || p.default_engine || 'kokoro';
    out.push({ id: `vb:${p.id}`, label: `${p.name} (${engine})`, group: 'Voicebox (local)', provider: 'voicebox',
      config: { ttsProvider: 'voicebox', voiceboxProfileId: p.id, voiceboxEngine: engine } });
  }
  for (const v of goodSystemVoices(system)) {
    out.push({ id: `os:${v.name}`, label: v.locale ? `${v.name} (${v.locale})` : v.name, group: 'Built-in', provider: 'system',
      config: { ttsProvider: 'macos-say', macosVoice: v.name, voiceboxProfileId: '' } });
  }
  return out;
}

// A random voice for a new bot: from the best provider available. ElevenLabs
// when there is a key, else Voicebox when it is running, else one of the good
// built-in voices. Null when there is nothing to choose (the app's default
// then applies). `random` is injectable for tests.
function pickRandomVoice(voices, random = Math.random) {
  for (const provider of ['elevenlabs', 'voicebox', 'system']) {
    const pool = (voices || []).filter((v) => v.provider === provider);
    if (pool.length) return pool[Math.floor(random() * pool.length)];
  }
  return null;
}

module.exports = {
  WHITELISTED_SYSTEM_STANDARD, goodSystemVoices, tierOf,
  listSystemVoices, listVoiceboxProfiles, listElevenLabsVoices, listAllVoices, pickRandomVoice,
};
