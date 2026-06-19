// phrase.js — fast-model "what would I say right now" drafting for the two-tier
// SHADOW HARNESS (docs/two-tier-design.md).
//
// At each floor-open the fast model is asked, from the bot's current `stance`,
// whether to speak and what to say. For now this is LOG-ONLY — the draft is
// never spoken. It runs alongside the slow `/join-call` session (which still
// drives all real speech) so we can compare fast-from-stance against what the
// slow session actually says, and decide whether the fast model can become the
// bot's SOLE voice (the single-voice end state). Zero behavior change.
//
// Same local OpenAI-compatible endpoint + NON-reasoning-model constraint as
// comprehend.js and the fast-ack. Never throws — shadow work must not disturb
// the call.

function stripThink(raw) {
  return String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function buildSystem(botName, personality) {
  return [
    `You are ${botName}, an AI participant speaking aloud in a live group voice call.`,
    personality
      ? `Your personality / voice: ${personality}`
      : `Speak naturally and conversationally, like a thoughtful colleague.`,
    `You are given your own current internal "stance" (the point you'd most want to make right now), a brief read of the discussion, notes on who's in the call, and the most recent thing said.`,
    `The floor has just opened (someone finished talking). Decide whether THIS is your moment to speak.`,
    ``,
    `Reply as STRICT JSON with exactly these keys: {"speak": true|false, "text": "..."}.`,
    `- speak=true → "text" is the single thing to say now, in ${botName}'s own voice: one or two sentences, natural spoken language, no markdown or lists.`,
    `- speak=false → stay quiet (not your turn, or nothing worth adding). Put a short reason in "text".`,
    `Prefer silence over filler. Speak only when you genuinely add value, are addressed, or a question is left hanging.`,
    ``,
    `Output ONLY the JSON object — no prose, no code fences.`,
  ].join('\n');
}

function buildUser({ workingMemory, recentTranscript, lastUtterance }) {
  const wm = workingMemory || {};
  return [
    `YOUR CURRENT STANCE (what you'd most want to contribute): ${wm.stance || '(none formed yet)'}`,
    `DISCUSSION SO FAR: ${wm.understanding || '(unknown)'}`,
    `PEOPLE IN THE CALL: ${wm.people || '(unknown)'}`,
    ``,
    `RECENT TRANSCRIPT:`,
    recentTranscript || '(none)',
    ``,
    `MOST RECENT THING SAID: ${lastUtterance || '(silence)'}`,
    ``,
    `The floor just opened. Decide and output the JSON now.`,
    `/no_think`,
  ].join('\n');
}

// Defensively pull the first JSON object out of the model's reply (same as
// comprehend.js — local models mostly obey "JSON only" but occasionally wrap it).
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

// Returns { speak: boolean, text: string, ms: number } or null on any failure.
async function phrase({ workingMemory, recentTranscript, lastUtterance, botName, personality, config, log }) {
  const { endpoint, apiKey, model } = config || {};
  if (!endpoint) { log?.('no endpoint configured'); return null; }

  const url = endpoint.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: model || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: buildSystem(botName || 'the bot', personality) },
      { role: 'user', content: buildUser({ workingMemory, recentTranscript, lastUtterance }) },
    ],
    temperature: 0.5,
    max_tokens: 200,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(config?.timeoutMs) || 6000);
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
    if (!resp.ok) { log?.(`HTTP ${resp.status}`); return null; }
    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content || '';
    const parsed = extractJson(raw);
    if (!parsed) { log?.('could not parse JSON from reply'); return null; }
    return {
      speak: !!parsed.speak,
      text: typeof parsed.text === 'string' ? parsed.text.trim() : '',
      ms: Date.now() - started,
    };
  } catch (err) {
    log?.(err.name === 'AbortError' ? 'timed out' : err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { phrase };
