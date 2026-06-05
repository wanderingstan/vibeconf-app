// ack/openai-compat.js — calls any OpenAI-Chat-Completions-shaped endpoint
// to decide an ack phrase or skip. Works with LM Studio, Ollama (OpenAI
// mode), OpenAI itself, OpenRouter, Groq, Together, vLLM, llama.cpp server,
// and basically any inference runner that targets that schema.
//
// Returns: phrase string to TTS, or null to skip.
// Throws: on network/timeout/parse errors; caller decides whether to fall
//         back to builtin or just skip.

const fs = require('fs');
const path = require('path');

// Hardcoded fallback used only if the prompt file can't be read at all.
// Tiny on purpose — the real prompt lives in prompts/ack-system.md so it
// can be iterated on without touching code.
const FALLBACK_PROMPT =
  "You are an ack decider. Return a short 1-5 word filler phrase, or the literal token SKIP if no ack is warranted. Never echo the user's words.";

// Prompt resolution + hot-reload. The prompt path is resolved in this order:
//   1. config.promptPath (from store) — usually unset
//   2. VIBECONF_ACK_PROMPT_PATH env var
//   3. bundled default at electron-app/ack/prompts/ack-system.md
//
// The file is re-read on every call only if its mtime changed since last
// load (one stat() per ack call — negligible). Edit the file, the next
// ack uses the new prompt — no app restart required.
const DEFAULT_PROMPT_PATH = path.join(__dirname, 'prompts', 'ack-system.md');

let _cached = { path: null, mtimeMs: 0, content: null };

function loadSystemPrompt(configuredPath) {
  const resolved =
    (configuredPath && configuredPath.trim()) ||
    process.env.VIBECONF_ACK_PROMPT_PATH ||
    DEFAULT_PROMPT_PATH;
  try {
    const stat = fs.statSync(resolved);
    if (_cached.path === resolved && _cached.mtimeMs === stat.mtimeMs) {
      return _cached.content;
    }
    const content = fs.readFileSync(resolved, 'utf8');
    _cached = { path: resolved, mtimeMs: stat.mtimeMs, content };
    return content;
  } catch (err) {
    // File missing or unreadable — return the last good cached prompt if we
    // have one, otherwise the hardcoded fallback. Never throws.
    return _cached.content || FALLBACK_PROMPT;
  }
}

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
  const { endpoint, apiKey, model, timeoutMs, promptPath } = config;
  if (!endpoint) throw new Error('ack endpoint not configured');

  const systemPrompt = loadSystemPrompt(promptPath);
  const url = endpoint.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: model || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
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

// Fire-and-forget warmup. Sends a trivial completion request using the same
// system prompt the real ack calls will use, so the engine's KV cache for
// the prefix gets populated. Subsequent acks hit the cached prefix and
// skip the multi-second cold-prefill cost.
//
// Called from main.js when the bot joins a call — at that moment the user
// is most likely to start speaking soon, and the ~5-10s bot-navigating-to-
// Meet window absorbs the warmup latency invisibly.
async function warmup({ config, log }) {
  const { endpoint, apiKey, model, promptPath } = config;
  if (!endpoint) return;
  const systemPrompt = loadSystemPrompt(promptPath);
  const url = endpoint.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: model || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'User said: "warmup"\n/no_think' },
    ],
    temperature: 0,
    max_tokens: 4,
  };
  // Wider timeout than a real ack — first inference can be 3-5s on small
  // models. If even this fails, real acks will fall back to builtin until
  // the engine is responsive.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  const started = Date.now();
  try {
    log?.(`ack-llm warmup → ${model || 'gpt-4o-mini'}`);
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
      log?.(`ack-llm warmup HTTP ${resp.status}`);
      return;
    }
    await resp.json();
    log?.(`ack-llm warmup ok (${Date.now() - started}ms)`);
  } catch (err) {
    log?.(`ack-llm warmup failed (${err.message})`);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { decide, warmup };
