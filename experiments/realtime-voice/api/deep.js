// The other side of the seam: the slow, smart model.
//
// The realtime model calls this via its ask_deep_model tool. If
// ANTHROPIC_API_KEY is set we really ask Claude; otherwise we return a stub so
// the handoff mechanics are still demonstrable without a second key.

const DEEP_MODEL = process.env.DEEP_MODEL || 'claude-sonnet-5';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      try { resolve(JSON.parse(s || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function askClaude(question) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: DEEP_MODEL,
      max_tokens: 400,
      system:
        'You are being consulted by a realtime voice agent mid-conversation. ' +
        'Your answer will be READ ALOUD, so keep it under 60 words, plain prose, ' +
        'no markdown, no lists, no code blocks. Lead with the answer.',
      messages: [{ role: 'user', content: question }],
    }),
  });

  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

module.exports = async (req, res) => {
  const started = Date.now();
  res.setHeader('Content-Type', 'application/json');
  try {
    const { question } = await readBody(req);
    if (!question) throw new Error('missing question');

    let answer, model;
    if (process.env.ANTHROPIC_API_KEY) {
      answer = await askClaude(question);
      model = DEEP_MODEL;
    } else {
      answer =
        'The deep model is not wired up in this demo -- ANTHROPIC_API_KEY is unset. ' +
        'The handoff itself worked: the realtime model recognised this needed more ' +
        'thinking and routed it here instead of guessing.';
      model = 'stub';
    }

    res.end(JSON.stringify({ answer, model, ms: Date.now() - started }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(e.message || e), ms: Date.now() - started }));
  }
};
