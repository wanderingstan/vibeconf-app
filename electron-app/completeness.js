// completeness.js — fast-model UTTERANCE-COMPLETENESS judgment for the two-tier
// experiment.
//
// The one fast-model role the ~3s slow-model latency floor does NOT defeat:
// deciding, from the messy IN-FLIGHT captions, whether the current speaker has
// actually FINISHED their utterance — i.e. whether it's even time to respond yet.
// This runs INSIDE the silence window (before the slow model is invoked), so a
// sub-second model (Apple on-device ~0.34s warm, #243) is fast enough to gate it.
//
// Distinct from triage.js (addressivity — "is the bot being spoken to"). This is
// "is the human DONE talking", a more local/syntactic call that a small model may
// handle better than the about-vs-to nuance triage needs.
//
// Same local OpenAI-compatible endpoint contract as triage.js / comprehend.js:
// the json_schema is sent but NOT relied upon (Apple wrappers accept it and then
// freelance keys + ```json fences), so the prompt itself pins the exact shape and
// extractJson tolerates fences. Returns null on any failure; never throws.

function stripThink(raw) {
  return String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function extractJson(raw) {
  const text = stripThink(raw);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function buildSystem() {
  return [
    `You watch the LIVE, still-updating captions of one speaker in a group voice call. Captions are messy: NO punctuation, lowercase, run-ons. Because there is NEVER punctuation, you must judge completeness from GRAMMAR, not from a period.`,
    `Decide ONE thing: has the speaker reached the end of a complete sentence/clause/question (someone could now respond), or are they cut off mid-phrase with an obviously missing word coming next?`,
    `This is NOT about who they are addressing or whether a reply is wanted. ONLY: is the last word a natural END of a thought, or a DANGLING word that demands a continuation?`,
    ``,
    `complete=FALSE only when the final word leaves an obvious grammatical gap — it ends on a dangling connector or an article/preposition with its object missing: "...share the white", "...we need to", "...a diagram on the", "what do you", "the part is to". You can feel the next word is required.`,
    `complete=TRUE when the words form a finished sentence or question even without punctuation: "can you share the whiteboard", "what do you think", "the demo went really well", "what should we work on next", "thanks that is really helpful". A finished question/statement is COMPLETE even though it has no question mark or period.`,
    ``,
    `Do NOT mark something partial just because it contains function words ("can you", "what do you", "the") — those are fine WITHIN a finished sentence. Only the DANGLING-at-the-very-end case is partial.`,
    `Examples — partial: "jimmy can you" | "i think the most important part is to" | "and then after that we need to". complete: "jimmy can you share the whiteboard" | "what do you think jimmy" | "lets keep testing and see how it holds up".`,
    ``,
    `Reply as STRICT JSON: {"complete": true|false, "reason": "..."}.`,
    `"reason" is a short phrase (for debugging), not spoken.`,
    `Output ONLY the JSON object — no prose, no code fences.`,
  ].join('\n');
}

function buildUser(text) {
  return [
    `LIVE CAPTION SO FAR: ${JSON.stringify(text || '')}`,
    ``,
    `Has the speaker finished this utterance? Output the JSON now.`,
    `/no_think`,
  ].join('\n');
}

// Returns { complete: boolean, reason: string, ms: number } or null on failure.
async function judgeComplete({ text, config, log }) {
  const { endpoint, apiKey, model } = config || {};
  if (!endpoint) { log?.('no endpoint configured'); return null; }

  const url = endpoint.replace(/\/+$/, '') + '/chat/completions';
  const messages = [
    { role: 'system', content: buildSystem() },
    { role: 'user', content: buildUser(text) },
  ];
  const SCHEMA = {
    type: 'json_schema',
    json_schema: {
      name: 'completeness_decision',
      strict: true,
      schema: {
        type: 'object',
        properties: { complete: { type: 'boolean' }, reason: { type: 'string' } },
        required: ['complete', 'reason'],
        additionalProperties: false,
      },
    },
  };

  const post = async (useSchema) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(config?.timeoutMs) || 5000);
    try {
      const body = { model: model || 'apple-on-device', messages, temperature: 0, max_tokens: 80 };
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
      log?.('HTTP 400 with json_schema — retrying without structured output');
      resp = await post(false);
    }
    if (!resp.ok) { log?.(`HTTP ${resp.status}`); return null; }
    const data = await resp.json();
    const parsed = extractJson(data?.choices?.[0]?.message?.content || '');
    if (!parsed) { log?.('could not parse JSON from reply'); return null; }
    return {
      complete: !!parsed.complete,
      reason: typeof parsed.reason === 'string' ? parsed.reason.trim() : '',
      ms: Date.now() - started,
    };
  } catch (err) {
    log?.(err.name === 'AbortError' ? 'timed out' : err.message);
    return null;
  }
}

// Parse a log file's [caption-raw] lines into per-turn progressions.
// Line format (from local-server._logRawCaption):
//   ...📝 [caption-raw] t<turnId> LIVE|settled <speaker>: "<json-encoded text>"
// Returns [{ turnId, speaker, states: [{ live: bool, text }] }] in file order.
function parseCaptionLog(content) {
  const re = /\[caption-raw\]\s+t(\d+)\s+(LIVE|settled)\s+([^:]+):\s+("(?:[^"\\]|\\.)*")/;
  const turns = new Map();
  const order = [];
  for (const line of String(content || '').split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    const [, turnId, liveTag, speaker, jsonText] = m;
    let text;
    try { text = JSON.parse(jsonText); } catch { text = jsonText; }
    if (!turns.has(turnId)) {
      turns.set(turnId, { turnId, speaker: speaker.trim(), states: [] });
      order.push(turnId);
    }
    turns.get(turnId).states.push({ live: liveTag === 'LIVE', text });
  }
  return order.map((id) => turns.get(id));
}

module.exports = { judgeComplete, parseCaptionLog, buildSystem, buildUser };
