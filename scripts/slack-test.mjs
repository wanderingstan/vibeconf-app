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
//   node scripts/slack-test.mjs --bots Alice:7901,Jimmy:7902
//   node scripts/slack-test.mjs --bots Alice:7901              # single-bot smoke
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
const BOTS = arg('bots', 'Alice:7901').split(',').map((s) => { const [name, port] = s.split(':'); return new Bot(name, Number(port), ROOM); });

// Per-run nonces so each bot can verify the OTHER's (or its own) chat landed.
const stamp = process.argv.includes('--stamp') ? process.argv[process.argv.indexOf('--stamp') + 1] : String(BOTS.length);
const nonce = (b) => `slackchat-${b.name}-${stamp}`;

// Slack bots auto-join on launch, but that takes several seconds (load channel →
// click Huddle → lobby → start → popup). Driving before in-call sends commands to
// a not-yet-live huddle popup. Wait for each bot to report in-call first — the
// agent-facing analogue of meet-test's join() barrier.
//
// 60s (was 35s): a Slack huddle is materially slower to establish than a Meet join
// — clicking Start Huddle in the preview can take 30s+ to flip to in-call under
// load (seen on the 2026-07-08 nightly: huddle preview reached + Start clicked, but
// in-call at ~35s hadn't landed). The huddle DID establish on an immediate re-run,
// so this is start-latency, not a hard failure — a longer window absorbs it.
//
// But a longer window does NOT absorb a hard block: from ~2026-07-13 the huddle
// stopped establishing entirely because Slack threw a mandatory-2FA setup wall in
// front of the (admin/owner) test account. It read only as a generic timeout for
// two weeks. On failure we now capture a screenshot + the main-window DOM (see
// captureHuddleBlocker) so the cause is visible in the log, not just guessed.
async function waitForInCall(bot, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await bot.status()).callStatus === 'in-call') return true; } catch { /* retry */ }
    await sleep(1000);
  }
  return false;
}

// Known signatures Slack throws in place of a huddle — so an opaque "huddle never
// established" timeout self-documents its cause in the log. Order matters: first
// match wins as the reported cause.
const BLOCKER_SIGNATURES = [
  [/two-factor|two factor|\b2FA\b/i, 'Slack 2FA-setup wall (account requires two-factor auth)'],
  [/use Slack in your browser|open the Slack app|download the/i, "Slack 'use Slack in your browser' interstitial"],
  [/sign in|signed out|enter your (email|password)|log in to|workspace url/i, 'Slack sign-in / session expired — profile needs re-auth'],
  [/rate.?limit|too many|try again later|slow down/i, 'Slack rate-limit / throttle'],
  [/something went wrong|error|unavailable|try reloading/i, 'Slack generic error page'],
];

// On an inCall timeout, capture WHAT the bot is actually looking at instead of
// bailing blind: a screenshot (pixels) + the main-window DOM (greppable text). In
// Slack mode the bot's 'meet' surface IS the app.slack.com window, so whatever is
// blocking the huddle (2FA wall, re-auth, "use Slack in your browser") lands here.
async function captureHuddleBlocker(bot) {
  // 1) Screenshot — always attempt; shows any blocker visually.
  try {
    const shot = await bot.screenshot();
    if (shot.ok) console.log(`  📸 [${bot.name}] inCall-timeout screenshot: ${shot.path}`);
    else console.log(`  📸 [${bot.name}] screenshot unavailable (${shot.path ? 'no path' : 'no active view'})`);
  } catch (e) { console.log(`  📸 [${bot.name}] screenshot failed: ${e.message}`); }

  // 2) DOM of the main Slack window — target the text-bearing elements a blocker
  //    uses (headings/dialogs/buttons/links), NOT 'body': Slack front-loads
  //    body.outerHTML with huge inline <style>, so a capped 'body' slice is all
  //    CSS and the real message never appears.
  try {
    const dom = await bot.inspectDom({
      target: 'meet',
      selector: 'h1, h2, h3, [role="dialog"], [role="alertdialog"], [aria-modal="true"], button, a[href]',
      maxElements: 20,
      maxChars: 2000,
    });
    if (!dom.ok) { console.log(`  🔎 [${bot.name}] DOM inspect unavailable: ${dom.error || 'unknown'}`); return; }
    const text = (dom.html || [])
      .join('\n')
      .replace(/<(style|script|svg)[\s\S]*?<\/\1>/gi, ' ') // drop non-text element bodies
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const hit = BLOCKER_SIGNATURES.find(([re]) => re.test(text));
    if (hit) console.log(`  🚧 [${bot.name}] LIKELY CAUSE: ${hit[1]}`);
    else console.log(`  🔎 [${bot.name}] no known blocker signature matched — inspect the screenshot`);
    // A readable snippet so unknown blockers are still diagnosable from the log alone.
    console.log(`  🔎 [${bot.name}] window text: ${text.slice(0, 500)}${text.length > 500 ? '…' : ''}`);
  } catch (e) { console.log(`  🔎 [${bot.name}] DOM inspect failed: ${e.message}`); }
}

async function run() {
  const [a, b] = BOTS;

  // 0) Barrier: wait for the auto-join to land before driving anything.
  for (const bot of BOTS) {
    const ok = await waitForInCall(bot);
    record(bot.name, 'inCall', ok, ok ? '' : 'not in-call after 60s — huddle never established?');
    if (!ok) {
      await captureHuddleBlocker(bot); // capture the blocker (screenshot + DOM) before bailing
      return; // nothing else will work; bail so the failure is clear
    }
  }

  // 1) Speak (→ main-window VirtualMic). Heard by the human/other bot via captions.
  await a.speak('Slack command-wiring test. Can you hear me?');
  await sleep(2000);

  // 2) Chat send (→ huddle popup SlackProvider.sendChat).
  await a.sendChat(nonce(a));
  if (b) await b.sendChat(nonce(b));
  await sleep(3500); // let the Thread render + propagate (Slack chat delivery lags)

  // 3) Chat read-back (→ SlackProvider.readChat). Each bot should see its own +
  //    the other's message. Single-bot run just round-trips its own.
  // Slack huddle chat delivery lags more than Meet, so give the assertion a wider
  // window (8×2s ≈ 16s vs the 5×1.5s default) — the 2026-07-08 nightly re-run
  // failed expectChatContains because the peer's message hadn't propagated yet.
  const CHAT_WAIT = { attempts: 8, intervalMs: 2000 };
  await a.readChat();
  await a.expectChatContains(b ? nonce(b) : nonce(a), CHAT_WAIT);
  if (b) {
    await b.readChat();
    await b.expectChatContains(nonce(a), CHAT_WAIT);
  }

  // 4) Listen — a hears the other (captions). Only meaningful with a 2nd talker.
  if (b) {
    await b.speak('Got it — Jimmy here, replying.');
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
