#!/usr/bin/env node
// eval-call-log.mjs — point it at a Vibeconferencing session log and get a
// unified set of call stats. Parses the markers the app already logs (no app
// changes needed). Designed to grow — add a new extractor + a report line.
//
//   node scripts/eval-call-log.mjs <path-to-session.log>
//   node scripts/eval-call-log.mjs latest            # newest log in the app's logs dir
//   node scripts/eval-call-log.mjs <log> --json      # machine-readable
//   pnpm eval:log <log>
//
// The pure parser is exported as analyzeLog(text) so it's unit-testable; the CLI
// below is a thin wrapper (file resolution + rendering).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ── pure helpers ─────────────────────────────────────────────────────────────
// LEADING wall-clock stamp "HH:MM:SS.mmm" → ms-of-day. Anchored to start-of-line
// so it can't match a time inside an ISO datetime mid-line (e.g. the session-log
// `started=…T14:36:00.658Z` header). Returns null for header/un-stamped lines.
const tsOf = (line) => {
  const m = line.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
  if (!m) return null;
  return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4];
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
// Nearest-rank percentile (matches local-server's _perfStats p90).
const percentile = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))];
};
const emojisIn = (s) => Array.from(s.matchAll(/\p{Extended_Pictographic}/gu)).map((m) => m[0]);
const platformOf = (room) => {
  if (!room) return 'unknown';
  if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(room)) return 'google-meet';
  return 'slack-or-other';
};

const KNOWN_BENIGN_ERR = /Meet poll failed/i; // transient browser-tab scan timeouts

// ── the analyzer ─────────────────────────────────────────────────────────────
// Parse a session log's text and return a structured stats report.
export function analyzeLog(raw, file = '<input>') {
  const lines = raw.split('\n');

  const settings = {};
  const calls = [];
  const botSpeeches = [];
  const resolves = [];
  const perfSamples = []; // measured Claude reaction times (ms) from the ⚡ [perf] marker
  const thinks = [];
  const bargeDrops = [];
  const bargeReplays = []; // #239: stashes that auto-replayed on a silence edge
  const heardNames = new Set();
  const silenceNames = new Set();
  const emojiCount = new Map();
  const errors = [];
  const callStatusEvents = []; // { ts, status } — the authoritative in-call window
  let ticks = 0, ackTrig = 0, ackSkip = 0, wbUpdates = 0, chatOps = 0, captionStalls = 0;
  let botName = null, sessionStarted = null, version = null, platform = null, profile = null;

  for (const line of lines) {
    let m = line.match(/\[session-log\]\s+([A-Za-z0-9_]+)=(.*?)(?:\s+\(updated|$)/);
    if (m) {
      const [, k, v] = m;
      if (k === 'botName') botName = v.trim();
      else if (k === 'started') sessionStarted = v.trim();
      else if (k === 'version') version = v.trim();
      else if (k === 'platform') platform = v.trim();
      else if (k === 'profile') profile = v.trim();
      else if (k === 'roomId') settings._roomId = v.trim();
      else if (!['pid', 'electron'].includes(k)) settings[k] = v.trim();
      continue;
    }
    const ts = tsOf(line);

    if ((m = line.match(/\[call\]\s+id=(\S+)\s+room=(\S+)\s+status=(\S+)/))) {
      calls.push({ ts, id: m[1], room: m[2], status: m[3] });
      continue;
    }
    if ((m = line.match(/\[local-server\] Call status:\s+([a-z-]+)/))) {
      callStatusEvents.push({ ts, status: m[1] });
      continue;
    }
    if ((m = line.match(/\[local-server\] Bot speech:\s+(.*?)\s*\(emoji:\s*(\S+?)\)\s*$/))) {
      const [, text, emoji] = m;
      botSpeeches.push({ ts, text, emoji });
      for (const e of emojisIn(emoji)) emojiCount.set(e, (emojiCount.get(e) || 0) + 1);
      continue;
    }
    if ((m = line.match(/\[resolve\] wait_for_speech resolved — reason=(\w+)(?:,\s*waited=(\d+)ms)?/))) {
      resolves.push({ ts, reason: m[1], waited: m[2] ? +m[2] : null });
      continue;
    }
    if ((m = line.match(/\[thinking\] Processing transcript — (\d+) words/))) {
      thinks.push({ ts, words: +m[1] });
      continue;
    }
    // Measured Claude reaction time (resolve → first speak), logged live by
    // local-server. Precise — preferred over the timestamp-derived quick reply
    // below (which is all we can do on older logs without this marker).
    if ((m = line.match(/\[perf\] Claude responded in (\d+)ms/))) {
      perfSamples.push(+m[1]);
      continue;
    }
    // A barge-in that took the floor from the bot. Two variants both count as a
    // yield: the reply was discarded ("Dropped bot speech") or, post-#239,
    // stashed for auto-replay ("Stashed dropped bot speech").
    if (/\[barge-in\] (Stashed d|D)ropped bot speech/.test(line)) {
      bargeDrops.push({ ts, stashed: /Stashed dropped bot speech/.test(line) });
      continue;
    }
    if (/\[barge-in\] replaying stash/.test(line)) { bargeReplays.push({ ts }); continue; }
    if ((m = line.match(/\[heard\]\s+([^:]+):/))) { heardNames.add(m[1].trim()); continue; }
    if ((m = line.match(/\[silence\] User\(s\) stopped speaking:\s+(.+)$/))) {
      for (const n of m[1].split(',').map((s) => s.trim()).filter(Boolean)) silenceNames.add(n);
      continue;
    }
    if (/\[background-tick\] surfacing/.test(line)) { ticks++; continue; }
    if (/\[ack\] trigger:/.test(line)) { ackTrig++; continue; }
    if (/\[ack\] Skipping/.test(line)) { ackSkip++; continue; }
    if (/Whiteboard update from/.test(line)) { wbUpdates++; continue; }
    if (/\bsendChat\b|Chat unread: true/.test(line)) { chatOps++; continue; }
    if (/\[caption-stall\]/.test(line)) { captionStalls++; continue; }
    if (/❌|\[error\]|\bexception\b/i.test(line) || (/\bfailed\b|\berror\b/i.test(line) && !/caption|suppressErrorRendering|<div|<button|html=/.test(line))) {
      errors.push({ ts, text: line.replace(/^[\d:.\s]+/, '').slice(0, 160), benign: KNOWN_BENIGN_ERR.test(line) });
    }
  }

  // derive
  const stamped = lines.map(tsOf).filter((t) => t != null);
  const firstTs = stamped[0] ?? null;
  const lastTs = stamped[stamped.length - 1] ?? null;
  let durationMs = firstTs != null && lastTs != null ? lastTs - firstTs : null;
  if (durationMs != null && durationMs < 0) durationMs += 24 * 3600 * 1000;

  // The CALL window is bounded by the authoritative `Call status` transitions
  // (in-call → idle/left), NOT the first/last log line — the app keeps logging
  // idle browser-tab polls for a long time after the call ends, which would
  // wildly overcount the duration. Fall back to the [call] marker, then to the
  // first/last actual in-call activity, only when status transitions are absent.
  const inCallEvt = callStatusEvents.find((e) => e.status === 'in-call');
  const joinEvt = callStatusEvents.find((e) => /join|waiting/.test(e.status));
  const activityStart = [botSpeeches[0]?.ts, resolves[0]?.ts, thinks[0]?.ts].filter((t) => t != null);
  const callStartTs = calls[0]?.ts ?? inCallEvt?.ts ?? joinEvt?.ts ?? (activityStart.length ? Math.min(...activityStart) : firstTs);
  const endEvt = callStatusEvents.find((e) => e.ts != null && callStartTs != null && e.ts >= callStartTs && /idle|left/.test(e.status));
  const lastActivityTimes = [botSpeeches.at(-1)?.ts, resolves.at(-1)?.ts, thinks.at(-1)?.ts, bargeDrops.at(-1)?.ts].filter((t) => t != null);
  const callEndTs = endEvt?.ts ?? (lastActivityTimes.length ? Math.max(...lastActivityTimes) : lastTs);
  let callDurationMs = callStartTs != null && callEndTs != null ? callEndTs - callStartTs : null;
  if (callDurationMs != null && callDurationMs < 0) callDurationMs += 24 * 3600 * 1000;
  const callEndedHow = endEvt ? `status:${endEvt.status}` : (lastActivityTimes.length ? 'last-activity' : 'last-log-line');

  const participants = new Set([...heardNames, ...silenceNames]);
  if (botName) participants.delete(botName);

  // LLM latency: per resolve, the bot speeches before the next resolve. First =
  // quick reply (split-response phase a), last = full response (phase c).
  const quick = [], full = [];
  for (let i = 0; i < resolves.length; i++) {
    const t0 = resolves[i].ts;
    const t1 = resolves[i + 1]?.ts ?? Infinity;
    if (t0 == null) continue;
    const turn = botSpeeches.filter((s) => s.ts != null && s.ts >= t0 && s.ts < t1);
    if (!turn.length) continue;
    quick.push(turn[0].ts - t0);
    full.push(turn[turn.length - 1].ts - t0);
  }

  let room = calls[0]?.room || settings._roomId || null;
  if (!room) {
    for (const line of lines) {
      const m = line.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})|room[:/ ]\s*([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i);
      if (m) { room = m[1] || m[2]; break; }
    }
  }
  const platform2 = platformOf(room);
  const callUrl = platform2 === 'google-meet' ? `https://meet.google.com/${room}` : (room || null);

  const realErrors = errors.filter((e) => !e.benign);
  const emojisSorted = [...emojiCount.entries()].sort((a, b) => b[1] - a[1]);
  const cleanSettings = Object.fromEntries(Object.entries(settings).filter(([k]) => !k.startsWith('_')));

  return {
    file,
    call: { id: calls[0]?.id || null, room, platform: platform2, url: callUrl, started: sessionStarted, durationMs: callDurationMs, durationBasis: callEndedHow, logSpanMs: durationMs, callsInLog: calls.length },
    app: { version, platform, profile, botName },
    settings: cleanSettings,
    participants: { count: participants.size, names: [...participants].sort(), bot: botName },
    bot: { spoke: botSpeeches.length, avgWords: mean(botSpeeches.map((s) => s.text.trim().split(/\s+/).length)), greeting: botSpeeches[0]?.text || null },
    latency: {
      turnsWithResponse: quick.length,
      quickReply: { meanMs: mean(quick), medianMs: median(quick) },
      fullResponse: { meanMs: mean(full), medianMs: median(full) },
      waitForSpeechMeanMs: mean(resolves.map((r) => r.waited).filter((x) => x != null)),
      // Precise Claude reaction time straight from the ⚡ [perf] marker (the
      // "how fast is Claude today" signal). Empty on logs predating the marker.
      measured: {
        count: perfSamples.length,
        meanMs: mean(perfSamples),
        medianMs: median(perfSamples),
        p90Ms: percentile(perfSamples, 90),
        minMs: perfSamples.length ? Math.min(...perfSamples) : null,
        maxMs: perfSamples.length ? Math.max(...perfSamples) : null,
      },
    },
    turnTaking: { botYieldedToHuman: bargeDrops.length, bargeStashed: bargeDrops.filter((d) => d.stashed).length, stashReplays: bargeReplays.length, silenceResolutions: resolves.length, thinkingTurns: thinks.length },
    emojis: emojisSorted.map(([e, n]) => ({ emoji: e, count: n })),
    errors: { total: errors.length, real: realErrors.length, transient: errors.length - realErrors.length, sample: realErrors.slice(0, 5).map((e) => e.text) },
    engagement: { backgroundTicks: ticks, acksTriggered: ackTrig, acksSkipped: ackSkip, whiteboardUpdates: wbUpdates, chatOps, captionStalls },
  };
}

// ── text rendering ───────────────────────────────────────────────────────────
const fmtDur = (ms) => {
  if (ms == null) return '—';
  let s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  return (h ? `${h}h ` : '') + (h || m ? `${m}m ` : '') + `${s}s`;
};
export function renderReport(r) {
  const ms = (x) => (x == null ? '—' : `${Math.round(x)}ms`);
  const L = [];
  L.push('═'.repeat(64));
  L.push(`CALL LOG ANALYSIS  ·  ${r.file.split('/').pop()}`);
  L.push('═'.repeat(64));
  L.push('');
  L.push('CALL');
  L.push(`  id            ${r.call.id || '—'}`);
  L.push(`  room          ${r.call.room || '—'}  (${r.call.platform})`);
  L.push(`  url           ${r.call.url || '—'}`);
  L.push(`  started       ${r.call.started || '—'}`);
  const idleTail = r.call.logSpanMs != null && r.call.durationMs != null ? r.call.logSpanMs - r.call.durationMs : 0;
  L.push(`  duration      ${fmtDur(r.call.durationMs)}  (in-call → ${r.call.durationBasis})${r.call.callsInLog > 1 ? ` · ${r.call.callsInLog} calls in log` : ''}`);
  if (idleTail > 120000) L.push(`                (log also spans ${fmtDur(idleTail)} of pre/post-call idle)`);
  L.push(`  app           v${r.app.version || '?'}  ·  ${r.app.platform || '?'}  ·  profile=${r.app.profile || '?'}`);
  L.push('');
  L.push(`PARTICIPANTS  (${r.participants.count})`);
  L.push(`  ${r.participants.names.join(', ') || '—'}`);
  if (r.app.botName) L.push(`  bot: ${r.app.botName}`);
  L.push('');
  L.push('SETTINGS  (experimental flags in effect)');
  for (const [k, v] of Object.entries(r.settings)) L.push(`  ${k.padEnd(24)} ${v}`);
  L.push('');
  L.push('BOT ACTIVITY');
  L.push(`  spoke                    ${r.bot.spoke} time(s)`);
  L.push(`  avg words / utterance    ${r.bot.avgWords != null ? Math.round(r.bot.avgWords) : '—'}`);
  L.push(`  greeting                 ${r.bot.greeting ? `"${r.bot.greeting.slice(0, 50)}${r.bot.greeting.length > 50 ? '…' : ''}"` : '—'}`);
  L.push('');
  L.push('RESPONSE LATENCY  (from silence-resolution to bot speaking)');
  L.push(`  turns answered           ${r.latency.turnsWithResponse}`);
  const meas = r.latency.measured;
  if (meas && meas.count) {
    // Measured directly by local-server — the authoritative "how fast is Claude
    // today" reaction time. Shown first; the derived numbers below corroborate.
    L.push(`  ⚡ Claude reaction (measured, n=${meas.count})`);
    L.push(`       mean ${ms(meas.meanMs)}  ·  median ${ms(meas.medianMs)}  ·  p90 ${ms(meas.p90Ms)}  ·  range ${ms(meas.minMs)}–${ms(meas.maxMs)}`);
  } else {
    L.push(`  ⚡ Claude reaction (measured)   — none (log predates the [perf] marker; using derived below)`);
  }
  L.push(`  quick reply  (1st, derived) mean ${ms(r.latency.quickReply.meanMs)}  ·  median ${ms(r.latency.quickReply.medianMs)}`);
  L.push(`  full response (final)    mean ${ms(r.latency.fullResponse.meanMs)}  ·  median ${ms(r.latency.fullResponse.medianMs)}`);
  L.push(`  wait_for_speech dur      mean ${ms(r.latency.waitForSpeechMeanMs)}  (total listen time/turn, incl. quiet)`);
  L.push('');
  L.push('TURN-TAKING');
  L.push(`  bot yielded to a human   ${r.turnTaking.botYieldedToHuman}  (barge-in: gave up the floor)`);
  L.push(`    ├ reply stashed         ${r.turnTaking.bargeStashed}  (#239: held for auto-replay, not discarded)`);
  L.push(`    └ stash replayed        ${r.turnTaking.stashReplays}  (queued reply spoken on the next silence)`);
  L.push(`  silence resolutions      ${r.turnTaking.silenceResolutions}`);
  L.push('');
  L.push('EMOJIS  (bot, by frequency)');
  L.push(`  ${r.emojis.length ? r.emojis.map((e) => `${e.emoji}×${e.count}`).join('   ') : '—'}`);
  L.push('');
  L.push('ERRORS');
  L.push(`  real                     ${r.errors.real}`);
  L.push(`  transient (Meet poll)    ${r.errors.transient}`);
  for (const e of r.errors.sample) L.push(`    · ${e}`);
  L.push('');
  L.push('ENGAGEMENT KNOBS OBSERVED');
  L.push(`  background ticks         ${r.engagement.backgroundTicks}`);
  L.push(`  acks: triggered/skipped  ${r.engagement.acksTriggered} / ${r.engagement.acksSkipped}`);
  L.push(`  whiteboard updates       ${r.engagement.whiteboardUpdates}`);
  L.push(`  chat ops                 ${r.engagement.chatOps}`);
  L.push(`  caption stalls (deaf)    ${r.engagement.captionStalls}`);
  L.push('═'.repeat(64));
  return L.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const LOGS_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Vibeconferencing', 'logs');
function newestLogIn(dir) {
  const found = [];
  for (const d of [dir, path.join(dir, 'archive')]) {
    try {
      for (const f of fs.readdirSync(d)) {
        if (f.endsWith('.log')) { const p = path.join(d, f); found.push({ p, m: fs.statSync(p).mtimeMs }); }
      }
    } catch { /* no such dir */ }
  }
  found.sort((a, b) => b.m - a.m);
  return found[0]?.p || null;
}
function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  let file = args.find((a) => !a.startsWith('-'));
  if (!file || file === 'latest' || file === 'last') {
    file = newestLogIn(LOGS_DIR);
    if (!file) { console.error(`No logs found in ${LOGS_DIR}. Pass a path explicitly.`); process.exit(1); }
    console.error(`(using latest: ${file})\n`);
  } else if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    const newest = newestLogIn(file);
    if (!newest) { console.error(`No .log files in ${file}`); process.exit(1); }
    file = newest;
  }
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { console.error(`Cannot read ${file}: ${e.message}`); process.exit(1); }
  const report = analyzeLog(raw, file);
  console.log(asJson ? JSON.stringify(report, null, 2) : renderReport(report));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
