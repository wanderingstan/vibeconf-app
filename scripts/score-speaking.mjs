#!/usr/bin/env node
//
// score-speaking.mjs — score speaking detection against ground truth, and sweep
// its constants offline (#422).
//
// The premise that makes this cheap: NONE of our detector constants change what
// Meet does. They only change what we CONCLUDE from a recording. So a single
// captured event stream (speakingEventCapture=true -> speaking-events.jsonl)
// can be re-scored at any window, attack, hold or lookback, and one call yields
// the whole parameter space instead of one call per candidate value.
//
// The detectors below are re-implementations of the ones in
// google-meet-provider.js, kept deliberately literal so they can be diffed
// against the originals by eye. If you change a detector there, change it here
// — and note that `verdict` events are captured too, so a sanity check is
// always available: replaying at the constants that were live should reproduce
// the verdicts that were actually emitted (--check).
//
// Usage:
//   node scripts/score-speaking.mjs --events speaking-events.jsonl --labels labels.json
//   node scripts/score-speaking.mjs ... --map speaker1=Alice,speaker2=Jimmy
//   node scripts/score-speaking.mjs ... --sweep window=400,600,800,1200
//   node scripts/score-speaking.mjs ... --sweep hold=150,250,400,600 --signal indicator
//   node scripts/score-speaking.mjs ... --check          # replay at live constants
//
// Alignment: labels are relative to the replayed track, events are wall-clock.
// --offset sets the gap explicitly; by default it is searched for (the maximum
// agreement between any-speaker labels and any-participant activity), which is
// both more accurate and less error-prone than bookkeeping it by hand.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// --- the detectors, re-implemented over a recorded event stream --------------

// Mutation counter — google-meet-provider.js _isSpeakingByMutation.
// Schmitt trigger: arm at >= ARM in-window mutations, release below RELEASE.
export function scoreCounter(muts, { windowMs = 1200, arm = 3, release = 2 } = {}, grid) {
  const out = [];
  let armed = false, i = 0;
  const inWindow = [];
  for (const t of grid) {
    while (i < muts.length && muts[i] <= t) { inWindow.push(muts[i]); i++; }
    while (inWindow.length && t - inWindow[0] > windowMs) inWindow.shift();
    if (armed) { if (inWindow.length < release) armed = false; }
    else if (inWindow.length >= arm) armed = true;
    out.push(armed);
  }
  return out;
}

// Indicator level — _readPromoted + _isSpeakingByMeter.
// Rest is learned exactly as the app learns it: the value held still for
// restHoldMs. Recorded as the RAW sprite offset precisely so this stays a
// parameter rather than a baked-in assumption.
// restMode selects HOW the resting bar is identified:
//   'park'     — what the app does today: the value held still for restHoldMs.
//   'flattest' — the smallest |offset| ever seen for this element.
//
// The difference is not cosmetic. The sprite is a ramp, so flat is one fixed
// end of it, and 'park' can be captured by a LOUD turn: hold the top bar for a
// second and rest becomes the top bar, after which silence reads as "off rest"
// and the signal is inverted until it parks at flat again. That was visible in
// production as rest=-40px on 4% of health beats.
export function scoreIndicator(readings, {
  attackMs = 50, holdMs = 250, restHoldMs = 1000, restMode = 'park',
} = {}, grid) {
  const out = [];
  let rest = null, lastVal = null, sameSince = 0, flattest = null;
  let run = 0, offSince = 0, lastMoveAt = 0;
  let i = 0;
  for (const t of grid) {
    while (i < readings.length && readings[i].t <= t) {
      const { t: rt, v } = readings[i]; i++;
      if (restMode === 'flattest') {
        const mag = Math.abs(parseFloat(v) || 0);
        if (flattest === null || mag < flattest.mag) flattest = { mag, v };
        rest = flattest.v;
      } else if (v === lastVal) {
        if (rt - sameSince >= restHoldMs) rest = v;
      } else { lastVal = v; sameSince = rt; }
      if (rest === null) continue;              // not calibrated yet
      if (v !== rest) {
        run++;
        if (!offSince) offSince = rt;
        if (run >= 2 && (rt - offSince) >= attackMs) lastMoveAt = rt;
      } else { run = 0; offSince = 0; }
    }
    out.push(rest !== null && !!lastMoveAt && (t - lastMoveAt) < holdMs);
  }
  return out;
}

// Echo guard — _rawSpeaking's suppression clause. Rising edges only; a verdict
// already true is left alone.
export function applyEchoGuard(verdicts, selfLoud, { lookbackMs = 700 } = {}, grid) {
  const out = [];
  let prev = false;
  let lastLoudAt = 0, i = 0;
  for (let k = 0; k < grid.length; k++) {
    const t = grid[k];
    while (i < selfLoud.length && selfLoud[i].t <= t) { if (selfLoud[i].loud) lastLoudAt = selfLoud[i].t; i++; }
    let v = verdicts[k];
    if (v && !prev && lastLoudAt && (t - lastLoudAt) < lookbackMs) v = false;
    out.push(v);
    prev = v;
  }
  return out;
}

// --- scoring ----------------------------------------------------------------

export function spansOf(verdicts, grid) {
  const spans = [];
  let start = null;
  for (let i = 0; i < verdicts.length; i++) {
    if (verdicts[i] && start === null) start = grid[i];
    else if (!verdicts[i] && start !== null) { spans.push([start, grid[i]]); start = null; }
  }
  if (start !== null) spans.push([start, grid[grid.length - 1]]);
  return spans;
}

const overlap = (a, b) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
const pct = (arr, p) => (arr.length ? arr.slice().sort((x, y) => x - y)[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null);

// Compare one participant's detected spans against their labelled speech.
//
// Onset latency is measured from the LABEL's start to the first detection that
// overlaps it. A detection that began before the label counts as 0, not as a
// negative: it is early, which the false-positive number already charges for,
// and letting it subtract would hide lateness elsewhere.
export function score(detected, labels) {
  const onsets = [], offsets = [], missedDurs = [];
  let missed = 0, fragments = 0;
  for (const L of labels) {
    const hits = detected.filter((d) => overlap(d, L) > 0);
    if (!hits.length) { missed++; missedDurs.push(L[1] - L[0]); continue; }
    fragments += hits.length;
    onsets.push(Math.max(0, hits[0][0] - L[0]));
    offsets.push(hits[hits.length - 1][1] - L[1]);
  }
  // False-positive time: detected time that overlaps no label at all.
  let fpMs = 0, fpEvents = 0;
  for (const d of detected) {
    const covered = labels.reduce((a, L) => a + overlap(d, L), 0);
    const extra = (d[1] - d[0]) - covered;
    if (covered === 0) { fpEvents++; fpMs += (d[1] - d[0]); }
    else fpMs += extra;
  }
  const labelledMs = labels.reduce((a, L) => a + (L[1] - L[0]), 0);
  return {
    turns: labels.length,
    missed,
    // Raw per-turn values, so results from several captures can be POOLED
    // properly. Averaging medians across captures is not the same statistic and
    // would quietly weight a 26-turn segment like a 300-turn one.
    onsets, offsets, missedDurations: missedDurs, labelledMs,
    onsetP50: pct(onsets, 0.5), onsetP90: pct(onsets, 0.9),
    offsetP50: pct(offsets, 0.5), offsetP90: pct(offsets, 0.9),
    fragPerTurn: labels.length ? (fragments / (labels.length - missed || 1)) : 0,
    fpEvents,
    fpSecPerMin: labelledMs ? (fpMs / 1000) / (labelledMs / 60000) : 0,
  };
}

// --- input ------------------------------------------------------------------

export function loadEvents(path) {
  const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const byParticipant = new Map();
  const selfLoud = [];
  for (const r of rows) {
    if (r.k === 'self') { selfLoud.push({ t: r.t, loud: r.v === 1 }); continue; }
    if (!r.p) continue;
    if (!byParticipant.has(r.p)) byParticipant.set(r.p, { muts: [], readings: [], verdicts: [] });
    const p = byParticipant.get(r.p);
    if (r.k === 'mut') p.muts.push(r.t);
    else if (r.k === 'ind') p.readings.push({ t: r.t, v: r.v });
    else if (r.k === 'verdict') p.verdicts.push({ t: r.t, on: r.v === 1 });
  }
  return { byParticipant, selfLoud, rows };
}

// Search the offset that best aligns labels to events. Coarse then fine, scored
// by agreement between "anyone labelled speaking" and "anything observed".
// Coarse-to-fine, over a WIDE range.
//
// +/-10s was not enough and produced silently wrong scores. A capture begins
// when the recorder starts, and playback begins later — after the join check,
// the warm-up settle and the base64 hand-off — which measured 21-46s on real
// runs. Worse, when one call serves several segments the later ones start
// minutes in. A search that cannot reach the true offset does not fail loudly;
// it returns a plausible number and every metric downstream is nonsense, which
// is exactly what happened to one segment of the first corpus.
function findOffset(activity, labelSpans, grid) {
  const anyLabel = labelSpans.flat().sort((a, b) => a[0] - b[0]);
  const test = (off) => {
    let s = 0;
    for (const L of anyLabel) s += activity.filter((d) => overlap(d, [L[0] + off, L[1] + off]) > 0).length;
    return s;
  };
  const span = grid[grid.length - 1] - grid[0];
  let best = { offset: grid[0], score: -1 };
  for (let off = -5000; off <= Math.min(span, 180000); off += 1000) {
    const sc = test(grid[0] + off);
    if (sc > best.score) best = { offset: grid[0] + off, score: sc };
  }
  for (let off = best.offset - 1000; off <= best.offset + 1000; off += 50) {
    const sc = test(off);
    if (sc > best.score) best = { offset: off, score: sc };
  }
  return best.offset;
}

// --- main -------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const flag = (n, d) => { const i = argv.indexOf('--' + n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
  const has = (n) => argv.includes('--' + n);
  const eventsPath = flag('events', null);
  const labelsPath = flag('labels', null);
  if (!eventsPath || !labelsPath) {
    console.error('usage: score-speaking.mjs --events speaking-events.jsonl --labels labels.json [--map s1=Alice,...] [--sweep window=400,600] [--signal counter|indicator|both]');
    process.exit(2);
  }
  const { byParticipant, selfLoud } = loadEvents(eventsPath);
  const labels = JSON.parse(readFileSync(labelsPath, 'utf8'));
  const map = new Map(flag('map', '').split(',').filter(Boolean).map((kv) => kv.split('=')));
  const stepMs = Number(flag('step', '10'));

  // Track the extent as we go rather than collecting every timestamp and
  // spreading it into Math.min/max. `Math.min(...allTs)` throws
  // "RangeError: Maximum call stack size exceeded" once the array is large
  // enough — each element becomes a function argument, and the limit is on the
  // order of 10^5. A real capture blows straight past it: a 51-minute call
  // wrote 613,347 events, and the whole archive sweep failed on every call
  // that had a full-length recording while the short ones passed, which is
  // exactly the shape that makes this look like a data problem rather than a
  // code one.
  let t0 = Infinity, t1 = -Infinity, nTs = 0;
  const seeTs = (t) => { nTs++; if (t < t0) t0 = t; if (t > t1) t1 = t; };
  for (const p of byParticipant.values()) { for (const t of p.muts) seeTs(t); for (const r of p.readings) seeTs(r.t); }
  if (!nTs) { console.error('no events in capture'); process.exit(2); }
  const grid = [];
  for (let t = t0; t <= t1; t += stepMs) grid.push(t);

  // Align labels to the capture.
  const activity = [];
  for (const p of byParticipant.values()) for (const t of p.muts) activity.push([t, t + 200]);
  const offset = flag('offset', null) !== null
    ? t0 + Number(flag('offset'))
    : findOffset(activity, labels.speakers.map((s) => s.spans), grid);
  console.log(`aligned: labels t=0 -> capture ${new Date(offset).toISOString()} (${offset - t0}ms into the capture)\n`);

  const signal = flag('signal', 'both');
  const sweep = flag('sweep', null);

  const runFor = (params) => {
    const rows = [];
    for (const sp of labels.speakers) {
      const who = map.get(sp.name) || sp.name;
      const p = byParticipant.get(who);
      if (!p) { rows.push({ who, note: 'no events for this participant — check --map' }); continue; }
      const L = sp.spans.map(([a, b]) => [a + offset, b + offset]);
      for (const kind of (signal === 'both' ? ['counter', 'indicator'] : [signal])) {
        let v = kind === 'counter'
          ? scoreCounter(p.muts, params, grid)
          : scoreIndicator(p.readings, params, grid);
        if (!has('no-guard')) v = applyEchoGuard(v, selfLoud, params, grid);
        const m = score(spansOf(v, grid), L);
        const { onsets: _o, offsets: _f, missedDurations: _d, ...summary } = m;
        rows.push({ who, kind, ...summary });
        collected.push({ source: eventsPath, who, speaker: sp.name, kind, params, ...m });
      }
    }
    return rows;
  };

  // --json dumps the per-turn measurements so results from SEVERAL captures can
  // be pooled. One 2-minute segment is 60 turns; a constant should not be
  // decided on that, and different calls differ in voice, mic and room.
  const jsonOut = flag('json', null);
  const collected = [];

  const fmt = (r) => r.note
    ? `${r.who.padEnd(14)} ${r.note}`
    : `${r.who.padEnd(14)} ${r.kind.padEnd(10)} turns=${String(r.turns).padStart(3)} missed=${String(r.missed).padStart(3)} `
      + `onset p50=${String(r.onsetP50).padStart(5)} p90=${String(r.onsetP90).padStart(5)} `
      + `offset p50=${String(r.offsetP50).padStart(5)} p90=${String(r.offsetP90).padStart(5)} `
      + `frag=${r.fragPerTurn.toFixed(2)} fp=${r.fpEvents}/${r.fpSecPerMin.toFixed(1)}s per min`;

  const dump = () => {
    if (!jsonOut) return;
    require('node:fs').writeFileSync(jsonOut, JSON.stringify(collected, null, 2));
    console.log(`\nwrote ${jsonOut} (${collected.length} rows)`);
  };

  if (!sweep) {
    for (const r of runFor({})) console.log(fmt(r));
    dump();
    return;
  }

  const [key, list] = sweep.split('=');
  console.log(`sweeping ${key}: ${list}\n`);
  for (const raw of list.split(',')) {
    const val = Number(raw);
    const numeric = { window: 'windowMs', hold: 'holdMs', attack: 'attackMs', lookback: 'lookbackMs' };
    const params = key === 'restMode' ? { restMode: raw } : { [numeric[key] || key]: val };
    console.log(`--- ${key}=${raw}`);
    for (const r of runFor(params)) console.log('  ' + fmt(r));
  }
  dump();
}

if (process.argv[1] && process.argv[1].endsWith('score-speaking.mjs')) main();
