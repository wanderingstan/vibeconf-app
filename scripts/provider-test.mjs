#!/usr/bin/env node
// provider-test.mjs — agent-less end-to-end test for any join-by-link platform.
//
// One scenario, every platform: the bots join by link over the HTTP API, then
// each capability the platform has is checked against a second bot. This is the
// seed of the calling library's conformance suite (design doc, "Testing and
// conformance"): the same checks for every provider, skipping what a platform
// lacks rather than failing it.
//
//   join        both bots reach in-call through join-<platform>
//   hear        Bob hears what Alice says (platform captions)
//   chat        each bot reads the other's message
//   share       Alice shares the whiteboard, then stops cleanly
//   leave       both bots leave
//
// PREREQ: a fleet of idle bots in this platform's profiles, and a standing
// meeting that lets them in unattended:
//   Zoom:  "join before host" on, captions allowed; test-zoom-1 signed in to
//          Zoom once (a signed-in bot skips the guest reCAPTCHA)
//   Teams: lobby set so everyone bypasses it
//   scripts/spawn-test-fleet.sh 2 --zoom      # or --teams
//
// Run:
//   node scripts/provider-test.mjs --platform zoom  --url <zoom link>  --bots Alice:7901,Bob:7902
//   node scripts/provider-test.mjs --platform teams --url <teams link> --bots Alice:7901,Bob:7902
//   (--url falls back to VIBECONF_ZOOM_URL / VIBECONF_TEAMS_URL)
//
// Exit code is non-zero if any step failed.

import { Bot, sleep, report, record } from './meet-test-lib.mjs';

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def; };

const PLATFORMS = {
  zoom: { env: 'VIBECONF_ZOOM_URL', captions: true, chat: true, share: true },
  teams: { env: 'VIBECONF_TEAMS_URL', captions: true, chat: true, share: true },
};

const PLATFORM = arg('platform', '');
const spec = PLATFORMS[PLATFORM];
if (!spec) {
  console.error(`--platform must be one of: ${Object.keys(PLATFORMS).join(', ')}`);
  process.exit(2);
}
const URL_ = arg('url', process.env[spec.env] || '');
if (!URL_) {
  console.error(`No meeting link: pass --url or set ${spec.env}`);
  process.exit(2);
}
// The room is unknown until join-<platform> answers; joinLink adopts it.
const BOTS = arg('bots', 'Alice:7901,Bob:7902').split(',').map((s) => { const [name, port] = s.split(':'); return new Bot(name, Number(port), 'no-room'); });
const stamp = String(Date.now());
const nonce = (b) => `${PLATFORM}chat-${b.name}-${stamp}`;

// Join is the step a platform change breaks, so a failure records what the
// bot is looking at (lobby, captcha, sign-in, "meeting not started").
async function captureJoinBlocker(bot) {
  try {
    const shot = await bot.screenshot();
    if (shot.ok) console.log(`  📸 [${bot.name}] join-timeout screenshot: ${shot.path}`);
  } catch (e) { console.log(`  📸 [${bot.name}] screenshot failed: ${e.message}`); }
  try {
    const dom = await bot.inspectDom({ target: 'meet', selector: 'h1, h2, h3, [role="dialog"], button', maxElements: 20, maxChars: 1500 });
    const text = (dom.html || []).join(' ').replace(/<(style|script|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text) console.log(`  🔎 [${bot.name}] page text: ${text.slice(0, 400)}`);
  } catch (e) { console.log(`  🔎 [${bot.name}] DOM inspect failed: ${e.message}`); }
}

async function run() {
  console.log(`provider-test → platform=${PLATFORM}, bots: ${BOTS.map((b) => b.name).join(', ')}`);
  const [a, b] = BOTS;

  // 1) Join. Sequential: two bots hitting a lobby at the same instant is not
  //    what we are testing, and Zoom's guest captcha is rate-sensitive.
  for (const bot of BOTS) {
    if (!(await bot.joinLink(PLATFORM, URL_))) return;
  }
  for (const bot of BOTS) {
    const ok = await bot.waitInCall({ maxMs: 90000 });
    record(bot.name, 'inCall', ok, ok ? '' : 'not in-call after 90s');
    if (!ok) { await captureJoinBlocker(bot); return; }
  }
  if (!b) return; // a single bot can only prove it joins

  // 2) Hear: Bob hears Alice through the platform's captions.
  if (spec.captions) {
    await sleep(3000); // captions start a moment after the call UI does
    b.since = new Date().toISOString();
    await a.speak(`This is ${a.name}, testing ${PLATFORM}. Can you hear me?`);
    const { spoke, transcript } = await b.waitForSpeech({ wait: 25, silence: 2 });
    const heard = transcript.map((e) => e.text || '').join(' ');
    record(b.name, 'hearsOtherBot', spoke && /test|hear/i.test(heard), spoke ? `heard "${heard.slice(0, 60)}"` : 'heard nothing');
  }

  // 3) Chat: each bot posts a nonce and reads the other's.
  if (spec.chat) {
    await a.sendChat(nonce(a));
    await b.sendChat(nonce(b));
    const wait = { attempts: 8, intervalMs: 2000 };
    await a.expectChatContains(nonce(b), wait);
    await b.expectChatContains(nonce(a), wait);
  }

  // 4) Share: start, confirm the platform reports it, stop, confirm it cleared.
  if (spec.share) {
    const { sharing } = await a.shareWhiteboard();
    if (sharing) {
      await sleep(1500);
      await a.stopSharing();
      let still = true;
      for (let i = 0; i < 10 && still; i++) {
        await sleep(500);
        try { still = !!(await a.status()).sharing; } catch { /* retry */ }
      }
      record(a.name, 'shareStopped', !still, still ? 'still sharing after stop' : 'share stopped cleanly');
    }
  }
}

run()
  .catch((err) => { console.error('provider-test error:', err && err.message); record('harness', 'run', false, err && err.message); })
  .finally(async () => {
    for (const bot of BOTS) { try { await bot.leave(); } catch { /* best effort */ } }
    const r = report();
    process.exit(r.fails > 0 || r.stalls > 0 ? 1 : 0);
  });
