// ack/index.js — provider dispatcher for the ack decider.
//
// Today's behavior (provider 'builtin') is the old hardcoded wordcount logic,
// extracted into ack/builtin.js. Setting `ackProvider = 'openai-compat'`
// swaps to an OpenAI-Chat-Completions HTTP call (LM Studio, Ollama, OpenAI,
// OpenRouter, etc.). If the LLM call fails or times out, we fall back to
// builtin so a flaky endpoint never makes the bot worse than it is today.
//
// The single entry point is `decide(ctx)` which returns a string to TTS or
// null to skip the ack entirely.

const builtin = require('./builtin');
const openaiCompat = require('./openai-compat');
const prefsSchema = require('../preferences-schema.js');

function getPrefs(store) {
  return {
    ackShortMin: Number(store?.get('ackShortMin')) || prefsSchema.PREFERENCES.ackShortMin.default,
    ackLongMin: Number(store?.get('ackLongMin')) || prefsSchema.PREFERENCES.ackLongMin.default,
    ackShortPhrases: store?.get('ackShortPhrases') || prefsSchema.PREFERENCES.ackShortPhrases.default,
    ackLongPhrases: store?.get('ackLongPhrases') || prefsSchema.PREFERENCES.ackLongPhrases.default,
  };
}

function getProviderConfig(store) {
  // ackProvider/ackEndpoint/etc. are stored OUTSIDE preferences-schema.js so
  // the agent can't read or change them (no MCP set_preference access).
  // Keys + their defaults:
  return {
    provider: store?.get('ackProvider') || 'builtin',
    endpoint: store?.get('ackEndpoint') || 'http://127.0.0.1:1234/v1',
    apiKey: store?.get('ackApiKey') || '',
    model: store?.get('ackModel') || 'gpt-4o-mini',
    timeoutMs: Number(store?.get('ackTimeoutMs')) || 500,
    // Override path for the system prompt. Empty = use bundled default at
    // electron-app/ack/prompts/ack-system.md (which is also editable in
    // place — hot-reloads on mtime change, no restart needed).
    promptPath: store?.get('ackPromptPath') || '',
  };
}

async function decide({ text, wordCount, addressivity, mode, recentTranscript, store, log }) {
  const prefs = getPrefs(store);
  const config = getProviderConfig(store);

  if (config.provider === 'openai-compat') {
    try {
      const phrase = await openaiCompat.decide({
        text, addressivity, mode, recentTranscript,
        config,
        log,
      });
      return phrase; // string or null (SKIP)
    } catch (err) {
      // Endpoint unreachable / timed out / parse error — fall back to builtin
      // so the bot is never strictly worse than baseline.
      log?.(`ack-llm failed (${err.message}); falling back to builtin`);
      return builtin.decide({ wordCount, prefs });
    }
  }

  // Default: builtin
  return builtin.decide({ wordCount, prefs });
}

module.exports = { decide };
