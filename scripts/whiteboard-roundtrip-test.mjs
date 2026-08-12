#!/usr/bin/env node
// whiteboard-roundtrip-test.mjs — prove the whiteboard write→read round-trips
// through the BACKEND (vibeconferencing.com → Upstash), isolated from rendering.
//
// whiteboard-e2e proves the board renders + reaches viewers (screenshot + vision).
// This proves the simpler, more fundamental thing underneath it: that content
// WRITTEN by one bot is READABLE by another — i.e. it actually persisted in the
// store and came back. Because the assertion is data-only (no screen-share, no
// vision), a failure points squarely at the whiteboard backend (e.g. Upstash
// throttling), with none of whiteboard-e2e's "was it the render? the share?"
// ambiguity.
//
// Cross-instance is the whole point: two app instances share whiteboard state
// ONLY through the backend, so bot B seeing bot A's content proves the round-trip
// persisted. The bots must be JOINED to the room for their sync-clients to poll —
// a join DISPATCH is enough (callStatus leaves 'idle'); no Meet admission needed.
//
// Run:
//   node scripts/whiteboard-roundtrip-test.mjs --bots Alice:7901,Jimmy:7902
//
// Exit non-zero if a write didn't round-trip to the other bot.

import { Bot, sleep, report, record } from './meet-test-lib.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const ROOM = arg('room', 'paz-sqoa-npe');
const BOTS = arg('bots', 'Alice:7901,Jimmy:7902').split(',').map((s) => { const [name, port] = s.split(':'); return new Bot(name, Number(port), ROOM); });
const stamp = arg('stamp', String(Date.now()).slice(-6));

// Wait until the bot's join has DISPATCHED (callStatus off 'idle') so its
// sync-client is polling the room. Full in-call admission isn't required.
async function waitDispatched(bot, maxMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try { const cs = (await bot.status()).callStatus; if (cs && cs !== 'idle') return cs; } catch { /* app still coming up — retry */ }
    await sleep(1000);
  }
  return null;
}

// Poll `reader` until its whiteboard content contains `needle`. Cross-instance,
// so success means `needle` round-tripped through the backend. Returns seconds
// waited, or null on timeout.
async function waitSees(reader, needle, maxMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try { const wb = await reader.readWhiteboard(); if ((wb.content || '').includes(needle)) return Math.round((Date.now() - t0) / 1000); } catch { /* retry */ }
    await sleep(1500);
  }
  return null;
}

async function run() {
  const [a, b] = BOTS;
  if (!b) { record(a.name, 'twoBots', false, 'need two bots (writer + reader)'); return; }
  console.log(`whiteboard round-trip → room ${ROOM}, bots ${a.name}:${a.port}, ${b.name}:${b.port} (backend/Upstash, no vision)`);

  // Join so both sync-clients poll the room (dispatch is enough).
  await a.join(); await b.join();
  for (const bot of [a, b]) {
    const cs = await waitDispatched(bot);
    record(bot.name, 'joinDispatched', !!cs, cs ? `callStatus=${cs}` : 'never left idle — join did not dispatch');
    if (!cs) return;
  }

  // A → B: A writes, B must read it back through the backend.
  const nonceA = `WBRT-A-${stamp}`;
  await a.updateWhiteboard(`# ${nonceA}\n\nwhiteboard round-trip A→B`);
  const secA = await waitSees(b, nonceA);
  record(b.name, 'readsWriterAContent', secA !== null,
    secA !== null ? `saw "${nonceA}" cross-instance in ~${secA}s` : `never saw "${nonceA}" — write did NOT round-trip through the backend (Upstash throttled/down?)`);

  // B → A: the other direction, so a one-way sync bug can't pass.
  const nonceB = `WBRT-B-${stamp}`;
  await b.updateWhiteboard(`# ${nonceB}\n\nwhiteboard round-trip B→A`);
  const secB = await waitSees(a, nonceB);
  record(a.name, 'readsWriterBContent', secB !== null,
    secB !== null ? `saw "${nonceB}" cross-instance in ~${secB}s` : `never saw "${nonceB}" — reverse round-trip failed (Upstash?)`);
}

run()
  .catch((err) => { console.error('whiteboard-roundtrip-test error:', err && err.message); })
  .finally(() => { const r = report(); process.exit(r.fails > 0 ? 1 : 0); });
