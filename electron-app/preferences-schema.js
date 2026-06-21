// preferences-schema.js — Whitelist of preferences exposed to the agent.
//
// Each entry is a self-contained spec: type, default, description, and
// optional validation. Anything NOT in this map is invisible to the agent
// even if it lives in the same config.json (API keys, auth cookies, etc.).
//
// Adding a new agent-exposed preference: add it here, then read it via
// store.get('key') ?? PREFERENCES.key.default in the consumer.

const PREFERENCES = {
  comprehendCharThreshold: {
    type: 'number',
    default: 0,
    min: 0,
    description:
      'Two-tier experiment (OFF by default): how many characters of NEW transcript ' +
      'must pile up before the bot refreshes its background working memory ' +
      '(understanding / stance / people) via a local model. 0 disables it (the ' +
      'default) — without this, a bot with no local model running would ping the ' +
      'endpoint every ~500c and fail. Set to e.g. 500 ONLY if you have a local ' +
      '(openai-compat / LM Studio) model configured and want to test the two-tier ' +
      'working memory. Lower = fresher but more local-model calls; the first two ' +
      'refreshes fire sooner (~120c then ~300c) to warm up, then settle to this value.',
  },
  ackShortMin: {
    type: 'number',
    default: 20,
    min: 0,
    description:
      'Word count below which the bot skips the acknowledgment entirely. ' +
      'For very short prompts the thinking emoji is enough feedback.',
  },
  ackLongMin: {
    type: 'number',
    default: 50,
    min: 0,
    description:
      'Word count at or above which the bot uses a longer ack ' +
      '("Let me think about that") instead of a short one.',
  },
  ackShortPhrases: {
    type: 'string[]',
    default: [
      'Mm-hmm.',
      'Mmmm',
      'Ahhh okay',
      'Okay.',
      'Got it.',
      'Mm.',
      'Right.',
      'Yeah.',
      'Sure.',
      'Uh-huh.',
      'Mhm.',
      'Cool.',
      'Gotcha.',
      'Right, right.',
    ],
    minItems: 1,
    description:
      'Phrases the bot picks from for short acks (when wordCount is between ' +
      'ackShortMin and ackLongMin). One is chosen at random per ack.',
  },
  ackLongPhrases: {
    type: 'string[]',
    default: [
      'Let me think about that.',
      'Hmm, let me consider that.',
      'Give me a moment.',
      'One moment',
      'One second, thinking.',
      'Hmm, good question.',
      'Let me chew on that.',
      'Just a sec, processing.',
      'Hmm, interesting.',
      'Hold on, working through that.',
      'Let me work that out.',
    ],
    minItems: 1,
    description:
      'Phrases the bot picks from for long acks (when wordCount >= ackLongMin).',
  },
  botName: {
    type: 'string',
    default: 'Jimmy',
    description:
      "The bot's display name in Meet calls. Takes effect on the next call.",
    requiresRestart: true,
  },
  logRawCaptions: {
    type: 'boolean',
    default: false,
    description:
      'Debug/data-collection: log the raw in-flight caption progression ' +
      '([caption-raw]) — every partial as Meet captions grow, marked LIVE vs ' +
      'settled. The messy data needed to test utterance-completeness detection ' +
      '(#243). Verbose; turn ON only when collecting test data, OFF for normal use.',
  },
  shadowPhrase: {
    type: 'boolean',
    default: false,
    description:
      'Two-tier experiment: at each floor-open, have the fast local model draft ' +
      'what it WOULD say from the current stance and log it (never spoken). OFF by ' +
      'default because it hits the same local model as the fast-ack and background ' +
      'comprehension — running all three at once overloads a single LM Studio ' +
      'instance (HTTP 500s, aborted acks). Turn ON only for measurement sessions.',
  },
  botPersonality: {
    type: 'string',
    default: '',
    maxLength: 2000,
    description:
      "Two-tier experiment: the voice/character the fast model speaks in (e.g. " +
      "'dry, concise, a bit wry; never corporate'). Used by the shadow harness " +
      "now (drafting what the bot would say) and by the fast model once it " +
      "becomes the bot's voice. Empty = a neutral, conversational default.",
  },
  ttsVoiceId: {
    type: 'string',
    default: '',
    description:
      'ElevenLabs voice ID. Empty means use macOS built-in TTS. ' +
      'Use list_voices and set_voice for an in-call switch instead of editing this directly.',
  },
  avatarBackgroundSvg: {
    type: 'string',
    default: '',
    maxLength: 1_000_000,
    description:
      "SVG source for the avatar background. Empty = default animated gradient. " +
      "The SVG can include <image href='file:///...' or 'https://...'> — the app " +
      "auto-resolves external references into data URIs so you don't need to " +
      "base64-encode anything. SVG/CSS animations don't tick (rasterized once); " +
      "the emoji's bounce provides motion. Use to display backgrounds, name plates, " +
      "debug info, or anything SVG can render.",
  },
  websiteUrl: {
    type: 'string',
    default: '',
    pattern: /^(|https?:\/\/.+)$/,
    description:
      'Override the website host the app talks to (auth, sync, room URLs). ' +
      'Empty = use the production default (https://vibeconferencing.com). ' +
      'Set to a Vercel preview like https://vibeconferencing-git-BRANCH-lets-vibe.vercel.app ' +
      'to test against a feature branch. Takes precedence over syncBaseUrl. ' +
      'Must be a full http:// or https:// URL with no trailing slash.',
    requiresRestart: true,
  },
  syncBaseUrl: {
    type: 'string',
    default: '',
    pattern: /^(|https?:\/\/.+)$/,
    description:
      'Legacy override for the sync/website host. Prefer websiteUrl for new setups. ' +
      'Empty = no override. Acts as a fallback websiteUrl when websiteUrl is unset. ' +
      'Must be a full http:// or https:// URL with no trailing slash.',
    requiresRestart: true,
  },

  // ── Conversation timing knobs ────────────────────────────────────────────
  // All read live from the local-server via the getPref callback — set_preference
  // takes effect on the next time the value is consulted (no app restart).
  // Per-profile, so different bot personas can have different conversational
  // rhythms.

  bargeInGraceMs: {
    type: 'number',
    default: 2000,
    min: 0,
    max: 10_000,
    description:
      'How long the bot waits after detecting a human interruption before ' +
      'actually stopping its TTS. Tunes the bot\'s "patience" — higher means ' +
      'a brief overlap is tolerated as natural conversation; lower means ' +
      'the bot drops out almost instantly. Default 2000ms.',
  },
  thinkingHoldMs: {
    type: 'number',
    default: 8000,
    min: 0,
    max: 60_000,
    description:
      'How long the avatar may keep showing "thinking" after new speech ' +
      'resolves a wait_for_speech, when the agent re-arms listening without ' +
      'speaking. Long enough to cover the fast-ack decision + ack TTS so the ' +
      '🤔 doesn\'t flicker away mid-acknowledgment; after this the state ' +
      'downgrades to listening so the bot doesn\'t look stuck pondering ' +
      'through silence (#221). Default 8000ms.',
  },
  bargeInBotRandomMinMs: {
    type: 'number',
    default: 1000,
    min: 0,
    max: 10_000,
    description:
      'When two bots try to speak at the same moment, each waits a random ' +
      'delay in [min, max] before committing to its turn — preventing ' +
      'lockstep talking over each other. This is the floor of that range.',
  },
  bargeInBotRandomMaxMs: {
    type: 'number',
    default: 4000,
    min: 0,
    max: 30_000,
    description:
      'Ceiling of the bot-vs-bot random-delay range (see bargeInBotRandomMinMs).',
  },
  bargeInStashMaxAgeMs: {
    type: 'number',
    default: 10_000,
    min: 0,
    max: 60_000,
    description:
      'When the bot yields mid-thought to a human, its queued speech is ' +
      'stashed and auto-replayed on the next silence gap if still fresh. ' +
      'This is how fresh (ms) the stash must be to replay; older than this ' +
      'and the slow model regenerates from scratch. Higher = more "the bot ' +
      'patiently waited and just said its thing"; lower = more "the bot ' +
      're-thinks every gap." Default 10s.',
  },
  captionDropoutGraceMs: {
    type: 'number',
    default: 2000,
    min: 0,
    max: 30_000,
    description:
      'How long a participant tile can stay active without caption text ' +
      'arriving before the bot decides the captions have dropped out (and ' +
      'surfaces that to the agent as a warning). See issue #187.',
  },
  botSpeakJitterMaxMs: {
    type: 'number',
    default: 800,
    min: 0,
    max: 5000,
    description:
      'When the call has 2+ other participants (so another bot could answer the ' +
      'same prompt in lockstep), the bot waits a random 0–N ms before speaking, to ' +
      'decorrelate simultaneous starts (#230) — two bots sharing identical timing ' +
      'otherwise speak in unison. Solo / single-human calls skip the jitter and ' +
      'speak immediately. 0 disables. Higher = more separation but more lag.',
  },
  defaultSilenceSeconds: {
    type: 'number',
    default: 2,
    min: 1,
    max: 30,
    description:
      'Default silence threshold (seconds) for wait_for_speech if the agent ' +
      'doesn\'t pass one. The bot waits this long after a speaker stops ' +
      'before considering their turn complete. Higher = more patient (bot ' +
      'lets users compose longer thoughts); lower = snappier.',
  },
  defaultMaxWaitForSpeechSec: {
    type: 'number',
    default: 55,
    min: 5,
    max: 300,
    description:
      'Maximum seconds wait_for_speech blocks before returning empty. The ' +
      'agent should re-call after a timeout. Default 55 (just under typical ' +
      'HTTP timeouts). Raise only if you have a reason — long blocks make ' +
      'the agent appear stalled.',
  },
  backgroundTickChars: {
    type: 'number',
    default: 0,
    min: 0,
    max: 5000,
    description:
      'Active-listening experiment (#245), OFF by default (0). When > 0, ' +
      'wait_for_speech surfaces the slow model EARLY — once this many NEW ' +
      'transcript characters pile up during conversation the bot is NOT part of ' +
      '— with a "background_tick" result instead of blocking until a definitive ' +
      'silence. On a tick the slow session updates its understanding / banks a ' +
      'brief active-listening probe and loops WITHOUT speaking; only a real ' +
      'silence resolution lets it speak. This is the mechanism that lets the ' +
      '(otherwise blocked) slow model think during long stretches. Content-based ' +
      '(like comprehendCharThreshold) so it scales with how much was actually ' +
      'said, not wall-clock. 0 = exactly today\'s behavior. Costs continuous ' +
      'slow-model turns — fine on the flat subscription, not metered. Try e.g. 600.',
  },
  backgroundTickJitterFrac: {
    type: 'number',
    default: 0.3,
    min: 0,
    max: 2,
    description:
      'Anti-lockstep jitter for backgroundTickChars (#245/#230). Each time the ' +
      'bot re-arms a background tick it rolls its effective threshold to ' +
      'backgroundTickChars × (1 + random·thisFraction) — so multiple bots in the ' +
      'same call surface (and later fire probes) on DIFFERENT cadences instead of ' +
      'in unison. 0.3 = up to +30%. 0 disables the jitter (all bots tick at the ' +
      'same threshold — not recommended with 2+ bots).',
  },
};

function validate(key, value) {
  const spec = PREFERENCES[key];
  if (!spec) return { ok: false, error: `Unknown preference '${key}'` };

  if (spec.type === 'number') {
    const n = typeof value === 'string' ? parseFloat(value) : value;
    if (!Number.isFinite(n)) return { ok: false, error: `Expected number, got ${typeof value}` };
    if (spec.min != null && n < spec.min) return { ok: false, error: `Below min ${spec.min}` };
    if (spec.max != null && n > spec.max) return { ok: false, error: `Above max ${spec.max}` };
    return { ok: true, value: n };
  }
  if (spec.type === 'string') {
    if (typeof value !== 'string') return { ok: false, error: `Expected string` };
    if (spec.maxLength != null && value.length > spec.maxLength) {
      return { ok: false, error: `String too long (max ${spec.maxLength} chars)` };
    }
    if (spec.pattern instanceof RegExp && !spec.pattern.test(value)) {
      return { ok: false, error: `Value doesn't match required format` };
    }
    return { ok: true, value };
  }
  if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') return { ok: false, error: `Expected boolean` };
    return { ok: true, value };
  }
  if (spec.type === 'string[]') {
    if (!Array.isArray(value) || !value.every(s => typeof s === 'string')) {
      return { ok: false, error: `Expected array of strings` };
    }
    if (spec.minItems != null && value.length < spec.minItems) {
      return { ok: false, error: `Must have at least ${spec.minItems} item(s)` };
    }
    return { ok: true, value };
  }
  return { ok: false, error: `Unhandled type ${spec.type}` };
}

function describe(store) {
  const get = typeof store === 'function' ? store : (k) => store?.get?.(k);
  return Object.entries(PREFERENCES).map(([key, spec]) => {
    const current = get(key);
    return {
      key,
      type: spec.type,
      value: current !== undefined ? current : spec.default,
      default: spec.default,
      description: spec.description,
      ...(spec.min != null && { min: spec.min }),
      ...(spec.max != null && { max: spec.max }),
      ...(spec.minItems != null && { minItems: spec.minItems }),
      ...(spec.requiresRestart && { requiresRestart: true }),
      isDefault: current === undefined,
    };
  });
}

module.exports = { PREFERENCES, validate, describe };
