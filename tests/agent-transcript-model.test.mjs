// agent-transcript-model.test.mjs — the TranscriptTailer's onModel callback,
// which drives the `[agent] model=` session-log marker latency-audit.py groups
// cycles by. Verifies: fires once per distinct model, skips '<synthetic>'
// (Claude Code's own compaction turns, not the bot replying), and survives a
// seed + live-pump split without double-firing on the same value.
//
// Run: node --test tests/agent-transcript-model.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entryModel, TranscriptTailer } from '../electron-app/agent-transcript.js';

function assistantEntry(model, text = 'hi') {
  return JSON.stringify({ type: 'assistant', message: { model, content: [{ type: 'text', text }] } });
}

test('entryModel: reads the model off an assistant entry', () => {
  assert.equal(entryModel(JSON.parse(assistantEntry('claude-opus-4-8'))), 'claude-opus-4-8');
});

test('entryModel: ignores <synthetic> entries (compaction turns, not a real reply)', () => {
  assert.equal(entryModel(JSON.parse(assistantEntry('<synthetic>'))), null);
});

test('entryModel: ignores user entries', () => {
  const entry = { type: 'user', message: { content: 'hello' } };
  assert.equal(entryModel(entry), null);
});

test('TranscriptTailer: onModel fires once per distinct model, not per line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-transcript-test-'));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, [assistantEntry('claude-sonnet-5', 'first'), assistantEntry('claude-sonnet-5', 'second')].join('\n') + '\n');

  const seen = [];
  const tailer = new TranscriptTailer({ onModel: (m) => seen.push(m) });
  tailer.bind(path, 'sess-1');
  assert.deepEqual(seen, ['claude-sonnet-5']);

  appendFileSync(path, assistantEntry('claude-sonnet-5', 'third') + '\n');
  tailer._pump();
  assert.deepEqual(seen, ['claude-sonnet-5'], 'same model again should not re-fire');

  appendFileSync(path, assistantEntry('claude-opus-4-8', 'switched') + '\n');
  tailer._pump();
  assert.deepEqual(seen, ['claude-sonnet-5', 'claude-opus-4-8']);

  tailer.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('TranscriptTailer: <synthetic> entries never trigger onModel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-transcript-test-'));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, assistantEntry('<synthetic>', 'compacted summary') + '\n');

  const seen = [];
  const tailer = new TranscriptTailer({ onModel: (m) => seen.push(m) });
  tailer.bind(path, 'sess-1');
  assert.deepEqual(seen, []);

  tailer.stop();
  rmSync(dir, { recursive: true, force: true });
});
