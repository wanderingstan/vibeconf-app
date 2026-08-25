// Mints a short-lived (~1 min) ephemeral client secret for the browser.
// The real OPENAI_API_KEY never leaves the server.
//
// OpenAI has shipped two shapes of this endpoint. We try the newer one first
// and fall back, so this keeps working across the rename.

const MODEL = process.env.REALTIME_MODEL || 'gpt-realtime';
const VOICE = process.env.REALTIME_VOICE || 'cedar';

const INSTRUCTIONS = `You are Pepper, a voice teammate sitting in on a working call.

Keep replies to one or two sentences. You are a participant, not a narrator.

You are fast but not deep. The moment a request needs real thinking -- reading
or writing code, multi-step reasoning, checking a repo, anything where being
wrong would cost the user something -- call the ask_deep_model tool. Do not
attempt that work yourself and do not guess.

Before you call it, say a short filler out loud first ("let me look at that")
so the line is never silent. Then read the result back in your own words.`;

const TOOLS = [
  {
    type: 'function',
    name: 'ask_deep_model',
    description:
      'Hand a question to a slower, much smarter model (Claude). Use for code, ' +
      'multi-step reasoning, repo questions, or anything accuracy-critical. ' +
      'Takes a few seconds -- speak a filler line before calling it.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The full question, self-contained, with any context needed to answer it.',
        },
      },
      required: ['question'],
    },
  },
];

async function mint() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set on the server');

  const auth = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  // Newer shape: /v1/realtime/client_secrets with a nested session object.
  let r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      session: {
        type: 'realtime',
        model: MODEL,
        audio: { output: { voice: VOICE } },
        instructions: INSTRUCTIONS,
        tools: TOOLS,
      },
    }),
  });

  if (r.ok) {
    const j = await r.json();
    const secret = j.value || j.client_secret?.value;
    if (secret) return { secret, model: MODEL, shape: 'client_secrets' };
  }

  // Older shape: /v1/realtime/sessions, flat.
  r = await fetch('https://api.openai.com/v1/realtime/sessions', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      model: MODEL,
      voice: VOICE,
      instructions: INSTRUCTIONS,
      tools: TOOLS,
      tool_choice: 'auto',
    }),
  });

  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 400)}`);

  const j = await r.json();
  const secret = j.client_secret?.value || j.value;
  if (!secret) throw new Error(`No client secret in response: ${JSON.stringify(j).slice(0, 300)}`);
  return { secret, model: MODEL, shape: 'sessions' };
}

module.exports = async (req, res) => {
  try {
    const out = await mint();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(out));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
};
