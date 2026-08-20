#!/usr/bin/env node
//
// analyse-turn-taking.mjs — what the CONVERSATION says our timing knobs should
// be (#422).
//
// The detector sweeps ask "how fast can we see a turn end". This asks the
// prior question: how long is a pause that is NOT the end of a turn? That
// number belongs to human conversation, not to our code, so it can be measured
// from labelled recordings alone — no calls, no replay, no detector involved.
//
// Two knobs fall straight out of it:
//
//   defaultSilenceSeconds — how long the bot waits after speech stops before
//     treating the turn as finished. Set it below a speaker's ordinary
//     mid-thought pause and the bot interrupts; set it far above and every
//     reply is late. The labels give both error rates directly.
//
//   bargeInGraceMs — how long the bot keeps talking after it detects someone
//     starting. Most overlaps in real conversation are backchannels ("mm-hm")
//     that the speaker does NOT intend as a floor grab, and riding those out is
//     the entire point of the grace. The overlap-duration distribution says
//     where the line between a backchannel and a real interruption sits.
//
// Usage: node scripts/analyse-turn-taking.mjs labels-*.json

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length) { console.error('usage: analyse-turn-taking.mjs <labels.json...>'); process.exit(2); }

const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length * p)] : null);

const resumeGaps = [];     // same speaker starts again — a PAUSE, not an ending
const switchGaps = [];     // the other speaker takes over — a real turn boundary
const overlaps = [];       // how long two speakers are talking at once
let calls = 0;

for (const f of files) {
  const d = JSON.parse(readFileSync(f, 'utf8'));
  if (d.speakers.length !== 2) continue;
  calls++;
  const [A, B] = d.speakers;
  const events = [
    ...A.spans.map(([s, e]) => ({ s, e, who: 0 })),
    ...B.spans.map(([s, e]) => ({ s, e, who: 1 })),
  ].sort((x, y) => x.s - y.s);

  for (let i = 0; i < events.length - 1; i++) {
    const cur = events[i];
    // The next speech that STARTS after this one ends. Anything starting before
    // it ends is overlap, handled below.
    const next = events.slice(i + 1).find((n) => n.s >= cur.e);
    if (!next) continue;
    const gap = next.s - cur.e;
    if (gap > 15000) continue;                 // a topic break, not turn-taking
    (next.who === cur.who ? resumeGaps : switchGaps).push(gap);
  }

  for (const a of A.spans) {
    for (const b of B.spans) {
      const ov = Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
      if (ov > 0) overlaps.push(ov);
    }
  }
}

console.log(`${calls} calls · ${resumeGaps.length} same-speaker pauses · `
  + `${switchGaps.length} speaker switches · ${overlaps.length} overlaps\n`);

console.log('PAUSE LENGTHS (ms)              p50    p75    p90    p95    p99');
const row = (name, a) => console.log(`${name.padEnd(30)}`
  + [0.5, 0.75, 0.9, 0.95, 0.99].map((p) => String(pct(a, p)).padStart(6)).join(' '));
row('same speaker resumes (pause)', resumeGaps);
row('other speaker takes over', switchGaps);
row('overlap duration', overlaps);

// The trade-off, priced. Waiting X ms after speech stops:
//   - interrupts anyone whose ordinary pause is longer than X
//   - and costs X ms on every turn where they really had finished.
console.log('\ndefaultSilenceSeconds — what each threshold costs');
console.log('  wait     interrupts a pause     added delay on a real handover');
for (const ms of [600, 800, 1000, 1200, 1400, 1600, 2000, 2500, 3000]) {
  const cutIn = resumeGaps.filter((g) => g > ms).length;
  const rate = (100 * cutIn / resumeGaps.length).toFixed(1);
  // A handover where the other speaker would have started before our threshold
  // expires is a turn we answer late by (ms - their gap).
  const late = switchGaps.filter((g) => g < ms).map((g) => ms - g);
  console.log(`  ${String(ms).padStart(5)}ms  ${rate.padStart(6)}% (${String(cutIn).padStart(4)})`
    + `        median +${String(pct(late, 0.5) ?? 0).padStart(4)}ms on ${late.length} of ${switchGaps.length}`);
}

console.log('\nbargeInGraceMs — how much overlap is a backchannel, not a floor grab');
for (const ms of [300, 500, 800, 1000, 1500, 2000, 2500]) {
  const ridden = overlaps.filter((o) => o <= ms).length;
  console.log(`  ${String(ms).padStart(5)}ms rides out ${(100 * ridden / overlaps.length).toFixed(1).padStart(5)}%`
    + ` of overlaps (${ridden}/${overlaps.length})`);
}
