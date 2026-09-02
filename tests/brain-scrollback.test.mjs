// brain-scrollback.test.mjs — the 🧠 window keeps a real history (#532).
//
// The bug this pins down: there was ONE constant, `MAX_LINES = 16`, and its own
// comment said what it had been sized for — "fills the side column next to the
// stats", i.e. the narrow strip drawn onto the bot's virtual camera. The brain
// window (#242) then reused the same buffer on purpose, which was the right call
// (a surface over an existing signal, not a second pipeline) — and silently
// inherited a depth chosen for a video tile, applied to a full-height scrollable
// window. Scrollback was 16 lines because nothing had kept a 17th.
//
// Two halves, and the second one is the half that is easy to forget:
//
//   1. Keep more (BUFFER_MAX_LINES), and let each consumer slice what it can
//      draw. Trimming at the SOURCE is what caused the bug.
//   2. Seed more. `_seed` only ever read the last SEED_TAIL_BYTES of the file,
//      and a Claude Code transcript costs ~7.7 KB per displayed line (measured
//      2026-09-02 across 58.7 MB of real local transcripts — the bulk is
//      tool_result payloads, which formatEntry drops). At the old 64 KB that is
//      about EIGHT lines. Deepening the buffer alone would have left the window
//      just as empty on attach, with the history sitting complete on disk.
//
// Run: node --test tests/brain-scrollback.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TranscriptTailer, BUFFER_MAX_LINES, OVERLAY_MAX_LINES } from '../electron-app/agent-transcript.js';
import { StreamActivitySource } from '../electron-app/agent-activity.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const transcriptJs = readFileSync(join(root, 'electron-app/agent-transcript.js'), 'utf8');
const pageInject = readFileSync(join(root, 'electron-app/page-inject.js'), 'utf8');
const panelJs = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');

const sayEntry = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

test('the two depths are separate, and the deep one is the buffer', () => {
  // The whole fix is that these are two numbers. If they ever collapse back into
  // one, whichever consumer did not choose it gets the other's constraint —
  // which is precisely #532.
  assert.notEqual(BUFFER_MAX_LINES, OVERLAY_MAX_LINES);
  assert.equal(OVERLAY_MAX_LINES, 16, 'the camera strip was always right at 16');
  assert.ok(BUFFER_MAX_LINES >= 1000, 'the window is for scrolling back through a call');
  // And the ambiguous name is gone rather than reassigned: `MAX_LINES` read as
  // "the limit" from either side, which is how one surface came to govern the
  // other in the first place.
  assert.doesNotMatch(transcriptJs, /^const MAX_LINES/m);
  assert.doesNotMatch(transcriptJs, /exports = \{[^}]*[ ,]MAX_LINES/, 'nothing can import the ambiguous name');
});

test('a long session keeps far more than the camera strip shows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-scrollback-'));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, '');
  try {
    const tailer = new TranscriptTailer({});
    tailer.bind(path, 'sess-1');
    for (let i = 0; i < 400; i++) appendFileSync(path, sayEntry(`line ${i}`) + '\n');
    tailer._pump();
    tailer.stop();
    // 400 is the shape of the bug: comfortably past the old cap, comfortably
    // inside the new one, so a regression to ANY 16-ish depth fails here.
    assert.equal(tailer.getLines().length, 400);
    assert.match(tailer.getLines()[0], /line 0$/, 'and the OLDEST line is still there to scroll back to');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('attaching mid-session recovers history that is already on disk', async () => {
  // The seed path is the one a real user hits: the app attaches when the driving
  // session first reports its transcript, which is after the agent has been
  // working for a while. "I opened the brain window and it was nearly empty" was
  // this, not a slow agent.
  const dir = mkdtempSync(join(tmpdir(), 'brain-seed-'));
  const path = join(dir, 'transcript.jsonl');
  // Padded to a realistic size: tool_result payloads are ~all of a transcript's
  // bytes and none of its display lines, so a seed window measured in bytes has
  // to be generous. 2 KB per entry is still an order of magnitude leaner than
  // the real thing.
  const pad = 'x'.repeat(2048);
  writeFileSync(path, Array.from({ length: 300 }, (_, i) =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `line ${i}` }] }, toolResultPad: pad })
  ).join('\n') + '\n');
  try {
    const tailer = new TranscriptTailer({});
    tailer.bind(path, 'sess-1'); // bind() seeds
    tailer.stop();
    assert.equal(tailer.getLines().length, 300, 'the whole history, not the last few KB of it');
    assert.match(tailer.getLines()[0], /line 0$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the seed window is wide enough to actually fill the buffer', () => {
  // Guards the half that is invisible until someone attaches to a real session:
  // a 1000-line buffer fed by a 64 KB read is still a nearly-empty window. At the
  // measured ~7.7 KB per display line, filling BUFFER_MAX_LINES needs megabytes.
  const m = transcriptJs.match(/const SEED_TAIL_BYTES = ([^;]+);/);
  assert.ok(m, 'SEED_TAIL_BYTES must still exist');
  // eslint-disable-next-line no-eval
  const bytes = eval(m[1]);
  const BYTES_PER_DISPLAY_LINE = 7700; // measured 2026-09-02, 12 real transcripts
  assert.ok(bytes >= BUFFER_MAX_LINES * BYTES_PER_DISPLAY_LINE * 0.9,
    `seed window ${bytes} B cannot fill ${BUFFER_MAX_LINES} lines at ~${BYTES_PER_DISPLAY_LINE} B/line`);
});

test('both transports keep the same depth', () => {
  // The brain window must not have less history when the app launched the agent
  // itself. Making the source invisible upstream is the entire point of
  // agent-activity.js, and a per-transport buffer depth is exactly the kind of
  // difference that leaks through it.
  let lines = [];
  const src = new StreamActivitySource({ onLines: (l) => { lines = l; } });
  src.bind();
  for (let i = 0; i < BUFFER_MAX_LINES + 25; i++) src.push(sayEntry(`line ${i}`) + '\n');
  assert.equal(lines.length, BUFFER_MAX_LINES, 'still bounded — this is serialised into every get-call-state');
  assert.match(lines[lines.length - 1], /line \d+$/, 'and it is the NEWEST lines that survive');
});

test('the camera overlay slices its own tail rather than shrinking the buffer', () => {
  // page-inject runs in Meet's page context and cannot import the constant, so
  // this pins its copy to the real one. A drifted copy is silent: the overlay
  // just quietly draws the wrong number of lines onto a live call.
  const m = pageInject.match(/const OVERLAY_LINES = (\d+);/);
  assert.ok(m, 'the overlay must name its own depth');
  assert.equal(Number(m[1]), OVERLAY_MAX_LINES);
  assert.match(pageInject, /const log = \(d\.agentLog \|\| \[\]\)\.slice\(-OVERLAY_LINES\);/,
    'sliced at draw time, off the shared buffer');
});

test('the troubleshooting dump also takes a tail, not the whole buffer', () => {
  // A third consumer that had also silently inherited the 16. It is one section
  // of a flat <pre> of call state; a thousand agent lines pasted into the middle
  // would bury everything else the screen exists to show.
  const fn = panelJs.slice(panelJs.indexOf('function agentActivityLines'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /slice\(-TROUBLESHOOTING_AGENT_LINES\)/);
  // The COUNT stays the full buffer's — it is how you confirm the fix without
  // counting lines by eye.
  assert.match(body, /\$\{log\.length\}/);
});
