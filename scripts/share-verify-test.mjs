#!/usr/bin/env node
// share-verify-test.mjs — prove screen sharing actually DELIVERS pixels (#267 step 3).
//
// The existing share test only confirms the toggle state ("sharing"). This one
// proves the content crossed the wire, from the VIEWER's perspective:
//   1. Bot A puts a unique nonce on the whiteboard and shares it.
//   2. Bot B (a different participant) screenshots its own call view.
//   3. A Claude VISION call asserts the nonce text is visible in B's screenshot.
// If the bot only clicked the button but no pixels reached others, B won't see it.
//
// Vision needs ANTHROPIC_API_KEY. Without it the test still captures B's
// screenshot and prints the path for a manual eyeball (no hard assertion) — so it
// degrades to a capture-and-look rather than failing.
//
// PREREQ: two bots running:
//   scripts/spawn-test-fleet.sh 2
//
// Run:
//   node scripts/share-verify-test.mjs --bots Jimmy:7901,Samantha:7902
//   pnpm test:share-verify -- --bots Jimmy:7901,Samantha:7902
//
// Exit non-zero on a real failure (share didn't engage, or vision didn't see it).

import { readFileSync } from 'fs';
import { Bot, sleep, report, record } from './meet-test-lib.mjs';

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def; };
const ROOM = arg('room', 'paz-sqoa-npe');
const BOTS = arg('bots', 'Jimmy:7901,Samantha:7902').split(',').map((s) => { const [name, port] = s.split(':'); return new Bot(name, Number(port), ROOM); });
const stamp = process.argv.includes('--stamp') ? process.argv[process.argv.indexOf('--stamp') + 1] : String(Date.now()).slice(-6);
// A nonce that OCR/vision won't confuse with Meet chrome: distinctive prefix + digits.
const NONCE = `SHAREOK-${stamp}`;
const VISION_MODEL = process.env.VIBECONF_VISION_MODEL || 'claude-haiku-4-5-20251001';

// Ask Claude vision whether `needle` is visible in the screenshot. Returns
// true/false, or null when there's no API key (can't assert).
async function visionSeesText(imagePath, needle) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const b64 = readFileSync(imagePath).toString('base64');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: 16,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
          { type: 'text', text: `This is a Google Meet screenshot. Is the text "${needle}" visible anywhere in it, including inside a shared-screen / presentation tile? Answer with ONLY the single word "yes" or "no".` },
        ],
      }],
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) { console.warn('[share-verify] vision API error:', resp.status, JSON.stringify(data).slice(0, 160)); return null; }
  const text = (data?.content?.[0]?.text || '').trim().toLowerCase();
  return /\byes\b/.test(text);
}

// Poll until the bot is actually IN the call (not still on the green room / being
// admitted). Without this the viewer screenshots the join screen and the test
// false-passes — exactly the gap a ground-truth check is meant to catch.
async function waitForInCall(bot, timeoutMs = 40000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await bot.status()).callStatus === 'in-call') return true; } catch { /* retry */ }
    await sleep(1000);
  }
  return false;
}

async function run() {
  const [a, b] = BOTS;
  if (!b) { record(a.name, 'twoBots', false, 'need two bots (sharer + viewer)'); return; }

  // Both join, and WAIT until each is genuinely in-call (green-room / admission
  // can take 10-20s). A screenshot before that captures the join screen, not the
  // call — the false pass we just caught.
  await a.join();
  await b.join();
  for (const bot of [a, b]) {
    const inCall = await waitForInCall(bot);
    record(bot.name, 'inCall', inCall, inCall ? '' : 'never reached in-call (admission/auto-join failed?)');
    if (!inCall) return;
  }
  await sleep(2000); // let captions/tiles settle

  // A: put the nonce on the whiteboard as a big heading, then share it.
  await a.updateWhiteboard(`# ${NONCE}\n\nScreen-share verification — if you can read this nonce, the share is live.`);
  const { sharing } = await a.shareWhiteboard();
  record(a.name, 'shareEngaged', sharing, sharing ? 'sharing confirmed' : 'share never engaged');
  if (!sharing) return;

  // Let the shared surface propagate to B's view.
  await sleep(7000);

  // B (the viewer) screenshots what IT sees.
  const shot = await b.screenshot();
  record(b.name, 'viewerScreenshot', shot.ok, shot.ok ? shot.path.split('/').pop() : 'capture failed');
  if (shot.ok) {
    const seen = await visionSeesText(shot.path, NONCE);
    if (seen === null) {
      // No API key (or vision unavailable): capture-and-eyeball, not a failure.
      record(b.name, 'nonceVisible', true, `SKIPPED vision (no ANTHROPIC_API_KEY) — eyeball: ${shot.path}`);
    } else {
      record(b.name, 'nonceVisible', seen,
        seen ? `vision confirms "${NONCE}" is on the shared screen` : `vision did NOT see "${NONCE}" — share may not have delivered. ${shot.path}`);
    }
  }

  await a.stopSharing();
}

run()
  .catch((err) => { console.error('share-verify-test error:', err && err.message); })
  .finally(() => { const r = report(); process.exit(r.fails > 0 ? 1 : 0); });
