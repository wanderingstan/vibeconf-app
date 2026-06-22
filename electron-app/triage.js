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

// Prompt tuned for Apple's on-device FoundationModels backend (#243). Notes:
// - No vendor control tokens (e.g. Qwen's "/no_think") — Apple's model doesn't
//   understand them and leaks them into output. Plain instructions only.
// - The hard cases are mention-vs-address and collective questions; the rules
//   below call those out explicitly because the model otherwise pattern-matches
//   the bot's name into a false "addressed".
function buildSystem(botName) {
  return [
    `You are the instant turn-taking judgment for ${botName}, one participant in a live group voice call. Someone just finished talking and the floor is open.`,
    `Decide ONE thing: did that finished line address ${botName}, such that a reply FROM ${botName} is expected right now?`,
    `You are NOT writing the reply — a separate, slower part of ${botName} does that. Your only job is the snap yes/no so ${botName} can acknowledge instantly instead of leaving an awkward silence.`,
    ``,
    `How to decide:`,
    `- Lines beginning "${botName}:" are ${botName}'s OWN past words — never read them as someone addressing it.`,
    `- If an ENGAGEMENT STATE is given saying ${botName} is mid-exchange with someone, then a bare "you"/"can you…"/an unnamed follow-up in the finished line refers to ${botName} — treat it as addressed. If it says ${botName} is sidelined while others talk to each other, a bare "you" is NOT ${botName} unless the finished line names it.`,
    `- ${botName} IS addressed when the finished line speaks TO it: (a) names it in a question/request ("${botName}, can you…"); or (b) is a clear question/request to the bot in a 1:1-style exchange even without the name ("Can you summarize that?"), INCLUDING a follow-up that continues ${botName}'s own just-finished exchange ("And can you also add…?", "now do the same for…"); or (c) is a collective question that explicitly invites everyone using the second person ("What do you all think?", "you guys?", "anyone?").`,
    `- ${botName} is NOT addressed when: the line only MENTIONS it in passing ("I was talking to ${botName} earlier", "${botName} already did that") — that is ABOUT it, not TO it; or a DIFFERENT participant is named; or people are chatting among themselves; or it's a statement, a greeting, or thinking out loud that expects no answer.`,
    `- Only say yes if THIS finished line genuinely addresses ${botName}. If ${botName}'s name is absent AND it is not plainly a question/request aimed at the bot, say no. Do NOT invent an address that isn't in the text.`,
    ``,
    `Reply as STRICT JSON only — no prose, no code fences:`,
    `{"ack": true|false, "category": "...", "reason": "..."}`,
    `"category" is exactly one of:`,
    `- "addressed"      — spoken TO ${botName}: named request/question, a 1:1 question, or a collective "you all/you guys/anyone" question. ack=true`,
    `- "other-bot"      — a DIFFERENT named participant is addressed, not ${botName}. ack=false`,
    `- "human-to-human" — people talking among themselves; ${botName} is not part of it. ack=false`,
    `- "ambient"        — open talk ${botName} could optionally join but isn't required to, or a passing mention of ${botName}. ack=false`,
    ``,
    `When genuinely torn between "addressed" and "ambient", choose "ambient" (ack=false) — a missed ack is recoverable (the slow part still answers), a wrong ack interrupts people. But a real collective "you all"-style question counts as "addressed".`,
    `"reason" is a brief debug phrase (a few words).`,
  ].join('\n');
}

function buildUser({ recentTranscript, lastUtterance, roster, botName, engagement }) {
  return [
    `WHO IS IN THE CALL: ${roster || '(unknown)'}`,
    ``,
    engagement
      ? `ENGAGEMENT STATE (who ${botName} is actively talking with right now — use this to resolve a bare "you"): ${engagement}`
      : `ENGAGEMENT STATE: (none — no active exchange tracked yet)`,
    ``,
    `RECENT TRANSCRIPT (most recent last):`,
    recentTranscript || '(none)',
    ``,
    `>>> THE LINE THAT JUST FINISHED: ${lastUtterance || '(silence)'}`,
    ``,
    `Did that finished line address ${botName}? Output the JSON now.`,
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
async function triage({ recentTranscript, lastUtterance, roster, botName, engagement, config, log }) {
  const { endpoint, apiKey, model } = config || {};
  if (!endpoint) { log?.('no endpoint configured'); return null; }

  const url = endpoint.replace(/\/+$/, '') + '/chat/completions';
  const messages = [
    { role: 'system', content: buildSystem(botName || 'the bot') },
    { role: 'user', content: buildUser({ recentTranscript, lastUtterance, roster, botName: botName || 'the bot', engagement }) },
  ];
  // Strict structured output via json_schema — LM Studio supports it. Some
  // openai-compat servers (e.g. the Apple-on-device wrappers, #243) don't and
  // reject it with a 400; in that case we retry WITHOUT response_format and lean
  // on extractJson + the "Output ONLY the JSON object" instruction in the prompt.
  const SCHEMA = {
    type: 'json_schema',
    json_schema: {
      name: 'triage_decision',
      strict: true,
      schema: {
        type: 'object',
        properties: { ack: { type: 'boolean' }, category: { type: 'string' }, reason: { type: 'string' } },
        required: ['ack', 'category', 'reason'],
        additionalProperties: false,
      },
    },
  };

  const post = async (useSchema) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(config?.timeoutMs) || 5000);
    try {
      const body = { model: model || 'gpt-4o-mini', messages, temperature: 0.1, max_tokens: 120 };
      if (useSchema) body.response_format = SCHEMA;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return resp;
    } finally {
      clearTimeout(timer);
    }
  };

  const started = Date.now();
  try {
    let resp = await post(true);
    if (resp.status === 400) {
      // Likely "response_format unsupported" — retry plain (prompt asks for JSON).
      log?.('HTTP 400 with json_schema — retrying without structured output');
      resp = await post(false);
    }
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
  }
}

module.exports = { triage };
