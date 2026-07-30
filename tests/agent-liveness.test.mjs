// agent-liveness.test.mjs — is anyone driving the bot? (#38)
//
// The last of #155's four silences to get a face, and the only one that is a
// real fault: a bot whose agent died looks exactly like one listening politely.
//
// The heartbeat is `wait_for_speech`, which is CAPPED at 55s, so a live agent
// checks in at least that often even in a silent room. Everything here rests on
// that cap, which is why it is asserted directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyAgent, agentIsAbsent, AGENT_AWAY_MS } = require('../electron-app/agent-liveness.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const inject = readFileSync(join(root, 'electron-app/page-inject.js'), 'utf8');
const panel = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');
const mcp = readFileSync(join(root, 'mcp-server/server.js'), 'utf8');

const NOW = 1_800_000_000_000;

test('the 55s wait_for_speech cap is what makes this detectable', () => {
  // If this cap is ever raised, the detector's floor rises with it and the
  // AGENT_AWAY_MS window below has to move too. Pinned so that is a deliberate
  // change rather than a silent regression in an unrelated file.
  assert.match(mcp, /Math\.min\(55,\s*timeout_seconds\s*\|\|\s*55\)/);
  // Activity is stamped on request ARRIVAL and a poll occupies up to 55s of it,
  // so the moment a poll resolves the clock already reads ~55s. The usable
  // turnaround budget is (AGENT_AWAY_MS - 55s), and it has to comfortably
  // outlast one slow model turn.
  assert.ok(AGENT_AWAY_MS - 55_000 >= 30_000,
    'the backstop must leave >=30s of turnaround headroom past the poll duration');
});

test('an agent that is waiting is live', () => {
  assert.equal(classifyAgent({ activeWaiters: 1, lastAgentActivityAt: null, now: NOW }), 'live');
  // Even with a stale timestamp: an open long-poll IS the agent, right now.
  assert.equal(classifyAgent({ activeWaiters: 2, lastAgentActivityAt: NOW - 600_000, now: NOW }), 'live');
});

test('a busy agent is not reported as gone', () => {
  // The false positive that matters. An agent mid-tool-call or synthesising a
  // long answer legitimately goes quiet past one 55s cycle; alarming there would
  // put 🫥 on a bot that is merely thinking, and train people to ignore it.
  const busy = classifyAgent({ activeWaiters: 0, lastAgentActivityAt: NOW - 80_000, now: NOW });
  assert.equal(busy, 'busy');
  assert.equal(agentIsAbsent(busy), false, 'a thinking agent must not get the absent face');
});

test('sustained silence is gone', () => {
  const away = classifyAgent({ activeWaiters: 0, lastAgentActivityAt: NOW - 100_000, now: NOW });
  assert.equal(away, 'away');
  assert.equal(agentIsAbsent(away), true);
});

test('never-attached is kept distinct from went-away', () => {
  // Different failures with different fixes: "it never started" (a launch that
  // failed, an unauthenticated terminal — #137) vs "it died mid-call".
  const never = classifyAgent({ activeWaiters: 0, lastAgentActivityAt: null, now: NOW });
  assert.equal(never, 'never');
  assert.equal(agentIsAbsent(never), true);
});

test('the loop turnaround is not a state anyone needs to see', () => {
  assert.equal(classifyAgent({ activeWaiters: 0, lastAgentActivityAt: NOW - 2_000, now: NOW }), 'settling');
});

test('any agent request counts as proof of life, not just wait_for_speech', () => {
  // The old view watched lastWaitForSpeechAt only, so an agent deep in tool work
  // scored as going stale while it was plainly alive.
  assert.match(server, /this\.lastAgentActivityAt = Date\.now\(\);/);
  // Stamped at the door, not on completion: wait_for_speech blocks for up to
  // 55s, so crediting it at the end would backdate liveness by a whole cycle.
  const door = server.indexOf('http.createServer');
  const stamp = server.indexOf('this.lastAgentActivityAt = Date.now();');
  const handle = server.indexOf('this._handleRequest(req, res)');
  assert.ok(door < stamp && stamp < handle, 'must be stamped on arrival, before the handler runs');
});

test('a dropped socket is detected immediately, not waited out', () => {
  // The main signal. An agent killed while parked in wait_for_speech — where it
  // spends most of its life — closes its TCP connection, which the OS tells us
  // about at once. Waiting out an elapsed-time threshold for something already
  // known is the slowness this removes.
  assert.match(server, /req\.on\('close', \(\) => \{/);
  assert.match(server, /this\.agentSocketLost = true;/);
  // 'close' also fires on a normal response, which is not a disconnect.
  const fn = server.slice(server.indexOf("req.on('close'"));
  assert.match(fn.slice(0, 200), /if \(waiter\.resolved\) return;/);
  // The waiter must be torn down, not left to fire its timers into a dead socket.
  assert.match(fn.slice(0, 600), /clearTimeout\(waiter\.timer\)/);
  assert.match(fn.slice(0, 600), /this\.waiters = this\.waiters\.filter/);
});

test('a dropped socket short-circuits the elapsed-time thresholds', () => {
  const fn = server.slice(server.indexOf('agentState() {'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /if \(this\.agentSocketLost && this\.waiters\.length === 0\) return 'away';/);
  // And the agent's next request clears it, so a reconnect recovers.
  assert.match(server, /this\.agentSocketLost = false;/);
});

test('the absent face only applies during a call', () => {
  // Out of a call there is nothing for an agent to drive, so "no agent" is the
  // normal resting condition rather than a fault worth a face.
  const fn = server.slice(server.indexOf('agentAbsentInCall()'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /this\.callStatus === 'in-call'/);
  assert.match(body, /agentIsAbsent\(this\.agentState\(\)\)/);
});

test('main polls, because an absence fires no event', () => {
  assert.match(main, /setInterval\(pollAgentLiveness/);
  assert.match(main, /action: 'set-agent-absent'/);
  // Only on change — not a message every tick.
  const fn = main.slice(main.indexOf('function pollAgentLiveness'));
  assert.match(fn.slice(0, fn.indexOf('\n}')), /if \(absent === _agentAbsent\) return;/);
});

test('losing the agent raises a real app error, not just a face', () => {
  // This is the only one of #155's four silences that is a genuine fault, so it
  // earns an interruption. broadcastError already does both halves: the notice
  // over the avatar in the panel, and a system notification when the app is not
  // in the foreground (deduped).
  const fn = main.slice(main.indexOf('function pollAgentLiveness'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /broadcastError\(message\)/);
  // Only on the way out. An alert for "everything is fine again" trains people
  // to dismiss alerts.
  const raise = body.indexOf('broadcastError(');
  assert.match(body.slice(0, raise), /if \(absent\) \{/, 'recovery must stay quiet');
});

test('the avatar shows 🫥, ranked above deaf', () => {
  assert.match(inject, /case 'set-agent-absent':/);
  assert.match(inject, /agentAbsentEmoji = this\.agentAbsent \? '\\u\{1FAE5\}' : null/);
  // "Can't hear you" presumes someone is home to hear. If nothing is driving,
  // that is the more basic truth.
  const chain = inject.slice(inject.indexOf('const emoji =\n        notOnLine'));
  const order = chain.slice(0, chain.indexOf(';'));
  assert.ok(order.indexOf('agentAbsentEmoji') < order.indexOf('deafEmoji'),
    'agent-absent must outrank deaf');
  assert.ok(order.indexOf('notOnLine') < order.indexOf('agentAbsentEmoji'),
    'not being in the call at all still wins');
});

test('the panel and the avatar cannot disagree', () => {
  // Two copies of the thresholds would eventually diverge — with the debug
  // screen reassuring you while the face says otherwise.
  assert.match(panel, /switch \(s\.agentState\)/, 'the panel must read the served verdict');
  assert.ok(!/idleSecs < 60/.test(panel), 'the panel must not keep its own thresholds');
  assert.match(server, /agentState: this\.agentState\(\)/, 'the verdict must be in the status payload');
});

test('the warning claims only as much as we actually know', () => {
  // A dropped socket means the process is gone. A quiet stretch does NOT — it
  // could be an agent sitting on a permission prompt in its terminal, or one
  // deep in work that makes no MCP calls. Telling someone to restart a session
  // that is alive and waiting on them would be worse than saying nothing.
  const fn = main.slice(main.indexOf('function pollAgentLiveness'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /agentAbsenceReason\(\)/);
  assert.match(body, /reason === 'dropped'/);
  // Only the dropped case is allowed to assert the terminal exited.
  const dropped = body.slice(body.indexOf("reason === 'dropped'"), body.indexOf("reason === 'never'"));
  assert.match(dropped, /disconnected/);
  // The ambiguous case must name the innocent explanations too.
  const quiet = body.slice(body.indexOf('gone quiet'));
  assert.match(quiet.slice(0, 300), /permission prompt/);
  assert.ok(!/Restart the session/.test(quiet.slice(0, 300)),
    'must not tell the user to restart an agent that may be alive and waiting on them');
});

test('the three absence reasons stay distinguishable', () => {
  const fn = server.slice(server.indexOf('agentAbsenceReason()'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /return 'dropped'/);
  assert.match(body, /'never'/);
  assert.match(body, /'quiet'/);
});

test('only a certainly-dead agent turns the face over', () => {
  // The topple asserts death. A dropped socket earns that; a quiet stretch does
  // not, because the agent may be alive on a permission prompt — turning its
  // face over would claim something we cannot see.
  const fn = inject.slice(inject.indexOf('const DEAD_FLIP_RAD'));
  const body = fn.slice(0, fn.indexOf('const peeking'));
  assert.match(body, /this\.agentAbsent && this\.agentAbsentReason === 'dropped'/);
  // Short of a half-turn on purpose: a full 180 lands perfectly inverted, which
  // reads as deliberate rather than collapsed.
  assert.match(body, /DEAD_FLIP_RAD = Math\.PI \* 0\.75/, 'should keel over, not flip');
  assert.match(body, /1 - Math\.pow\(1 - p, 3\)/, 'eased, so it reads as falling rather than snapping');
  // It has to actually reach the rotation.
  assert.match(inject, /ctx\.rotate\(speakTilt \+ tickTilt \+ agentTiltNow \+ deadFlip\)/);
  // And reset, so a reconnected agent stands back up.
  assert.match(body, /this\._deadSince = 0;/);
});

test('the reason reaches the avatar, not just the app', () => {
  assert.match(main, /payload: \{ absent, reason: absent \? _agentAbsentReason : null \}/);
  assert.match(inject, /cam\.agentAbsentReason = why/);
  assert.match(inject, /avatarState\.agentAbsentReason = why/, 'future cameras must inherit it');
});

test('a departing agent does not play the arrival animation', () => {
  // 🫥 is shared with "in the call, agent still warming up", which peeks over
  // the bottom edge and rises into place. Reusing that for an agent that has
  // GONE plays an entrance for a departure — it reads as booting up at the
  // exact moment the bot died.
  const rise = inject.slice(inject.indexOf('let ghostRise = 0;'));
  const guard = rise.slice(0, rise.indexOf('const peeking'));
  assert.match(guard, /emoji === '\\u\{1FAE5\}' && !this\.agentAbsent/,
    'the rise must be skipped when the face means the agent is gone');
});
