// agent-activity.test.mjs — one activity stream, whatever produced it (#242).
//
// Two transports that will never converge: a human's own Claude session (we do
// not own the process, so we tail the transcript) and an app-launched agent (we
// own it, so it hands us its events). Everything above — the brain pane, the
// 🤔→🧑‍💻 escalation, the debug overlay — must not be able to tell which is
// behind it.
//
// The reason this exists rather than "just tail the file": that file is Claude
// Code's implementation detail. App-launched agents wrote transcripts on Jul 28,
// wrote them unreliably by Jul 30, and by Aug 4 stopped entirely — a session ran
// 3½ minutes, spoke 22 times, and its named transcript was never created.
// Everything downstream died silently.
//
// Run: node --test tests/agent-activity.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentActivitySource, TranscriptActivitySource, StreamActivitySource } =
  require('../electron-app/agent-activity.js');

const collect = () => {
  const state = { lines: [], models: [] };
  const src = new StreamActivitySource({
    onLines: (l) => { state.lines = l; },
    onModel: (m) => { state.models.push(m); },
  });
  src.bind();
  return { src, state };
};

const frame = (o) => JSON.stringify(o) + '\n';

test('both transports satisfy the same contract', () => {
  for (const Cls of [TranscriptActivitySource, StreamActivitySource]) {
    const s = new Cls({});
    assert.ok(s instanceof AgentActivitySource, `${Cls.name} must be a source`);
    assert.equal(typeof s.bind, 'function');
    assert.equal(typeof s.stop, 'function');
    assert.ok(s.kind, 'each source names itself, so a log can say which is live');
  }
  assert.notEqual(new TranscriptActivitySource({}).kind, new StreamActivitySource({}).kind);
});

test('stream events produce the SAME display lines as a transcript would', () => {
  // The two formats agree — stream-json emits {type:'assistant', message:{content:[…]}},
  // the same shape the transcript stores — so there is one normaliser, not two
  // parsers to keep in step. That equivalence is the whole basis of the design.
  const { src, state } = collect();
  src.push(frame({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__vibeconferencing__get_room_info', input: {} }] } }));
  src.push(frame({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello there' }] } }));
  assert.deepEqual(state.lines, ['🔧 get_room_info', '🗣 Hello there']);
});

test('a chunk split mid-JSON loses nothing', () => {
  // stdout arrives in arbitrary chunks. A dropped boundary would silently lose
  // whole tool calls rather than erroring, which is the failure mode this whole
  // issue is about.
  const { src, state } = collect();
  const text = frame({ type: 'assistant', message: { content: [{ type: 'text', text: 'split me' }] } });
  const cut = Math.floor(text.length * 0.6);
  src.push(text.slice(0, cut));
  assert.deepEqual(state.lines, [], 'nothing emitted until the line completes');
  src.push(text.slice(cut));
  assert.deepEqual(state.lines, ['🗣 split me']);
});

test('non-event frames are ignored without a second list of types', () => {
  // stream-json carries system/hook/result frames. Filtering is formatEntry's
  // job — a type list here would drift from it the first time either changes.
  const { src, state } = collect();
  src.push(frame({ type: 'system', subtype: 'init', session_id: 'x' }));
  src.push(frame({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart' }));
  src.push('not json at all\n');
  assert.deepEqual(state.lines, [], 'none of that is agent activity');
});

test('the model is reported once, not per frame', () => {
  const { src, state } = collect();
  const say = (text) => frame({ type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text }] } });
  src.push(say('one'));
  src.push(say('two'));
  assert.deepEqual(state.models, ['claude-opus-5'], 'a repeat is not a change');
});

test('the buffer is bounded', () => {
  // A long call would otherwise grow this without limit, and it is serialised
  // into every get-call-state response.
  const { MAX_LINES } = require('../electron-app/agent-transcript.js');
  const { src, state } = collect();
  for (let i = 0; i < MAX_LINES + 50; i++) {
    src.push(frame({ type: 'assistant', message: { content: [{ type: 'text', text: `line ${i}` }] } }));
  }
  assert.equal(state.lines.length, MAX_LINES);
  assert.match(state.lines[state.lines.length - 1], /line \d+$/, 'the NEWEST lines are kept');
});

test('local-server consumes the interface, not a concrete tailer', () => {
  const src = readFileSyncSafe('electron-app/local-server.js');
  assert.match(src, /this\._agentSource = new TranscriptActivitySource/);
  assert.doesNotMatch(src, /new TranscriptTailer\(/, 'nothing above should name a transport');
  // And switching transports replaces rather than adds: two live sources would
  // interleave two agents into one buffer, which is worse than either alone.
  assert.match(src, /useStreamAgentSource\(\)/);
  const fn = src.slice(src.indexOf('useStreamAgentSource()'));
  assert.match(fn.slice(0, 600), /this\._agentSource\.stop\(\)/, 'the old source must be stopped');
});

function readFileSyncSafe(rel) {
  const { readFileSync } = require('node:fs');
  const { join, dirname } = require('node:path');
  const { fileURLToPath } = require('node:url');
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8');
}

test("an app-launched agent's own hook must not wipe its own feed", () => {
  // The realistic two-source case, and the one that would have bitten
  // immediately: a headlessly-spawned agent fires the PostToolUse hook ITSELF —
  // it makes mcp__vibeconferencing__ calls, which is exactly what the hook
  // matches. That POST lands in setAgentSession with a transcript path, and
  // StreamActivitySource.bind() resets. Without a guard the feed would clear
  // itself one tool call in and then stay empty, which looks exactly like an
  // agent doing nothing.
  require('../electron-app/local-server.js');
  const LocalServer = globalThis.LocalServer;
  const s = new LocalServer({ port: 0 });

  assert.equal(s._agentSource.kind, 'transcript', 'default transport is unchanged');
  const stream = s.useStreamAgentSource();
  assert.equal(s._agentSource.kind, 'stream');

  stream.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }) + '\n');
  assert.deepEqual(s.agentLog, ['🗣 working']);

  s.setAgentSession({ sessionId: 'x', transcriptPath: '/tmp/whatever.jsonl' });
  assert.deepEqual(s.agentLog, ['🗣 working'], 'the hook must not clear a stream feed');
  assert.equal(s._agentSource.kind, 'stream', 'and must not displace the transport we own');
});

test('a transcript bind still works when no stream source is live', () => {
  // The guard must not break the path that serves real users today.
  require('../electron-app/local-server.js');
  const LocalServer = globalThis.LocalServer;
  const s = new LocalServer({ port: 0 });
  s.setAgentSession({ sessionId: 'y', transcriptPath: '/tmp/nope.jsonl' });
  assert.equal(s._agentSource.kind, 'transcript');
  assert.equal(s._agentSource.path, '/tmp/nope.jsonl', 'the tail must actually be bound');
});

test('thinking blocks are formatted when non-empty, skipped when empty', () => {
  // MEASURED 2026-08-04 against CLI 2.1.219: every thinking block the CLI emits
  // has `signature` set and `thinking` EMPTY — 1,159 of them in a single
  // session's transcript, zero characters between them. Identical through the
  // stream transport, with and without --include-partial-messages, and
  // --thinking-display accepts only summarized|omitted.
  //
  // So the empty case is not a defensive edge — it is TODAY'S ONLY CASE, and
  // without the guard the pane fills with blank 💭 lines. The non-empty case is
  // asserted so the day the CLI starts populating it, it just works.
  const { formatEntry } = require('../electron-app/agent-transcript.js');
  const think = (t) => formatEntry({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: t, signature: 'abc' }] } });
  assert.deepEqual(think(''), [], "today's shape must produce nothing");
  assert.deepEqual(think('   '), []);
  assert.deepEqual(think('weighing two options'), ['💭 weighing two options']);
});

test('reasoning reaches BOTH transports through the one normaliser', () => {
  // The payoff of a shared formatEntry: handling thinking once covers the
  // tailed transcript and the live stream, with no second parser to keep in step.
  const { src, state } = collect();
  src.push(frame({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm', signature: 's' }] } }));
  assert.deepEqual(state.lines, ['💭 hmm']);
});

test('a DEAD stream agent releases the feed so the next session can bind', () => {
  // The 2026-08-10 Seth call: the app-spawned agent's brief join exited, Stan
  // drove the real call from a terminal, and the dead stream source kept
  // winning setAgentSession's guard — model/context markers went dark for the
  // rest of the call, silently (the guard's one-time notice had already
  // fired). main's onExit now calls releaseStreamAgentSource(), which must
  // hand the transport back to the transcript tail.
  require('../electron-app/local-server.js');
  const LocalServer = globalThis.LocalServer;
  const s = new LocalServer({ port: 0 });

  s.useStreamAgentSource();
  assert.equal(s._agentSource.kind, 'stream');

  s.releaseStreamAgentSource();
  assert.equal(s._agentSource.kind, 'transcript', 'exit hands the feed back to the tail');

  // And the next driving session's transcript bind must actually take.
  const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'agent-activity-release-'));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, '');
  s.setAgentSession({ sessionId: 'next', transcriptPath: path });
  assert.equal(s._agentSource.kind, 'transcript');
  assert.equal(s._agentSource.path, path, 'the terminal session binds where the dead stream used to squat');

  // Idempotent: releasing when the tail already owns the feed is a no-op.
  s.releaseStreamAgentSource();
  assert.equal(s._agentSource.path, path, 'release without a stream source must not rebuild the tail');

  s._agentSource.stop();
  rmSync(dir, { recursive: true, force: true });
});
