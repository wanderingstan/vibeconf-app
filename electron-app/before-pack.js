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

exports.default = async function beforePack() {
  const mcpDir = path.join(__dirname, '..', 'mcp-server');
  const sdk = path.join(mcpDir, 'node_modules', '@modelcontextprotocol', 'sdk');
  if (fs.existsSync(sdk)) {
    console.log('[before-pack] mcp-server deps already present — skipping install');
    return;
  }
  console.log('[before-pack] installing mcp-server production deps →', mcpDir);
  execSync('npm install --omit=dev --no-audit --no-fund', { cwd: mcpDir, stdio: 'inherit' });
};
