// codex-config.js — safe-ish install/remove helpers for ~/.codex/config.toml.
//
// Codex MCP servers live in TOML, not JSON. Keep this intentionally narrow:
// only replace our own [mcp_servers.vibeconferencing] block and direct
// subtables, preserve everything else verbatim, and back up before overwriting.

const fs = require('fs');
const path = require('path');

function tomlString(value) {
  return JSON.stringify(String(value));
}

function validateServerName(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error('Codex MCP server name must contain only letters, numbers, and underscores');
  }
}

function codexConfigPath(home) {
  return path.join(home, '.codex', 'config.toml');
}

function readCodexConfigSafe(configPath) {
  let content = '';
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(configPath).mtimeMs;
    content = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { content: '', readable: true, mtimeMs: undefined };
    return { content: '', readable: false, mtimeMs };
  }
  return { content, readable: true, mtimeMs };
}

function isTargetHeader(header, serverName) {
  return header === `mcp_servers.${serverName}` || header.startsWith(`mcp_servers.${serverName}.`);
}

function removeCodexServerBlock(content, serverName = 'vibeconferencing') {
  validateServerName(serverName);
  const lines = content.split(/\r?\n/);
  const kept = [];
  let skipping = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const header = trimmed.match(/^\[([^\]]+)\]$/)?.[1];
    if (header) skipping = isTargetHeader(header, serverName);
    if (!skipping) kept.push(line);
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function buildCodexMcpBlock({ serverName = 'vibeconferencing', command, args = [], env = {}, startupTimeoutSec = 120 }) {
  validateServerName(serverName);
  const envLines = Object.entries(env)
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join('\n');
  return `[mcp_servers.${serverName}]
command = ${tomlString(command)}
args = [${args.map(tomlString).join(', ')}]
startup_timeout_sec = ${Number(startupTimeoutSec)}

[mcp_servers.${serverName}.env]
${envLines}
`;
}

function atomicWriteText(filePath, content, opts = {}) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, content);

  let mode = 0o600;
  try { mode = fs.statSync(filePath).mode & 0o777; } catch { /* new file */ }
  try { fs.chmodSync(tmp, mode); } catch { /* best effort */ }

  if ('expectedMtimeMs' in opts) {
    let curMtimeMs;
    try { curMtimeMs = fs.statSync(filePath).mtimeMs; } catch { curMtimeMs = undefined; }
    if (curMtimeMs !== opts.expectedMtimeMs) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      throw new Error('codex-config: config.toml changed since read - aborting to avoid clobber');
    }
  }

  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

function writeCodexConfig(configPath, content, existing, mtimeMs) {
  let backupPath = null;
  if (existing) {
    backupPath = `${configPath}.bak.${Date.now()}`;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(backupPath, existing);
  }
  atomicWriteText(configPath, content, { expectedMtimeMs: mtimeMs });
  return backupPath;
}

function installCodexMcpConfig({ configPath, serverName = 'vibeconferencing', command, args, env }) {
  const { content: existing, readable, mtimeMs } = readCodexConfigSafe(configPath);
  if (!readable) return { ok: false, changed: false, reason: 'unreadable', configPath };

  const block = buildCodexMcpBlock({ serverName, command, args, env });
  const next = [removeCodexServerBlock(existing, serverName), block].filter(Boolean).join('\n\n') + '\n';
  if (existing === next) return { ok: true, changed: false, configPath };

  const backupPath = writeCodexConfig(configPath, next, existing, mtimeMs);
  return { ok: true, changed: true, configPath, backupPath };
}

function uninstallCodexMcpConfig({ configPath, serverName = 'vibeconferencing' }) {
  const { content: existing, readable, mtimeMs } = readCodexConfigSafe(configPath);
  if (!readable) return { ok: false, changed: false, reason: 'unreadable', configPath };

  const nextBase = removeCodexServerBlock(existing, serverName);
  const next = nextBase ? `${nextBase}\n` : '';
  if (existing === next) return { ok: true, changed: false, configPath };

  const backupPath = writeCodexConfig(configPath, next, existing, mtimeMs);
  return { ok: true, changed: true, configPath, backupPath };
}

function currentCodexMcpServerPath(content, serverName = 'vibeconferencing') {
  validateServerName(serverName);
  const lines = content.split(/\r?\n/);
  let inServer = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const header = trimmed.match(/^\[([^\]]+)\]$/)?.[1];
    if (header) {
      inServer = header === `mcp_servers.${serverName}`;
      continue;
    }
    if (!inServer) continue;
    const args = trimmed.match(/^args\s*=\s*\[\s*"((?:\\"|[^"])*)"/);
    if (args) return args[1].replace(/\\"/g, '"');
  }
  return null;
}

module.exports = {
  codexConfigPath,
  readCodexConfigSafe,
  removeCodexServerBlock,
  buildCodexMcpBlock,
  installCodexMcpConfig,
  uninstallCodexMcpConfig,
  currentCodexMcpServerPath,
};
