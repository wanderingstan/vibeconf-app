#!/usr/bin/env node
// smoke-app-health.mjs — fast, GOOGLE-FREE app-health smoke for the on-push
// self-hosted runner. It drives one already-running test bot (spawn it with
// `pnpm smoke:health:ci`) and asserts the things that have actually broken the
// nightly recently — WITHOUT needing a real Meet/Slack admission, so it's
// deterministic and safe to gate merges on. It exercises no Google/Slack join,
// so it never flakes on their latency.
//
// Checks:
//   1. the local control API is reachable and NOT 'unauthorized'
//      (guards the #201 mandatory-token regression + the fleet's
//      VIBECONF_REQUIRE_TOKEN=0 wiring — the whole nightly went red on this).
//   2. status returns a valid callStatus (app booted, IPC/local-server wiring intact).
//   3. join_call DISPATCHES — callStatus leaves 'idle' within the dispatch window.
//      We do NOT wait for in-call (that needs a real Google admission); setRoom
//      flips callStatus to navigating/joining immediately on dispatch, independent
//      of Google — so this catches #160-class call-state regressions cheaply.
//   4. the app is still responsive after the join (no crash on the join path).
//
// Run:  node scripts/smoke-app-health.mjs --bots Alice:7901
// Exit code is non-zero if any check failed, so a runner/CI can gate on it.

import { Bot, sleep } from './meet-test-lib.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const [name, portStr] = arg('bots', 'Alice:7901').split(',')[0].split(':');
const port = Number(portStr);
const room = arg('room', 'paz-sqoa-npe');
const bot = new Bot(name, port, room);

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

console.log(`app-health smoke → ${bot.base} as "${name}" (Google-free)`);

// 1) Control API reachable + authorized. A no-op 'leave' against a throwaway room
//    is the cheapest authenticated write. `unauthorized` here means the mandatory
//    token is on and the fleet didn't disable it (the exact 2026-08-01 breakage).
let authOk = false, authDetail = '';
try {
  const { data, status } = await bot._post(
    '/api/sync/no-room',
    JSON.stringify({ sender: name, role: 'bot', meta: { action: 'leave' } }),
  );
  authOk = status === 200 && data?.error !== 'unauthorized' && data?.success !== false;
  authDetail = data?.error ? data.error : `HTTP ${status}`;
} catch (e) { authDetail = e.message; }
check('control API reachable + authorized', authOk, authDetail);

// 2) Status shape — app booted and the local-server is wired to the renderer.
let cs0 = null;
try { cs0 = (await bot.status()).callStatus; } catch (e) { authDetail = e.message; }
check('status returns a callStatus', typeof cs0 === 'string', `callStatus=${cs0}`);

// 3) join_call dispatches → callStatus leaves 'idle' (no real admission required).
await bot.join();
let moved = false, cs = cs0;
for (let i = 0; i < 15 && !moved; i++) {
  await sleep(1000);
  try { cs = (await bot.status()).callStatus; } catch { /* app busy navigating — retry */ }
  if (cs && cs !== 'idle') moved = true;
}
check('join_call dispatches (callStatus leaves idle)', moved, `callStatus=${cs}`);

// 4) App still responsive after the join path (didn't crash mid-navigate).
let alive = false;
try { alive = typeof (await bot.status()).callStatus === 'string'; } catch { /* dead */ }
check('app responsive after join', alive);

// Best-effort: leave so the instance is idle for the next run.
try { await bot._sync({ meta: { action: 'leave' } }); } catch { /* ignore */ }

console.log(failures
  ? `\n🔴 app-health smoke FAILED — ${failures} check(s)`
  : '\n✅ app-health smoke PASSED — all checks green');
process.exit(failures ? 1 : 0);
