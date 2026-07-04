#!/usr/bin/env node
// agent-fuzz-test.mjs — real-agent "quasi-fuzzing" e2e test (#267 item 5).
//
// Puts a REAL Claude agent on each test bot, gives each a natural-language
// MISSION, lets them drive the call non-deterministically, then grades the run
// with an LLM judge against the mission's rubric. This is the product-signal
// layer above the deterministic harness (meet-test.mjs): "did the real agent do
// the right thing", not just "did the buttons get clicked".
//
// End-to-end runner (this is what `pnpm test:meet:agents` invokes):
//   spawn bodies + agents (spawn-test-fleet.sh --with-agents) → wait for the
//   mission to play out → collect transcript + session log per bot → LLM judge →
//   PASS/FAIL + results line → tear down.
//
// Usage:
//   node scripts/agent-fuzz-test.mjs [--bots Alice:7901,Jimmy:7902] [--room paz-sqoa-npe]
//        [--mission smoke] [--duration 180] [--no-spawn] [--keep]
//
// ⚠️ SCAFFOLDING — authored without a live run available; validate before trusting.
//    Open validation items (see also spawn-agents.mjs):
//    - Permissions: #279 may block `claude -p` on the mini (dangerous-skip not honored).
//    - Transcript timing: /api/sync transcript may clear once a bot LEAVES; if the
//      judge sees an empty transcript, snapshot per-bot transcripts on a timer
//      DURING the run instead of once at the end (session-log is durable regardless).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bot, sleep } from './meet-test-lib.mjs';
import { getMission, renderRubric } from './agent-missions.mjs';
import { judgeRun } from './llm-judge.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPAWN = path.join(REPO, 'scripts', 'spawn-test-fleet.sh');
const RUNDIR = path.join(process.env.HOME, 'vibeconf-test-results', 'agent-fuzz');
const PIDFILE = path.join(RUNDIR, 'agents.pids');

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const flag = (name) => process.argv.includes('--' + name);

const BOTS = arg('bots', 'Alice:7901,Jimmy:7902');
const ROOM = arg('room', 'paz-sqoa-npe');
const MISSION_KEY = arg('mission', 'smoke');
const DURATION_S = Number(arg('duration', '180'));
const NO_SPAWN = flag('no-spawn');
const KEEP = flag('keep');

const bots = BOTS.split(',').filter(Boolean).map((s) => {
  const [name, port] = s.split(':');
  return new Bot(name, Number(port), ROOM);
});
const N = bots.length;

function runSpawn(extra) {
  execFileSync('zsh', [SPAWN, String(N), ...extra], { cwd: REPO, stdio: 'inherit', timeout: 120_000 });
}

// True while any spawned agent process is still alive.
function agentsAlive() {
  let pids = [];
  try { pids = fs.readFileSync(PIDFILE, 'utf8').split('\n').filter(Boolean).map(Number); } catch { return false; }
  return pids.some((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
}

async function main() {
  fs.mkdirSync(RUNDIR, { recursive: true });
  const missionDef = getMission(MISSION_KEY);
  const rubric = renderRubric(missionDef, { peer: 'the other bot', room: ROOM });

  console.log(`\n▶ Real-agent fuzz test — mission "${missionDef.key}", room ${ROOM}, ${N} bots\n`);

  // 1) Spawn bodies + attach real agents (unless the fleet is already up).
  if (!NO_SPAWN) {
    runSpawn(['--with-agents', `--room=${ROOM}`, `--mission=${MISSION_KEY}`]);
  }

  // 2) Let the agents run the mission, SAMPLING who's speaking each tick to
  //    measure turn-taking / talk-over (each bot's botState==='speaking' means
  //    its own TTS is playing; 2+ at once = talk-over). Finish early when all
  //    agents exit, else stop at the duration cap.
  console.log(`\n⏳ Running the mission (up to ${DURATION_S}s; ends early when agents finish)…`);
  const deadline = DURATION_S * 1000;
  const step = 800;              // finer tick so overlap sampling has resolution
  let waited = 0;
  const sample = { ticks: 0, speaking: bots.map(() => 0), anySpeaking: 0, overlap: 0 };
  await sleep(8000);            // let agents actually start before sampling
  while (waited < deadline) {
    const speaking = await Promise.all(bots.map((b) =>
      b.status().then((s) => s.botState === 'speaking').catch(() => false)));
    sample.ticks++;
    speaking.forEach((sp, i) => { if (sp) sample.speaking[i]++; });
    const num = speaking.filter(Boolean).length;
    if (num >= 1) sample.anySpeaking++;
    if (num >= 2) sample.overlap++;   // 2+ bots speaking simultaneously = talk-over
    if (!agentsAlive()) { console.log('  ✓ all agents finished'); break; }
    await sleep(step);
    waited += step;
  }
  if (waited >= deadline) console.log('  ⚠ duration cap reached — agents may still be running (grading anyway)');

  // talk-over % = fraction of speaking-time where 2+ bots spoke at once.
  const talkOverPct = sample.anySpeaking ? Math.round((sample.overlap / sample.anySpeaking) * 100) : 0;
  const metrics = [
    `Sampled every ${step}ms across ${sample.ticks} ticks.`,
    ...bots.map((b, i) => `- ${b.name}: speaking on ${sample.speaking[i]}/${sample.ticks} ticks`),
    `- ticks with ANY bot speaking: ${sample.anySpeaking}`,
    `- ticks with 2+ bots speaking at once (talk-over): ${sample.overlap}`,
    `- TALK-OVER = ${talkOverPct}% of speaking time was simultaneous (lower is better; high = they spoke over each other).`,
  ].join('\n');
  console.log(`\n📊 talk-over: ${talkOverPct}% of speaking time simultaneous (${sample.overlap}/${sample.anySpeaking} ticks)`);

  // 3) Collect judging inputs: transcript + session log from each bot body.
  //    (Best-effort transcript — see the timing caveat in the header.)
  let transcript = '';
  let sessionLog = '';
  for (const bot of bots) {
    try {
      const t = await bot.transcriptText();
      if (t) transcript += `\n----- ${bot.name} (${bot.port}) transcript -----\n${t}\n`;
      const l = await bot.sessionLog(4000);
      if (l) sessionLog += `\n===== ${bot.name} (${bot.port}) session log =====\n${l}\n`;
    } catch (e) {
      sessionLog += `\n(!) could not read ${bot.name}: ${e.message}\n`;
    }
  }

  // 4) Judge the run.
  console.log('\n⚖  Judging the run…');
  const verdict = await judgeRun({ rubric, transcript, sessionLog, metrics });

  // 5) Report + append a results line (mirrors the meet-test results.jsonl shape).
  console.log('\n────────────────────────────────────────────────────────────────────────');
  console.log(`  judge: ${verdict.via}   ok: ${verdict.ok}`);
  if (verdict.checks && Object.keys(verdict.checks).length) {
    console.log('  checks: ' + Object.entries(verdict.checks).map(([k, v]) => `${k}=${v ? '✓' : '✗'}`).join('  '));
  }
  console.log('  reasons: ' + (verdict.reasons || '(none)'));
  console.log(verdict.ok ? '✅ PASS' : '🔴 FAIL');
  console.log('────────────────────────────────────────────────────────────────────────');

  const line = JSON.stringify({
    mission: missionDef.key, room: ROOM, bots: N,
    ok: verdict.ok, via: verdict.via, talkOverPct, checks: verdict.checks || {},
  });
  fs.appendFileSync(path.join(RUNDIR, 'results.jsonl'), line + '\n');

  // 6) Teardown (unless --keep or the caller manages the fleet lifecycle).
  if (!NO_SPAWN && !KEEP) {
    console.log('\n▶ Tearing down agents + fleet…');
    try { runSpawn(['--with-agents', '--kill']); } catch { /* best-effort */ }
  }

  process.exit(verdict.ok ? 0 : 1);
}

main().catch((e) => { console.error('agent-fuzz-test error:', e); process.exit(2); });
