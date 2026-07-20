#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function usage() {
  return `Usage: node scripts/smoke-codex-mcp.mjs [options]

Options:
  --base-url=URL       Local app URL for this Codex instance (default: VIBECONF_BASE_URL or http://127.0.0.1:7865)
  --bot-name=NAME      Bot identity exposed to the MCP server (default: VIBECONF_BOT_NAME or Codex)
  --room-id=CODE       Optional default Meet room code (default: VIBECONF_ROOM_ID or empty)
  --mcp-server=PATH    Path to mcp-server/server.js (default: this checkout)
  --timeout-ms=N       Per-request timeout in milliseconds (default: 10000)
  --help               Show this help
`;
}

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
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

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function checkLocalServer(baseUrl, timeoutMs) {
  const resp = await withTimeout(
    fetch(`${baseUrl}/api/sync/no-room`),
    timeoutMs,
    'local app status check',
  );
  if (!resp.ok) {
    throw new Error(`Local app status check failed: HTTP ${resp.status}`);
  }
  return resp.json();
}

function createMcpClient({ mcpServerPath, baseUrl, botName, roomId, timeoutMs }) {
  const child = spawn(process.execPath, [mcpServerPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      VIBECONF_BASE_URL: baseUrl,
      VIBECONF_BOT_NAME: botName,
      VIBECONF_ROOM_ID: roomId,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let nextId = 1;
  let stdoutBuffer = '';
  let stderrBuffer = '';
  const pending = new Map();

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex;
    while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (err) {
        throw new Error(`MCP server wrote non-JSON output: ${line}\n${err.message}`);
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
        else resolve(message.result);
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk;
  });

  child.on('exit', (code, signal) => {
    const err = new Error(`MCP server exited early: ${signal || code}`);
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
  });

  function request(method, params = {}) {
    const id = nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    const promise = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify(message)}\n`);
    });
    return withTimeout(promise, timeoutMs, method);
  }

  function notify(method, params = {}) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async function close() {
    child.stdin.end();
    child.kill();
  }

  return {
    request,
    notify,
    close,
    get stderr() {
      return stderrBuffer.trim();
    },
  };
}

function textFromToolResult(result) {
  return (result?.content || [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const baseUrl = validateBaseUrl(args['base-url'] || process.env.VIBECONF_BASE_URL || 'http://127.0.0.1:7865');
  const botName = args['bot-name'] || process.env.VIBECONF_BOT_NAME || 'Codex';
  const roomId = args['room-id'] || process.env.VIBECONF_ROOM_ID || '';
  const timeoutMs = Number(args['timeout-ms'] || 10000);
  const mcpServerPath = path.resolve(args['mcp-server'] || path.join(repoRoot, 'mcp-server', 'server.js'));

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }

  const status = await checkLocalServer(baseUrl, timeoutMs);
  const statusBaseUrl = status?.status?.localServerUrl || baseUrl;
  const profile = status?.status?.localProfile || '(default)';

  const mcp = createMcpClient({ mcpServerPath, baseUrl, botName, roomId, timeoutMs });
  try {
    await mcp.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'vibeconf-codex-mcp-smoke', version: '0.1.0' },
    });
    mcp.notify('notifications/initialized');

    const toolsResult = await mcp.request('tools/list');
    const tools = toolsResult.tools || [];
    if (!tools.some((tool) => tool.name === 'get_room_info')) {
      throw new Error('MCP tools/list did not include get_room_info');
    }

    const roomInfo = await mcp.request('tools/call', {
      name: 'get_room_info',
      arguments: roomId ? { room_id: roomId } : {},
    });
    const roomInfoText = textFromToolResult(roomInfo);
    if (!roomInfoText.includes('Local server:') && !roomInfoText.includes('Room:')) {
      throw new Error(`get_room_info returned an unexpected response:\n${roomInfoText}`);
    }

    console.log('Codex MCP smoke passed');
    console.log(`Base URL: ${baseUrl}`);
    console.log(`App status URL: ${statusBaseUrl}`);
    console.log(`Profile: ${profile}`);
    console.log(`Bot name: ${botName}`);
    console.log(`MCP tools: ${tools.length}`);
    console.log('');
    console.log(roomInfoText);
  } catch (err) {
    if (mcp.stderr) {
      console.error('MCP server stderr:');
      console.error(mcp.stderr);
      console.error('');
    }
    throw err;
  } finally {
    await mcp.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  console.error('');
  console.error('Start the intended app instance first, for example:');
  console.error('  cd electron-app && pnpm dev -- --profile=codex --local-port=7866');
  console.error('Then run:');
  console.error('  npm run smoke:codex-mcp -- --base-url=http://127.0.0.1:7866 --bot-name=Codex');
  console.error('');
  process.exit(1);
});
