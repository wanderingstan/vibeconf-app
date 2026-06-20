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

// The bot's posture is governed by its MODE — the same active/passive/silent
// lever the rest of the app uses — NOT by the fast model second-guessing whether
// it's its turn (which it does badly: it talked itself out of every turn in
// testing). Mode decides the default; the model only phrases accordingly.
function modeGuidance(mode) {
  switch (mode) {
    case 'passive':
      return `MODE: PASSIVE. You are a quiet participant in a conversation that is mostly between other people. Set speak=true ONLY if you were directly addressed — named, or clearly asked a question. Otherwise set speak=false: the others are talking among themselves and must not be interrupted.`;
    case 'silent':
      return `MODE: SILENT. Always set speak=false.`;
    case 'active':
    default:
      return `MODE: ACTIVE. You are an engaged participant. The floor just opened — set speak=true and contribute whenever you have something useful to add or are continuing an exchange you're part of. Lean toward contributing; set speak=false only for pure filler, or when another person clearly still holds the floor.`;
  }
}

function buildSystem(botName, personality, mode) {
  return [
    `You ARE ${botName}, a participant speaking aloud in a live group voice call. You are not an assistant describing ${botName} — you are ${botName}, talking.`,
    `In the transcript, lines beginning "${botName}:" are YOUR OWN earlier words. Never refer to ${botName} in the third person and never defer to "${botName}" as if they were someone else.`,
    personality
      ? `Your personality / voice: ${personality}`
      : `Speak naturally and conversationally, like a sharp, warm colleague.`,
    ``,
    `The floor just opened (someone finished talking). Your job: say the ONE thing you'd say right now, as a direct reply to what was just said.`,
    ``,
    `How to sound like a real participant, not a chatbot:`,
    `- RESPOND to the last speaker and their specific point — react to it, agree/push back/build on it. When it's a direct exchange, address them by name. Do NOT give a balanced general statement about the topic.`,
    `- Be SHORT: one sentence, occasionally two. This is spoken aloud — long paragraphs are wrong. No lists, no markdown.`,
    `- Do NOT announce actions ("I'll share my screen", "I'll capture that on the whiteboard"). You can only speak, not act — so just say your point. Something else handles doing.`,
    `- Use your internal "stance" as your substance, but deliver it as a natural spoken reply, not a summary or a mini-essay.`,
    `- No filler preambles ("That's a great point", "I think we need to clarify that"). Just say the thing.`,
    ``,
    modeGuidance(mode),
    ``,
    `Reply as STRICT JSON with exactly these keys: {"speak": true|false, "text": "..."}.`,
    `- speak=true → "text" is exactly the words to say aloud, in your own voice. No reasoning, no stage directions — just the spoken line.`,
    `- speak=false → "text" is a brief reason for staying quiet (not spoken).`,
    ``,
    `Output ONLY the JSON object — no prose, no code fences.`,
  ].join('\n');
}

function buildUser({ workingMemory, recentTranscript, lastUtterance, roster }) {
  const wm = workingMemory || {};
  return [
    `WHO IS IN THE CALL: ${roster || '(unknown)'}`,
    `NOTES ON PEOPLE: ${wm.people || '(none yet)'}`,
    `WHAT'S BEING DISCUSSED: ${wm.understanding || '(unknown)'}`,
    `YOUR STANCE (your substance — the point you most want to land): ${wm.stance || '(none formed yet)'}`,
    ``,
    `RECENT TRANSCRIPT (most recent last):`,
    recentTranscript || '(none)',
    ``,
    `>>> REPLY TO THIS (the line that just finished): ${lastUtterance || '(silence)'}`,
    ``,
    `Say your one spoken line, as a direct reply to that. Output the JSON now.`,
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
async function phrase({ workingMemory, recentTranscript, lastUtterance, roster, mode, botName, personality, config, log }) {
  const { endpoint, apiKey, model } = config || {};
  if (!endpoint) { log?.('no endpoint configured'); return null; }

  const url = endpoint.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: model || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: buildSystem(botName || 'the bot', personality, mode) },
      { role: 'user', content: buildUser({ workingMemory, recentTranscript, lastUtterance, roster }) },
    ],
    temperature: 0.5,
    max_tokens: 200,
    // Guaranteed-valid structured JSON so a stray prose/fence wrapper doesn't
    // drop the draft. LM Studio (MLX) rejects type:'json_object' — it wants
    // 'json_schema'. extractJson stays as a backstop for servers that ignore it.
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'phrase_decision',
        strict: true,
        schema: {
          type: 'object',
          properties: { speak: { type: 'boolean' }, text: { type: 'string' } },
          required: ['speak', 'text'],
          additionalProperties: false,
        },
      },
    },
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
