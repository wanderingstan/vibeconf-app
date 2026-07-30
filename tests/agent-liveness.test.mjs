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
  assert.ok(AGENT_AWAY_MS > 55_000 * 2 - 1, 'the away window must span at least two check-in cycles');
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
  const busy = classifyAgent({ activeWaiters: 0, lastAgentActivityAt: NOW - 90_000, now: NOW });
  assert.equal(busy, 'busy');
  assert.equal(agentIsAbsent(busy), false, 'a thinking agent must not get the absent face');
});

test('two missed cycles is gone', () => {
  const away = classifyAgent({ activeWaiters: 0, lastAgentActivityAt: NOW - 130_000, now: NOW });
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
  assert.match(body, /broadcastError\(/);
  assert.match(body, /No agent is driving this bot/);
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
