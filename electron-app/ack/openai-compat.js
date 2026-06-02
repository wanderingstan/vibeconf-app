// ack/openai-compat.js — calls any OpenAI-Chat-Completions-shaped endpoint
// to decide an ack phrase or skip. Works with LM Studio, Ollama (OpenAI
// mode), OpenAI itself, OpenRouter, Groq, Together, vLLM, llama.cpp server,
// and basically any inference runner that targets that schema.
//
// Returns: phrase string to TTS, or null to skip.
// Throws: on network/timeout/parse errors; caller decides whether to fall
//         back to builtin or just skip.

const SYSTEM_PROMPT = [
  "You are a fast acknowledgement decider for an AI bot in a live voice call. The bot's full response comes a moment after yours — your only job is to pick a 1-5 word discourse filler that signals the bot heard the user, OR output SKIP when no filler is warranted.",
  "",
  "OUTPUT FORMAT:",
  "- Return ONE short conversational phrase (1-5 words, no quotes, no explanation, no markdown).",
  "- Or return the literal token SKIP.",
  "- At most one trailing period or question mark.",
  "",
  "WHEN TO SKIP — return SKIP if ANY of these apply:",
  "- The user is talking to someone NOT in the call (\"Hey Susan, ...\", \"sorry honey, hold on\", muttering, addressing a pet, side-conversation, asides).",
  "- The user is addressing a named person who is not the bot.",
  "- The utterance is a very short direct question the bot can answer faster than acking (\"Are you there?\", \"What time is it?\").",
  "- The utterance is a sentence fragment that's clearly mid-thought (\"...and then what?\", \"Now when you...\").",
  "- A 1:1-call hint does NOT override these — even in a 1:1 the user can be talking to someone off-camera or themselves.",
  "",
  "WHEN TO ACK:",
  "- A substantive thought, question, or instruction (5+ words) clearly addressed to the bot or the room.",
  "- Pick a natural discourse filler. Examples: \"Got it.\", \"Mm-hmm.\", \"Hmm, let me think.\", \"Right, right.\", \"Sure.\", \"Oh.\", \"Yeah.\", \"One moment.\"",
  "- Match the tone: thinking-cue for hard questions; warm \"Mm-hmm\" for personal disclosures; \"Got it\" for instructions.",
  "",
  "NEVER:",
  "- Echo back words from the user's sentence. Example: user says \"Can you hear me?\" → \"Hear me.\" is WRONG. Use \"Yeah.\" or \"Mm-hmm.\" or SKIP.",
  "- Use meta-vocabulary like \"acknowledge\", \"ack\", \"noted\", \"confirmed\" — these are robotic. Pick natural conversational fillers.",
  "- Pre-answer the user's question — the bot's real response handles that. Your filler just signals \"heard you\".",
  "- Explain, use markdown, or use multiple sentences.",
  "",
  "EXAMPLES:",
  "- User: \"Can you write a hello-world example in Python?\" → SKIP (short enough to answer immediately, or \"Sure thing.\")",
  "- User: \"I've been thinking about how we should structure the database for this feature, and I'm torn between three approaches.\" → \"Hmm, let me think.\"",
  "- User: \"Hey Susan, keep the noise down. I'm testing in here.\" → SKIP (talking to Susan, not the bot)",
  "- User: \"...and then what?\" → SKIP (mid-thought fragment)",
  "- User: \"I don't know, it just feels wrong somehow.\" → \"Mm-hmm.\"",
  "- User: \"Hello, can you hear me?\" → SKIP (short, bot can answer immediately) or \"Yeah.\" — NEVER \"Hear me.\"",
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
