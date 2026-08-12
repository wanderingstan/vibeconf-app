// agent-transcript-usage.test.mjs — the per-turn token-usage feed behind the
// `📊 [context]` session-log marker (#345). Verifies: entryUsage reads the full
// prompt size (fresh + cache reads + cache writes) off an assistant entry,
// multi-entry API turns (same message id) emit once, and both transports —
// TranscriptTailer and StreamActivitySource — dedupe identically.
//
// Run: node --test tests/agent-transcript-usage.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entryUsage, TranscriptTailer } from '../electron-app/agent-transcript.js';
import { StreamActivitySource } from '../electron-app/agent-activity.js';

function usageEntry(msgId, usage, { model = 'claude-opus-5', text = 'hi' } = {}) {
  return JSON.stringify({
    type: 'assistant',
    message: { id: msgId, model, usage, content: [{ type: 'text', text }] },
  });
}

const USAGE_A = { input_tokens: 3, cache_read_input_tokens: 46000, cache_creation_input_tokens: 120, output_tokens: 40 };
const USAGE_B = { input_tokens: 5, cache_read_input_tokens: 46120, cache_creation_input_tokens: 90, output_tokens: 22 };

test('entryUsage: input is the full prompt — fresh + cache reads + cache writes', () => {
  const u = entryUsage(JSON.parse(usageEntry('msg_1', USAGE_A)));
  assert.equal(u.input, 3 + 46000 + 120);
  assert.equal(u.fresh, 3);
  assert.equal(u.cacheRead, 46000);
  assert.equal(u.cacheCreate, 120);
  assert.equal(u.output, 40);
  assert.equal(u.msgId, 'msg_1');
});

test('entryUsage: null for user entries, <synthetic> turns, and usage-less entries', () => {
  assert.equal(entryUsage({ type: 'user', message: { content: 'hello' } }), null);
  assert.equal(entryUsage(JSON.parse(usageEntry('msg_1', USAGE_A, { model: '<synthetic>' }))), null);
  assert.equal(entryUsage({ type: 'assistant', message: { id: 'm', model: 'claude-opus-5', content: [] } }), null);
});

test('TranscriptTailer: one onUsage per API turn, not per JSONL entry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-usage-test-'));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, ''); // seed replays history and must NOT emit usage

  const seen = [];
  const tailer = new TranscriptTailer({ onUsage: (u) => seen.push(u) });
  tailer.bind(path, 'sess-1');

  // One API turn spans two JSONL entries (text block + tool_use block) sharing
  // a message id and identical usage — the marker must fire once.
  appendFileSync(path, usageEntry('msg_1', USAGE_A, { text: 'thinking aloud' }) + '\n');
  appendFileSync(path, usageEntry('msg_1', USAGE_A, { text: 'same turn, second block' }) + '\n');
  tailer._pump();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].input, 46123);

  appendFileSync(path, usageEntry('msg_2', USAGE_B) + '\n');
  tailer._pump();
  assert.equal(seen.length, 2);
  assert.equal(seen[1].input, 5 + 46120 + 90);

  tailer.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('TranscriptTailer: seeding an existing transcript does not replay usage history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-usage-test-'));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, [usageEntry('msg_1', USAGE_A), usageEntry('msg_2', USAGE_B)].join('\n') + '\n');

  const seen = [];
  const tailer = new TranscriptTailer({ onUsage: (u) => seen.push(u) });
  tailer.bind(path, 'sess-1');
  assert.deepEqual(seen, [], 'seed is history, not live turns');

  appendFileSync(path, usageEntry('msg_3', USAGE_B) + '\n');
  tailer._pump();
  assert.equal(seen.length, 1, 'live turns after the seed still emit');

  tailer.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('StreamActivitySource: same per-turn dedupe on the stream transport', () => {
  const seen = [];
  const src = new StreamActivitySource({ onUsage: (u) => seen.push(u) });
  src.bind();
  src.push(usageEntry('msg_1', USAGE_A) + '\n' + usageEntry('msg_1', USAGE_A) + '\n');
  src.push(usageEntry('msg_2', USAGE_B) + '\n');
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map((u) => u.msgId), ['msg_1', 'msg_2']);
});
