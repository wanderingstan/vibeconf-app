// supervisor-directory.test.mjs — the supervisor as the fleet's directory (#301).
//
// An agent asks one fixed port "where is Bramble?" and gets a port back, then
// talks to that bot directly. A DIRECTORY, not a proxy: nothing an agent says to
// a bot passes through the supervisor, so a supervisor that dies costs new
// lookups and leaves every live call alone. Routing traffic through it would put
// it in the hot path of every utterance and spend the crash isolation
// process-per-bot was chosen to buy.
//
// Run: node --test tests/supervisor-directory.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { SUPERVISOR_PORT, supervisorPort, supervisorUrl } = require('../electron-app/supervisor-port.js');
const { supervisorIsRunning } = require('../electron-app/profile-launch.js');
const server = readFileSync(join(root, 'mcp-server/server.js'), 'utf8');
const supervisorApp = readFileSync(join(root, 'electron-app/supervisor-app.js'), 'utf8');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

test('the supervisor does not squat on the default bot’s port', () => {
  // 7865 is the default BOT's seat, and every installed Claude MCP config on
  // every machine already points at it. A supervisor there would take that
  // bot's address and break all of them at once.
  assert.notEqual(SUPERVISOR_PORT, 7865);
  // Below the bot ranges (7865 default, 7870-7899 profiles, 7901-7916 fleet),
  // so the family reads as one block with the coordinator at its head.
  assert.ok(SUPERVISOR_PORT < 7865, `${SUPERVISOR_PORT} is inside the bot range`);
});

test('the port is overridable, so two checkouts do not fight', () => {
  assert.equal(supervisorPort({}), SUPERVISOR_PORT);
  assert.equal(supervisorPort({ VIBECONF_SUPERVISOR_PORT: '7999' }), 7999);
  // Junk falls back rather than producing a nonsense listen() call.
  for (const bad of ['', 'abc', '0', '70000', '-1']) {
    assert.equal(supervisorPort({ VIBECONF_SUPERVISOR_PORT: bad }), SUPERVISOR_PORT, `bad port "${bad}" leaked`);
  }
  assert.equal(supervisorUrl({}), `http://127.0.0.1:${SUPERVISOR_PORT}`);
  assert.equal(supervisorUrl({ VIBECONF_SUPERVISOR_URL: 'http://x:1' }), 'http://x:1');
});

test('the MCP and the app agree on where the supervisor lives', () => {
  // They are separate packages and cannot share a module, so the number is
  // written twice. If they ever disagree, every lookup silently falls back to
  // scanning and nothing says why.
  assert.ok(server.includes(String(SUPERVISOR_PORT)),
    `mcp-server/server.js does not mention port ${SUPERVISOR_PORT}`);
});

test('the agent asks the supervisor FIRST, and scans only as a fallback', () => {
  const discover = server.slice(server.indexOf('async function discoverInstances'));
  const body = discover.slice(0, discover.indexOf('\n}'));
  assert.match(body, /askSupervisor\(\)/);
  assert.match(body, /scanForInstances\(\)/);
  assert.ok(body.indexOf('askSupervisor') < body.indexOf('scanForInstances'),
    'the supervisor must be consulted before the port scan, not after');
});

test('no supervisor means scan — an agent keeps working when it is quit', () => {
  // The supervisor is an ordinary window the user may close, so the fallback is
  // not ceremony: it is the difference between "quit the coordinator" and
  // "every agent stops being able to find a bot".
  const ask = server.slice(server.indexOf('async function askSupervisor'));
  const body = ask.slice(0, ask.indexOf('\n}'));
  assert.match(body, /catch\s*{\s*\n?\s*return null;/, 'an unreachable supervisor must return null, never throw');
  assert.match(body, /if \(!body\?\.ok \|\| !Array\.isArray\(body\.instances\)\) return null;/);
});

test('an empty fleet from a live supervisor is an answer, not a miss', () => {
  // Falling back to a scan when the supervisor says "no bots" would spend 46
  // probes re-confirming something authoritative it was just told.
  const ask = server.slice(server.indexOf('async function askSupervisor'));
  const body = ask.slice(0, ask.indexOf('\n}'));
  assert.ok(!/instances\.length/.test(body), 'an empty instance list must still count as a supervisor answer');
});

test('the directory answers in the shape the resolver already expects', () => {
  // instance-routing.js is pure and unit-tested and does not change: only where
  // its input comes from does. So the payload has to carry those exact fields.
  const probe = supervisorApp.slice(supervisorApp.indexOf('async function probe('));
  const body = probe.slice(0, probe.indexOf('\n}'));
  for (const field of ['port', 'baseUrl', 'profile', 'botName', 'configuredBotName', 'callStatus', 'roomId']) {
    // `port` is a shorthand property, so match either `port,` or `field: value`.
    assert.match(body, new RegExp(`\\b${field}[,:]`), `the directory must report ${field}`);
  }
});

test('the directory is loopback-only', () => {
  // It lists every bot on the machine and can start processes.
  assert.match(supervisorApp, /directory\.listen\(port, '127\.0\.0\.1'/);
});

test('a bot starting makes sure a supervisor exists', () => {
  // The guarantee is "bots running means the supervisor is running" — not that
  // it lives forever. Quit it while nothing is happening and the next bot
  // launch brings it back.
  assert.match(main, /function ensureSupervisorRunning\(\)/);
  const ready = main.slice(main.indexOf('app.whenReady().then(async () => {'));
  assert.match(ready.slice(0, 300), /ensureSupervisorRunning\(\);/);
  // NOT awaited: a bot must never be slower to appear because the coordinator is.
  assert.ok(!/await ensureSupervisorRunning\(\)/.test(main),
    'awaiting it puts the coordinator on a bot’s critical path');
});

test('an unreachable supervisor reads as absent, quickly', async () => {
  // On a bot's startup path. Wrong-in-the-cheap-direction: a false "no" costs a
  // duplicate launch that the single-instance lock refuses.
  //
  // The fake HONOURS the abort signal, because a real fetch does. One that
  // ignores it hangs forever and tests nothing but the test's own patience.
  //
  // The setTimeout is load-bearing and not a delay: AbortSignal.timeout()'s
  // internal timer is UNREF'd, so a promise that settles only on abort leaves
  // nothing keeping the event loop alive — Node exits first and the test is
  // cancelled rather than run. A ref'd timer holds the loop; the abort still
  // wins the race, which is the thing being asserted.
  const hangs = (_url, { signal } = {}) => new Promise((_resolve, reject) => {
    const held = setTimeout(() => reject(new Error('never answered')), 5000);
    signal?.addEventListener('abort', () => { clearTimeout(held); reject(new Error('aborted')); });
  });
  const started = Date.now();
  assert.equal(await supervisorIsRunning({ url: 'http://127.0.0.1:1', fetchImpl: hangs, timeoutMs: 120 }), false);
  assert.ok(Date.now() - started < 2000, 'a hung supervisor must not hang the bot');

  // A refused connection, and a 200 that is not actually a supervisor.
  assert.equal(await supervisorIsRunning({
    url: 'http://x', fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  }), false);
  assert.equal(await supervisorIsRunning({
    url: 'http://x', fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  }), false);
  assert.equal(await supervisorIsRunning({
    url: 'http://x', fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) }),
  }), true);
});

test('quitting is allowed, but says what stops', () => {
  // The Granola model: wants to be always-on, says so loudly, and then lets you.
  // Refusing to close would be worse than being absent; quitting silently hides
  // a failure that only shows up later as "why didn't it join".
  const confirm = supervisorApp.slice(supervisorApp.indexOf('async function confirmQuit'));
  const body = confirm.slice(0, confirm.indexOf('\n}\n'));
  assert.match(body, /auto-join/, 'the dialog must name what stops working');
  assert.match(body, /buttons: \['Keep running', 'Quit anyway'\]/);
  assert.match(body, /defaultId: 0/, 'staying must be the default, not quitting');
  assert.match(body, /checkboxLabel: "Don't ask again"/);
  // And it must actually be able to quit — a warning that cannot be dismissed
  // is a refusal wearing a dialog.
  assert.match(body, /app\.quit\(\)/);
});
