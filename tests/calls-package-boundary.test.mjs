// calls-package-boundary.test.mjs: Phase 3 of the calls library. The calling
// layer lives in packages/calls (@vibeconferencing/calls) and the app depends
// on it. These pin the package's two rules: it never reaches into the app, and
// only hosts/electron requires Electron (a Playwright host comes next).
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = join(root, 'packages', 'calls');

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === 'vendor' || f === 'node_modules') return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const sources = walk(pkg).filter((p) => p.endsWith('.js'));
const requiresOf = (src) => [...src.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);

test('only hosts/electron requires Electron', () => {
  const offenders = sources
    .filter((p) => !relative(pkg, p).startsWith('hosts/electron/'))
    .filter((p) => requiresOf(readFileSync(p, 'utf8')).includes('electron'))
    .map((p) => relative(pkg, p));
  assert.deepEqual(offenders, []);
});

test('the package never requires a file outside itself', () => {
  const leaks = [];
  for (const p of sources) {
    for (const r of requiresOf(readFileSync(p, 'utf8'))) {
      if (!r.startsWith('.')) continue;
      const target = resolve(dirname(p), r);
      if (relative(pkg, target).startsWith('..')) leaks.push(`${relative(pkg, p)} → ${r}`);
    }
  }
  assert.deepEqual(leaks, []);
});

test('the app depends on the package, linked from the repo under npm and pnpm alike', () => {
  const app = JSON.parse(readFileSync(join(root, 'electron-app', 'package.json'), 'utf8'));
  assert.equal(app.dependencies['@vibeconferencing/calls'], 'file:../packages/calls');
  // pnpm would copy a file: directory into its store, so edits wouldn't show
  // until a reinstall; the override makes it a symlink, as npm already does.
  assert.equal(app.pnpm.overrides['@vibeconferencing/calls'], 'link:../packages/calls');
  const lib = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  assert.equal(lib.name, '@vibeconferencing/calls');
  assert.equal(lib.license, 'MIT');
  // Every top-level folder ships.
  const dirs = readdirSync(pkg).filter((f) => statSync(join(pkg, f)).isDirectory() && f !== 'node_modules');
  for (const d of dirs) assert.ok(lib.files.includes(d + '/'), `${d}/ is missing from the package's files`);
});

test('the app no longer carries its own copy of a library file', () => {
  const appFiles = new Set(readdirSync(join(root, 'electron-app')));
  const dupes = sources.map((p) => p.split('/').pop()).filter((f) => appFiles.has(f));
  assert.deepEqual(dupes, []);
});
