// llm-judge.mjs — grade a non-deterministic agent run against a rubric.
//
// Mirrors the CLI-first / API-fallback pattern already used by
// share-verify-test.mjs's vision check:
//   1. `claude -p` (the interactive subscription — no API key, preferred on the mini)
//   2. Anthropic Messages API (needs ANTHROPIC_API_KEY) with structured JSON output
//   3. null  → caller records a manual-review fallback (never a false PASS)
//
// The judge reads a transcript + session log and returns a structured verdict.
// It's a reasoning task over messy text, so the API fallback defaults to
// claude-opus-4-8 (override with VIBECONF_JUDGE_MODEL). The CLI path uses
// whatever model your `claude` login defaults to.

import { execFile } from 'node:child_process';

const JUDGE_MODEL = process.env.VIBECONF_JUDGE_MODEL || 'claude-opus-4-8';

// Structured verdict schema — kept within structured-outputs limits (no
// minLength/enum-of-objects etc.). `ok` is the single go/no-go bit.
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'reasons', 'checks'],
  properties: {
    ok: { type: 'boolean' },
    reasons: { type: 'string' },
    checks: {
      type: 'object',
      additionalProperties: false,
      required: ['joined', 'heard', 'shared', 'chatted', 'left_clean', 'no_loops', 'no_double_answers', 'avoided_talk_over'],
      properties: {
        joined: { type: 'boolean' },
        heard: { type: 'boolean' },
        shared: { type: 'boolean' },
        chatted: { type: 'boolean' },
        left_clean: { type: 'boolean' },
        no_loops: { type: 'boolean' },
        no_double_answers: { type: 'boolean' },
        avoided_talk_over: { type: 'boolean' },
      },
    },
  },
};

function buildPrompt({ rubric, transcript, sessionLog, metrics }) {
  // Cap the inputs so a runaway log can't blow the context / CLI arg limits.
  const clip = (s, n) => (s && s.length > n ? s.slice(-n) : s || '(none)');
  return [
    'You are grading an automated, non-deterministic multi-bot video-call test.',
    'Real Claude agents drove the bots through a mission; below are the MEASURED',
    'METRICS (objective, sampled by the harness), the call TRANSCRIPT (what was',
    'said/heard), and the SESSION LOG (agent + app behavior).',
    'Grade STRICTLY against the RUBRIC. Judge only from the evidence provided.',
    'For turn-taking / talk-over, treat the MEASURED METRICS as authoritative.',
    '',
    '=== RUBRIC ===',
    rubric,
    '',
    '=== MEASURED METRICS ===',
    metrics || '(none)',
    '',
    '=== TRANSCRIPT ===',
    clip(transcript, 12000),
    '',
    '=== SESSION LOG (tail) ===',
    clip(sessionLog, 16000),
    '',
    'Respond with ONLY a JSON object, no prose, matching exactly:',
    '{"ok": <bool overall pass>, "reasons": "<one-paragraph justification>", "checks": {',
    '  "joined": <bool>, "heard": <bool>, "shared": <bool>, "chatted": <bool>,',
    '  "left_clean": <bool>, "no_loops": <bool>, "no_double_answers": <bool>,',
    '  "avoided_talk_over": <bool — false if the bots spoke over each other a lot> }}',
  ].join('\n');
}

function extractJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function execFileP(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args, opts, (err, stdout, stderr) =>
      resolve({ err, stdout: stdout || '', stderr: stderr || '' }));
  });
}

// 1) Claude CLI (subscription). Returns the parsed verdict or null.
async function judgeViaCli(prompt) {
  // -p = headless print mode. No tools needed for a text judgment.
  const { err, stdout } = await execFileP('claude', ['-p', prompt], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  if (err) return null;
  return extractJson(stdout);
}

// 2) Anthropic Messages API with structured JSON output. Returns verdict or null.
async function judgeViaApi(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        max_tokens: 1024,
        // Structured outputs: constrain the response to the verdict schema so we
        // always get parseable JSON back (canonical output_config.format form).
        output_config: { format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = (data.content || []).map((b) => b.text || '').join('');
    return extractJson(text);
  } catch {
    return null;
  }
}

// Public: grade a run. Returns { ok, checks, reasons, via } — via ∈ cli|api|none.
// via==='none' means neither judge was available → NOT a pass; caller decides.
export async function judgeRun({ rubric, transcript, sessionLog, metrics }) {
  const prompt = buildPrompt({ rubric, transcript, sessionLog, metrics });

  const cli = await judgeViaCli(prompt);
  if (cli && typeof cli.ok === 'boolean') return { ...cli, via: 'cli' };

  const api = await judgeViaApi(prompt);
  if (api && typeof api.ok === 'boolean') return { ...api, via: 'api' };

  return {
    ok: false,
    reasons: 'No judge available (claude CLI failed and no ANTHROPIC_API_KEY) — manual review required.',
    checks: {},
    via: 'none',
  };
}
