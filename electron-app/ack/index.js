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
    model: store?.get('ackModel') || 'qwen2.5-7b-instruct-mlx',
    timeoutMs: Number(store?.get('ackTimeoutMs')) || 500,
    // Override path for the system prompt. Empty = use bundled default at
    // electron-app/ack/prompts/ack-system.md (which is also editable in
    // place — hot-reloads on mtime change, no restart needed).
    promptPath: store?.get('ackPromptPath') || '',
  };
}

// The shared local OpenAI-compatible model endpoint, INDEPENDENT of which
// provider the ack itself uses. The fast-ack, background comprehension, and the
// shadow drafter are three separate consumers of this one endpoint; each has
// its own enable switch (ackProvider / comprehendCharThreshold / shadowPhrase).
// So comprehend + shadow can run with ackProvider='builtin' (cheap wordcount
// ack, no LM Studio hit) while still using the local model themselves — which
// is exactly the low-contention setup for a two-tier eval. Decoupling fixes the
// bug where setting ackProvider=builtin silently disabled comprehend + shadow.
function getLocalModelConfig(store) {
  return {
    endpoint: store?.get('ackEndpoint') || 'http://127.0.0.1:1234/v1',
    apiKey: store?.get('ackApiKey') || '',
    model: store?.get('ackModel') || 'qwen2.5-7b-instruct-mlx',
  };
}

// Returns { phrase, source, latencyMs, error }.
//   phrase    string | null  (null means SKIP)
//   source    'llm' | 'llm-fallback-builtin' | 'builtin'
//   latencyMs number — measured from entry to return for the chosen path
//   error     string | undefined — set when the LLM path failed and we fell back
async function decide({ text, wordCount, addressivity, mode, recentTranscript, store, log }) {
  const prefs = getPrefs(store);
  const config = getProviderConfig(store);
  const started = Date.now();

  if (config.provider === 'openai-compat') {
    try {
      const phrase = await openaiCompat.decide({
        text, addressivity, mode, recentTranscript,
        config,
        log,
      });
      return { phrase, source: 'llm', latencyMs: Date.now() - started };
    } catch (err) {
      // Endpoint unreachable / timed out / parse error — fall back to builtin
      // so the bot is never strictly worse than baseline.
      log?.(`ack-llm failed (${err.message}); falling back to builtin`);
      const phrase = builtin.decide({ wordCount, prefs });
      return {
        phrase,
        source: 'llm-fallback-builtin',
        latencyMs: Date.now() - started,
        error: err.message,
      };
    }
  }

  // Default: builtin
  return {
    phrase: builtin.decide({ wordCount, prefs }),
    source: 'builtin',
    latencyMs: Date.now() - started,
  };
}

// Fire-and-forget warmup. main.js calls this on join_call to pre-populate
// the LLM engine's KV cache so the first real ack of the call doesn't pay
// the multi-second cold-prefill cost. Builtin needs no warmup — it's a
// noop in that case.
async function warmup({ store, log }) {
  const config = getProviderConfig(store);
  if (config.provider !== 'openai-compat') return;
  return openaiCompat.warmup({ config, log });
}

// Warm up the shared LOCAL model (used by triage + comprehend) regardless of
// ackProvider — so the first triage request isn't a 5s cold-start timeout while
// LM Studio loads the model (observed live: first 3 triage calls timed out, then
// warmed to ~1.9s). A trivial completion loads the model; the exact prompt is
// irrelevant for warmup. Fire-and-forget.
async function warmupLocalModel({ store, log }) {
  const lm = getLocalModelConfig(store);
  return openaiCompat.warmup({ config: { ...lm, promptPath: '' }, log });
}

module.exports = { decide, warmup, getProviderConfig, getLocalModelConfig, warmupLocalModel };
