// mcp-server-has-no-electron-app-imports.test.mjs — the packaging boundary is real.
//
// `mcp-server/` is copied into the built app as extraResources, landing at
// Contents/Resources/mcp-server/. `electron-app/` is NOT copied alongside it —
// it is compiled into app.asar. So a relative import from mcp-server into
// electron-app resolves perfectly in the repo and then dies at runtime in the
// packaged build:
//
//     Error [ERR_MODULE_NOT_FOUND]: Cannot find module
//       '.../Contents/Resources/electron-app/board-fit.js'
//       imported from '.../Contents/Resources/mcp-server/server.js'
//
// That is not a degraded feature. The MCP server is the bot's ONLY channel to
// the app, so it fails to start and NO bot can connect to ANY call — the app
// runs, the bot sits in the room, and it is deaf and mute.
//
// Shipped exactly that way in v0.8.50, by me, adding the #644 board-fit import.
// Two comments in server.js already warned about this boundary ("cannot reach
// into electron-app/. Keep the two in sync") and the full 1978-test suite passed,
// because every test runs from the repo where the path exists. Nothing checked
// the thing that actually breaks.
//
// The fix was to stop crossing the boundary at all: the Electron side formats the
// note and passes a finished string through the existing sync payload. Duplicating
// the module would also have worked, but carries a keep-in-sync burden.
//
// Run: node --test tests/mcp-server-has-no-electron-app-imports.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const mcpDir = join(repo, 'mcp-server');

function jsFilesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...jsFilesUnder(full));
    else if (/\.(mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

// Matches `from "../electron-app/x.js"` and `require('../electron-app/x.js')`,
// at any depth of ../ — the whole point is that NO path out of mcp-server/ into
// electron-app/ survives packaging.
const CROSSES = /(?:from\s*|require\s*\(\s*)['"](?:\.\.\/)+electron-app\//;

test('no file in mcp-server/ imports from electron-app/', () => {
  const offenders = [];
  for (const file of jsFilesUnder(mcpDir)) {
    const src = readFileSync(file, 'utf8');
    src.split('\n').forEach((line, i) => {
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) return; // prose, not code
      if (CROSSES.test(line)) offenders.push(`${file.slice(repo.length + 1)}:${i + 1}  ${line.trim()}`);
    });
  }

  assert.deepEqual(offenders, [],
    'mcp-server/ is packaged as extraResources WITHOUT electron-app/ beside it, so these imports '
    + 'resolve in the repo and throw ERR_MODULE_NOT_FOUND in the built app — which kills the MCP '
    + 'server on startup and leaves every bot unable to connect:\n  ' + offenders.join('\n  '));
});

test('the board-fit note arrives pre-formatted, not recomputed across the boundary', () => {
  const server = readFileSync(join(mcpDir, 'server.js'), 'utf8');

  // The fix: consume the string the app already rendered.
  assert.match(server, /wb\.fitNote/,
    'server.js should read the formatted note from the sync payload');

  // And must NOT reach for the formatters, which live on the Electron side.
  assert.doesNotMatch(server, /\bformatFitReport\s*\(/,
    'formatting belongs to the Electron side; calling it here means importing across the boundary');
});
