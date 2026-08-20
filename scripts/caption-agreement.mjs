#!/usr/bin/env node
//
// caption-agreement.mjs — do the bots in a call see the SAME transcript?
//
// The deterministic speak ordering (#100, electron-app/speak-order.js) keys on
// the utterance being answered: every bot hashes it to pick the same winner
// without exchanging anything. That rests on an assumption worth testing rather
// than asserting — Meet's captions are generated once, server-side, and
// broadcast, so every participant should see identical text.
//
// This asks each bot what it has, lines the transcripts up, and reports the two
// things the ordering actually depends on:
//
//   1. Do they agree on the last utterance from someone else?
//   2. Do they derive the same SEED from it? The seed uses the first 8 words
//      normalised, precisely so a late ASR revision to the tail cannot change
//      it — so bots can disagree on the exact text and still agree on the key.
//
// Run (bots must be in a call):
//   node scripts/caption-agreement.mjs --bots Alice:7901,Jimmy:7902,Cosmo:7903

import { createRequire } from 'node:module';
import { resolveTarget } from './meet-targets.mjs';

const require = createRequire(import.meta.url);
const { turnKey, hash32 } = require('../electron-app/speak-order.js');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const ROOM = flag('room', resolveTarget(flag('target', 'default')).room);
const SHOW = Number(flag('show', '5'));
const BOTS = flag('bots', 'Alice:7901,Jimmy:7902,Cosmo:7903').split(',').map((s) => {
  const [name, port] = s.split(':');
  return { name, port: Number(port) };
});

async function transcriptOf(bot) {
  try {
    const resp = await fetch(`http://127.0.0.1:${bot.port}/api/sync/${ROOM}`);
    const data = await resp.json();
    return ((data && data.transcript && data.transcript.entries) || [])
      .map((e) => ({ who: e.participantName, text: e.text, at: e.timestamp }));
  } catch (err) { return { error: err.message }; }
}

const views = [];
for (const b of BOTS) {
  const t = await transcriptOf(b);
  if (t.error) { console.log(`${b.name}: unreachable (${t.error})`); continue; }
  views.push({ bot: b.name, entries: t });
}
if (views.length < 2) { console.error('need at least two reachable bots in a call'); process.exit(2); }

console.log(`transcript sizes: ${views.map((v) => `${v.bot}=${v.entries.length}`).join('  ')}\n`);

// --- the last few utterances, as each bot has them --------------------------
console.log(`last ${SHOW} entries per bot`);
for (const v of views) {
  console.log(`\n  ${v.bot}`);
  for (const e of v.entries.slice(-SHOW)) {
    console.log(`    ${String(e.who).padEnd(14)} ${JSON.stringify(String(e.text).slice(0, 72))}`);
  }
}

// --- what each bot would use as its seed ------------------------------------
//
// The ordering keys on the last utterance NOT from this bot — which is what
// every bot in the call saw, and therefore what they can all agree on.
console.log('\n\nthe seed each bot would derive');
const seeds = [];
// Exclude EVERY bot, not just this one. "The last utterance not from me" is
// self-relative and gives each bot a different answer in a multi-bot exchange —
// which is exactly the disagreement this script was written to find.
const botNames = new Set(views.map((v) => v.bot.toLowerCase()));
for (const v of views) {
  const last = [...v.entries].reverse().find((e) => e.text && e.who && !botNames.has(String(e.who).toLowerCase()));
  if (!last) { console.log(`  ${v.bot.padEnd(14)} (nothing from anyone else — would fall back to jitter)`); seeds.push(null); continue; }
  const key = turnKey(last.who, last.text);
  seeds.push(key);
  console.log(`  ${v.bot.padEnd(14)} from ${String(last.who).padEnd(14)} key=${JSON.stringify(key.slice(0, 56))} hash=${hash32(key)}`);
}

const present = seeds.filter(Boolean);
const agree = present.length > 1 && new Set(present).size === 1;
console.log('\n' + (agree
  ? `✅ all ${present.length} bots derive the SAME seed — the ordering agrees`
  : `❌ seeds DIFFER (${new Set(present).size} distinct among ${present.length}) — bots would compute different winners`));

// If they differ, say exactly where: same utterance but different text, or a
// different utterance entirely. Those have different fixes — the first is an
// ASR revision the seed should be made robust to, the second means one bot is
// missing captions the others have.
if (!agree && present.length > 1) {
  const lasts = views.map((v) => ({
    bot: v.bot,
    last: [...v.entries].reverse().find((e) => e.text && e.who && e.who !== v.bot),
  })).filter((x) => x.last);
  const speakers = new Set(lasts.map((x) => x.last.who));
  const texts = new Set(lasts.map((x) => String(x.last.text).trim().toLowerCase()));
  console.log(speakers.size > 1
    ? `   cause: they are keying on DIFFERENT utterances (${[...speakers].join(' vs ')}) — someone is behind or missing captions`
    : `   cause: same speaker, different TEXT — ${[...texts].map((t) => JSON.stringify(t.slice(0, 60))).join('\n           vs ')}`);
}
