// agent-hook-fable-warning.test.mjs — the AGENT_HOOK_CONTENT script (main.js)
// warns in-terminal when a bot joins a call on Fable, via a systemMessage in
// its PostToolUse stdout. Runs the ACTUAL extracted hook script as a child
// process rather than unit-testing pieces of it in-process: the bug this
// caught during development only showed up under real execution —
// process.exit() truncated the systemMessage write because it raced ahead of
// the pipe flush, so an in-process/mocked test would have passed while the
// real hook silently swallowed every warning.
//
// Run: node --test tests/agent-hook-fable-warning.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mainJsPath = join(__dirname, '..', 'electron-app', 'main.js');

// Extract AGENT_HOOK_CONTENT the same way it's written to disk in production
// (ensureAgentActivityHook): parse the source, `eval` just the template
// literal (no ${...} interpolation lives in it — see main.js), write it out.
function extractHookScript() {
  const src = readFileSync(mainJsPath, 'utf-8');
  const m = src.match(/const AGENT_HOOK_CONTENT = (`[\s\S]*?`);/);
  assert.ok(m, 'AGENT_HOOK_CONTENT template literal not found in main.js — did it move or get renamed?');
  // eslint-disable-next-line no-eval
  return eval(m[1]);
}

function assistantJoinCallEntry(model) {
  return JSON.stringify({
    type: 'assistant',
    message: { model, content: [{ type: 'tool_use', name: 'mcp__vibeconferencing__join_call', input: {} }] },
  });
}

function runHook(hookPath, input) {
  // No local server listening on the fallback port in a test environment —
  // the hook's own error handling must swallow that and still exit 0.
  return execFileSync('node', [hookPath], { input: JSON.stringify(input), timeout: 3000 }).toString();
}

test('AGENT_HOOK_CONTENT: warns once on join_call when the model is Fable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hook-test-'));
  const hookPath = join(dir, 'hook.cjs');
  const transcriptPath = join(dir, 'transcript.jsonl');
  writeFileSync(hookPath, extractHookScript());
  writeFileSync(transcriptPath, assistantJoinCallEntry('claude-fable-5') + '\n');

  const out = runHook(hookPath, { transcript_path: transcriptPath, session_id: 's1', tool_name: 'mcp__vibeconferencing__join_call' });
  const parsed = JSON.parse(out);
  assert.match(parsed.systemMessage, /fable/i);
  assert.match(parsed.systemMessage, /Sonnet\/Opus/);

  rmSync(dir, { recursive: true, force: true });
});

test('AGENT_HOOK_CONTENT: silent on join_call when the model is Sonnet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hook-test-'));
  const hookPath = join(dir, 'hook.cjs');
  const transcriptPath = join(dir, 'transcript.jsonl');
  writeFileSync(hookPath, extractHookScript());
  writeFileSync(transcriptPath, assistantJoinCallEntry('claude-sonnet-5') + '\n');

  const out = runHook(hookPath, { transcript_path: transcriptPath, session_id: 's2', tool_name: 'mcp__vibeconferencing__join_call' });
  assert.equal(out, '', 'a non-Fable join should produce no stdout at all');

  rmSync(dir, { recursive: true, force: true });
});

test('AGENT_HOOK_CONTENT: silent on a Fable session for non-join_call tools', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hook-test-'));
  const hookPath = join(dir, 'hook.cjs');
  const transcriptPath = join(dir, 'transcript.jsonl');
  writeFileSync(hookPath, extractHookScript());
  writeFileSync(transcriptPath, assistantJoinCallEntry('claude-fable-5') + '\n');

  const out = runHook(hookPath, { transcript_path: transcriptPath, session_id: 's3', tool_name: 'mcp__vibeconferencing__speak' });
  assert.equal(out, '', 'the warning is scoped to the join_call moment, not every tool call');

  rmSync(dir, { recursive: true, force: true });
});

test('AGENT_HOOK_CONTENT: never crashes on malformed stdin, a missing transcript, or a missing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hook-test-'));
  const hookPath = join(dir, 'hook.cjs');
  writeFileSync(hookPath, extractHookScript());

  assert.doesNotThrow(() => execFileSync('node', [hookPath], { input: 'not json at all', timeout: 3000 }));
  assert.doesNotThrow(() => execFileSync('node', [hookPath], {
    input: JSON.stringify({ tool_name: 'mcp__vibeconferencing__join_call' }), timeout: 3000,
  }));
  assert.doesNotThrow(() => execFileSync('node', [hookPath], {
    input: JSON.stringify({ transcript_path: join(dir, 'does-not-exist.jsonl'), tool_name: 'mcp__vibeconferencing__join_call' }),
    timeout: 3000,
  }));

  rmSync(dir, { recursive: true, force: true });
});
