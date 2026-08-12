#!/usr/bin/env node
// spawn-agents.mjs — attach a REAL Claude agent to each already-running test bot
// body, for the real-agent fuzzing test (#267 item 5).
//
// The test fleet (scripts/spawn-test-fleet.sh) spawns agent-LESS bot bodies —
// the harness is normally their brain. This gives each body a real brain:
// launches `claude` pinned to that bot's app port (same mechanism the app uses
// in main.js launchClaudeTerminal — a per-instance mcp-config.json with
// VIBECONF_BASE_URL/VIBECONF_BOT_NAME + --strict-mcp-config), seeded with a
// /join-call and a MISSION prompt. Each agent joins, does its mission, leaves.
//
// Usage:
//   node scripts/spawn-agents.mjs --bots Alice:7901,Jimmy:7902 --room paz-sqoa-npe [--mission smoke]
//   node scripts/spawn-agents.mjs --kill
//
// ⚠️ SCAFFOLDING — not yet validated live (no live tests available while authored).
//    Known risk to verify first: issue #279 — `--dangerously-skip-permissions`
//    may not be honored for a bot instance on the Mac mini, so `claude -p` could
//    block on a permission prompt. Validate interactively before trusting a run.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMission, promptForBot } from './agent-missions.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP_SERVER = path.join(REPO, 'mcp-server', 'server.js');
const RUNDIR = path.join(process.env.HOME, 'vibeconf-test-results', 'agent-fuzz');
const PIDFILE = path.join(RUNDIR, 'agents.pids');

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const flag = (name) => process.argv.includes('--' + name);

function parseBots(spec) {
  return (spec || '').split(',').filter(Boolean).map((s) => {
    const [name, port] = s.split(':');
    return { name, port: Number(port) };
  });
}

function killAgents() {
  let pids = [];
  try { pids = fs.readFileSync(PIDFILE, 'utf8').split('\n').filter(Boolean).map(Number); } catch { /* none */ }
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); console.log(`  • sent SIGTERM to agent pid ${pid}`); } catch { /* gone */ }
  }
  try { fs.rmSync(PIDFILE); } catch { /* ignore */ }
  console.log('✓ agents stopped (bodies are torn down separately by the fleet script)');
}

// Write a per-bot MCP config pinning the vibeconferencing server to THIS bot's
// port — same shape as main.js:2180. Returns the config path.
function writeMcpConfig(bot) {
  const cfg = {
    mcpServers: {
      vibeconferencing: {
        command: 'node',
        args: [MCP_SERVER],
        env: {
          VIBECONF_ROOM_ID: '',
          VIBECONF_BOT_NAME: bot.name,
          VIBECONF_BASE_URL: `http://127.0.0.1:${bot.port}`,
        },
      },
    },
  };
  const cfgPath = path.join(RUNDIR, `mcp-${bot.name}-${bot.port}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return cfgPath;
}

function spawnAgent(bot, index, room, mission, peerName) {
  // Per-bot prompt: role-based missions (e.g. turn-taking) assign host/guest by
  // index; symmetric missions give every bot the same prompt.
  const { prompt: missionPrompt, role } = promptForBot(mission, index, { peer: peerName, room });
  const cfgPath = writeMcpConfig(bot);
  // ISOLATION (critical): a pre-spawned, profile-isolated test BODY is already
  // running for this agent on its port. Use the `join_call` MCP TOOL, which routes
  // to that running instance by name (resolveInstance matches profile OR bot-name
  // → drives its port). Do NOT use the `/join-call` slash-command skill: its
  // bootstrap runs `open -a Vibeconferencing --meet-url=…`, which LAUNCHES a
  // second, DEFAULT-profile installed app — orphaning the test body, ghosting in
  // the call, and touching production userData. Headless -p run so it terminates
  // when the mission is done. (leave_call at the end.)
  const prompt = [
    `You are already running as bot "${bot.name}" — an app instance for you is ALREADY open.`,
    `Do NOT launch a new app: never run \`open -a Vibeconferencing\`, the /join-call slash`,
    `command, or any app-launch step. Instead call the join_call MCP tool to join the`,
    `Google Meet room "${room}" as "${bot.name}" (it will route to your running instance).`,
    `Then carry out this mission, and call leave_call when done:`,
    ``,
    missionPrompt,
  ].join('\n');
  const args = ['-p', prompt, '--dangerously-skip-permissions', '--mcp-config', cfgPath, '--strict-mcp-config'];
  const logPath = path.join(RUNDIR, `agent-${bot.name}-${bot.port}.log`);
  const out = fs.openSync(logPath, 'a');
  const child = spawn('claude', args, {
    cwd: REPO,
    // VIBECONF_LOCAL_PORT makes the agent-activity hook report to THIS bot's port.
    env: { ...process.env, VIBECONF_LOCAL_PORT: String(bot.port), VIBECONF_AGENT_FUZZ: '1' },
    stdio: ['ignore', out, out],
    detached: true,
  });
  // Handle a failed spawn gracefully — e.g. `claude` not on PATH → ENOENT. Without
  // this listener Node throws an unhandled 'error' event and crashes the whole run
  // (this bit the 3am nightly). Log it and carry on with an undefined pid; the
  // orchestrator treats "no live agents" as an inconclusive run, not a crash.
  child.on('error', (err) => {
    console.error(`  ✗ agent ${bot.name} failed to launch: ${err.code || err.message}` +
      (err.code === 'ENOENT' ? ` — is 'claude' on PATH?` : ''));
  });
  child.unref();
  console.log(`  • agent ${bot.name} [${role}] → port ${bot.port} (pid ${child.pid ?? 'FAILED'}), log: ${path.basename(logPath)}`);
  return child.pid;
}

function main() {
  fs.mkdirSync(RUNDIR, { recursive: true });
  if (flag('kill')) return killAgents();

  const bots = parseBots(arg('bots'));
  const room = arg('room');
  const mission = getMission(arg('mission'));
  if (bots.length < 2) { console.error('need at least 2 bots (--bots Name:port,Name:port)'); process.exit(1); }
  if (!room) { console.error('need --room <meet-code>'); process.exit(1); }

  console.log(`▶ Attaching agents for mission "${mission.key}" in room ${room}:`);
  const pids = [];
  for (let i = 0; i < bots.length; i++) {
    const peer = bots[(i + 1) % bots.length].name; // name the next bot as the peer
    pids.push(spawnAgent(bots[i], i, room, mission, peer));
  }
  fs.writeFileSync(PIDFILE, pids.filter(Boolean).join('\n') + '\n');
  console.log(`✓ ${pids.length} agent(s) attached. Reap with: node scripts/spawn-agents.mjs --kill`);
}

main();
