// claude-model.test.mjs — the `--model` flag for the launched Claude session.
//
// Two jobs. The boring one: blank now means `sonnet` rather than "pass no flag and
// let the CLI decide", because an implicit default that shifts under us is worse
// than an explicit one.
//
// The one that actually matters: this value is interpolated into a shell command
// that is itself inside an AppleScript string —
//
//     do script "claude --model <X> --mcp-config … \"/join-call abc\""
//
// Quoting is already two layers deep. So the value is sanitized down to the
// characters an alias or a model id can contain, and anything that sanitizes away
// to nothing falls back to the default rather than silently dropping the flag: an
// unexpected model is a much smaller surprise than an unexpected shell.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { DEFAULT_CLAUDE_MODEL, resolveClaudeModel, claudeModelFlag } = require('../electron-app/claude-model.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the default is sonnet', () => {
  assert.equal(DEFAULT_CLAUDE_MODEL, 'sonnet');
});

test('blank / unset resolves to the default — this is the change', () => {
  for (const empty of ['', '   ', null, undefined]) {
    assert.equal(resolveClaudeModel(empty), 'sonnet', `${JSON.stringify(empty)} → sonnet`);
  }
});

test('an explicit choice always wins over the default', () => {
  assert.equal(resolveClaudeModel('opus'), 'opus');
  assert.equal(resolveClaudeModel('haiku'), 'haiku');
  assert.equal(resolveClaudeModel('  opus  '), 'opus', 'surrounding whitespace is not a choice');
});

test('full model ids survive intact', () => {
  for (const id of ['claude-sonnet-4-5-20250929', 'claude-opus-4-8', 'claude-haiku-4-5-20251001']) {
    assert.equal(resolveClaudeModel(id), id);
  }
  assert.equal(resolveClaudeModel('some.model_id-1.2'), 'some.model_id-1.2', 'dots and underscores are legal');
});

test('shell metacharacters are stripped, not escaped', () => {
  // The command is `do script "claude --model <X> …"` — a quote or a $( ) here is
  // an injection, not a typo.
  assert.equal(resolveClaudeModel('opus; rm -rf /'), 'opusrm-rf');
  assert.equal(resolveClaudeModel('$(whoami)'), 'whoami');
  assert.equal(resolveClaudeModel('opus"'), 'opus');
  assert.equal(resolveClaudeModel('`id`'), 'id');
  assert.equal(resolveClaudeModel('a b'), 'ab', 'no spaces survive — a space would split the arg');
});

test('a value that sanitizes to nothing falls back to the default, never to an empty flag', () => {
  // `--model ''` or a bare `--model` followed by the next flag would be worse than
  // simply using sonnet.
  for (const hostile of ['"', '$( )', ';;;', '!!!', '   ;   ']) {
    const got = resolveClaudeModel(hostile);
    assert.equal(got, 'sonnet', `${JSON.stringify(hostile)} → sonnet, got ${JSON.stringify(got)}`);
  }
});

test('the flag is always emitted, and is a single safe argument', () => {
  assert.equal(claudeModelFlag(''), ' --model sonnet');
  assert.equal(claudeModelFlag('opus'), ' --model opus');
  assert.equal(claudeModelFlag('$(id)'), ' --model id');
  // Exactly one leading space, one flag, one value, no shell-significant chars.
  for (const raw of ['', 'opus', 'claude-sonnet-4-5-20250929', '"; echo pwned; #']) {
    const flag = claudeModelFlag(raw);
    assert.match(flag, /^ --model [A-Za-z0-9._-]+$/, `unsafe flag for ${JSON.stringify(raw)}: ${flag}`);
  }
});

test('main.js uses the helper and no longer builds the flag conditionally', () => {
  const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
  assert.match(main, /const \{ claudeModelFlag \} = require\('\.\/claude-model\.js'\);/);
  assert.match(main, /const modelFlag = claudeModelFlag\(store\.get\('claudeModel'\)\);/);
  // The old form silently dropped the flag when the setting was blank.
  assert.doesNotMatch(main, /const modelFlag = claudeModel \? ` --model/);
});

test('the panel no longer tells the user that blank means Claude’s default', () => {
  const html = readFileSync(join(root, 'electron-app/renderer/panel.html'), 'utf8');
  assert.doesNotMatch(html, /Blank = Claude's default/);
  assert.match(html, /Blank = <code>sonnet<\/code>/);
  assert.match(html, /placeholder="sonnet"/, 'the placeholder now states a fact, not a hint');
});
