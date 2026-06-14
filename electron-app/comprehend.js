// comprehend.js — background "working memory" maintenance for the two-tier
// experiment (docs/two-tier-design.md).
//
// Unlike the slow session (which is single-threaded and blocked in
// wait_for_speech, so it can only refresh working memory at silence
// boundaries), this runs in-process in the Electron main process and is
// triggered by TRANSCRIPT ACCUMULATION — every time enough new speech has
// piled up, local-server fires onComprehensionDue and we call the local model
// here to re-read the conversation. That keeps the bot warm through long
// human-to-human stretches it isn't part of yet.
//
// Uses the same local OpenAI-compatible endpoint as the fast-ack model (LM
// Studio etc.). The model must be a NON-reasoning instruct model — see the
// constraint in docs/two-tier-design.md.

// Qwen thinking-mode soft switch + backstop, mirrored from ack/openai-compat.js.
function stripThink(raw) {
  return String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function buildSystem(botName) {
  return [
    `You maintain the private working memory of an AI participant named ${botName} in a live group voice call.`,
    `You are given the recent transcript and the current working memory. Produce an UPDATED working memory as STRICT JSON with exactly these keys:`,
    `{"understanding": "...", "stance": "...", "people": "..."}`,
    ``,
    `- understanding: a few sentences capturing what is being discussed right now. Rewrite freely as the topic moves.`,
    `- stance: the single point ${botName} would make if the floor opened this instant — a sentence or two, already shaped to be said aloud. If ${botName} has nothing worth adding right now, use "".`,
    `- people: accumulating notes on who is in the call (roles, expertise, relationships, who has been quiet). ADD to the prior people notes; do NOT discard what is already there.`,
    ``,
    `Output ONLY the JSON object — no prose, no markdown, no code fences.`,
  ].join('\n');
}

function buildUser({ transcript, workingMemory }) {
  const wm = workingMemory || {};
  return [
    `CURRENT WORKING MEMORY:`,
    `understanding: ${wm.understanding || '(empty)'}`,
    `stance: ${wm.stance || '(empty)'}`,
    `people: ${wm.people || '(empty)'}`,
    ``,
    `RECENT TRANSCRIPT:`,
    transcript || '(none)',
    ``,
    `/no_think`,
  ].join('\n');
}

// Defensively pull the first JSON object out of the model's reply. Local 7B
// models mostly obey "JSON only" but occasionally wrap it in prose or fences;
// extract the outermost {...} and parse that.
function extractJson(raw) {
  const text = stripThink(raw);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Returns { understanding?, stance?, people? } (only string fields the model
// returned) or null on any failure. Never throws — this is background work and
// a flaky/slow endpoint must not disturb the call.
async function comprehend({ transcript, workingMemory, botName, config, log }) {
  const { endpoint, apiKey, model } = config || {};
  if (!endpoint) { log?.('comprehend: no endpoint configured'); return null; }

  const url = endpoint.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: model || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: buildSystem(botName || 'the bot') },
      { role: 'user', content: buildUser({ transcript, workingMemory }) },
    ],
    temperature: 0.3,
    max_tokens: 500,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(config?.timeoutMs) || 8000);
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
      log?.(`comprehend: HTTP ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content || '';
    const parsed = extractJson(raw);
    if (!parsed) { log?.(`comprehend: could not parse JSON from reply`); return null; }
    const out = {};
    if (typeof parsed.understanding === 'string') out.understanding = parsed.understanding.trim();
    if (typeof parsed.stance === 'string') out.stance = parsed.stance.trim();
    if (typeof parsed.people === 'string') out.people = parsed.people.trim();
    if (!('understanding' in out) && !('stance' in out) && !('people' in out)) {
      log?.('comprehend: reply had no usable fields');
      return null;
    }
    log?.(`comprehend: ok in ${Date.now() - started}ms (u${(out.understanding||'').length} s${(out.stance||'').length} p${(out.people||'').length})`);
    return out;
  } catch (err) {
    log?.(`comprehend: ${err.name === 'AbortError' ? 'timed out' : err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { comprehend };
