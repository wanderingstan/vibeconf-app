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

const fs = require('fs');
const path = require('path');

// The completeness prompt lives in prompts/completeness-system.md so Stan/Seth
// can tune the firing bar without editing code — hot-reloaded on mtime change
// (re-run scripts/completeness-eval.mjs to iterate). The inline FALLBACK below
// is the source of truth if the file is missing/unreadable. Override the path
// with VIBECONF_COMPLETENESS_PROMPT_PATH if needed.
const DEFAULT_PROMPT_PATH = path.join(__dirname, 'prompts', 'completeness-system.md');
let _promptCache = { path: null, mtimeMs: 0, content: null };

const FALLBACK_SYSTEM = [
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

// Hot-reloaded system prompt: prompts/completeness-system.md if present (re-read
// only when its mtime changes), else the inline FALLBACK_SYSTEM. Never throws.
function buildSystem() {
  const resolved = process.env.VIBECONF_COMPLETENESS_PROMPT_PATH || DEFAULT_PROMPT_PATH;
  try {
    const stat = fs.statSync(resolved);
    if (_promptCache.path === resolved && _promptCache.mtimeMs === stat.mtimeMs) {
      return _promptCache.content;
    }
    const content = fs.readFileSync(resolved, 'utf8').trim();
    _promptCache = { path: resolved, mtimeMs: stat.mtimeMs, content };
    return content;
  } catch {
    return _promptCache.content || FALLBACK_SYSTEM;
  }
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

// Endpoint-free fallback for judgeComplete. When the on-device model is not
// running (nothing listening on ackEndpoint), judgeComplete returns null and the
// probe gate used to skip — which silently disabled active listening entirely
// for anyone without the local server up. A dead port should degrade the gate,
// not delete it.
//
// The model's whole job is the DANGLING-final-word test described in the system
// prompt above, and that test is mostly lexical: a thought is unfinished when it
// ends on a word that grammatically demands a next one. Encode exactly that. It
// is strictly worse than the model (no semantics, no long-range grammar), so it
// is used only as a fallback and is deliberately CONSERVATIVE — when unsure it
// answers "not complete", which costs us a missed probe rather than an
// interruption.
//
// Returns { complete, reason, ms, heuristic: true }.
const DANGLING_FINAL_WORDS = new Set([
  // articles / determiners
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'your', 'our', 'their', 'his', 'her', 'its',
  // prepositions
  'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'onto', 'about',
  'over', 'under', 'between', 'through', 'during', 'against', 'toward', 'towards', 'upon',
  // conjunctions / connectors
  'and', 'or', 'but', 'so', 'because', 'if', 'when', 'while', 'as', 'than', 'then',
  'though', 'although', 'unless', 'until', 'whether', 'plus',
  // auxiliaries / modals
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did',
  'have', 'has', 'had', 'can', 'could', 'will', 'would', 'shall', 'should',
  'may', 'might', 'must', 'gonna', 'wanna',
  // pronouns / wh-words that demand a predicate
  'i', 'you', 'he', 'she', 'we', 'they', 'it',
  'what', 'which', 'who', 'whom', 'whose', 'where', 'why', 'how',
  // very common dangling verbs/adverbs
  'like', 'just', 'very', 'really', 'more', 'most', 'some', 'any', 'not', 'no',
]);

const MIN_HEURISTIC_WORDS = 3;

function heuristicComplete(text) {
  const started = Date.now();
  const clean = String(text || '').trim();
  const words = clean.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean);
  // No actual words means no thought — "..." and "???" are not openings.
  if (words.length === 0) {
    return { complete: false, reason: 'heuristic: no words', ms: Date.now() - started, heuristic: true };
  }
  // Real punctuation is rare in live captions, but when Meet does emit a
  // terminator it is the strongest possible signal — take it, even for a
  // one-word answer ("Really?") that the word-count floor would reject.
  if (/[.!?]["')\]]?$/.test(clean)) {
    return { complete: true, reason: 'heuristic: terminal punctuation', ms: Date.now() - started, heuristic: true };
  }
  if (words.length < MIN_HEURISTIC_WORDS) {
    return { complete: false, reason: `heuristic: only ${words.length} words`, ms: Date.now() - started, heuristic: true };
  }
  const last = words[words.length - 1];
  if (DANGLING_FINAL_WORDS.has(last)) {
    return { complete: false, reason: `heuristic: dangling final word "${last}"`, ms: Date.now() - started, heuristic: true };
  }
  return { complete: true, reason: `heuristic: ends on "${last}"`, ms: Date.now() - started, heuristic: true };
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

module.exports = { judgeComplete, heuristicComplete, parseCaptionLog, buildSystem, buildUser };
