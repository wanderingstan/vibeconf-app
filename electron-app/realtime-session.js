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
    '',
    'You will be told who is speaking, and other things you cannot hear, in notes',
    'marked [room]. Never read one out. Much of what is said is between other',
    'people and is not yours to answer.',
    '',
    'You are not alone. A slower teammate is listening to this call with you. It',
    'can read the repo, search, use tools and write to the whiteboard. You cannot,',
    'but the two of you are one bot, and it hands you what it finds as it finds it.',
    '',
    'So never tell anyone what you cannot do, and never point them elsewhere for it.',
    'When something is beyond you, say you will check and call ask_teammate. Your',
    'teammate takes seconds, so fill that gap out loud rather than leaving silence:',
    '"let me look", "one second". A narrated pause sounds like thinking; an',
    'unexplained one sounds like a fault. If it still has not arrived,',
    'saying you do not have it yet is fine. What is never fine is inventing the',
    'thing itself.',
    '',
    'Speak English. Switch only if someone speaks to you in another language first.',
    'Never open the call yourself. Say nothing until somebody has actually spoken.',
  ].join('\n');
}

// What the voice model may do for itself.
//
// The line is not "hard vs easy", it is where the ARGUMENTS come from. If they
// come out of what was just said in the room, the fast model can call it: that
// is the shape these models are drilled on, and there is nothing to get wrong
// that it does not already have in front of it. If they require knowing
// something it does not know, it must not, because this is a model that has
// invented staff who do not exist, and a fabricated tool call has consequences
// a fabricated sentence does not.
//
// ask_teammate is the escape hatch that makes the rest safe, and the one that
// matters most. Its whole job is to be a better answer than "I can't do that":
// anything the model cannot do itself, it hands over rather than declining.
const VOICE_TOOLS = [
  {
    type: 'function',
    name: 'ask_teammate',
    description:
      'Hand something to your slower teammate, who has the repo, real tools, and can ' +
      'do things you cannot. Use it in BOTH of these cases, and prefer it to saying no: ' +
      '(1) you need information you do not have, and (2) somebody asks for something you ' +
      'cannot do yourself, in which case do not say it cannot be done, say you will check ' +
      'and call this. It answers in its own time, not as a reply to you, so say something ' +
      'natural out loud first and carry on with the conversation.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'What you need, in one sentence, self-contained enough to act on without the transcript.',
        },
      },
      required: ['question'],
    },
  },
  {
    type: 'function',
    name: 'extend_session',
    description:
      'Keep this call going past its time limit. You will be told when the limit is near ' +
      'and you will mention it to the room. Call this ONLY when somebody then actually ' +
      'asks you to continue: "keep going", "stay on", "yes please". Do not call it because ' +
      'the conversation seems useful, because nobody objected, or to avoid interrupting. ' +
      'The limit exists because this call costs money by the minute, and the person paying ' +
      'is not necessarily the person talking.',
    parameters: {
      type: 'object',
      properties: {
        minutes: {
          type: 'number',
          description: 'How much longer, in minutes. Ask for what was agreed, or 15 if nobody said.',
        },
      },
      required: ['minutes'],
    },
  },
  {
    type: 'function',
    name: 'send_chat',
    description:
      'Put a short message in the call chat. For things better read than heard: a link, ' +
      'an exact spelling, a number somebody asked you to repeat. Say what you are doing ' +
      'out loud as well, because a message nobody notices helps nobody.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The message. One or two lines.' } },
      required: ['text'],
    },
  },
  {
    type: 'function',
    name: 'write_whiteboard',
    description:
      'Write on the shared whiteboard, replacing what is there. Markdown. ONLY for content ' +
      'that came out of this conversation: a list somebody just dictated, a decision to ' +
      'write down, an agenda being agreed. If it needs looking up, or you would have to ' +
      'reconstruct it from memory, use ask_teammate and let them write it.',
    parameters: {
      type: 'object',
      properties: { content: { type: 'string', description: 'The whole board, in markdown. It replaces the current contents.' } },
      required: ['content'],
    },
  },
];

// How much longer this session may run, and what to do about it.
//
// Metered in wall-clock rather than tokens because realtime audio bills
// continuously in BOTH directions whether anybody is talking or not, so minutes
// are both a good proxy for cost and the only unit a person can actually decide
// with. "Twenty minutes left" is a decision; "600k audio tokens" is not.
//
// Pure so the awkward parts are testable: the boundary, the extension, and the
// fact that a warning must fire exactly once rather than every tick.
function realtimeBudget({ startedAt, now, maxMinutes, extraMs = 0, warnedAt = null, warnLeadMs = 5 * 60 * 1000 }) {
  const max = Number(maxMinutes);
  if (!Number.isFinite(max) || max <= 0) {
    return { capped: false, expired: false, shouldWarn: false, msLeft: Infinity };
  }
  const limitMs = max * 60 * 1000 + extraMs;
  const usedMs = Math.max(0, now - startedAt);
  const msLeft = limitMs - usedMs;

  // A cap shorter than the warning lead would otherwise warn instantly and then
  // stop, which is noise rather than notice. Below that, just stop.
  const warnable = limitMs > warnLeadMs;

  return {
    capped: true,
    expired: msLeft <= 0,
    // Once per deadline, not once per tick. An extension moves the deadline, so
    // comparing against the deadline the warning was issued for is what lets a
    // second warning fire after an extension without letting it repeat.
    shouldWarn: warnable && msLeft > 0 && msLeft <= warnLeadMs && warnedAt !== limitMs,
    warnKey: limitMs,
    msLeft,
    minutesLeft: Math.max(0, Math.ceil(msLeft / 60000)),
  };
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
          tools: VOICE_TOOLS,
          tool_choice: 'auto',
        },
      },
    },
    {
      shape: 'sessions',
      url: 'https://api.openai.com/v1/realtime/sessions',
      body: { model: cfg.model, voice: cfg.voice, instructions, tools: VOICE_TOOLS, tool_choice: 'auto' },
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

// Who is allowed to make this bot speak.
//
// The realtime model no longer decides for itself (create_response:false).
// Left to it, it answered 117 of 179 human turns in a three-way call, plenty of
// them aimed at the other person: it behaves like the two-party conversation it
// was trained on. VAD cannot fix that, because VAD knows when speech ENDED and
// never who it was for.
//
// Matching is the same plain lowercase substring the passive-mode name gate
// uses, so a realtime bot and a normal one agree on what "addressed" means.
function buildResponsePolicy({ botName, participants = [], respondWhenUnnamed = true } = {}) {
  const bot = String(botName || '').trim();
  const botLower = bot.toLowerCase();

  // People say "Stan", not "Stan James", so carry the first token too. Two
  // characters minimum: a stray initial would match most sentences.
  const expand = (name) => {
    const full = String(name || '').toLowerCase().trim();
    const first = full.split(/\s+/)[0];
    return [full, first].filter((x) => x && x.length >= 2);
  };

  const people = participants.filter((p) => p && p.name && !p.isPseudo);

  // The bot's own tile. Its Meet display name ("jimmy bot") is often not its
  // configured name ("Jimmy"), so substring rather than equality.
  const isBot = (p) => !!p.isSelf
    || (!!botLower && String(p.name).toLowerCase().includes(botLower))
    || String(p.name).toLowerCase() === 'you';

  return {
    // Two in the room means everything said is said to the bot. Gating there
    // would only add ways to be wrongly silent.
    gate: people.length > 2,
    botNames: [...new Set(botLower ? expand(bot) : [])],
    otherNames: [...new Set(people.filter((p) => !isBot(p)).flatMap((p) => expand(p.name)))],
    respondWhenUnnamed: respondWhenUnnamed !== false,
  };
}

module.exports = {
  VOICE_TOOLS,
  realtimeBudget,
  buildResponsePolicy,
  REALTIME_DEFAULTS,
  buildInstructions,
  resolveRealtimeConfig,
  mintEphemeralSession,
};
