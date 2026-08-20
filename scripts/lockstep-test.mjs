#!/usr/bin/env node
//
// lockstep-test.mjs — how often do several bots start talking at once?
//
// Nothing measures this today. meet-test.mjs counts cross-bot overlaps but says
// of them "informational — not a failure; use a dedicated lockstep scenario to
// test for real", because in that harness the bots are running unrelated
// scripts and any overlap is coincidence. This is that dedicated scenario: all
// bots are given the SAME cue at the SAME instant, which is the situation that
// actually happens in a call — one human stops, one silence threshold fires,
// every bot decides to answer.
//
// It exists to make the fix arguable with numbers. Random jitter (#230/#100)
// has never had a measured collision rate; it was reasoned about from
// (1 - D/N)^2 and adjusted when calls sounded bad. Before replacing it with a
// deterministic ordering, we should know what we are replacing.
//
// WHAT IS MEASURED. Each bot logs the moment its audio actually starts. Two
// bots "collided" if those moments are closer together than the time it takes
// one to SEE the other — under that gap, the loser could not possibly have
// yielded, so the room hears both. That threshold is the detection latency
// (#422: onset p90 ~180ms on the meter signal, ~360-460ms on the mutation
// counter), not an arbitrary window.
//
// PREREQ: a fleet, all bots in one call:
//   scripts/spawn-test-fleet.sh 3
//
// Run:
//   node scripts/lockstep-test.mjs --bots Alice:7901,Jimmy:7902,Cosmo:7903
//   node scripts/lockstep-test.mjs --rounds 20 --collision-ms 460
//   node scripts/lockstep-test.mjs --ordering ranked      # configure + measure
//
// Exit code is non-zero only on harness failure; the collision rate is a
// measurement, not a pass/fail.

import { readFileSync, statSync } from 'node:fs';
import { Bot, sleep, record, report } from './meet-test-lib.mjs';
import { resolveTarget } from './meet-targets.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };

const ROOM = flag('room', resolveTarget(flag('target', 'default')).room);
const ROUNDS = Number(flag('rounds', '12'));
const COLLISION_MS = Number(flag('collision-ms', '460'));
const SETTLE_MS = Number(flag('settle', '9000'));
const ORDERING = flag('ordering', null);          // 'jitter' | 'ranked' | null = leave as configured
const GAP_MS = flag('gap', null);
const BOTS = flag('bots', 'Alice:7901,Jimmy:7902,Cosmo:7903').split(',').map((s) => {
  const [name, port] = s.split(':');
  return new Bot(name, Number(port), ROOM);
});

// A bot that stands in for the human.
//
// The ranked ordering keys on the last utterance from OUTSIDE the bot set, so
// something has to say it. Requiring a person to speak before every run made
// this untestable unattended — and each restart wipes the bots' transcripts, so
// it had to be a fresh sentence every time.
//
// A bot left out of everyone's peerBotNames looks exactly like a human to them:
// its speech is a valid seed, and it takes no part in the ordering. Stan's idea,
// and it removes the last human dependency from the harness.
const PROMPTER = (() => {
  const spec = flag('prompter', null);
  if (!spec) return null;
  const [name, port] = spec.split(':');
  return new Bot(name, Number(port), ROOM);
})();

if (BOTS.length < 2) { console.error('need at least two bots'); process.exit(2); }

async function setPref(bot, key, value) {
  const { data } = await bot._post('/api/preferences', JSON.stringify({ key, value }));
  return data?.success !== false;
}

// When did this bot's audio ACTUALLY start?
//
// Not from the HTTP response: that returns when the utterance is accepted,
// which is before any delay has elapsed — the exact interval under test.
//
// Not from status().botState either: the sync payload has no such field
// (checked 2026-08-17 — meet-test-lib maps `data.status.botState`, which is
// always undefined, so anything polling it silently measures nothing. That is
// how the first run of this script reported "0/3 spoke" while all three bots
// were plainly talking).
//
// The session log is the honest source: the renderer records the moment TTS
// audio is handed to the virtual mic, with millisecond timestamps, and every
// bot in the fleet shares one machine clock — so the numbers are directly
// comparable across bots, which is the entire measurement.
const SPEAK_MARK = /Queuing TTS audio/;

// Raw payload, not bot.status(): that wrapper maps a fixed subset of fields and
// drops sessionLogPath (as it drops botState, which is how the first version of
// this script measured nothing at all).
async function logPath(bot) {
  try {
    const resp = await fetch(`${bot.base}/api/sync/${ROOM}`);
    const data = await resp.json();
    return data?.status?.sessionLogPath || null;
  } catch { return null; }
}

function tailSpeakTimes(file, sinceBytes) {
  let size = 0;
  try { size = statSync(file).size; } catch { return { size: sinceBytes, times: [] }; }
  if (size <= sinceBytes) return { size, times: [] };
  // Slice the BUFFER, not the string. statSync gives bytes; these logs are full
  // of emoji, so string indices drift from byte offsets and a string .slice()
  // starts further into the file with every multi-byte character written. That
  // read fine for the first rounds and then silently returned nothing, which
  // looked exactly like bots declining to speak.
  let text = '';
  try { text = readFileSync(file).subarray(sinceBytes).toString('utf8'); }
  catch { return { size, times: [] }; }
  const times = [];
  for (const line of text.split('\n')) {
    if (!SPEAK_MARK.test(line)) continue;
    const m = line.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
    if (!m) continue;
    const [, h, mi, s, ms] = m;
    const d = new Date();
    d.setHours(Number(h), Number(mi), Number(s), Number(ms));
    times.push(d.getTime());
  }
  return { size, times };
}

async function run() {
  if (ORDERING) {
    for (const b of BOTS) {
      // Pin the jitter knobs to their defaults every run. Test profiles PERSIST
      // preferences, so a value left behind by earlier debugging silently
      // changes what "jitter" means — one comparison read 85.7% collisions and
      // another 27.8% on the same code, because one profile still had a 77ms
      // jitter ceiling from an unrelated experiment.
      await setPref(b, 'botSpeakJitterMaxMs', 2000);
      await setPref(b, 'botSpeakUrgencyLeadMs', 900);
      await setPref(b, 'botSpeakOrdering', ORDERING);
      if (ORDERING === 'ranked') {
        await setPref(b, 'peerBotNames', BOTS.map((x) => x.name).filter((n) => n !== b.name));
      }
      if (GAP_MS) await setPref(b, 'botSpeakRankGapMs', Number(GAP_MS));
    }
    record('harness', 'configure', true, `botSpeakOrdering=${ORDERING}${GAP_MS ? ` gap=${GAP_MS}ms` : ''}`);
  }

  // Discard yielded speech instead of replaying it, FOR THE DURATION OF THE
  // TEST ONLY. A bot that loses the floor normally stashes its utterance and
  // replays it at the next gap — correct in a conversation, ruinous as a
  // measurement: the replays from round N occupy the floor when round N+1
  // fires, so every later round reads as silence and the collision rate is
  // computed from a handful of unpolluted rounds. Seen directly: six of ten
  // rounds recorded no speech at all until this was turned off.
  // Disabled FOR THIS RUN only — a replayed stash would look like a collision.
  // Restored in the finally below: these are shared test profiles, and a pin left
  // behind silently voids whatever runs next. It did exactly that to the
  // etiquette suite, whose stash rules all failed against a leftover 0 until the
  // cause was traced back here.
  for (const b of BOTS) await setPref(b, 'bargeInStashMaxAgeMs', 0);
  record('harness', 'noStashReplay', true, 'bargeInStashMaxAgeMs=0 for the run (restored after)');

  const logs = [];
  for (const b of BOTS) {
    const p = await logPath(b);
    if (!p) { record('harness', 'logPath', false, `${b.name}: no sessionLogPath`); return; }
    logs.push({ bot: b.name, path: p, size: tailSpeakTimes(p, 0).size });
  }

  const rounds = [];
  for (let r = 1; r <= ROUNDS; r++) {
    // The cue the bots are answering. A NEW sentence each round, so the seed
    // changes and the winner rotates — a fixed seed would hand every round to
    // the same bot and hide whether the ordering is fair.
    if (PROMPTER) {
      await PROMPTER.speak(`Question ${r}: what does everyone think about topic number ${r}?`);
      // Wait for it to reach the responders as a caption — the seed cannot be
      // derived until Meet has transcribed it, which lags the audio.
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const seen = await Promise.all(BOTS.map(async (b) => {
          try {
            const resp = await fetch(`${b.base}/api/sync/${ROOM}`);
            const data = await resp.json();
            return ((data?.transcript?.entries) || []).some(
              (e) => e.participantName === PROMPTER.name && /topic number/i.test(e.text || ''));
          } catch { return false; }
        }));
        if (seen.every(Boolean)) break;
        await sleep(500);
      }
    }
    // Every bot is told to say something at the same instant — the lockstep the
    // real failure produces. Deliberately not identical text, so a listener can
    // tell who spoke, but identical length so synthesis time doesn't skew it.
    await Promise.all(BOTS.map((b, i) =>
      b.speak(`Round ${r}, this is bot number ${i + 1} reporting in.`, { urgency: 0.4 })));
    // Let every delay expire AND synthesis finish before reading the logs. Too
    // short and a late speaker's line lands after the read, which then reports
    // a silent round and misattributes the line to the next one. The longest
    // legitimate wait is the jitter ceiling (2s) plus the urgency lead (0.9s)
    // plus TTS synthesis (1-3s).
    await sleep(SETTLE_MS);

    const starts = logs.map((l) => {
      const { size, times } = tailSpeakTimes(l.path, l.size);
      l.size = size;
      return times.length ? times[times.length - 1] : null;
    });

    const heard = BOTS.map((b, i) => ({ bot: b.name, at: starts[i] })).filter((x) => x.at);
    const gaps = [];
    for (let i = 0; i < heard.length; i++) {
      for (let j = i + 1; j < heard.length; j++) gaps.push(Math.abs(heard[i].at - heard[j].at));
    }
    const collisions = gaps.filter((g) => g < COLLISION_MS).length;
    rounds.push({ round: r, spoke: heard.length, gaps, collisions });
    console.log(`  round ${String(r).padStart(2)}: ${heard.length}/${BOTS.length} spoke · `
      + `gaps ${gaps.map((g) => g + 'ms').join(', ') || '(n/a)'} · `
      + `${collisions} collision${collisions === 1 ? '' : 's'}`);

    // Let the floor clear before the next round, so one round's speech is not
    // still playing when the next cue lands.
    await sleep(6000);
  }

  const allGaps = rounds.flatMap((r) => r.gaps);
  const collisions = allGaps.filter((g) => g < COLLISION_MS).length;
  const pct = allGaps.length ? (100 * collisions / allGaps.length) : 0;
  const sorted = allGaps.slice().sort((a, b) => a - b);
  const pctl = (p) => (sorted.length ? sorted[Math.floor(sorted.length * p)] : null);

  console.log('\n────────────────────────────────────────────────');
  console.log(`rounds: ${rounds.length} · bot pairs measured: ${allGaps.length}`);
  console.log(`COLLISIONS (< ${COLLISION_MS}ms apart): ${collisions} of ${allGaps.length} = ${pct.toFixed(1)}%`);
  console.log(`gap between starts: p10 ${pctl(0.1)}ms · p50 ${pctl(0.5)}ms · p90 ${pctl(0.9)}ms`);
  const silent = rounds.filter((r) => r.spoke < BOTS.length).length;
  if (silent) console.log(`rounds where a bot never spoke: ${silent} (stashed behind another bot, or dropped)`);
  console.log('────────────────────────────────────────────────');
  record('harness', 'collisionRate', true, `${pct.toFixed(1)}% (${collisions}/${allGaps.length})`);
}

// Put back anything this run pinned. These are SHARED test profiles: a value
// left behind does not fail, it quietly changes what the next suite measures.
// This one set bargeInStashMaxAgeMs=0 and left it, and the etiquette suite then
// reported three app bugs that were really this pin — every stash discarded the
// instant it was made ("too stale (2252ms old, max 0ms)").
async function restorePins() {
  const { PREFERENCES } = (await import('node:module')).createRequire(import.meta.url)(
    '../electron-app/preferences-schema.js');
  for (const b of BOTS) {
    try { await setPref(b, 'bargeInStashMaxAgeMs', PREFERENCES.bargeInStashMaxAgeMs.default); }
    catch { /* best-effort: a bot that died mid-run cannot be restored */ }
  }
}

run()
  .catch((err) => record('harness', 'run', false, err.message))
  .finally(async () => {
    await restorePins();
    const { fails } = report();
    process.exit(fails > 0 ? 1 : 0);
  });
