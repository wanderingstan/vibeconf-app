// realtime-session.js — brokering for OpenAI's Realtime (speech-to-speech) model.
//
// EXPERIMENT (#607 follow-on). Off unless `realtimeVoice` is set on this bot.
//
// This is the main-process half. The page never sees the API key: we mint a
// short-lived ephemeral client secret here and hand only that to page-inject,
// which does the WebRTC negotiation itself and wires the audio.
//
// Why the page and not here: the two things a realtime session needs are
// already in the page and nowhere else. Incoming call audio arrives as remote
// tracks on Meet's own RTCPeerConnection (AudioCapture hooks it), and outgoing
// audio has to land in VirtualMic's MediaStreamDestination, which IS the mic
// Meet publishes. Routing either through the main process would mean encoding
// audio, shipping it over IPC and decoding it again, twice, for no gain.
//
// The slow (Claude) half of the seam is deliberately NOT wired here. This
// establishes the audio path first; see docs/realtime-voice-in-app.md.

const REALTIME_DEFAULTS = {
  model: 'gpt-realtime',
  voice: 'cedar',
};

// Short on purpose. Realtime models drop clauses from long instructions in a
// way text models do not, so anything conditional belongs in a tool, not here.
function buildInstructions({ botName } = {}) {
  const name = (botName || '').trim();
  const who = name ? `You are ${name}, a` : 'You are a';
  return [
    `${who} voice teammate sitting in on a working call.`,
    '',
    'Keep replies to one or two sentences. You are a participant, not a narrator.',
    'Most of the time you are listening; say nothing unless you are addressed or',
    'you have something genuinely useful to add.',
    '',
    'Speak English. Switch only if someone speaks to you in another language first.',
    'Never open the call yourself. Say nothing until somebody has actually spoken.',
  ].join('\n');
}

// Reads the per-bot switch and the app-level key. Preferences are stored per
// profile, so `realtimeVoice` is already per-bot with no extra machinery: one
// bot can run realtime while its siblings stay on the normal Claude + TTS path.
//
// The API key deliberately does NOT live in preferences-schema.js — that map is
// the agent-visible whitelist, and keys are exactly what it exists to exclude.
// It sits alongside ttsApiKey in the same config.json.
function resolveRealtimeConfig({ store, env = {}, defaults = {} } = {}) {
  const get = (k) => {
    try { return store && typeof store.get === 'function' ? store.get(k) : undefined; }
    catch { return undefined; }
  };

  const enabled = get('realtimeVoice') === true;
  const apiKey = String(get('realtimeApiKey') || env.OPENAI_API_KEY || '').trim();
  const model = String(get('realtimeModel') || defaults.model || REALTIME_DEFAULTS.model);
  const voice = String(get('realtimeVoiceName') || defaults.voice || REALTIME_DEFAULTS.voice);

  const missing = [];
  if (enabled && !apiKey) missing.push('realtimeApiKey');

  // A key that does not start with sk- is almost always a mangled paste rather
  // than a revoked key, and the two are indistinguishable from OpenAI's 401.
  // Found the hard way: a paste that lost its leading character stored
  // "k-proj-..." and only announced itself as "Incorrect API key" once a call
  // was already underway. A warning, never a block: prefixes are OpenAI's to
  // change, and refusing a key we merely fail to recognise would be worse than
  // letting it try.
  const suspicious = !!apiKey && !apiKey.startsWith('sk-');

  return {
    enabled, apiKey, model, voice, missing, suspicious,
    ready: enabled && missing.length === 0,
  };
}

// OpenAI has shipped two shapes of the token endpoint. Try the newer, fall back
// to the older, and surface the server's own message on failure — a bare status
// is the difference between "no credit" and "wrong model" being diagnosable.
async function mintEphemeralSession(cfg, { fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (!doFetch) throw new Error('no fetch available');
  if (!cfg || !cfg.apiKey) throw new Error('realtime: no API key configured');

  const auth = {
    Authorization: `Bearer ${cfg.apiKey}`,
    'Content-Type': 'application/json',
  };
  const instructions = cfg.instructions || buildInstructions({});
  let firstError = null;

  const attempts = [
    {
      shape: 'client_secrets',
      url: 'https://api.openai.com/v1/realtime/client_secrets',
      body: {
        session: {
          type: 'realtime',
          model: cfg.model,
          audio: { output: { voice: cfg.voice } },
          instructions,
        },
      },
    },
    {
      shape: 'sessions',
      url: 'https://api.openai.com/v1/realtime/sessions',
      body: { model: cfg.model, voice: cfg.voice, instructions },
    },
  ];

  for (const a of attempts) {
    let res;
    try {
      res = await doFetch(a.url, { method: 'POST', headers: auth, body: JSON.stringify(a.body) });
    } catch (err) {
      if (!firstError) firstError = `network: ${err.message}`;
      continue;
    }

    if (res.ok) {
      const json = await res.json();
      const secret = json.value || (json.client_secret && json.client_secret.value);
      if (secret) return { secret, model: cfg.model, voice: cfg.voice, shape: a.shape };
      if (!firstError) firstError = `${a.shape}: no client secret in response`;
      continue;
    }

    const text = await res.text().catch(() => '');
    let why = text.slice(0, 200);
    try { why = JSON.parse(text).error.message || why; } catch { /* not JSON */ }
    if (!firstError) firstError = `${res.status} ${why}`;
  }

  throw new Error(`realtime: could not mint a session (${firstError || 'unknown'})`);
}

module.exports = {
  REALTIME_DEFAULTS,
  buildInstructions,
  resolveRealtimeConfig,
  mintEphemeralSession,
};
