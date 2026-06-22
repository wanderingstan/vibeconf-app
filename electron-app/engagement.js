// engagement.js — dedicated "who is the bot engaged with right now" classifier
// for the two-tier turn-taking experiment (#243).
//
// WHY THIS IS SEPARATE from comprehend.js: we tried folding `engagement` into
// comprehend's 4-field working-memory JSON and it failed on the case that
// matters most — when the floor SHIFTS away from the bot to two other people,
// the small (Apple 3B) model kept anchoring the bot in the exchange ("Jimmy is
// talking with Stan") because the whole prompt is framed around the bot. An
// ISOLATED, single-purpose prompt that asks ONLY "who is the current
// speaker→addressee pair?" — with no mention of the bot — gets it right
// reliably (3/3 where the bundled version was 0/3).
//
// So: the LLM does the hard PERCEPTION it's good at (read the last turns, name
// the active pair), and we place the bot relative to that pair in plain code
// (where the model was biased). The resulting `engagement` string feeds
// triage.js so a bare "you" / unnamed follow-up resolves to the right person.
//
// Same local OpenAI-compatible endpoint as triage/comprehend (now Apple).

function extractJson(raw) {
  const text = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function buildSystem(roster) {
  return [
    `You are watching a live group voice call transcript.`,
    `WHO IS IN THE CALL:`,
    roster || '(unknown)',
    ``,
    `Look ONLY at the final one or two lines of the transcript. Decide who is speaking in the LAST line and who they are speaking TO — the specific person they address by name, answer, or continue a back-and-forth with.`,
    `Judge purely from the END of the transcript, not from who was central earlier.`,
    ``,
    `Reply as STRICT JSON only — no prose, no code fences:`,
    `{"speaker": "<name of who speaks the last line>", "addressing": "<name of who they are speaking to, or 'group' if no single person>"}`,
    `Use exact names from the roster. If the last line addresses no one in particular (a statement to the room), set "addressing" to "group".`,
  ].join('\n');
}

// Match a model-returned name against the bot's name (first-token, case-insensitive).
function isBot(name, botName) {
  if (!name || !botName) return false;
  const n = name.trim().toLowerCase();
  const b = botName.trim().toLowerCase();
  const bFirst = b.split(/\s+/)[0];
  return n === b || n.includes(bFirst) || bFirst.includes(n.split(/\s+/)[0]);
}

// Turn the perceived {speaker, addressing} pair into the engagement string,
// placing the bot deterministically — the part the LLM was biased on.
function placeEngagement(speaker, addressing, botName) {
  const s = (speaker || '').trim();
  const a = (addressing || '').trim();
  if (!s) return '';
  const group = !a || /^group$/i.test(a);
  if (isBot(s, botName)) {
    // Bot is the one speaking — it's engaged with whoever it's addressing.
    return group ? `${botName} is addressing the group` : `${botName} is actively talking with ${a}`;
  }
  if (isBot(a, botName)) {
    // Bot is being spoken to.
    return `${botName} is actively talking with ${s}`;
  }
  // The current exchange is between two OTHERS — the bot is sidelined.
  return group
    ? `sidelined; ${s} is addressing the group`
    : `sidelined; ${s} is talking with ${a}`;
}

// Returns { engagement: string, speaker, addressing, ms } or null on failure.
// Never throws.
async function classifyEngagement({ transcript, roster, botName, config, log }) {
  const { endpoint, apiKey, model } = config || {};
  if (!endpoint) { log?.('engagement: no endpoint configured'); return null; }
  if (!transcript || !transcript.trim()) { log?.('engagement: empty transcript'); return null; }

  const url = endpoint.replace(/\/+$/, '') + '/chat/completions';
  const messages = [
    { role: 'system', content: buildSystem(roster) },
    { role: 'user', content: `TRANSCRIPT (most recent last):\n${transcript}\n\nOutput the JSON now.` },
  ];
  const SCHEMA = {
    type: 'json_schema',
    json_schema: {
      name: 'engagement_pair',
      strict: true,
      schema: {
        type: 'object',
        properties: { speaker: { type: 'string' }, addressing: { type: 'string' } },
        required: ['speaker', 'addressing'],
        additionalProperties: false,
      },
    },
  };

  const post = async (useSchema) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(config?.timeoutMs) || 6000);
    try {
      const body = { model: model || 'gpt-4o-mini', messages, temperature: 0.1, max_tokens: 60 };
      if (useSchema) body.response_format = SCHEMA;
      return await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const started = Date.now();
  try {
    let resp = await post(true);
    if (resp.status === 400) {
      log?.('engagement: HTTP 400 with json_schema — retrying without structured output');
      resp = await post(false);
    }
    if (!resp.ok) { log?.(`engagement: HTTP ${resp.status}`); return null; }
    const data = await resp.json();
    const parsed = extractJson(data?.choices?.[0]?.message?.content || '');
    if (!parsed || typeof parsed.speaker !== 'string') { log?.('engagement: could not parse JSON'); return null; }
    const speaker = parsed.speaker.trim();
    const addressing = typeof parsed.addressing === 'string' ? parsed.addressing.trim() : '';
    const engagement = placeEngagement(speaker, addressing, botName || 'the bot');
    return { engagement, speaker, addressing, ms: Date.now() - started };
  } catch (err) {
    log?.(`engagement: ${err.name === 'AbortError' ? 'timed out' : err.message}`);
    return null;
  }
}

module.exports = { classifyEngagement, placeEngagement };
