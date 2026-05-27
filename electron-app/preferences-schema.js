// preferences-schema.js — Whitelist of preferences exposed to the agent.
//
// Each entry is a self-contained spec: type, default, description, and
// optional validation. Anything NOT in this map is invisible to the agent
// even if it lives in the same config.json (API keys, auth cookies, etc.).
//
// Adding a new agent-exposed preference: add it here, then read it via
// store.get('key') ?? PREFERENCES.key.default in the consumer.

const PREFERENCES = {
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
