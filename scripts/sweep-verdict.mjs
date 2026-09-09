#!/usr/bin/env node
//
// sweep-verdict.mjs — turn a corpus of labelled calls into a VERDICT on the
// timing constants we actually ship (#422).
//
// analyse-turn-taking.mjs prints the trade-off tables. Nobody reads a table at
// 4am, and a table does not say whether anything should change. This reads the
// same labels, reads the CURRENT defaults out of preferences-schema.js, and
// says in two lines per constant whether it still sits where the data puts it.
//
// Two deliberate differences from analyse-turn-taking.mjs:
//
//   1. It handles ANY number of speakers. That one skips calls unless there are
//      exactly two (`if (d.speakers.length !== 2) continue`), and almost every
//      call we record has three or four — a bot, sometimes several, plus two or
//      more humans. On the current archive that restriction excludes nearly the
//      whole corpus, which is a large part of why these numbers have not been
//      revisited. "Same speaker resumes" and "someone else takes over" are
//      perfectly well defined for N speakers.
//
//   2. It uses the bot's own track to DISQUALIFY gaps rather than folding it in.
//      We are measuring how long a human pauses mid-thought, so as not to cut
//      them off. The bot's TTS pauses on punctuation, not on thought, so its
//      spans must not become "pauses" — but they are exactly what tells us a
//      gap was not a pause at all: if the bot spoke in the gap, the human
//      stopped, got an answer, and came back. That is a new turn.
//
//      This matters more than it sounds. Measured on 10 archived calls without
//      the check, the "median mid-thought pause" came out at 5.3 SECONDS and the
//      p90 at 51 seconds — nobody pauses for 51 seconds mid-sentence. It was
//      measuring whole conversational round-trips and calling them pauses, and
//      every recommendation downstream of it was worthless.
//
// Usage:
//   node scripts/sweep-verdict.mjs <labels.json...> [--target-interrupt 5]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const files = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
if (!files.length) {
  console.error('usage: sweep-verdict.mjs <labels.json...> [--target-interrupt PCT]');
  process.exit(2);
}

// The one POLICY number in here, stated rather than buried: how often it is
// acceptable to cut a human off mid-thought. The data cannot choose this — it
// is a taste decision about which error hurts more, and every "recommended"
// value below is downstream of it. Change it and the recommendations move.
const TARGET_INTERRUPT_PCT = Number(flag('target-interrupt', '5'));

const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : null);
const isBot = (name) => /^bot$/i.test(name) || /bot$/i.test(name);

// A pause we could plausibly cut into. Beyond this the bot has long since
// answered, so the gap says nothing about how patient it should be, and
// including it drags the percentiles into nonsense.
const MAX_PAUSE_MS = 8000;

const resumeGaps = [];  // same speaker starts again: a PAUSE, not an ending
const switchGaps = [];  // someone else takes over: a real turn boundary
const overlaps = [];    // two people talking at once
let calls = 0, skipped = 0, humanSpeakers = 0;
let longGaps = 0;   // same speaker, but too far apart to be one thought
let answered = 0;   // same speaker, but the bot replied in between

for (const f of files) {
  let d;
  try { d = JSON.parse(readFileSync(f, 'utf8')); } catch { skipped++; continue; }
  const all = d.speakers || [];
  const botSpans = all.filter((s) => isBot(s.name)).flatMap((s) => s.spans || []);
  const speakers = all.filter((s) => !isBot(s.name));
  if (speakers.length < 2) { skipped++; continue; }
  const botSpokeBetween = (a, b) => botSpans.some(([s, e]) => e > a && s < b);
  calls++; humanSpeakers += speakers.length;

  const events = speakers.flatMap((s, who) => (s.spans || []).map(([st, e]) => ({ s: st, e, who })))
    .sort((x, y) => x.s - y.s);

  for (let i = 0; i < events.length - 1; i++) {
    const cur = events[i], next = events[i + 1];
    const gap = next.s - cur.e;
    if (gap < 0) continue;                       // overlap, counted below
    if (next.who !== cur.who) { switchGaps.push(gap); continue; }
    // Same speaker again — a pause only if nothing happened in between and it
    // is short enough that the bot would still have been waiting.
    if (gap > MAX_PAUSE_MS) { longGaps++; continue; }
    if (botSpokeBetween(cur.e, next.s)) { answered++; continue; }
    resumeGaps.push(gap);
  }
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      if (events[j].s >= events[i].e) break;     // sorted by start: no later one can overlap
      if (events[j].who === events[i].who) continue;
      const ov = Math.min(events[i].e, events[j].e) - events[j].s;
      if (ov > 0) overlaps.push(ov);
    }
  }
}

console.log(`corpus: ${calls} call(s) usable, ${skipped} skipped, ${humanSpeakers} human speaker-tracks`);
console.log(`        ${resumeGaps.length} pauses · ${switchGaps.length} handovers · ${overlaps.length} overlaps`);
console.log(`        (discarded ${longGaps} same-speaker gaps over ${MAX_PAUSE_MS}ms and `
  + `${answered} where the bot answered in between — neither is a mid-thought pause)`);
if (!resumeGaps.length || !switchGaps.length) {
  console.log('\nNot enough labelled conversation to say anything. No verdict.');
  process.exit(0);
}
console.log(`policy: cutting someone off is acceptable at most ${TARGET_INTERRUPT_PCT}% of the time\n`);

const schema = require(join(dirname(fileURLToPath(import.meta.url)), '..', 'electron-app', 'preferences-schema.js'));
const prefs = schema.PREFERENCES || schema.preferences || schema;
const current = (k) => (prefs[k] || {}).default;

const verdicts = [];
function verdict(key, currentValue, recommended, unit, detail) {
  // "Close enough" is not a fudge: these are noisy percentile estimates, and
  // reporting a 40ms move as a finding would train everyone to ignore this.
  const drift = Math.abs(recommended - currentValue) / currentValue;
  const holds = drift < 0.2;
  verdicts.push({ key, holds });
  console.log(`${holds ? 'HOLDS ' : 'MOVED '} ${key} = ${currentValue}${unit}`);
  console.log(`        data says ~${recommended}${unit} — ${detail}\n`);
}

// defaultSilenceSeconds: wait long enough that an ordinary mid-thought pause is
// not read as the end of a turn.
const silenceMs = current('defaultSilenceSeconds') * 1000;
const cutInAt = (ms) => 100 * resumeGaps.filter((g) => g > ms).length / resumeGaps.length;
let wantSilence = null;
for (let ms = 200; ms <= MAX_PAUSE_MS; ms += 50) if (cutInAt(ms) <= TARGET_INTERRUPT_PCT) { wantSilence = ms; break; }

const nowCutIn = cutInAt(silenceMs);
const shape = `pauses run p50 ${pct(resumeGaps, 0.5)}ms, p90 ${pct(resumeGaps, 0.9)}ms`;
// ALWAYS price the trade, even when the target is reachable. On the current
// corpus "5% interruptions" comes out at 6.5 seconds, which is a technically
// correct answer and a useless one: a bot that waits six and a half seconds
// before every reply is dead air, not politeness. Printing that number alone
// would look like a recommendation. The table is the honest artefact — the
// choice between cutting people off and being slow is a taste call, and this
// can only show what each row costs.
const costAt = (ms) => pct(switchGaps.filter((g) => g < ms).map((g) => ms - g), 0.5) ?? 0;
const priceTable = () => {
  console.log('        the trade, priced:');
  for (const ms of [1000, 1400, 2000, 3000, 4000, 6000]) {
    console.log(`          ${String(ms).padStart(5)}ms  cuts in on ${cutInAt(ms).toFixed(1).padStart(5)}%`
      + `   adds a median +${String(costAt(ms)).padStart(4)}ms to a real handover`);
  }
  console.log('        This is a taste call, not a data one. Pick a row.\n');
};

if (wantSilence) {
  verdict('defaultSilenceSeconds', current('defaultSilenceSeconds'), +(wantSilence / 1000).toFixed(2), 's',
    `at ${silenceMs}ms we cut in on ${nowCutIn.toFixed(1)}% of pauses; ${shape}`);
  priceTable();
} else {
  // No reachable answer is itself the finding, and printing "?" would hide it.
  // Human pauses have a long tail, so past some point buying a lower
  // interrupt rate costs more delay than anyone will sit through. Say what the
  // target would actually cost instead of pretending there is a clean value.
  console.log(`UNREACHABLE defaultSilenceSeconds = ${current('defaultSilenceSeconds')}s`);
  console.log(`        no wait under ${MAX_PAUSE_MS}ms gets interruptions to ${TARGET_INTERRUPT_PCT}%.`);
  console.log(`        at ${silenceMs}ms we cut in on ${nowCutIn.toFixed(1)}% of pauses; ${shape}`);
  priceTable();
  verdicts.push({ key: 'defaultSilenceSeconds', holds: false });
}

// bargeInGraceMs: keep talking through short overlaps, because most are
// backchannels the speaker never meant as a floor grab.
const grace = current('bargeInGraceMs');
const ridesOut = (ms) => 100 * overlaps.filter((o) => o <= ms).length / (overlaps.length || 1);
verdict('bargeInGraceMs', grace, pct(overlaps, 0.75) ?? '?', 'ms',
  overlaps.length
    ? `at ${grace}ms we ride out ${ridesOut(grace).toFixed(1)}% of overlaps; `
      + `overlaps run p50 ${pct(overlaps, 0.5)}ms, p90 ${pct(overlaps, 0.9)}ms`
    : 'no overlaps in this corpus — nothing to say');

const moved = verdicts.filter((v) => !v.holds);
console.log(moved.length
  ? `${moved.length} constant(s) look wrong: ${moved.map((v) => v.key).join(', ')}`
  : 'Every constant still sits where the data puts it. Nothing to change.');
// Non-zero when something moved, so a caller can decide whether to shout.
process.exit(moved.length ? 3 : 0);
