// ack/openai-compat.js — calls any OpenAI-Chat-Completions-shaped endpoint
// to decide an ack phrase or skip. Works with LM Studio, Ollama (OpenAI
// mode), OpenAI itself, OpenRouter, Groq, Together, vLLM, llama.cpp server,
// and basically any inference runner that targets that schema.
//
// Returns: phrase string to TTS, or null to skip.
// Throws: on network/timeout/parse errors; caller decides whether to fall
//         back to builtin or just skip.

const SYSTEM_PROMPT = [
  "You decide an AI bot's acknowledgement before its full spoken response in a live voice call.",
  "Output rules — be strict:",
  "  - If an acknowledgement is warranted: return ONE phrase, 1-5 words max, no quotes, no explanation. Match the tone (curious / matter-of-fact / warm / etc.) of what was just said.",
  "  - If no acknowledgement is warranted (very short direct question, sentence fragment, casual remark, or anything the bot can answer faster than it could ack): return the literal token SKIP.",
  "Examples of good acks: \"Got it.\", \"Mm-hmm.\", \"Hmm, let me think.\", \"Right, right.\", \"Sure.\"",
  "Examples that should SKIP: \"Are you there?\", \"What time is it?\", \"...and then what?\"",
  "Never explain. Never use markdown. Never use punctuation beyond a single trailing period or question mark.",
].join('\n');

function buildUserMessage({ text, addressivity, mode, recentTranscript }) {
  const ctx = [];
  ctx.push(`User said: "${text}"`);
  if (addressivity === 'me') ctx.push('(addressed to the bot by name)');
  else if (addressivity === 'me-1on1') ctx.push('(1:1 call — the bot is the only respondent)');
  if (mode && mode !== 'active') ctx.push(`(bot mode: ${mode})`);
  if (recentTranscript && recentTranscript.length > 1) {
    const prior = recentTranscript
      .slice(-4, -1)
      .map(e => `  ${e.participantName || 'someone'}: ${e.text}`)
      .join('\n');
    if (prior) ctx.push(`Recent context:\n${prior}`);
  }
  // /no_think disables Qwen3's chain-of-thought traces — without this the
  // model emits <think>...</think> before the answer, blowing the latency
  // budget and dumping reasoning into the ack phrase. Harmless to other
  // models, which treat it as literal text and ignore it.
  ctx.push('/no_think');
  return ctx.join('\n');
}

// Strip any leftover <think>...</think> wrapper in case the model ignored
// /no_think (some Qwen3 quants still emit a brief trace before the answer).
function stripThink(raw) {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

async function decide({ text, addressivity, mode, recentTranscript, config, log }) {
  const { endpoint, apiKey, model, timeoutMs } = config;
  if (!endpoint) throw new Error('ack endpoint not configured');

  const url = endpoint.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: model || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage({ text, addressivity, mode, recentTranscript }) },
    ],
    temperature: 0.6,
    max_tokens: 24,
  };

  // Surface the exact user message we're sending — makes it obvious when
  // the model's odd response is downstream of an odd input. System prompt
  // is fixed, so we don't log it on every call.
  log?.(`ack-llm → ${model || 'gpt-4o-mini'} sending: ${JSON.stringify(body.messages[1].content.slice(0, 300))}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 500);
  const started = Date.now();
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    }
    const data = await resp.json();
    const rawWithThink = data?.choices?.[0]?.message?.content?.trim() || '';
    const raw = stripThink(rawWithThink).trim();
    const latencyMs = Date.now() - started;
    log?.(`ack-llm latency=${latencyMs}ms raw=${JSON.stringify(raw.slice(0, 80))}`);
    if (!raw) return null;
    if (/^SKIP\.?$/i.test(raw)) return null;
    // Strip surrounding quotes the model might add despite instructions
    const cleaned = raw.replace(/^["'`]+|["'`]+$/g, '').trim();
    // Cap at 5 words — model went off-script if longer
    const words = cleaned.split(/\s+/);
    if (words.length > 5) return words.slice(0, 5).join(' ');
    return cleaned || null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { decide };
