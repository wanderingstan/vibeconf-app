// The slow model, as a back channel.
//
// Streams newline-delimited JSON events rather than returning one answer, so
// the fast model can be briefed while the work is still happening:
//
//   {"type":"working","gist":"..."}       silent inject, no speech
//   {"type":"progress","gist":"..."}      silent inject, no speech
//   {"type":"nothing_to_add"}             Claude self-gates; page stays quiet
//   {"type":"interject","voice_line":...} take the floor now
//   {"type":"final","voice_line":...,"artifact":...}
//
// Claude writes its own voice_line. The fast model reads it near-verbatim
// instead of summarising, which is what keeps precision from being mangled.

const DEEP_MODEL = process.env.DEEP_MODEL || 'claude-sonnet-5';

const SYSTEM = `You are the slow, careful half of a voice assistant sitting in on a live
meeting. A fast speech model is holding the floor and will read your words aloud.

Reply with ONLY a JSON object, no prose around it, no code fences:

{
  "verdict": "answer" | "nothing",
  "voice_line": "what to say out loud",
  "artifact": "longer content for the screen, or null",
  "urgent": true | false
}

Rules:
- "nothing" if the fast model has already handled it, or the utterance was
  small talk, or you would only be padding. Silence is a valid contribution.
- voice_line is READ ALOUD: under 45 words, plain prose, no markdown, no
  lists, no code. Lead with the answer.
- Put code, diagrams, and anything precise in artifact. Never in voice_line.
  If there is an artifact, voice_line should point at it ("it's on the board").
- urgent: true only if this corrects a live mistake and cannot wait for a gap.`;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function parseVerdict(text) {
  // Claude is asked for bare JSON, but tolerate fences or stray prose.
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { verdict: 'answer', voice_line: text.slice(0, 240), artifact: null };
  try { return JSON.parse(m[0]); }
  catch { return { verdict: 'answer', voice_line: text.slice(0, 240), artifact: null }; }
}

async function askClaude(question, signal) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: DEEP_MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: 'user', content: question }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return parseVerdict(text);
}

// No ANTHROPIC_API_KEY: simulate a plausible verdict so the floor-control
// mechanics are still fully exercisable. Clearly labelled as simulated.
function stubVerdict(q) {
  const s = (q || '').toLowerCase();
  const trivial = /capital of|what time|how are you|thanks|thank you|hello|hi\b/.test(s);
  const codey = /code|function|python|javascript|bug|test|refactor|regex|sql|migrat/.test(s);

  if (trivial) return { verdict: 'nothing' };
  if (codey) {
    return {
      verdict: 'answer',
      urgent: false,
      voice_line:
        'Simulated deep answer: I put a version on the board with the edge cases marked. ' +
        'The empty-list case is the one that usually bites.',
      artifact:
        'def merge(a, b):\n' +
        '    out, i, j = [], 0, 0\n' +
        '    while i < len(a) and j < len(b):\n' +
        '        if a[i] <= b[j]: out.append(a[i]); i += 1\n' +
        '        else:            out.append(b[j]); j += 1\n' +
        '    return out + a[i:] + b[j:]\n\n' +
        '# edge cases: either list empty; equal heads (<= keeps it stable); duplicates.',
    };
  }
  return {
    verdict: 'answer',
    urgent: false,
    voice_line:
      'Simulated deep answer: I had time to think about that one, and the fast model ' +
      'would have had to guess at it.',
    artifact: null,
  };
}

module.exports = async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });

  const t0 = Date.now();
  const send = (o) => res.write(JSON.stringify({ ...o, ms: Date.now() - t0 }) + '\n');

  // The caller hanging up (a superseded question) should abort the upstream call.
  const ac = new AbortController();
  req.on('aborted', () => ac.abort());

  let ticker;
  try {
    const { question } = await readBody(req);
    if (!question) throw new Error('missing question');

    const live = !!process.env.ANTHROPIC_API_KEY;

    send({ type: 'working', gist: live ? 'thinking it through' : 'thinking it through (simulated)' });

    // Honest progress: elapsed time, not invented activity. In the app this is
    // where real tool-call updates would land.
    ticker = setInterval(() => send({ type: 'progress', gist: 'still working' }), 2500);

    let v;
    if (live) {
      v = await askClaude(question, ac.signal);
    } else {
      await new Promise((r) => setTimeout(r, 3200));
      v = stubVerdict(question);
    }

    clearInterval(ticker);

    if (v.verdict === 'nothing') {
      send({ type: 'nothing_to_add' });
    } else {
      send({
        type: v.urgent ? 'interject' : 'final',
        voice_line: v.voice_line || '',
        artifact: v.artifact || null,
        model: live ? DEEP_MODEL : 'stub',
      });
    }
  } catch (e) {
    clearInterval(ticker);
    if (!ac.signal.aborted) send({ type: 'failed', error: String(e.message || e) });
  } finally {
    clearInterval(ticker);
    res.end();
  }
};
