#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function usage() {
  return `Usage: node scripts/install-codex-mcp.mjs [options]

Options:
  --base-url=URL       Local app URL for this Codex instance (default: VIBECONF_BASE_URL or http://127.0.0.1:7865)
  --bot-name=NAME      Bot identity exposed to the MCP server (default: VIBECONF_BOT_NAME or Codex)
  --room-id=CODE       Optional default Meet room code (default: VIBECONF_ROOM_ID or empty)
  --server-name=NAME   Codex MCP server name (default: vibeconferencing)
  --codex-home=PATH    Codex home directory (default: CODEX_HOME or ~/.codex)
  --config=PATH        Codex config.toml path (default: <codex-home>/config.toml)
  --mcp-server=PATH    Path to mcp-server/server.js (default: this checkout)
  --dry-run            Print the config block without writing
  --help               Show this help
`;
}

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    const match = arg.match(/^--([a-z0-9-]+)=(.*)$/i);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    args[match[1]] = match[2];
  }
  return args;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function validateServerName(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error('--server-name must contain only letters, numbers, and underscores');
  }
}

function validateBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid --base-url: ${value}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('--base-url must start with http:// or https://');
  }
  return parsed.toString().replace(/\/$/, '');
}

function removeExistingServerBlock(content, serverName) {
  const headersToRemove = new Set([
    `[mcp_servers.${serverName}]`,
    `[mcp_servers.${serverName}.env]`,
  ]);
  const lines = content.split(/\r?\n/);
  const kept = [];
  let skipping = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      skipping = headersToRemove.has(trimmed);
    }
    if (!skipping) kept.push(line);
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function buildBlock({ serverName, mcpServerPath, baseUrl, botName, roomId }) {
  return `[mcp_servers.${serverName}]
command = "node"
args = [${tomlString(mcpServerPath)}]
startup_timeout_sec = 120

[mcp_servers.${serverName}.env]
VIBECONF_ROOM_ID = ${tomlString(roomId)}
VIBECONF_BOT_NAME = ${tomlString(botName)}
VIBECONF_BASE_URL = ${tomlString(baseUrl)}
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const codexHome = path.resolve(args['codex-home'] || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const configPath = path.resolve(args.config || path.join(codexHome, 'config.toml'));
  const mcpServerPath = path.resolve(args['mcp-server'] || path.join(repoRoot, 'mcp-server', 'server.js'));
  const serverName = args['server-name'] || 'vibeconferencing';
  const baseUrl = validateBaseUrl(args['base-url'] || process.env.VIBECONF_BASE_URL || 'http://127.0.0.1:7865');
  const botName = args['bot-name'] || process.env.VIBECONF_BOT_NAME || 'Codex';
  const roomId = args['room-id'] || process.env.VIBECONF_ROOM_ID || '';

  validateServerName(serverName);

  if (!fs.existsSync(mcpServerPath)) {
    throw new Error(`MCP server not found: ${mcpServerPath}`);
  }

  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const block = buildBlock({ serverName, mcpServerPath, baseUrl, botName, roomId });
  const next = [removeExistingServerBlock(existing, serverName), block].filter(Boolean).join('\n\n') + '\n';

  if (args.dryRun) {
    console.log(`Would update ${configPath}`);
    console.log('');
    process.stdout.write(block);
    return;
  }

  if (existing === next) {
    console.log(`Codex MCP config already up to date: ${configPath}`);
  } else {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    if (existing) {
      const backupPath = `${configPath}.bak.${Date.now()}`;
      fs.writeFileSync(backupPath, existing);
      console.log(`Backed up existing Codex config: ${backupPath}`);
    }
    fs.writeFileSync(configPath, next);
    console.log(`Updated Codex MCP config: ${configPath}`);
  }

  console.log(`MCP server: ${serverName}`);
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Bot name: ${botName}`);
  console.log('Restart Codex so it loads the MCP server.');
}

try {
  main();
} catch (err) {
  console.error(err.message);
  console.error('');
  console.error(usage());
  process.exit(1);
}
