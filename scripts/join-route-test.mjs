#!/usr/bin/env node
//
// join-route-test.mjs — exercise the /join-call and /call routes THROUGH THE MCP
// SERVER, which nothing else does.
//
// Why this exists
// ---------------
// #105: the first `/join-call` after an app launch was silently dropped. The
// request adopted the room on its way in, which set callStatus='joining', and
// then the rejoin guard read that state and treated the request as a duplicate
// OF ITSELF — 7ms apart in the log. It answered ok:true/alreadyInCall:true, so
// the agent believed it had joined while nothing ever navigated. It failed
// exactly once per launch, always, which is why clicking Join in the app
// appeared to "fix" it. It cost most of the Jul 28 standup.
//
// Every existing lane missed it, because none of them use this route:
//   • spawn-test-fleet.sh puts bots in a call with a --meet-url LAUNCH ARG
//   • meet-test.mjs then drives an already-joined bot over HTTP
//   • smoke-codex-mcp.mjs speaks MCP but only calls get_room_info
// So the join path an actual user takes had no coverage at all.
//
// What it checks
// --------------
//   1. A FRESH, IDLE instance accepts a join and actually navigates.
//      This is the #105 regression. The tell is `alreadyInCall` on a bot that
//      has never been in a call — and, more importantly, the app never leaving
//      idle. Both are asserted.
//   2. A REPEAT join for the same room is still ignored (#26). The fix for #105
//      must not reopen the bug the guard exists for: honouring a duplicate join
//      tore down a healthy call and hung on Meet's "Getting ready…" forever.
//   3. A join for a DIFFERENT room is honoured as a real call switch.
//   4. --include-start-call: the /call route. ADVISORY only — it reaches the
//      public website to mint a real Meet, so a red there can mean our bug, an
//      expired session, or the network. Kept out of the verdict on purpose.
//
// Deliberately NOT checked: admission. Whether Google lets the bot in depends on
// the meet, the account and the guest queue, and #57 is a standing example of a
// nightly lane going red for environmental reasons. Everything here is decided
// by our own code, so a failure means WE broke something. That is the whole
// point of splitting it out from the live-call lanes.
//
// Usage:
//   node scripts/join-route-test.mjs --base-url=http://127.0.0.1:7901
//   node scripts/join-route-test.mjs --base-url=... --include-start-call
//
// Expects an app instance already running and IDLE (not in a call) — the #105
// trigger is `!this.roomId`, so a fleet member already in a call cannot
// reproduce it. spawn-test-fleet.sh with --no-meet leaves one idle.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// Codes are never actually joined — the app navigates, Google does whatever it
// does, and we only assert on our own state transitions. Two distinct codes so
// the call-switch case is a genuine switch.
// What join_call says when it declined to act. Note "still joining" stands
// ALONE — the tool renders alreadyInCall+status:'joining' as "The bot is still
// joining call X", with no "already" in front. A first draft of this test
// matched /already (in|still joining)/ and therefore passed against the #105
// bug it was written to catch.
const SWALLOWED = /already in|still joining|nothing to do/i;

const ROOM_A = 'aaa-bbbb-ccc';
const ROOM_B = 'zzz-yyyy-xxx';

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const m = arg.match(/^--([a-z0-9-]+)(?:=(.*))?$/i);
    if (!m) throw new Error(`Unknown argument: ${arg}`);
    args[m[1]] = m[2] ?? true;
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function appStatus(baseUrl) {
  const resp = await fetch(`${baseUrl}/api/sync/no-room`, { signal: AbortSignal.timeout(5000) });
  if (!resp.ok) throw new Error(`app status HTTP ${resp.status}`);
  return (await resp.json()).status || {};
}

// Did the app actually NAVIGATE to the meet?
//
// callStatus is NOT the answer, and getting this wrong is how the first draft of
// this test passed against #105. Adopting an unknown room calls setRoom(), which
// sets callStatus='joining' as a side effect — so under the bug the app reports
// "joining" while having done absolutely nothing. That false signal is the
// bug's own signature.
//
// currentMeetUrl is set by loadMeetURL, i.e. only when the app really went
// somewhere. That is the honest tell. We do NOT wait for 'in-call': whether
// Google admits the bot is out of our control and is what makes lanes like #57
// flaky for environmental reasons.
async function waitForNavigation(baseUrl, roomId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = { callStatus: null, currentMeetUrl: null };
  while (Date.now() < deadline) {
    const resp = await fetch(`${baseUrl}/api/sync/no-room`, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.json()).catch(() => null);
    if (resp) {
      last = { callStatus: resp.status?.callStatus, currentMeetUrl: resp.currentMeetUrl };
      if (last.currentMeetUrl && String(last.currentMeetUrl).includes(roomId)) return last;
    }
    await sleep(500);
  }
  return last;
}

// --- minimal MCP stdio client (same shape as smoke-codex-mcp.mjs) ------------

function startMcp({ baseUrl, botName, timeoutMs }) {
  const serverPath = path.join(repoRoot, 'mcp-server', 'server.js');
  // Pin the MCP server's multi-instance discovery to OUR test bot's port only
  // (#57). By default it probes the whole 7865-7910 range, so on a machine that
  // also runs the app for real — the always-on mini, where the production bot
  // sits idle on :7865 — every unscoped tool call (start_call, and any join once
  // our bot has left its call and stops self-identifying by name) trips the
  // "Multiple app instances running" guard and the check goes red for an
  // environment reason, not a code one. Narrowing the range to our own port makes
  // the whole test hermetic regardless of what else is running.
  const testPort = (baseUrl.match(/:(\d+)/) || [])[1];
  const portRange = testPort ? { VIBECONF_PORT_RANGE: `${testPort}-${testPort}` } : {};
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, VIBECONF_BASE_URL: baseUrl, VIBECONF_BOT_NAME: botName, ...portRange },
  });
  const pending = new Map();
  let nextId = 1;
  let buffer = '';
  let stderrBuffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderrBuffer += c; });
  child.on('exit', (code, signal) => {
    const err = new Error(`MCP server exited early: ${signal || code}\n${stderrBuffer.trim()}`);
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
  });

  const request = (method, params = {}) => {
    const id = nextId++;
    return Promise.race([
      new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      }),
      sleep(timeoutMs).then(() => { throw new Error(`MCP ${method} timed out after ${timeoutMs}ms`); }),
    ]);
  };

  return {
    request,
    notify: (method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
    close: () => { try { child.stdin.end(); child.kill(); } catch { /* already gone */ } },
    get stderr() { return stderrBuffer.trim(); },
  };
}

const textOf = (result) =>
  (result?.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n');

// --- checks ------------------------------------------------------------------

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failures.push(name);
}
// A precondition outside our code wasn't met (not signed in, site down, rate
// limited). NOT a pass — we proved nothing — but NOT a failure either: counting
// it red would mean "our route is broken" when the truth is "the environment
// isn't set up". Logged so a permanently-skipped check can't hide behind green.
function skip(name, detail) {
  console.log(`SKIP  ${name}${detail ? `\n      ${detail}` : ''}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/join-route-test.mjs --base-url=http://127.0.0.1:7901 [--bot-name=NAME]');
    return 0;
  }
  const baseUrl = (args['base-url'] || process.env.VIBECONF_BASE_URL || 'http://127.0.0.1:7865').replace(/\/$/, '');
  const botName = args['bot-name'] || process.env.VIBECONF_BOT_NAME || 'JoinRouteTest';
  const timeoutMs = Number(args['timeout-ms'] || 20000);

  console.log(`join-route-test → ${baseUrl} as "${botName}"\n`);

  const pre = await appStatus(baseUrl);
  if (pre.callStatus && pre.callStatus !== 'idle' && pre.callStatus !== 'left') {
    console.error(`This instance is already ${pre.callStatus}. The #105 trigger is an app with NO room, `
      + 'so a busy instance cannot reproduce it. Point --base-url at an idle one.');
    return 2;
  }

  const mcp = startMcp({ baseUrl, botName, timeoutMs });
  try {
    await mcp.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'join-route-test', version: '1.0.0' },
    });
    mcp.notify('notifications/initialized');

    // 1. THE #105 REGRESSION — a first join must navigate, not answer "already in".
    const first = textOf(await mcp.request('tools/call', {
      name: 'join_call', arguments: { room_id: ROOM_A, bot_name: botName },
    }));
    check('first join_call is not answered as "already in call"',
      !SWALLOWED.test(first),
      `#105: the request matched its own room adoption. Response was:\n      ${first.slice(0, 200)}`);

    const nav = await waitForNavigation(baseUrl, ROOM_A);
    check('first join_call actually NAVIGATES the app to the meet',
      !!nav.currentMeetUrl && String(nav.currentMeetUrl).includes(ROOM_A),
      `currentMeetUrl is ${JSON.stringify(nav.currentMeetUrl)} while callStatus says `
      + `"${nav.callStatus}" — the app is REPORTING a join it never performed. That gap `
      + 'is exactly #105: the agent believes it is in the call and sits there forever.');

    // 2. THE #26 PROTECTION — a duplicate must still be a no-op.
    const second = textOf(await mcp.request('tools/call', {
      name: 'join_call', arguments: { room_id: ROOM_A, bot_name: botName },
    }));
    check('a repeat join for the SAME room is ignored',
      SWALLOWED.test(second),
      `#26: honouring a duplicate tore down a healthy call. Response was:\n      ${second.slice(0, 200)}`);

    // 3. A different room is a real switch, not a duplicate.
    const other = textOf(await mcp.request('tools/call', {
      name: 'join_call', arguments: { room_id: ROOM_B, bot_name: botName },
    }));
    check('a join for a DIFFERENT room is honoured as a call switch',
      !SWALLOWED.test(other),
      `Response was:\n      ${other.slice(0, 200)}`);

    await mcp.request('tools/call', { name: 'leave_call', arguments: { room_id: ROOM_B } }).catch(() => {});

    // 4. The /call route (start_call). OFF by default and NON-GATING when on:
    // unlike everything above, this reaches the public website to mint a real
    // Meet, so a failure can mean our bug OR an expired session OR the network.
    // Mixing that into a lane whose whole selling point is "a failure means WE
    // broke something" would undo the point. Run it with --include-start-call
    // when you want the signal, and read it as advisory.
    if (args['include-start-call']) {
      await mcp.request('tools/call', { name: 'leave_call', arguments: {} }).catch(() => {});
      await sleep(1500);
      let startText = '';
      try {
        startText = textOf(await mcp.request('tools/call', { name: 'start_call', arguments: {} }));
      } catch (err) {
        startText = `ERROR: ${err.message}`;
      }
      const mintedCode = (startText.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i) || [])[1];
      const started = !!mintedCode;
      const CHECK = 'start_call (/call) mints a meet and sends the bot in';
      // The route reaches vibeconferencing.com to mint a real Meet, so an
      // unmet EXTERNAL precondition — the profile isn't signed into vibeconf.com
      // (the isolated guest profiles never are), the site is down, or we're rate
      // limited — is not evidence our route is broken. These map to start_call's
      // own REASONS strings (#57). Skip on those; only a genuine code/route break
      // (a malformed request, an exception, or an unrecognized response) is red.
      const PRECONDITION = /Not signed in to vibeconferencing\.com|Couldn't reach vibeconferencing\.com|Too many calls started recently|Google couldn't create the room/i;
      if (started) {
        // #122: hand the fresh room to the lanes that run after us. A minted room
        // survives the leave_call below — retire releases our quota claim, it does
        // NOT close the room (verified 2026-07-29) — so downstream lanes can join
        // it. The marker is parsed by scheduled-meet-test.sh; keep the format.
        console.log(`VIBECONF_MINTED_ROOM=${mintedCode}`);
        check(CHECK, true);
      } else if (PRECONDITION.test(startText)) {
        skip(CHECK, `${startText.slice(0, 240)}\n      This is an environment precondition, not a `
          + 'route bug — the /call mint needs a signed-in vibeconf.com session (the guest test '
          + 'profile has none). Sign the profile in to promote this from SKIP to a real check.');
      } else {
        check(CHECK, false,
          `${startText.slice(0, 240)}\n      NOTE: unlike the checks above, this one reaches `
          + 'vibeconferencing.com (/api/meet/create). A signed-out/site-down/rate-limited result '
          + 'is reported as SKIP; this red means the response was none of those — a real route bug.');
      }
      await mcp.request('tools/call', { name: 'leave_call', arguments: {} }).catch(() => {});
    }
  } finally {
    mcp.close();
  }

  console.log('');
  if (failures.length) {
    console.error(`join-route-test FAILED (${failures.length}): ${failures.join(', ')}`);
    return 1;
  }
  console.log('join-route-test passed');
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(`join-route-test errored: ${err.message}`);
  process.exit(1);
});
