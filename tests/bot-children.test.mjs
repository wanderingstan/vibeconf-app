// bot-children.test.mjs: the app window owns its bots as child processes (#301).
//
// On 2026-10-19 a hosted bot quit four times mid-call and nothing could say
// who stopped it: bots were launched detached, so the app window could not see
// them exit or read their output. These pin the parent/child contract on both
// ends (bot-children.js in the app, bot-parent-link.js in the bot), with a fake
// child process standing in for Electron.
//
// Run: node --test tests/bot-children.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createBotChildren } = require('../electron-app/bot-children.js');
const { connectToParent } = require('../electron-app/bot-parent-link.js');
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function fakeChild(pid = 4242) {
  const c = new EventEmitter();
  c.pid = pid;
  c.connected = true;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.sent = [];
  c.killed = [];
  c.send = (m) => { c.sent.push(m); };
  c.kill = (sig) => { c.killed.push(sig); };
  return c;
}

function quietLog() {
  const lines = [];
  const rec = (...a) => lines.push(a.join(' '));
  return { lines, log: rec, warn: rec, error: rec };
}

test('spawns with a private channel and pipes the bot\'s output into the app log, line by line', () => {
  const child = fakeChild();
  let spawned;
  const log = quietLog();
  const kids = createBotChildren({ spawn: (cmd, argv, opts) => { spawned = { cmd, argv, opts }; return child; }, log });
  const r = kids.start('charlie', '/bin/electron', ['.', '--profile=charlie'], { env: { A: '1' } });
  assert.deepEqual(r, { ok: true, pid: 4242 });
  assert.deepEqual(spawned.opts.stdio, ['ignore', 'pipe', 'pipe', 'ipc']);
  assert.equal(spawned.opts.env.A, '1');

  child.stdout.emit('data', 'first line\nsecond ha');
  child.stdout.emit('data', 'lf\n');
  child.stderr.emit('data', 'oops\n');
  assert.ok(log.lines.includes('[bot:charlie] first line'));
  assert.ok(log.lines.includes('[bot:charlie] second half'), 'a line split across chunks is joined');
  assert.ok(log.lines.includes('[bot:charlie err] oops'));
});

test('one child per bot: starting a running bot again does not spawn a second', () => {
  let n = 0;
  const kids = createBotChildren({ spawn: () => { n++; return fakeChild(); }, log: quietLog() });
  kids.start('charlie', 'x', []);
  const again = kids.start('charlie', 'x', []);
  assert.equal(n, 1);
  assert.equal(again.already, true);
});

test('an exit nobody asked for is reported loudly, with the bot\'s last lines', () => {
  const child = fakeChild();
  const log = quietLog();
  const exits = [];
  const kids = createBotChildren({ spawn: () => child, log, onExit: (i) => exits.push(i) });
  kids.start('jimmy', 'x', []);
  child.stdout.emit('data', '[electron] state → thinking\n');
  child.emit('exit', 0, null);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].expected, false);
  assert.equal(exits[0].code, 0);
  assert.deepEqual(exits[0].tail, ['[electron] state → thinking']);
  assert.ok(log.lines.some((l) => /EXITED on its own: exit code 0/.test(l) && /state → thinking/.test(l)));
  assert.equal(kids.has('jimmy'), false, 'gone from the map, so it can be started again');
});

test('a signal is named', () => {
  const child = fakeChild();
  const exits = [];
  const kids = createBotChildren({ spawn: () => child, log: quietLog(), onExit: (i) => exits.push(i) });
  kids.start('jimmy', 'x', []);
  child.emit('exit', null, 'SIGKILL');
  assert.equal(exits[0].signal, 'SIGKILL');
});

test('quit asks over the channel, with the reason, and the exit is marked expected', async () => {
  const child = fakeChild();
  const exits = [];
  const kids = createBotChildren({ spawn: () => child, log: quietLog(), onExit: (i) => exits.push(i) });
  kids.start('ravi', 'x', []);
  const p = kids.quit('ravi', 'supervisor: reaper', 1000);
  assert.deepEqual(child.sent, [{ type: 'quit', reason: 'supervisor: reaper' }]);
  child.emit('exit', 0, null);
  assert.equal(await p, true);
  assert.equal(exits[0].expected, true);
  assert.equal(exits[0].reason, 'supervisor: reaper');
  assert.deepEqual(child.killed, [], 'no signal needed');
});

test('a bot that will not quit gets SIGTERM after the timeout', async () => {
  const child = fakeChild();
  const kids = createBotChildren({ spawn: () => child, log: quietLog() });
  kids.start('ravi', 'x', []);
  const p = kids.quit('ravi', 'test', 20);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(child.killed, ['SIGTERM']);
  child.emit('exit', null, 'SIGTERM');
  assert.equal(await p, true);
});

test('hello records the port; select reaches the app; duplicate makes the exit expected', () => {
  const child = fakeChild();
  const msgs = [];
  const exits = [];
  const kids = createBotChildren({ spawn: () => child, log: quietLog(), onMessage: (n, m) => msgs.push([n, m.type]), onExit: (i) => exits.push(i) });
  kids.start('bob', 'x', []);
  child.emit('message', { type: 'hello', pid: 4242, port: 7885 });
  assert.equal(kids.nameForPort(7885), 'bob');
  child.emit('message', { type: 'select' });
  assert.deepEqual(msgs, [['bob', 'hello'], ['bob', 'select']]);

  const dup = fakeChild(99);
  const kids2 = createBotChildren({ spawn: () => dup, log: quietLog(), onExit: (i) => exits.push(i) });
  kids2.start('bob', 'x', []);
  dup.emit('message', { type: 'duplicate' });
  dup.emit('exit', 0, null);
  assert.equal(exits.at(-1).expected, true);
});

// ── The bot's end ──

function fakeProc() {
  const p = new EventEmitter();
  p.pid = 7;
  p.connected = true;
  p.sent = [];
  p.send = (m) => { p.sent.push(m); };
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  return p;
}

test('a bot not started by the app has no link', () => {
  const p = fakeProc();
  delete p.send;
  assert.equal(connectToParent({ proc: p, onQuit() {}, isInCall: () => false }), null);
});

test('the bot quits when asked, naming the reason', () => {
  const p = fakeProc();
  const quits = [];
  connectToParent({ proc: p, onQuit: (c) => quits.push(c), isInCall: () => false });
  p.emit('message', { type: 'quit', reason: 'supervisor: reaper' });
  assert.match(quits[0], /child channel: supervisor: reaper/);
});

test('the app going away: an idle bot quits at once', () => {
  const p = fakeProc();
  const quits = [];
  connectToParent({ proc: p, onQuit: (c) => quits.push(c), isInCall: () => false });
  p.connected = false;
  p.emit('disconnect');
  assert.match(quits[0], /went away/);
});

test('the app going away mid-call: the bot finishes the call first', async () => {
  const p = fakeProc();
  const quits = [];
  let inCall = true;
  connectToParent({ proc: p, onQuit: (c) => quits.push(c), isInCall: () => inCall, pollMs: 10 });
  p.connected = false;
  p.emit('disconnect');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(quits.length, 0, 'still in the call');
  inCall = false;
  await new Promise((r) => setTimeout(r, 30));
  assert.match(quits[0], /after the call ended/);
});

test('a broken stdout pipe after the app is gone cannot crash the bot', () => {
  const p = fakeProc();
  connectToParent({ proc: p, onQuit() {}, isInCall: () => true });
  assert.doesNotThrow(() => p.stdout.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' })));
});

test('select and hello go over the channel; after a disconnect select says "show your own window"', () => {
  const p = fakeProc();
  const link = connectToParent({ proc: p, onQuit() {}, isInCall: () => true });
  assert.equal(link.hello(7885), true);
  assert.equal(link.select(), true);
  assert.deepEqual(p.sent, [{ type: 'hello', pid: 7, port: 7885 }, { type: 'select' }]);
  p.connected = false;
  p.emit('disconnect');
  assert.equal(link.select(), false);
});

// ── Wiring ──

test('the app window spawns bots as children, not detached launches', () => {
  const sup = read('electron-app/supervisor-app.js');
  const fn = sup.slice(sup.indexOf('function launchProfile('), sup.indexOf('function botAuthHeaders('));
  assert.match(fn, /botChildren\.start\(name, app\.getPath\('exe'\), argv, \{ env \}\)/);
  assert.doesNotMatch(fn, /profileLaunchCommand\(|execFile\(|detached: true/);
  assert.match(fn, /delete env\.ELECTRON_RUN_AS_NODE/);
});

test('stopping a bot prefers its channel; quitting the app stops children still starting up', () => {
  const sup = read('electron-app/supervisor-app.js');
  assert.match(sup, /if \(child\) return botChildren\.quit\(child, `supervisor: \$\{reason\}`, timeoutMs\);/);
  assert.match(sup, /new Set\(\[\.\.\.running\.keys\(\), \.\.\.botChildren\.names\(\)\]\)/);
});

test('the bot opens its link before anything else and uses it to be shown and to report its port', () => {
  const main = read('electron-app/main.js');
  assert.ok(main.indexOf("require('./bot-parent-link.js').connectToParent(") < main.indexOf('const path = require('));
  assert.match(main, /await localServer\.start\(\);[\s\S]{0,200}parentLink\.hello\(localServer\.port\)/);
  assert.match(main, /if \(parentLink && parentLink\.select\(\)\) \{ lastSelectAt = Date\.now\(\); return; \}/);
  assert.equal((main.match(/parentLink\.duplicate\(\)/g) || []).length, 2, 'both single-instance refusals say so');
});
