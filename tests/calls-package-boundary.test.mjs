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

// Every provider is driven the same way: commands as method calls, reports as
// provider events. The host's preload owns the IPC (Meet's did its own until
// Phase 3b, which left the Playwright host a Meet-only wire to fake).
test('no provider talks IPC itself', () => {
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const offenders = sources
    .filter((p) => relative(pkg, p).startsWith('providers/'))
    .filter((p) => /ipcRenderer|hostIpc/.test(code(readFileSync(p, 'utf8'))))
    .map((p) => relative(pkg, p));
  assert.deepEqual(offenders, []);
});

// Phase 3b dropped CALL_COMMANDS from Meet's import while speak() still used
// it: every play-tts threw inside an IPC handler, silently, and the bots went
// mute. A provider must import each contract name it uses.
test('every provider imports the contract names it uses', () => {
  for (const p of sources.filter((f) => relative(pkg, f).startsWith('providers/'))) {
    const src = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const imported = new Set();
    for (const m of src.matchAll(/const \{([^}]+)\} = require\([^)]*call-provider[^)]*\)/g)) {
      for (const n of m[1].split(',')) imported.add(n.trim().split(':').pop().trim());
    }
    for (const name of new Set(src.match(/\bCALL_(?:COMMANDS|EVENTS|BOOTSTRAP)\b/g) || [])) {
      assert.ok(imported.has(name), `${relative(pkg, p)} uses ${name} without importing it`);
    }
  }
});

// Meet, Zoom, Teams and Slack run their whole session in the library (Phases
// 3b, 4b and 4c); their preloads only carry it over IPC. A loop back in a preload is a
// session the Playwright host can't run.
test('the Meet, Zoom, Teams and Slack preloads run no loop of their own', () => {
  for (const f of ['preload-meet.js', 'preload-zoom.js', 'preload-teams.js', 'preload-slack-main.js', 'preload-slack-huddle.js']) {
    const src = readFileSync(join(root, 'electron-app', f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/setInterval\(/.test(src), `${f} polls the page itself`);
  }
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
  // And pnpm's lockfile agrees, in the same dependency field: the mini's smoke
  // run installs with --frozen-lockfile and refuses any drift (it caught the
  // package recorded under devDependencies after a revert, Phase 3).
  const lock = readFileSync(join(root, 'electron-app', 'pnpm-lock.yaml'), 'utf8');
  const deps = lock.slice(lock.indexOf('    dependencies:'), lock.indexOf('    devDependencies:'));
  assert.match(deps, /'@vibeconferencing\/calls':\n\s+specifier: link:\.\.\/packages\/calls/);
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
