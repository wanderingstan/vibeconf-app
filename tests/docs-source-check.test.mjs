// docs-source-check.test.mjs — source annotation checker tests.
// Run: node --test tests/docs-source-check.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkDocs, renderResults } from '../scripts/docs-source-check.mjs';

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeconf-doc-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }
  return root;
}

test('passes when a source regex matches the named file', (t) => {
  const repoRoot = fixture(t, {
    'README.md': '',
    'docs/install.md': '<!-- source: src/app.js /const DEFAULT_PORT = 7865;/ -->\nThe default port is 7865.\n',
    'src/app.js': 'const DEFAULT_PORT = 7865;\n',
  });

  const result = checkDocs({ repoRoot });
  assert.equal(result.checked, 1);
  assert.equal(result.pass, 1);
  assert.equal(result.fail, 0);
  assert.equal(result.checks[0].status, 'pass');
});

test('fails when a source regex matches nothing', (t) => {
  const repoRoot = fixture(t, {
    'README.md': '<!-- source: src/app.js /DEFAULT_PORT = 9999/ -->\nThe default port is 9999.\n',
    'src/app.js': 'const DEFAULT_PORT = 7865;\n',
  });

  const result = checkDocs({ repoRoot });
  assert.equal(result.fail, 1);
  assert.match(result.checks[0].message, /regex did not match/);
});

test('fails when the named source file is missing', (t) => {
  const repoRoot = fixture(t, {
    'README.md': '<!-- source: src/missing.js /anything/ -->\nA claim.\n',
  });

  const result = checkDocs({ repoRoot });
  assert.equal(result.fail, 1);
  assert.match(result.checks[0].message, /source file not found/);
});

test('counts explicit unverified markers without checking them', (t) => {
  const repoRoot = fixture(t, {
    'README.md': '<!-- unverified -->\nA claim that cannot be code-backed yet.\n',
  });

  const result = checkDocs({ repoRoot });
  assert.equal(result.checked, 0);
  assert.equal(result.unverified, 1);
  assert.equal(result.fail, 0);
});

test('reports a malformed annotation as FAIL without throwing', (t) => {
  const repoRoot = fixture(t, {
    'README.md': '<!-- source: src/app.js missing-regex-delimiters -->\nA claim.\n',
    'src/app.js': 'const ok = true;\n',
  });

  const result = checkDocs({ repoRoot });
  assert.equal(result.checked, 1);
  assert.equal(result.fail, 1);
  assert.match(result.checks[0].message, /malformed source annotation/);
  assert.match(renderResults(result), /^FAIL README\.md:1/m);
});

test('report mode lists annotated and unannotated doc files', (t) => {
  const repoRoot = fixture(t, {
    'README.md': '',
    'docs/install.md': '<!-- source: src/app.js /const ok = true/ -->\nA claim.\n',
    'docs/quiet.md': 'No annotations here.\n',
    'src/app.js': 'const ok = true;\n',
  });

  const output = renderResults(checkDocs({ repoRoot }), { report: true });
  assert.match(output, /README\.md: 0 annotations \(0 source, 0 unverified\)/);
  assert.match(output, /docs\/install\.md: 1 annotation \(1 source, 0 unverified\)/);
  assert.match(output, /docs\/quiet\.md: 0 annotations \(0 source, 0 unverified\)/);
});

test('CLI exits 1 when a source regex does not match', (t) => {
  const repoRoot = fixture(t, {
    'README.md': '',
    'docs/broken.md': '<!-- source: src/app.js /never-matches/ -->\nA claim.\n',
    'src/app.js': 'const ok = true;\n',
  });
  const scriptsDir = path.join(repoRoot, 'scripts');
  const scriptPath = path.join(scriptsDir, 'docs-source-check.mjs');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.copyFileSync(
    fileURLToPath(new URL('../scripts/docs-source-check.mjs', import.meta.url)),
    scriptPath,
  );

  const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^FAIL docs\/broken\.md:1/m);
  assert.match(result.stdout, /Summary: 1 annotations checked, 0 pass, 1 fail/);
});
