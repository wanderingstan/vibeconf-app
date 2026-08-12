// codex-config.test.mjs — app-managed ~/.codex/config.toml integration.
// Run: node --test tests/codex-config.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  removeCodexServerBlock,
  buildCodexMcpBlock,
  installCodexMcpConfig,
  uninstallCodexMcpConfig,
  currentCodexMcpServerPath,
} = require('../electron-app/codex-config.js');

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vibeconf-codex-'));

test('builds the Codex mcp_servers block Codex expects', () => {
  const block = buildCodexMcpBlock({
    command: '/Applications/Vibeconferencing.app/Contents/MacOS/Vibeconferencing',
    args: ['/app/mcp-server/server.js'],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      VIBECONF_ROOM_ID: '',
      VIBECONF_BOT_NAME: 'Codex',
      VIBECONF_BASE_URL: 'http://127.0.0.1:7865',
    },
  });
  assert.match(block, /\[mcp_servers\.vibeconferencing\]/);
  assert.match(block, /command = "\/Applications\/Vibeconferencing\.app\/Contents\/MacOS\/Vibeconferencing"/);
  assert.match(block, /args = \["\/app\/mcp-server\/server\.js"\]/);
  assert.match(block, /startup_timeout_sec = 120/);
  assert.match(block, /\[mcp_servers\.vibeconferencing\.env\]/);
  assert.match(block, /VIBECONF_BASE_URL = "http:\/\/127\.0\.0\.1:7865"/);
});

test('install preserves unrelated TOML and writes one vibeconferencing block', () => {
  const configPath = path.join(tmpHome(), 'config.toml');
  fs.writeFileSync(configPath, '# user stuff\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n');
  const result = installCodexMcpConfig({
    configPath,
    command: 'node',
    args: ['/repo/mcp-server/server.js'],
    env: { VIBECONF_BASE_URL: 'http://127.0.0.1:7865', VIBECONF_BOT_NAME: 'Codex', VIBECONF_ROOM_ID: '' },
  });
  const toml = fs.readFileSync(configPath, 'utf-8');
  assert.equal(result.changed, true);
  assert.match(toml, /model = "gpt-5"/);
  assert.match(toml, /\[mcp_servers\.other\]/);
  assert.equal((toml.match(/\[mcp_servers\.vibeconferencing\]/g) || []).length, 1);
  assert.match(toml, /VIBECONF_BOT_NAME = "Codex"/);
});

test('reinstall is idempotent, then updates in place with a backup', () => {
  const home = tmpHome();
  const configPath = path.join(home, 'config.toml');
  const first = {
    configPath,
    command: 'node',
    args: ['/repo/mcp-server/server.js'],
    env: { VIBECONF_BASE_URL: 'http://127.0.0.1:7865', VIBECONF_BOT_NAME: 'Codex', VIBECONF_ROOM_ID: '' },
  };
  assert.equal(installCodexMcpConfig(first).changed, true);
  assert.equal(installCodexMcpConfig(first).changed, false);
  assert.equal(fs.readdirSync(home).filter((f) => f.includes('.bak.')).length, 0);

  const second = { ...first, env: { ...first.env, VIBECONF_BOT_NAME: 'Codex2' } };
  const result = installCodexMcpConfig(second);
  const toml = fs.readFileSync(configPath, 'utf-8');
  assert.equal(result.changed, true);
  assert.match(toml, /VIBECONF_BOT_NAME = "Codex2"/);
  assert.equal((toml.match(/\[mcp_servers\.vibeconferencing\]/g) || []).length, 1);
  assert.ok(fs.readdirSync(home).some((f) => f.includes('.bak.')), 'expected a backup for an existing config');
});

test('remove strips only our server and direct subtables', () => {
  const existing = `[mcp_servers.other]
command = "other"

[mcp_servers.vibeconferencing]
command = "node"
args = ["/old/server.js"]

[mcp_servers.vibeconferencing.env]
VIBECONF_BASE_URL = "http://127.0.0.1:7865"

[mcp_servers.other.env]
TOKEN = "x"
`;
  const next = removeCodexServerBlock(existing);
  assert.match(next, /\[mcp_servers\.other\]/);
  assert.match(next, /\[mcp_servers\.other\.env\]/);
  assert.doesNotMatch(next, /vibeconferencing/);
});

test('uninstall removes our block from config.toml and keeps the rest', () => {
  const configPath = path.join(tmpHome(), 'config.toml');
  fs.writeFileSync(configPath, `[mcp_servers.other]
command = "other"

[mcp_servers.vibeconferencing]
command = "node"
args = ["/old/server.js"]

[mcp_servers.vibeconferencing.env]
VIBECONF_BASE_URL = "http://127.0.0.1:7865"
`);
  const result = uninstallCodexMcpConfig({ configPath });
  const toml = fs.readFileSync(configPath, 'utf-8');
  assert.equal(result.changed, true);
  assert.match(toml, /\[mcp_servers\.other\]/);
  assert.doesNotMatch(toml, /vibeconferencing/);
});

test('currentCodexMcpServerPath extracts the existing server path for worktree guard', () => {
  const toml = `[mcp_servers.vibeconferencing]
command = "node"
args = ["/stable/mcp-server/server.js"]

[mcp_servers.vibeconferencing.env]
VIBECONF_BASE_URL = "http://127.0.0.1:7865"
`;
  assert.equal(currentCodexMcpServerPath(toml), '/stable/mcp-server/server.js');
});
