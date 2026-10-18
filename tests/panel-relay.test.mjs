// panel-relay.test.mjs — driving a bot's panel from the supervisor's window (#301 one-window spike).
//
// The supervisor's one window shows the selected bot's real panel.html, but the
// bot is a separate process, so the panel's IPC is carried over HTTP by
// panel-relay.js. These pin the three primitives and the one side effect that
// must NOT happen (relay traffic counting as the agent being alive).
//
// Run: node --test tests/panel-relay.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPanelRelay } = require('../electron-app/panel-relay.js');

// The slice of ipcMain the relay touches: handle/removeHandler, plus the
// EventEmitter side for ipcMain.on listeners.
function fakeIpcMain() {
  const ipc = new EventEmitter();
  ipc.registered = new Map();
  ipc.handle = (ch, fn) => { ipc.registered.set(ch, fn); };
  ipc.removeHandler = (ch) => { ipc.registered.delete(ch); };
  return ipc;
}

function fakePanel() {
  const sent = [];
  return { sent, mainFrame: {}, send: (ch, ...args) => sent.push([ch, ...args]) };
}

test('handlers registered AFTER the relay is installed can be invoked through it', async () => {
  const ipc = fakeIpcMain();
  const relay = createPanelRelay({ ipcMain: ipc });
  ipc.handle('get-config', (_e, keys) => Object.fromEntries(keys.map((k) => [k, `v-${k}`])));
  assert.equal(ipc.registered.has('get-config'), true, 'still registered with Electron');
  assert.deepEqual(await relay.invoke('get-config', [['botName']]), { botName: 'v-botName' });
});

test('a relayed call presents the bot\'s own panel as event.sender', async () => {
  const ipc = fakeIpcMain();
  const relay = createPanelRelay({ ipcMain: ipc });
  const panel = fakePanel();
  relay.attachPanel(panel);
  let sender = null;
  ipc.handle('whoami', (e) => { sender = e.sender; return true; });
  await relay.invoke('whoami', []);
  assert.equal(sender, panel, 'handlers that check event.sender === panelView.webContents keep working');
});

test('an unknown channel is a clear no-handler error, and a removed handler is gone', async () => {
  const ipc = fakeIpcMain();
  const relay = createPanelRelay({ ipcMain: ipc });
  await assert.rejects(relay.invoke('nope', []), (err) => err.code === 'no-handler');
  ipc.handle('temp', () => 1);
  ipc.removeHandler('temp');
  await assert.rejects(relay.invoke('temp', []), (err) => err.code === 'no-handler');
});

test('send reaches every ipcMain.on listener, and one throwing does not stop the rest', () => {
  const ipc = fakeIpcMain();
  const relay = createPanelRelay({ ipcMain: ipc, log: { warn() {} } });
  const got = [];
  ipc.on('join-meet', () => { throw new Error('boom'); });
  ipc.on('join-meet', (_e, url, opts) => got.push([url, opts]));
  assert.equal(relay.send('join-meet', ['https://meet.google.com/abc-defg-hij', { x: 1 }]), 2);
  assert.deepEqual(got, [['https://meet.google.com/abc-defg-hij', { x: 1 }]]);
});

test('every push to the panel still reaches it, and is copied to relay subscribers', async () => {
  const ipc = fakeIpcMain();
  const relay = createPanelRelay({ ipcMain: ipc });
  const panel = fakePanel();
  relay.attachPanel(panel);
  relay.attachPanel(panel); // idempotent: a second attach must not double-send

  // Subscribe the way the supervisor does, through the SSE route.
  const req = Object.assign(new EventEmitter(), { method: 'GET' });
  const frames = [];
  const res = { writeHead() {}, write: (s) => frames.push(s) };
  await relay.handleRequest(req, res, new URL('http://x/api/panel/events'), async () => '');
  assert.equal(relay.subscriberCount(), 1);

  panel.send('call-status', { status: 'in-call' });
  assert.deepEqual(panel.sent, [['call-status', { status: 'in-call' }]], 'the bot\'s own panel got it once');
  const data = frames.filter((f) => f.startsWith('data: ')).map((f) => JSON.parse(f.slice(6)));
  assert.deepEqual(data, [{ channel: 'call-status', args: [{ status: 'in-call' }] }]);

  req.emit('close');
  assert.equal(relay.subscriberCount(), 0);
});

test('relay traffic does not count as the agent being alive', () => {
  const src = readFileSync(new URL('../electron-app/local-server.js', import.meta.url), 'utf8');
  assert.match(src, /if \(!String\(req\.url \|\| ''\)\.startsWith\('\/api\/panel\/'\)\) \{\s*\n\s*this\.lastAgentActivityAt = Date\.now\(\);/);
});

test('the relay routes sit behind the bot\'s auth check', () => {
  const src = readFileSync(new URL('../electron-app/local-server.js', import.meta.url), 'utf8');
  const auth = src.indexOf("const isOpen = (req.method === 'GET' && reqPath === '/api/sync/no-room')");
  const routes = src.indexOf("url.pathname.startsWith('/api/panel/')");
  assert.ok(auth > 0 && routes > auth, '/api/panel/* is mounted after the token check');
  assert.doesNotMatch(src.slice(auth, auth + 200), /api\/panel/, 'and is not on the open list');
});

test('main.js installs the relay before registering any handler', () => {
  const main = readFileSync(new URL('../electron-app/main.js', import.meta.url), 'utf8');
  const install = main.indexOf("createPanelRelay({ ipcMain })");
  const firstHandle = main.indexOf('ipcMain.handle(');
  assert.ok(install > 0 && install < firstHandle);
});

// ── Headless bots ──

const mainSrc = readFileSync(new URL('../electron-app/main.js', import.meta.url), 'utf8');

test('a headless bot never shows its window itself; show/focus/restore ask the supervisor instead', () => {
  assert.match(mainSrc, /const HEADLESS = cliArgs\.headless === 'true';/);
  const once = mainSrc.slice(mainSrc.indexOf('function showMainWindowOnce()'));
  assert.match(once.slice(0, 400), /if \(HEADLESS\) \{ mainWindowShown = true; return; \}/);
  const mh = mainSrc.slice(mainSrc.indexOf('function makeHeadless(win)'), mainSrc.indexOf('function createMainWindow()'));
  for (const m of ['show', 'showInactive', 'focus', 'restore']) assert.match(mh, new RegExp(`win\\.${m} = presentInShell;`));
  assert.match(mh, /\/api\/select\?profile=/);
  assert.match(mainSrc, /if \(HEADLESS\) makeHeadless\(mainWindow\);/);
});

test('with no supervisor answering, a headless bot falls back to its own window and Dock icon', () => {
  const mh = mainSrc.slice(mainSrc.indexOf('function makeHeadless(win)'), mainSrc.indexOf('function createMainWindow()'));
  const fallback = mh.slice(mh.indexOf('} catch (err) {'));
  assert.match(fallback, /app\.dock\.show\(\)/);
  assert.match(fallback, /real\.show\(\);/);
});

test('no Dock icon and no taskbar entry while headless', () => {
  assert.match(mainSrc, /if \(HEADLESS && app\.dock\) app\.dock\.hide\(\);\s*\n\s*createMainWindow\(\);/);
  assert.match(mainSrc, /skipTaskbar: HEADLESS,/);
  assert.match(mainSrc, /if \(app\.dock && !HEADLESS\) app\.dock\.show\(\);/);
});

test('the relay answers a ping, so the supervisor can tell a hostable bot from an older build', async () => {
  const relay = createPanelRelay({ ipcMain: fakeIpcMain() });
  let status = 0;
  let body = '';
  const res = { writeHead: (c) => { status = c; }, end: (b) => { body = b; } };
  assert.equal(await relay.handleRequest({ method: 'GET' }, res, new URL('http://x/api/panel/ping'), async () => ''), true);
  assert.equal(status, 200);
  assert.equal(JSON.parse(body).ok, true);
});
