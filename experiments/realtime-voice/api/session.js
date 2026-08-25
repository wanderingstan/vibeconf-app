// Mints a short-lived (~1 min) ephemeral client secret for the browser.
// The real OPENAI_API_KEY never leaves the server.
//
// OpenAI has shipped two shapes of this endpoint. We try the newer one first
// and fall back, so this keeps working across the rename.

const MODEL = process.env.REALTIME_MODEL || 'gpt-realtime';
const VOICE = process.env.REALTIME_VOICE || 'cedar';

// Two seams to compare.
//
// ROUTER: the fast model decides whether to escalate, via a tool. The weakest
// model makes the highest-leverage call, and Claude's clock only starts after
// it finishes deciding.
//
// BACKCHANNEL: the fast model never decides. It acknowledges and holds the
// floor while the server dispatches to Claude in parallel, then reads back
// whatever Claude pushes in. Claude self-gates by returning "nothing".

const ROUTER_INSTRUCTIONS = `You are Pepper, a voice teammate sitting in on a working call.

Keep replies to one or two sentences. You are a participant, not a narrator.

You are fast but not deep. The moment a request needs real thinking -- reading
or writing code, multi-step reasoning, checking a repo, anything where being
wrong would cost the user something -- call the ask_deep_model tool. Do not
attempt that work yourself and do not guess.

Before you call it, say a short filler out loud first ("let me look at that")
so the line is never silent. Then read the result back in your own words.`;

const BACKCHANNEL_INSTRUCTIONS = `You are Pepper, a voice teammate sitting in on a working call.

Your job is to hold the floor, not to answer. A slower, much smarter model is
working on every question in parallel with you, and its words will be handed to
you to read out.

When someone asks you something:
1. Acknowledge in one short sentence.
2. Say the ask back in your own words, so a mishearing gets caught early.
3. Stop talking.

Never commit to a conclusion, a difficulty ("that's easy"), or a direction.
You do not yet know the answer and guessing will contradict what comes back.
Small talk you can just answer normally and briefly.

You will receive bracketed [backchannel] notes. Those are private status
updates, not things anyone said. Never read one out verbatim. If you are asked
to speak after one, use it to say something true about where things stand.

When you are given words to deliver, say them close to as written. Do not
summarise them and do not add to them.`;

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

async function mint(mode) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set on the server');

  const auth = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  const router = mode !== 'backchannel';
  const instructions = router ? ROUTER_INSTRUCTIONS : BACKCHANNEL_INSTRUCTIONS;
  // In backchannel mode the tool is a fallback, not the main path.
  const tools = router ? TOOLS : [];

  // Newer shape: /v1/realtime/client_secrets with a nested session object.
  let r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      session: {
        type: 'realtime',
        model: MODEL,
        audio: { output: { voice: VOICE } },
        instructions,
        tools,
      },
    }),
  });

  if (r.ok) {
    const j = await r.json();
    const secret = j.value || j.client_secret?.value;
    if (secret) return { secret, model: MODEL, shape: 'client_secrets', mode };
  }

  // Older shape: /v1/realtime/sessions, flat.
  r = await fetch('https://api.openai.com/v1/realtime/sessions', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      model: MODEL,
      voice: VOICE,
      instructions,
      tools,
      tool_choice: 'auto',
    }),
  });

  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 400)}`);

  const j = await r.json();
  const secret = j.client_secret?.value || j.value;
  if (!secret) throw new Error(`No client secret in response: ${JSON.stringify(j).slice(0, 300)}`);
  return { secret, model: MODEL, shape: 'sessions', mode };
}

module.exports = async (req, res) => {
  try {
    const mode = new URL(req.url, 'http://x').searchParams.get('mode') || 'router';
    const out = await mint(mode);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(out));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
};
