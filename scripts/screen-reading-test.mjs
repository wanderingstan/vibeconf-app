#!/usr/bin/env node
// screen-reading-test.mjs — can the bot READ a participant's shared screen, and
// can it notice the screen CHANGING without being told? (#673)
//
// Both halves come from the same report: a student shares a screen, works
// through a problem in silence, and the bot answers from a stale or unreadable
// picture. Bethany's words were "I shared it like 10 seconds ago. Why aren't you
// seeing it?"
//
// WHAT THIS IS NOT. whiteboard-e2e-test.mjs already proves a share ARRIVES, by
// putting one large nonce on a whiteboard and vision-checking it. That is a
// connectivity test, and it passes on a picture far too coarse to read a
// student's terminal. Neither half below can be satisfied by the share merely
// arriving.
//
//   LEGIBILITY (test 1) — a calibrated card with 10-18px rows, each carrying its
//     own nonce, so a pass means the model RESOLVED the digits at that size
//     rather than recognised a familiar sentence. This is a REGRESSION GUARD for
//     the meetViewSize default: at 1600x900 a 1920-wide share lands in an ~875px
//     tile and 12px text is ~5.5 effective px. Expected RED before #687 lands
//     and GREEN after — that is the point of it, not a flake.
//
//   STALENESS (test 2) — the one that fails on today's main for a structural
//     reason. A bot in a call is parked in wait_for_speech, a long poll that
//     returns only when someone SPEAKS (or at the timeout). So a screen that
//     changes in silence cannot reach it: not slowly, at all. The test drives a
//     student's terminal through four git states with nobody speaking and asks
//     how long until the poll comes back because the SCREEN moved.
//
//     The mechanism it asserts already exists for a sibling case: chat wakes the
//     same poll (`chatWake`, local-server.js ~4365, `reason === 'chat'`). This
//     test asserts the screen deserves the same treatment, so it is a request
//     for a new wake REASON, not new machinery.
//
// A NOTE ON HOW THIS FAILS. It is written so a failure names its cause. A share
// that never engaged, a bot never in-call, and a vision model that is absent are
// each reported distinctly from "the picture was too small to read" and from
// "nothing ever told the bot". #627's lesson is that a check which records a
// pass when it did not run is worse than no check, so the vision-unavailable
// path here is SKIP, never a silent true.
//
// PREREQ: two bots running:
//   scripts/spawn-test-fleet.sh 2
//
// Run:
//   node scripts/screen-reading-test.mjs --bots Alice:7901,Jimmy:7902
//   node scripts/screen-reading-test.mjs --bots Alice:7901,Jimmy:7902 --only staleness

import { readFileSync } from 'fs';
import { execFile } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Bot, sleep, report, record } from './meet-test-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'screen-reading');

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def; };
const ROOM = arg('room', 'paz-sqoa-npe');
const ONLY = arg('only', 'both'); // both | legibility | staleness
const BOTS = arg('bots', 'Alice:7901,Jimmy:7902').split(',').map((s) => {
  const [name, port] = s.split(':');
  return new Bot(name, Number(port), ROOM);
});
const STAMP = arg('stamp', String(Date.now()).slice(-6));
const VISION_MODEL = process.env.VIBECONF_VISION_MODEL || 'claude-haiku-4-5-20251001';

// How long a change may take to reach a waiting bot before it counts as too slow
// to be useful. Not arbitrary: the complaint was a 15-30s cycle, and a student
// waiting on an answer notices anything past a few seconds. 10s is chosen to be
// generous enough that passing it means the mechanism genuinely works, rather
// than that the budget was tuned until it passed.
const NOTICE_BUDGET_S = 10;

// ---------------------------------------------------------------------------
// Vision. Same two-path approach as whiteboard-e2e-test.mjs (CLI first, so the
// machine's Claude subscription is used and no API key is needed), but it
// returns the model's ANSWER rather than a boolean, because these questions are
// "which of these can you read", not "is this string present".
// ---------------------------------------------------------------------------

function claudeCliAsk(imagePath, question) {
  return new Promise((resolve) => {
    const prompt = `Read the image file at ${imagePath} (a Google Meet screenshot). ${question}`;
    execFile('claude', ['-p', prompt, '--allowedTools', 'Read', '--add-dir', dirname(imagePath)],
      { timeout: 120000 }, (err, stdout) => {
        if (err) { resolve(null); return; } // not installed / not logged in
        resolve((stdout || '').trim());
      });
  });
}

async function visionAsk(imagePath, question) {
  const viaCli = await claudeCliAsk(imagePath, question);
  if (viaCli !== null) return viaCli;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const b64 = readFileSync(imagePath).toString('base64');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
          { type: 'text', text: `This is a Google Meet screenshot. ${question}` },
        ],
      }],
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) { console.warn('[screen-reading] vision API error:', resp.status, JSON.stringify(data).slice(0, 160)); return null; }
  return (data?.content?.[0]?.text || '').trim();
}

// ---------------------------------------------------------------------------

async function waitForInCall(bot, timeoutMs = 40000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await bot.status()).callStatus === 'in-call') return true; } catch { /* retry */ }
    await sleep(1000);
  }
  return false;
}

// The size the viewer's Meet view is actually running at. Recorded, not set:
// test-fleet profiles PERSIST preferences between runs, so a stale meetViewSize
// left by an earlier run would otherwise change this test's result silently. If
// the number in the report is not the shipping default, that is the explanation.
async function effectiveMeetViewSize(bot) {
  try {
    const resp = await fetch(`${bot.base}/api/preferences`, { headers: bot._auth() });
    const d = await resp.json();
    const items = Array.isArray(d) ? d : (d.preferences || []);
    const p = items.find((i) => i && i.key === 'meetViewSize');
    return p ? String(p.value) : null;
  } catch { return null; }
}

function fixtureUrl(file, params) {
  const qs = new URLSearchParams(params).toString();
  return `file://${join(FIXTURES, file)}?${qs}`;
}

// ---------------------------------------------------------------------------
// TEST 1 — legibility.
// ---------------------------------------------------------------------------

async function legibilityTest(sharer, viewer) {
  console.log('\n— legibility: can the viewer READ small text on the shared screen? —');

  const size = await effectiveMeetViewSize(viewer);
  record(viewer.name, 'meetViewSize', true, `viewer's Meet view is ${size || 'unknown'} (recorded, not set — fleet profiles persist prefs)`);

  const { engaged, sustained, droppedAfterMs } = await sharer.shareWhiteboard({ sustainMs: 2000 });
  record(sharer.name, 'shareEngaged', engaged,
    engaged ? (sustained ? 'sharing confirmed' : `⚠︎ ENVIRONMENTAL (non-gating, #282): engaged then collapsed after ~${droppedAfterMs}ms`)
      : 'present never engaged');
  if (!engaged || !sustained) return;

  await sharer.loadUrl(fixtureUrl('card.html', { stamp: STAMP }));
  await sleep(7000); // let the swapped surface propagate to the viewer

  const shot = await viewer.screenshot();
  record(viewer.name, 'cardScreenshot', shot.ok, shot.ok ? shot.path.split('/').pop() : 'capture failed');
  if (!shot.ok) return;

  const answer = await visionAsk(shot.path,
    `Inside the shared-screen tile there is a calibration card with rows labelled 10px, 11px, 12px, 13px, 14px, 16px, 18px. `
    + `Each row ends with a token like TOKEN-<size>-${STAMP}. `
    + `Report ONLY the row labels whose token you can actually READ, as a comma-separated list (e.g. "14px,16px,18px"). `
    + `Do not guess: if a row is too blurry to resolve the characters, leave it out. `
    + `If you cannot see the card at all, answer exactly "NONE".`);

  if (answer === null) {
    // #627: never record a pass for a check that did not run.
    record(viewer.name, 'smallTextReadable', false,
      `SKIPPED — no claude CLI and no ANTHROPIC_API_KEY, so legibility was NOT verified. Eyeball: ${shot.path}`);
    return;
  }

  const readable = (answer.match(/\b(10|11|12|13|14|16|18)px\b/g) || []);
  const uniq = [...new Set(readable)];
  const sawControl = /\bNONE\b/i.test(answer) === false;

  // The bar is 12px: a student's editor is 12-14px, so anything coarser cannot
  // diagnose the screen they are actually looking at.
  const ok = uniq.includes('12px');
  record(viewer.name, 'smallTextReadable', ok,
    ok ? `vision read down to 12px (readable: ${uniq.join(',') || 'none'}) at view size ${size}`
      : sawControl
        ? `share ARRIVED but 12px was NOT readable (readable: ${uniq.join(',') || 'none'}) at view size ${size} — the picture is too small to diagnose a student's editor. ${shot.path}`
        : `vision could not see the card at all — the share may not have delivered. ${shot.path}`);
}

// ---------------------------------------------------------------------------
// TEST 2 — staleness. Expected RED on today's main.
// ---------------------------------------------------------------------------

async function stalenessTest(sharer, viewer) {
  console.log('\n— staleness: does a SILENT screen change ever reach a waiting bot? —');

  const { engaged, sustained } = await sharer.shareWhiteboard({ sustainMs: 2000 });
  record(sharer.name, 'stalenessShareEngaged', engaged && sustained,
    engaged && sustained ? 'sharing confirmed' : 'share did not hold — cannot test staleness without a live share');
  if (!engaged || !sustained) return;

  await sharer.loadUrl(fixtureUrl('terminal.html', { step: 1, stamp: STAMP }));
  await sleep(5000);

  // Four successive changes, as a student would produce working through a git
  // problem. NOBODY SPEAKS at any point — that is the whole condition under
  // test. One transition could pass on a poll that happened to be in flight;
  // four cannot.
  const notices = [];
  for (const step of [2, 3, 4]) {
    // Park the viewer in the same long poll a real agent sits in between turns.
    // Started BEFORE the change, so the clock measures notice latency and not
    // how long we happened to wait before asking.
    const parked = viewer.waitForSpeech({ wait: NOTICE_BUDGET_S, silence: 2 });
    await sleep(500); // ensure the poll is established before the screen moves

    const changedAt = Date.now();
    await sharer.loadUrl(fixtureUrl('terminal.html', { step, stamp: STAMP }));

    const r = await parked;
    const noticedMs = Date.now() - changedAt;

    // A wake is only a PASS if it came back for the SCREEN. A speech wake would
    // be someone talking (nobody is), and a timeout is the failure this test
    // exists to catch. `screenWake` does not exist yet — that is the point; it
    // is the sibling of `chatWake`, which local-server.js already sets.
    const wokeForScreen = r?.screenWake === true;
    notices.push({ step, wokeForScreen, noticedMs, timedOut: r?.timedOut });
    record(viewer.name, `noticedStep${step}`, wokeForScreen,
      wokeForScreen
        ? `woke on the screen change in ${noticedMs}ms`
        : r?.spoke
          ? `woke on SPEECH, not the screen — the room was supposed to be silent (${noticedMs}ms)`
          : `NEVER NOTICED — the poll timed out after ${noticedMs}ms with the screen changed. `
            + `A bot parked in wait_for_speech cannot be told the screen moved (#673).`);
  }

  const allNoticed = notices.length > 0 && notices.every((n) => n.wokeForScreen);
  const worst = notices.reduce((m, n) => Math.max(m, n.noticedMs), 0);
  record(viewer.name, 'staleness', allNoticed,
    allNoticed
      ? `every silent screen change reached the bot, worst ${worst}ms (budget ${NOTICE_BUDGET_S * 1000}ms)`
      : `${notices.filter((n) => !n.wokeForScreen).length}/${notices.length} silent screen changes never reached the bot`);

  // Ground truth: the picture really did change, so a staleness failure above is
  // about NOTICING and not about the share having died halfway through. Checked
  // once, at the end, rather than per step — the vision call is the expensive
  // part and one confirmation carries the point.
  const shot = await viewer.screenshot();
  if (shot.ok) {
    const answer = await visionAsk(shot.path,
      `Inside the shared-screen tile is a terminal. It should show a token of the form STEP4-${STAMP}. `
      + `Answer ONLY with the token you can see (for example "STEP2-${STAMP}"), or "NONE" if you cannot read one.`);
    if (answer === null) {
      record(viewer.name, 'finalStateOnScreen', false,
        `SKIPPED — no vision available, so the final shared state was NOT verified. Eyeball: ${shot.path}`);
    } else {
      const ok = new RegExp(`STEP4-${STAMP}`, 'i').test(answer);
      record(viewer.name, 'finalStateOnScreen', ok,
        ok ? `the viewer's screen really is showing step 4 — so any staleness failure above is about NOTICING, not delivery`
          : `expected STEP4-${STAMP} on screen, vision reported "${answer.slice(0, 60)}" — the share itself may have stalled. ${shot.path}`);
    }
  }
}

// ---------------------------------------------------------------------------

async function run() {
  const [sharer, viewer] = BOTS;
  if (!viewer) { record(sharer?.name || 'test', 'twoBots', false, 'need two bots (sharer + viewer)'); return; }

  await sharer.join();
  await viewer.join();
  for (const bot of [sharer, viewer]) {
    const inCall = await waitForInCall(bot);
    record(bot.name, 'inCall', inCall, inCall ? '' : 'never reached in-call (admission/auto-join failed?)');
    if (!inCall) return;
  }
  await sleep(2000);

  try {
    if (ONLY === 'both' || ONLY === 'legibility') await legibilityTest(sharer, viewer);
    if (ONLY === 'both' || ONLY === 'staleness') await stalenessTest(sharer, viewer);
  } finally {
    await sharer.stopSharing().catch(() => {});
  }
}

run()
  .catch((err) => { console.error('screen-reading-test error:', err && err.message); })
  .finally(() => { const r = report(); process.exit(r.fails > 0 ? 1 : 0); });
