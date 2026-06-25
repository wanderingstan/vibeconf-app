#!/usr/bin/env node
// slack-test.mjs — agent-less smoke test for the Slack huddle backend (#265).
//
// Unlike meet-test.mjs, this does NOT call bot.join(): Slack bots AUTO-JOIN the
// huddle on launch (via --provider=slack --slack-url=…), and join() would issue
// a Google Meet join_call that navigates the bot OUT of the huddle into Meet.
// So we drive the already-in-huddle bots in place — exercising the command IPC
// wiring (speak → main-window VirtualMic; chat → huddle popup SlackProvider).
//
// PREREQ: launch the Slack fleet first, signed-in profiles, in the test channel:
//   scripts/spawn-test-fleet.sh 2 --slack --slack-url=https://app.slack.com/client/<team>/<channel>
//   (or 1 bot + your own human account in the huddle)
//
// Run:
//   node scripts/slack-test.mjs --bots Jimmy:7901,Samantha:7902
//   node scripts/slack-test.mjs --bots Jimmy:7901              # single-bot smoke
//
// Exit code is non-zero if any step failed — so it can gate CI later.

import { createRequire } from 'module';
import { Bot, sleep, report, record } from './meet-test-lib.mjs';

// Reuse the app's room-code derivation so the test drives the SAME room the app
// keyed at launch (slack-<team>-<channel>). Otherwise a placeholder path would
// write transcripts to a phantom vibeconferencing room that the app never uses.
const require = createRequire(import.meta.url);
const { SLACK } = require('../electron-app/slack-selectors.js');

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def; };
// Room = the per-huddle code derived from --slack-url (the channel the fleet
// joined), matching what the app set via SLACK.roomCodeFromUrl. --room overrides;
// 'slack-huddle' is the last-resort fallback when neither is supplied.
const slackUrl = arg('slack-url', '');
const ROOM = arg('room', (slackUrl && SLACK.roomCodeFromUrl(slackUrl)) || 'slack-huddle');
const BOTS = arg('bots', 'Jimmy:7901').split(',').map((s) => { const [name, port] = s.split(':'); return new Bot(name, Number(port), ROOM); });

// Per-run nonces so each bot can verify the OTHER's (or its own) chat landed.
const stamp = process.argv.includes('--stamp') ? process.argv[process.argv.indexOf('--stamp') + 1] : String(BOTS.length);
const nonce = (b) => `slackchat-${b.name}-${stamp}`;

// Slack bots auto-join on launch, but that takes several seconds (load channel →
// click Huddle → lobby → start → popup). Driving before in-call sends commands to
// a not-yet-live huddle popup. Wait for each bot to report in-call first — the
// agent-facing analogue of meet-test's join() barrier.
async function waitForInCall(bot, timeoutMs = 35000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await bot.status()).callStatus === 'in-call') return true; } catch { /* retry */ }
    await sleep(1000);
  }
  return false;
}

async function run() {
  const [a, b] = BOTS;

  // 0) Barrier: wait for the auto-join to land before driving anything.
  for (const bot of BOTS) {
    const ok = await waitForInCall(bot);
    record(bot.name, 'inCall', ok, ok ? '' : 'not in-call after 35s — auto-join failed?');
    if (!ok) return; // nothing else will work; bail so the failure is clear
  }

  // 1) Speak (→ main-window VirtualMic). Heard by the human/other bot via captions.
  await a.speak('Slack command-wiring test. Can you hear me?');
  await sleep(2000);

  // 2) Chat send (→ huddle popup SlackProvider.sendChat).
  await a.sendChat(nonce(a));
  if (b) await b.sendChat(nonce(b));
  await sleep(2500); // let the Thread render + propagate

  // 3) Chat read-back (→ SlackProvider.readChat). Each bot should see its own +
  //    the other's message. Single-bot run just round-trips its own.
  await a.readChat();
  await a.expectChatContains(b ? nonce(b) : nonce(a));
  if (b) {
    await b.readChat();
    await b.expectChatContains(nonce(a));
  }

  // 4) Listen — a hears the other (captions). Only meaningful with a 2nd talker.
  if (b) {
    await b.speak('Got it — Samantha here, replying.');
    await a.waitForSpeech({ wait: 12, silence: 2 });
  }

  // 5) Screen-share parity with Meet: share the whiteboard, confirm Slack
  //    actually engaged (status.sharing is now driven by the popup's REAL
  //    isSharing() via selfPresenting — not the optimistic request flag), then
  //    stop and confirm it cleared. Mirrors meet-test's shareWhiteboard check.
  const { sharing } = await a.shareWhiteboard();
  if (sharing) {
    await sleep(1500);
    await a.stopSharing();
    // Let the popup heartbeat report the toggle went off (selfPresenting:false).
    let stillSharing = true;
    for (let i = 0; i < 10 && stillSharing; i++) {
      await sleep(500);
      try { stillSharing = !!(await a.status()).sharing; } catch { /* retry */ }
    }
    record(a.name, 'shareStopped', !stillSharing, stillSharing ? 'still sharing after stop' : 'share stopped cleanly');
  }
}

run()
  .catch((err) => { console.error('slack-test error:', err && err.message); })
  .finally(() => {
    const r = report();
    process.exit(r.fails > 0 || r.stalls > 0 ? 1 : 0);
  });
