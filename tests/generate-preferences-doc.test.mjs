import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  BEGIN_MARKER,
  END_MARKER,
  generateDocument,
} from '../scripts/generate-preferences-doc.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/generate-preferences-doc.mjs');

function runGenerator(outputPath, ...args) {
  return spawnSync(process.execPath, [script, '--output', outputPath, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function withTempDoc(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-preferences-doc-'));
  const outputPath = path.join(tempDir, 'preferences.md');
  try {
    return run(outputPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('the generator emits every schema preference', () => {
  const generated = generateDocument();
  const entries = generated.match(/^### `[^`]+`$/gm) || [];
  assert.ok(entries.length > 50, `expected more than 50 preferences, got ${entries.length}`);
  assert.equal(new Set(entries).size, entries.length, 'preference headings must be unique');
  assert.ok(generated.includes(BEGIN_MARKER));
  assert.ok(generated.includes(END_MARKER));
});

test('--check passes on fresh output and fails after tampering', () => withTempDoc((outputPath) => {
  const generated = runGenerator(outputPath);
  assert.equal(generated.status, 0, generated.stderr);

  const fresh = runGenerator(outputPath, '--check');
  assert.equal(fresh.status, 0, fresh.stderr);

  const original = fs.readFileSync(outputPath, 'utf8');
  fs.writeFileSync(outputPath, original.replace('| Type |', '| Type | tampered'));
  const stale = runGenerator(outputPath, '--check');
  assert.equal(stale.status, 1, 'tampered output should fail --check');
  assert.match(stale.stderr, /preferences\.md is stale/);
  assert.match(stale.stderr, /^--- .+preferences\.md$/m);
  assert.match(stale.stderr, /^\+\+\+ .+preferences\.md \(generated\)$/m);
}));

test('the hand-editable preamble survives regeneration', () => withTempDoc((outputPath) => {
  assert.equal(runGenerator(outputPath).status, 0);
  const first = fs.readFileSync(outputPath, 'utf8');
  const generatedSection = first.slice(first.indexOf(BEGIN_MARKER));
  const customPreamble = '# Preferences\n\nCustom hand-edited guidance.';
  fs.writeFileSync(outputPath, `${customPreamble}\n\n${generatedSection}`);

  const regenerated = runGenerator(outputPath);
  assert.equal(regenerated.status, 0, regenerated.stderr);
  const result = fs.readFileSync(outputPath, 'utf8');
  assert.equal(result.slice(0, result.indexOf(BEGIN_MARKER)).trimEnd(), customPreamble);
  assert.equal(result.slice(result.indexOf(BEGIN_MARKER)), generatedSection);
}));
