#!/usr/bin/env node
//
// displacement-test.mjs — who is allowed to take the room from whom, against
// REAL app instances on real ports (#518).
//
// Why this exists
// ---------------
// The 2026-08-24 standup, the first time two bots were driven from two
// terminals. Buddy's MCP tools were dialing Pepper's port (#517), so Buddy's
// wait_for_speech landed on Pepper's app. The single-agent guard did what it was
// written to do and evicted the incumbent — Pepper's loop exited, and from
// outside Pepper had simply gone quiet. Twice in ten minutes.
//
// The unit tests for this (tests/stranger-displacement.test.mjs) construct a
// LocalServer in-process and hand it a fake req/res. That proves the decision,
// and it cannot prove the thing that actually broke: this is a bug about two
// PROCESSES, two ports, and one of them being addressed by mistake. Nothing in
// the suite exercises multi-bot coordination against running apps at all.
//
// Deliberately does NOT need a Meet. Everything here is decided by our own HTTP
// layer, so a red means WE broke something — the same split join-route-test.mjs
// makes, and the reason both can run in seconds without a live call. (Also why
// it is safe as a GATING nightly lane: no Google, no admission queue, no #57.)
//
// What it checks
// --------------
//   1. A DIFFERENT bot is refused (409, wrongInstance) rather than served.
//   2. The incumbent SURVIVES that refusal — the actual regression. A refusal
//      that still evicted would look fine from the newcomer's side.
//   3. The SAME bot still displaces. The guard exists to stop two agents on one
//      bot double-speaking; fixing #518 must not disable it.
//   4. An UNNAMED caller still displaces — older agents send no `bot`, and
//      "no idea" must not be read as "a stranger".
//   5. Positive control: the same name on its OWN port is served normally, so
//      the refusal is about the mismatch and not about the name.
//
// Usage:
//   node scripts/displacement-test.mjs --bots Alice:7901,Jimmy:7902
//
// Expects two fleet instances already running (spawn-test-fleet.sh 2). They do
// not need to be in a call.

// Both spellings: meet-test.mjs takes `--bots A:1,B:2` and join-route-test.mjs
// takes `--base-url=...`, and getting the wrong one silently falls back to the
// defaults, which is a confusing way to test the wrong ports.
const args = {};
for (let i = 0, argv = process.argv.slice(2); i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const eq = argv[i].indexOf('=');
  if (eq !== -1) { args[argv[i].slice(2, eq)] = argv[i].slice(eq + 1); continue; }
  const next = argv[i + 1];
  if (next && !next.startsWith('--')) { args[argv[i].slice(2)] = next; i++; }
  else args[argv[i].slice(2)] = true;
}

const bots = String(args.bots || 'Alice:7901,Jimmy:7902').split(',').map((pair) => {
  const [name, port] = pair.split(':');
  return { name, port: Number(port), base: `http://127.0.0.1:${Number(port)}` };
});
if (bots.length < 2) {
  console.error('displacement-test: need two bots, e.g. --bots Alice:7901,Jimmy:7902');
  process.exit(1);
}
const [A, B] = bots;

// A room slug is adopted by whichever instance is asked first, so an idle app
// serves this without ever having been in a call.
const ROOM = 'displacement-test';
const WAIT_S = 30;

const failures = [];
function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail && !ok ? `\n      ${detail}` : ''}`);
  if (!ok) failures.push(name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Open a long poll. Returns a handle whose `settled` flips when the server
// answers, so "did the incumbent survive" is observable without racing a timer.
function poll(bot, asName, { targetBase = null } = {}) {
  const base = targetBase || bot.base;
  const ac = new AbortController();
  const q = new URLSearchParams({ wait: String(WAIT_S), silence: '1.4' });
  if (asName !== null) q.set('bot', asName);
  const h = { settled: false, status: null, body: null, error: null, abort: () => ac.abort() };
  h.done = fetch(`${base}/api/sync/${ROOM}?${q}`, { signal: ac.signal })
    .then(async (r) => { h.status = r.status; h.body = await r.json().catch(() => null); h.settled = true; })
    .catch((e) => { if (e.name !== 'AbortError') { h.error = e; h.settled = true; } });
  return h;
}

async function reachable(bot) {
  try {
    const r = await fetch(`${bot.base}/api/sync/no-room`, { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch { return false; }
}

async function main() {
  for (const bot of [A, B]) {
    if (!await reachable(bot)) {
      console.error(`displacement-test: ${bot.name} on :${bot.port} is not answering. `
        + 'Run scripts/spawn-test-fleet.sh 2 first.');
      return 1;
    }
  }
  console.log(`displacement-test: ${A.name}:${A.port}, ${B.name}:${B.port}\n`);

  // Start from a known-empty waiter list. A previous run (or a real agent) may
  // still be parked on this port, and the first assertion below is "nobody has
  // displaced our incumbent" — which a stranger left over from thirty seconds
  // ago would satisfy for the wrong reason. Opening a poll as A displaces
  // whatever is there; aborting it drops ours too, via the server's own
  // socket-close handling. Observed: two runs back to back, no gap, disagreed.
  const drain = poll(A, A.name);
  await sleep(300);
  drain.abort();
  await sleep(200);

  // ── 1 & 2: a stranger is refused, and the incumbent keeps the room ──
  const incumbent = poll(A, A.name);
  await sleep(400);                       // let the waiter register
  check(`${A.name}'s poll is parked on its own port`, !incumbent.settled,
    `it returned immediately: ${incumbent.status} ${JSON.stringify(incumbent.body)?.slice(0, 160)}`);

  const stranger = poll(A, B.name, { targetBase: A.base }); // B's tools dialing A's port
  await stranger.done;

  check('a different bot is refused, not served', stranger.status === 409,
    `got ${stranger.status}: ${JSON.stringify(stranger.body)?.slice(0, 200)}`);
  check('the refusal is machine-readable', stranger.body?.wrongInstance === true,
    `body: ${JSON.stringify(stranger.body)?.slice(0, 200)}`);
  check('the refusal names the port that answered', String(stranger.body?.error || '').includes(String(A.port)),
    `error: ${String(stranger.body?.error || '').slice(0, 200)}`);
  check('the refusal says how to find the right instance',
    /list_call_instances/.test(String(stranger.body?.error || '')),
    `error: ${String(stranger.body?.error || '').slice(0, 200)}`);

  // THE regression. A refusal that still evicted would look identical from the
  // stranger's side, and would leave the incumbent just as silent as before.
  await sleep(300);
  check(`${A.name} still holds the room after refusing a stranger`, !incumbent.settled,
    `${A.name}'s poll resolved: ${JSON.stringify(incumbent.body)?.slice(0, 200)}`);

  // ── 5: positive control — the same name on its OWN port is fine ──
  const onOwnPort = poll(B, B.name);
  await sleep(400);
  check(`${B.name} is served normally on its own port`, !onOwnPort.settled && onOwnPort.status !== 409,
    `status ${onOwnPort.status}: ${JSON.stringify(onOwnPort.body)?.slice(0, 160)}`);
  onOwnPort.abort();

  // ── 3: a duplicate of the SAME bot still displaces ──
  const duplicate = poll(A, A.name);
  await incumbent.done;                   // the guard should resolve the first one
  check(`a second ${A.name} agent still displaces the first`,
    incumbent.settled && incumbent.body?.displaced === true,
    `first poll resolved as: ${JSON.stringify(incumbent.body)?.slice(0, 200)}`);

  // ── 4: an unnamed caller still displaces (back-compat) ──
  const unnamed = poll(A, null);
  await duplicate.done;
  check('a caller that sends no name still displaces',
    duplicate.settled && duplicate.body?.displaced === true,
    `poll resolved as: ${JSON.stringify(duplicate.body)?.slice(0, 200)}`);
  unnamed.abort();

  // Leave no waiter parked on either instance. Without this the NEXT run of this
  // script inherits our leftovers, and the fleet is reused across nightly lanes.
  for (const h of [incumbent, stranger, onOwnPort, duplicate, unnamed]) {
    try { h.abort(); } catch { /* already settled */ }
  }
  await Promise.allSettled([incumbent.done, stranger.done, onOwnPort.done, duplicate.done, unnamed.done]);
  await sleep(200);

  console.log('');
  if (failures.length) {
    console.error(`displacement-test FAILED (${failures.length}): ${failures.join(', ')}`);
    return 1;
  }
  console.log('displacement-test passed');
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(`displacement-test errored: ${err.message}`);
  process.exit(1);
});
