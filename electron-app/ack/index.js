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
    endpoint: store?.get('ackEndpoint') || 'http://127.0.0.1:11535/v1',
    apiKey: store?.get('ackApiKey') || '',
    model: store?.get('ackModel') || 'apple-on-device',
    timeoutMs: Number(store?.get('ackTimeoutMs')) || 500,
    // Override path for the system prompt. Empty = use bundled default at
    // electron-app/ack/prompts/ack-system.md (which is also editable in
    // place — hot-reloads on mtime change, no restart needed).
    promptPath: store?.get('ackPromptPath') || '',
  };
}

// The shared local OpenAI-compatible model endpoint, INDEPENDENT of which
// provider the ack itself uses. The fast-ack phrase, background comprehension,
// and the triage-ack are separate consumers of this one endpoint; each has its
// own enable switch (ackProvider / comprehendCharThreshold / triageAck). So
// comprehend + triage can run with ackProvider='builtin' (cheap wordcount ack,
// no LLM hit for the phrase) while still using the local model themselves.
// Decoupling fixes the bug where ackProvider=builtin silently disabled them.
function getLocalModelConfig(store) {
  return {
    endpoint: store?.get('ackEndpoint') || 'http://127.0.0.1:11535/v1',
    apiKey: store?.get('ackApiKey') || '',
    model: store?.get('ackModel') || 'apple-on-device',
  };
}

// Returns { phrase, source, latencyMs, error }.
//   phrase    string | null  (null means SKIP)
//   source    'llm' | 'llm-fallback-builtin' | 'builtin'
//   latencyMs number — measured from entry to return for the chosen path
//   error     string | undefined — set when the LLM path failed and we fell back
// Which pool a phrase came from — the caller needs it to pick a VOLUME.
//
// The two acks are different speech acts. A short one is backchannel: it does
// not ask for the floor, and a person murmuring agreement is markedly quieter
// than one speaking. A long one ("Let me think about that.") announces that the
// floor has changed hands, and something taking the floor at a third of normal
// volume is simply hard to hear.
//
// Membership rather than a flag threaded through builtin.decide, so the pools
// stay the single source of truth and a user who edits them cannot desync this.
// Unknown phrases (an LLM-authored one) count as short: a generated filler is
// covering latency, not claiming the floor.
function poolOf(phrase, prefs) {
  return (prefs.ackLongPhrases || []).includes(phrase) ? 'long' : 'short';
}

async function decide({ text, wordCount, addressivity, mode, recentTranscript, store, log }) {
  const prefs = getPrefs(store);
  const config = getProviderConfig(store);
  const started = Date.now();

  // Does this look like a finished thought? Gates the LONG pool only — see the
  // reasoning in builtin.js. The HEURISTIC judge, not the model one: an ack has
  // to be instant to be worth anything, and the model judge is an awaited HTTP
  // call to an endpoint most installs do not run. Requiring a terminator is
  // exactly the signal wanted here, and when the caption source never
  // punctuates the answer is "not finished", which correctly keeps every ack
  // short.
  const { heuristicComplete } = require('../completeness');
  let complete = false;
  try { complete = !!heuristicComplete(text).complete; } catch { /* treat as unfinished */ }

  if (config.provider === 'openai-compat') {
    try {
      const phrase = await openaiCompat.decide({
        text, addressivity, mode, recentTranscript,
        config,
        log,
      });
      // An LLM-authored ack is treated as a murmur: it is generated to cover the
      // slow model's latency, not to announce that the floor has changed hands.
      return { phrase, pool: 'short', source: 'llm', latencyMs: Date.now() - started };
    } catch (err) {
      // Endpoint unreachable / timed out / parse error — fall back to builtin
      // so the bot is never strictly worse than baseline.
      log?.(`ack-llm failed (${err.message}); falling back to builtin`);
      const phrase = builtin.decide({ wordCount, complete, prefs });
      return {
        phrase,
        pool: poolOf(phrase, prefs),
        source: 'llm-fallback-builtin',
        latencyMs: Date.now() - started,
        error: err.message,
      };
    }
  }

  // Default: builtin
  const phrase = builtin.decide({ wordCount, complete, prefs });
  return {
    phrase,
    pool: poolOf(phrase, prefs),
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
