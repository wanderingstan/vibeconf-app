#!/usr/bin/env node
//
// roster-churn-test.mjs — does the roster survive people coming and going?
//
// Why this exists
// ---------------
// Nothing ever left DOMSpeakerTracker's participants Map. Someone who hung up
// stayed in it for the rest of the session, still reported to the agent as
// present, and a REJOIN doubled them: Meet issues a new device id, so the same
// human returned as a second entry beside the dead one. The 2026-08-13 call
// ended holding five rows for four people, two of them "Pepper".
//
// Every existing lane missed it because every existing lane joins once and
// stays. meet-test.mjs drives bots that never leave mid-run, so a roster that
// only ever grows looks identical to a correct one.
//
// Worse, the dead rows are what made the logs look like speaking detection had
// gone blind for long stretches (they read `item=STALE mtr=blind` forever), so
// this bug cost debugging time on a detector that was working fine.
//
// What it checks, per cycle
// -------------------------
//   1. A departure is NOTICED — the leaver disappears from the observers'
//      rosters within the tracker's grace (GONE_MS = 10s) plus a margin.
//   2. A rejoin does not DOUBLE them — exactly one row for that name after.
//   3. The rebuilt tile is still WIRED UP — the returning bot speaks and an
//      observer hears it. This is the real subject of the test: a roster that
//      is merely tidy is worthless if the tile that came back is not being
//      watched for speech. Tile identity changes on rejoin, so this is where a
//      stale-reference bug would surface.
//
// Deliberately NOT checked: the exact moment of eviction. The grace clock
// starts at the first 2s scan that MISSES the tile, not at the instant they
// left, so eviction lands somewhere in [GONE_MS, GONE_MS + scan interval].
// Asserting a precise deadline would make this flaky for no gain.
//
// PREREQ: three bot apps running, e.g.
//   scripts/spawn-test-fleet.sh 3
//
// Run:
//   node scripts/roster-churn-test.mjs --bots Alice:7901,Jimmy:7902,Cosmo:7903
//   node scripts/roster-churn-test.mjs --cycles 3
//
// Exit code is non-zero if any check failed.

import { Bot, sleep, report, record } from './meet-test-lib.mjs';
import { resolveTarget } from './meet-targets.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

const TARGET = resolveTarget(arg('target', 'default'));
const ROOM = arg('room', TARGET.room);
const CYCLES = Number(arg('cycles', '2'));
const BOTS = arg('bots', 'Alice:7901,Jimmy:7902,Cosmo:7903')
  .split(',')
  .map((s) => {
    const [name, port] = s.split(':');
    return new Bot(name, Number(port), ROOM);
  });

if (BOTS.length < 3) {
  console.error('need three bots: two observers and one that comes and goes');
  process.exit(2);
}

const [alice, jimmy, churner] = BOTS;
const OBSERVERS = [alice, jimmy];

// GONE_MS in the tracker, plus the 2s scan interval, plus room for a slow
// people-pane re-render. Kept in one place so the reason is legible.
const EVICTION_WAIT_MS = 10_000 + 2_000 + 6_000;

// Names as the observers see them. The bot's own tile carries the same display
// name, so self is filtered out — this is about seeing OTHERS correctly.
async function rosterOf(bot) {
  const { participants } = await bot.status();
  return (participants || [])
    .filter((p) => !p.isSelf && p.name !== 'You')
    .map((p) => p.name);
}

async function expectPresent(bot, name, present, label) {
  const roster = await rosterOf(bot);
  const count = roster.filter((n) => n === name).length;
  const ok = present ? count === 1 : count === 0;
  record(bot.name, label, ok,
    `${name} x${count} — roster: [${roster.join(', ')}]`);
  return ok;
}

async function run() {
  for (const bot of BOTS) await bot.join();
  // Captions have a cold start; the observers need to be fully wired before any
  // of this means anything.
  for (const bot of BOTS) await bot.warmUp();

  for (const observer of OBSERVERS) {
    await expectPresent(observer, churner.name, true, 'seesChurnerInitially');
  }

  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    console.log(`\n— cycle ${cycle}/${CYCLES} —`);

    // --- departure ---
    await churner.leave();
    await sleep(EVICTION_WAIT_MS);
    for (const observer of OBSERVERS) {
      await expectPresent(observer, churner.name, false, `c${cycle}:forgotAfterLeave`);
    }

    // --- return ---
    await churner.join();
    await churner.warmUp();
    await sleep(4000);              // let both observers' panes settle
    for (const observer of OBSERVERS) {
      await expectPresent(observer, churner.name, true, `c${cycle}:oneRowAfterRejoin`);
    }

    // --- still wired up? ---
    // The point of the whole test. A tidy roster proves nothing if the tile
    // that came back is not being watched.
    const listeners = OBSERVERS.map((o) => o.waitForSpeech({ wait: 20, silence: 2 }));
    await sleep(1200);              // let the long-polls register first
    await churner.speak(`Rejoin check, cycle ${cycle}. Can you still hear me?`);
    const heard = await Promise.all(listeners);
    heard.forEach((h, i) => {
      const who = OBSERVERS[i];
      const texts = (h.transcript || []).map((e) => e.participantName);
      record(who.name, `c${cycle}:heardAfterRejoin`,
        !h.timedOut && texts.includes(churner.name),
        h.timedOut ? 'timed out — the rebuilt tile is not being watched'
          : `heard from: ${texts.join(', ') || '(nobody)'}`);
    });
  }

  for (const bot of BOTS) await bot.leave();
}

run()
  .catch((err) => {
    record('harness', 'run', false, err.message);
  })
  .finally(() => {
    const { fails } = report();
    process.exit(fails > 0 ? 1 : 0);
  });
