#!/usr/bin/env node
// meet-test.mjs — automated multi-bot Meet feature/perf test (HTTP-driven spike).
//
// Drives 2+ already-running bot apps through scripted scenarios concurrently,
// exercising real features (speak, whiteboard share, background change, listen),
// timestamps everything, and prints a latency / stall / lockstep report. No
// Claude agents → deterministic, repeatable, zero tokens.
//
// PREREQ: the bot apps must already be running on their ports, signed in, e.g.
//   scripts/launch-test-call.command        (boots Jimmy:7865 + Samantha:7866)
// or manually: pnpm dev  /  pnpm dev -- --profile=bot2 --local-port=7866
// You (the human) can also be in the meet to observe.
//
// Run:
//   node scripts/meet-test.mjs                                  # defaults
//   node scripts/meet-test.mjs --room paz-sqoa-npe --bots Jimmy:7865,Samantha:7866
//
// Exit code is non-zero if any step failed or a stall was detected — so this can
// gate CI later.

import { Bot, sleep, report, record } from './meet-test-lib.mjs';

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def; };
const ROOM = arg('room', 'paz-sqoa-npe');
const BOTS = arg('bots', 'Jimmy:7865,Samantha:7866').split(',').map((s) => { const [name, port] = s.split(':'); return new Bot(name, Number(port), ROOM); });

const COLORADO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#e8855b"/><path d="M0 70 L30 40 L50 60 L70 35 L100 65 L100 100 L0 100Z" fill="#33406b"/></svg>';

// Per-run chat nonces so each bot can verify it RECEIVED the other's posted
// message (chat history persists in the meet, so the nonce disambiguates this
// run). Date.now() is fine here — this is a normal node script.
const NONCE_J = `chatJ-${Date.now()}`;
const NONCE_S = `chatS-${Date.now()}`;

// Per-bot scripts. Each is an async fn given its Bot. They run concurrently, so
// timing/overlap between bots is exercised the way a real call would.
const SCRIPTS = {
  // Jimmy: the "presenter" — whiteboard share + background, plus chat send/read.
  Jimmy: async (bot) => {
    await bot.join();
    await sleep(4000); // admission + captions
    await bot.speak('Hi, Jimmy here. Starting the screen-share test now.', { emoji: '🤓' });
    await bot.updateWhiteboard('# Automated Test\n\n```mermaid\ngraph TD\n  A[Harness] --> B[Bots]\n  B --> C[Meet]\n```');
    await bot.shareWhiteboard();
    await bot.sendChat(`Jimmy chat check ${NONCE_J}`); // CHAT: post (tests send)
    await sleep(2000);
    await bot.speak('Diagram is on the board. Changing my background.');
    await bot.setBackground(COLORADO_SVG);
    await bot.setAvatarEmoji('😎');
    await sleep(2000);
    await bot.waitForSpeech({ wait: 10, silence: 2 }); // listen for Samantha
    await bot.expectChatContains(NONCE_S); // CHAT: did Jimmy receive Samantha's post?
    await bot.stopSharing();
    await bot.speak('Stopping the share. Test complete on my end.');
    // leave() happens centrally in main() after the chat-wake phase.
  },

  // Samantha: the "responder" — speaks, listens, plus chat send/read.
  Samantha: async (bot) => {
    await bot.join();
    await sleep(4500);
    await bot.speak('Samantha here too, listening for Jimmy.');
    await bot.sendChat(`Samantha chat check ${NONCE_S}`); // CHAT: post (tests send)
    const r1 = await bot.waitForSpeech({ wait: 12, silence: 2 });
    if (r1.spoke) await bot.speak('Got it, Jimmy — I can hear you.');
    await bot.waitForSpeech({ wait: 10, silence: 2 });
    await bot.expectChatContains(NONCE_J); // CHAT: did Samantha receive Jimmy's post?
    await bot.speak('Wrapping up on my side too.');
    // leave() happens centrally in main() after the chat-wake phase.
  },
};

// Fallback for any bot without a named script (e.g. a 3rd/4th fleet member) —
// a simple join → speak → listen → leave so it still participates and exercises
// turn-taking/lockstep with the others rather than sitting idle.
const DEFAULT_SCRIPT = async (bot) => {
  await bot.join();
  await sleep(5000);
  await bot.speak(`${bot.name} here, joining the test.`);
  await bot.waitForSpeech({ wait: 12, silence: 2 });
  await bot.speak(`${bot.name} signing off.`);
  // leave() happens centrally in main() after the chat-wake phase.
};

// Coordinated chat-WAKE assertion: in a quiet room, a chat message should
// promptly wake a bot sitting in wait_for_speech (the beta39 chatWake path) —
// not leave it blocked until the ~55s timeout. Sequential coordination (one
// waiter, one poster) makes the timing deterministic. Needs 2+ bots.
async function chatWakeTest(bots) {
  if (bots.length < 2) { console.log('\n(chat-wake test needs 2+ bots — skipping)'); return; }
  const [waiter, poster] = bots;
  console.log('\n— chat-wake test (quiet room) —');
  // The wake only fires in a genuinely QUIET room. Trailing TTS/captions from
  // the scenario are still settling, so DRAIN them first: a short wait_for_speech
  // absorbs any in-flight speech and leaves the room quiet before the real test.
  await sleep(3000);
  await waiter.waitForSpeech({ wait: 6, silence: 1 }); // drain trailing speech
  await sleep(1500);
  const nonce = `wake-${Date.now()}`;
  const started = Date.now();
  const waitP = waiter.waitForSpeech({ wait: 25, silence: 2 }); // long wait; expect early wake
  await sleep(2500); // ensure the waiter is parked in its long-poll
  await poster.sendChat(`wake check ${nonce}`);
  const r = await waitP;
  const elapsed = Date.now() - started;
  // PASS = woken by chat, promptly (well under the 25s cap), not a full timeout.
  const ok = r.chatWake === true && elapsed < 12000;
  record(waiter.name, 'chatWake', ok,
    ok ? `woke in ${elapsed}ms via chat`
       : `expected chat-wake; got ${r.chatWake ? 'chatWake' : (r.timedOut ? 'timeout' : 'speech')} in ${elapsed}ms (room may not have been quiet)`);
}

async function main() {
  console.log(`meet-test → room ${ROOM}, bots: ${BOTS.map((b) => `${b.name}:${b.port}`).join(', ')}\n`);

  // Preflight: every bot app reachable?
  const reach = await Promise.all(BOTS.map((b) => b.ping()));
  const down = BOTS.filter((_, i) => !reach[i]);
  if (down.length) {
    console.error(`✗ Not reachable: ${down.map((b) => `${b.name}:${b.port}`).join(', ')}`);
    console.error('  Launch the bot apps first (scripts/launch-test-call.command).');
    process.exit(2);
  }

  const started = Date.now();
  await Promise.all(BOTS.map((b) => {
    const script = SCRIPTS[b.name] || DEFAULT_SCRIPT;
    if (!SCRIPTS[b.name]) console.log(`(no named script for ${b.name} — using default join/speak/listen)`);
    return script(b).catch((err) => console.error(`✗ [${b.name}] script error:`, err.message));
  }));
  console.log(`\nScenario scripts finished in ${Math.round((Date.now() - started) / 1000)}s.`);

  // Coordinated phase that needs a quiet room + the bots still in the call.
  await chatWakeTest(BOTS).catch((err) => console.error('✗ chat-wake test error:', err.message));

  // Central teardown (scripts no longer leave themselves).
  await Promise.all(BOTS.map((b) => b.leave().catch(() => {})));

  const r = report();
  process.exit(r.fails > 0 || r.stalls > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
