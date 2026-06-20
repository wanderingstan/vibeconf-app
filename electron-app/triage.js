// triage.js — fast-model TURN-TAKING TRIAGE for the two-tier experiment.
//
// The fast model's settled role. The eval (2026-06-20) showed a 7B can't be the
// bot's substantive *voice* — but turn-taking is a CLASSIFICATION task, which a
// small model does far better than generation. So the fast model's job is the
// sub-second judgment: "is the bot being addressed, such that a quick
// acknowledgment is expected right now?" — vs the others talking among
// themselves / addressing a different participant.
//
// NON-AUTHORITATIVE (Stan's framing): triage only decides whether to fire an
// INSTANT ack to cover the slow model's ~5s latency. The slow model still
// receives every turn and speaks (late) if it disagrees — so a missed ack is
// recoverable and a wrong ack is just a stray "On it." It never silences the bot.
//
// Log-only for now (measurement): we're validating the classifier's accuracy
// against what the slow session actually does before wiring it to anything.
//
// Same local OpenAI-compatible endpoint + non-reasoning model + json_schema as
// comprehend.js / phrase.js.

function stripThink(raw) {
  return String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function buildSystem(botName) {
  return [
    `You are the instant turn-taking judgment for ${botName}, a participant in a live group voice call. The floor just opened (someone finished talking).`,
    `Decide ONE thing: is ${botName} being addressed, such that a response from ${botName} is expected right NOW?`,
    `You are NOT writing the response — a separate, slower part of ${botName} does that. Your only job is the snap call of whether ${botName} is being spoken to, so it can acknowledge instantly instead of leaving an awkward silence.`,
    `Lines in the transcript beginning "${botName}:" are ${botName}'s OWN earlier words — not someone addressing it.`,
    ``,
    `Reply as STRICT JSON: {"ack": true|false, "category": "...", "reason": "..."}.`,
    `"category" is exactly one of:`,
    `- "addressed"      — ${botName} is directly spoken to, named, or asked a question/request. → ack=true`,
    `- "other-bot"      — a DIFFERENT participant is being addressed (another name), not ${botName}. → ack=false`,
    `- "human-to-human" — people are talking among themselves; ${botName} is not part of this exchange. → ack=false`,
    `- "ambient"        — open discussion ${botName} could optionally join but isn't required to. → ack=false`,
    ``,
    `Set ack=true ONLY for "addressed". When torn between "addressed" and "ambient", choose false — a missed ack is recoverable (the slow part still answers), but a wrong ack interrupts people.`,
    `"reason" is a short phrase (for debugging), not spoken.`,
    `Output ONLY the JSON object — no prose, no code fences.`,
  ].join('\n');
}

function buildUser({ recentTranscript, lastUtterance, roster, botName }) {
  return [
    `WHO IS IN THE CALL: ${roster || '(unknown)'}`,
    ``,
    `RECENT TRANSCRIPT (most recent last):`,
    recentTranscript || '(none)',
    ``,
    `>>> THE LINE THAT JUST FINISHED: ${lastUtterance || '(silence)'}`,
    ``,
    `Is ${botName} being addressed here? Output the JSON now.`,
    `/no_think`,
  ].join('\n');
}

function extractJson(raw) {
  const text = stripThink(raw);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

// Returns { ack: boolean, category: string, reason: string, ms: number } or null
// on any failure. Never throws.
async function triage({ recentTranscript, lastUtterance, roster, botName, config, log }) {
  const { endpoint, apiKey, model } = config || {};
  if (!endpoint) { log?.('no endpoint configured'); return null; }

  const url = endpoint.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: model || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: buildSystem(botName || 'the bot') },
      { role: 'user', content: buildUser({ recentTranscript, lastUtterance, roster, botName: botName || 'the bot' }) },
    ],
    temperature: 0.1, // classification — keep it decisive
    max_tokens: 120,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'triage_decision',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            ack: { type: 'boolean' },
            category: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['ack', 'category', 'reason'],
          additionalProperties: false,
        },
      },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(config?.timeoutMs) || 5000);
  const started = Date.now();
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) { log?.(`HTTP ${resp.status}`); return null; }
    const data = await resp.json();
    const parsed = extractJson(data?.choices?.[0]?.message?.content || '');
    if (!parsed) { log?.('could not parse JSON from reply'); return null; }
    return {
      ack: !!parsed.ack,
      category: typeof parsed.category === 'string' ? parsed.category.trim() : '(none)',
      reason: typeof parsed.reason === 'string' ? parsed.reason.trim() : '',
      ms: Date.now() - started,
    };
  } catch (err) {
    log?.(err.name === 'AbortError' ? 'timed out' : err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { triage };
