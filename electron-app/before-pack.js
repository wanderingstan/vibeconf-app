// electron-builder beforePack hook.
//
// The app bundles ../mcp-server as-is (see `extraResources`), node_modules and
// all. On a FRESH CLONE those deps aren't installed, so without this the packaged
// app ships an mcp-server missing @modelcontextprotocol/sdk + zod — a broken MCP
// server at runtime. Install its production deps here so `pnpm dist` works from a
// clean checkout with no extra manual step.
const { execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// The calls library (@vibeconferencing/calls) is a package in this repo,
// linked in at node_modules/@vibeconferencing/calls -> ../../../packages/calls.
// electron-builder 25 refuses to pack a file whose real path is outside this
// directory, so for the length of the pack the link becomes a real copy, and
// afterPack (after-pack.js) puts the link back. So does process exit, so a
// failed build never leaves the app running a stale copy in development.
const CALLS_LINK = path.join(__dirname, 'node_modules', '@vibeconferencing', 'calls');
const CALLS_SRC = path.join(__dirname, '..', 'packages', 'calls');
let callsLinkTarget = null;

function stageCallsPackage() {
  let st;
  try { st = fs.lstatSync(CALLS_LINK); } catch { throw new Error('@vibeconferencing/calls is not installed: run pnpm install (or npm ci) in electron-app'); }
  if (!st.isSymbolicLink()) return; // already a real copy
  callsLinkTarget = fs.readlinkSync(CALLS_LINK);
  fs.unlinkSync(CALLS_LINK);
  fs.cpSync(CALLS_SRC, CALLS_LINK, {
    recursive: true,
    filter: (src) => !path.relative(CALLS_SRC, src).split(path.sep).includes('node_modules'),
  });
  process.once('exit', restoreCallsLink);
  console.log('[before-pack] staged a copy of packages/calls for packing');
}

function restoreCallsLink() {
  if (!callsLinkTarget) return;
  fs.rmSync(CALLS_LINK, { recursive: true, force: true });
  fs.symlinkSync(callsLinkTarget, CALLS_LINK, 'junction'); // the type is ignored off Windows
  callsLinkTarget = null;
}

exports.restoreCallsLink = restoreCallsLink;

exports.default = async function beforePack() {
  stageCallsPackage();
  const mcpDir = path.join(__dirname, '..', 'mcp-server');
  const sdk = path.join(mcpDir, 'node_modules', '@modelcontextprotocol', 'sdk');
  if (fs.existsSync(sdk)) {
    console.log('[before-pack] mcp-server deps already present — skipping install');
    return;
  }
  console.log('[before-pack] installing mcp-server production deps →', mcpDir);
  execSync('npm install --omit=dev --no-audit --no-fund', { cwd: mcpDir, stdio: 'inherit' });
};
