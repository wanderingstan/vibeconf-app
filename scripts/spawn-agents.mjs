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

// #334: `claude -p` intermittently dies at init ("Execution error" / empty log) on
// ~1 launch in 5, and the old fire-and-forget launch lost that agent for the whole
// run — leaving a bare log with no exit code to even diagnose it. A launch flake
// dies within seconds; a healthy agent runs for the whole mission. So we hold a
// startup grace, RECORD every exit, and RELAUNCH anything that dies inside it.
const STARTUP_GRACE_MS = 15_000;
const MAX_ATTEMPTS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let handedOff = false; // once the pidfile is committed, stop retrying

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

// Build the per-bot launch spec once (prompt, mcp-config, args, log path). Stable
// across retries — only the child process is respawned.
function prepareSlot(bot, index, room, mission, peerName) {
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
  return { bot, index, role, args, logPath, attempt: 0, child: null, pid: undefined };
}

// (Re)launch the agent for a slot. Wires up exit logging (#334: record every exit
// so a failure is diagnosable instead of a bare 15-byte log) and fast-failure
// retry (relaunch if it dies within the startup grace, up to MAX_ATTEMPTS).
function launch(slot) {
  slot.attempt += 1;
  const out = fs.openSync(slot.logPath, 'a');
  const startedAt = Date.now();
  const child = spawn('claude', slot.args, {
    cwd: REPO,
    // VIBECONF_LOCAL_PORT makes the agent-activity hook report to THIS bot's port.
    env: { ...process.env, VIBECONF_LOCAL_PORT: String(slot.bot.port), VIBECONF_AGENT_FUZZ: '1' },
    stdio: ['ignore', out, out],
    detached: true,
  });
  // A failed spawn (e.g. `claude` not on PATH → ENOENT) emits 'error', not 'exit'.
  // Without this listener Node throws an unhandled 'error' and crashes the whole
  // run (this bit the 3am nightly). Log it and carry on; the orchestrator treats
  // "no live agents" as inconclusive, not a crash.
  child.on('error', (err) => {
    console.error(`  ✗ agent ${slot.bot.name} failed to launch: ${err.code || err.message}` +
      (err.code === 'ENOENT' ? ` — is 'claude' on PATH?` : ''));
  });
  child.on('exit', (code, signal) => {
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    // Record the outcome of every attempt so an intermittent failure (#334) leaves
    // a trail — the old bare "Execution error" log had no exit code at all.
    try {
      fs.appendFileSync(slot.logPath,
        `\n[agent-exit ${slot.bot.name}: code=${code} signal=${signal} after ${secs}s (attempt ${slot.attempt}/${MAX_ATTEMPTS})]\n`);
    } catch { /* ignore */ }
    // A death INSIDE the startup grace is a launch flake, not a real mission run —
    // relaunch it. Never after the pidfile is committed (handedOff) or past
    // MAX_ATTEMPTS.
    if (!handedOff && (Date.now() - startedAt) < STARTUP_GRACE_MS && slot.attempt < MAX_ATTEMPTS) {
      try {
        fs.appendFileSync(slot.logPath,
          `[agent-retry ${slot.bot.name}: relaunching (attempt ${slot.attempt + 1}/${MAX_ATTEMPTS})]\n`);
      } catch { /* ignore */ }
      console.log(`  ↻ agent ${slot.bot.name} died in ${secs}s (code=${code} signal=${signal}) — relaunching (attempt ${slot.attempt + 1}/${MAX_ATTEMPTS})`);
      launch(slot);
    }
  });
  child.unref();
  slot.child = child;
  slot.pid = child.pid;
  console.log(`  • agent ${slot.bot.name} [${slot.role}] → port ${slot.bot.port} (pid ${child.pid ?? 'FAILED'}, attempt ${slot.attempt}/${MAX_ATTEMPTS}), log: ${path.basename(slot.logPath)}`);
}

async function main() {
  fs.mkdirSync(RUNDIR, { recursive: true });
  if (flag('kill')) return killAgents();

  const bots = parseBots(arg('bots'));
  const room = arg('room');
  const mission = getMission(arg('mission'));
  if (bots.length < 2) { console.error('need at least 2 bots (--bots Name:port,Name:port)'); process.exit(1); }
  if (!room) { console.error('need --room <meet-code>'); process.exit(1); }

  console.log(`▶ Attaching agents for mission "${mission.key}" in room ${room}:`);
  const slots = bots.map((bot, i) => prepareSlot(bot, i, room, mission, bots[(i + 1) % bots.length].name));
  for (const slot of slots) launch(slot);

  // #334: hold for a startup grace so a fast launch-failure is caught and
  // relaunched before we commit the pidfile. Whatever is alive after this is a
  // real mission run; flakes have already been retried (or exhausted attempts).
  await sleep(STARTUP_GRACE_MS);
  handedOff = true;
  const live = slots.filter((s) => s.pid && isAlive(s.pid));
  fs.writeFileSync(PIDFILE, live.map((s) => s.pid).join('\n') + (live.length ? '\n' : ''));
  const retried = slots.filter((s) => s.attempt > 1).length;
  console.log(`✓ ${live.length}/${slots.length} agent(s) live after ${STARTUP_GRACE_MS / 1000}s startup grace` +
    (retried ? ` (${retried} needed a relaunch)` : '') +
    `. Reap with: node scripts/spawn-agents.mjs --kill`);
  process.exit(0);
}

main();
