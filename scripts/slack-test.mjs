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

import { Bot, sleep, report } from './meet-test-lib.mjs';

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def; };
// Room is just the local-server URL path here — the bot drives whatever call
// it's already in (the huddle), so any stable label works.
const ROOM = arg('room', 'slack-huddle');
const BOTS = arg('bots', 'Jimmy:7901').split(',').map((s) => { const [name, port] = s.split(':'); return new Bot(name, Number(port), ROOM); });

// Per-run nonces so each bot can verify the OTHER's (or its own) chat landed.
const stamp = process.argv.includes('--stamp') ? process.argv[process.argv.indexOf('--stamp') + 1] : String(BOTS.length);
const nonce = (b) => `slackchat-${b.name}-${stamp}`;

async function run() {
  const [a, b] = BOTS;

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
}

run()
  .catch((err) => { console.error('slack-test error:', err && err.message); })
  .finally(() => {
    const r = report();
    process.exit(r.fails > 0 || r.stalls > 0 ? 1 : 0);
  });
