// error-bar-stack.test.mjs — two bugs that together hid the "sign the bot in"
// warning on 2026-10-15 (call suc-skmh-yqt-20261015T192124Z):
//
//   1. pushAvatarBackground checked meetView BEFORE awaiting resolveSvg. The
//      guest-join fallback (#347 guest join, #795 anonymous guest) replaced
//      meetView during that await, so the send hit null, the catch hit null
//      again, and the TypeError escaped as an unhandledRejection — which main
//      broadcasts to the panel as an error of its own.
//   2. The panel's error bar rendered only the newest entry of its stack, so
//      that generic error sat on top of the actionable identity-challenge
//      warning and hid both its text and its "sign in" button.
//
// Both are exercised by running the real source against small fakes rather
// than by matching its text.
//
// Run: node --test tests/error-bar-stack.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mainJs = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const panelJs = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');

// ---------------------------------------------------------------------------
// Bug 1: pushAvatarBackground
// ---------------------------------------------------------------------------

function loadPushAvatarBackground() {
  const a = mainJs.indexOf('function liveMeetWc()');
  const b = mainJs.indexOf('async function pushAvatarBackground(svgSource)');
  assert.ok(a > -1 && b > a, 'liveMeetWc must be defined just before pushAvatarBackground');
  const end = mainJs.indexOf('\n}\n', b) + 3;
  const src = mainJs.slice(a, end);
  const ctx = {
    meetView: null,
    resolveSvg: null,
    console: { warn() {}, log() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.pushAvatarBackground = pushAvatarBackground;', ctx);
  return ctx;
}

function fakeView() {
  const sent = [];
  return { sent, webContents: { isDestroyed: () => false, send: (ch, msg) => sent.push(msg) } };
}

test('pushAvatarBackground sends on the happy path', async () => {
  const ctx = loadPushAvatarBackground();
  const view = fakeView();
  ctx.meetView = view;
  ctx.resolveSvg = async (s) => `resolved:${s}`;
  await ctx.pushAvatarBackground('<svg/>');
  assert.equal(view.sent.length, 1);
  assert.equal(view.sent[0].payload.svg, 'resolved:<svg/>');
});

test('pushAvatarBackground re-checks the view after the await (guest fallback swapped it)', async () => {
  const ctx = loadPushAvatarBackground();
  ctx.meetView = fakeView();
  ctx.resolveSvg = async () => { ctx.meetView = null; return '<svg/>'; };
  // Must resolve, not reject: a rejection here is the unhandledRejection that
  // buried the sign-in warning.
  await assert.doesNotReject(ctx.pushAvatarBackground('<svg/>'));
});

test('pushAvatarBackground re-checks the view in the catch too', async () => {
  const ctx = loadPushAvatarBackground();
  ctx.meetView = fakeView();
  ctx.resolveSvg = async () => { ctx.meetView = null; throw new Error('bad file'); };
  await assert.doesNotReject(ctx.pushAvatarBackground('<svg/>'));
});

test('a destroyed (not nulled) view is treated as gone as well', async () => {
  const ctx = loadPushAvatarBackground();
  const view = fakeView();
  ctx.meetView = view;
  ctx.resolveSvg = async () => { view.webContents.isDestroyed = () => true; view.webContents.send = () => { throw new Error('destroyed'); }; return ''; };
  await assert.doesNotReject(ctx.pushAvatarBackground('<svg/>'));
});

test('the Runway connect re-checks the view after minting a session', () => {
  // Same shape in setRunwayFace: guard, several awaits, then meetView.send.
  const i = mainJs.indexOf('async function setRunwayFace(seat, on)');
  const body = mainJs.slice(i, mainJs.indexOf('\n}\n', i));
  const mint = body.indexOf('await mod.createAvatarSession(seat)');
  const connect = body.indexOf("send('runway-avatar', { type: 'connect'");
  assert.ok(mint > -1 && connect > mint);
  assert.match(body.slice(mint, connect), /liveMeetWc\(\)/,
    'the view must be re-read between the mint and the connect');
  assert.doesNotMatch(body.slice(mint, connect + 60), /meetView\.webContents\.send\('runway-avatar', \{ type: 'connect'/);
});

// ---------------------------------------------------------------------------
// Bug 2: the error bar shows up to three, newest first
// ---------------------------------------------------------------------------

class FakeEl {
  constructor(tag) { this.tag = tag; this.className = ''; this.textContent = ''; this.style = {}; this.children = []; this._click = []; }
  appendChild(c) { this.children.push(c); return c; }
  replaceChildren(...cs) { this.children = cs; }
  addEventListener(ev, fn) { if (ev === 'click') this._click.push(fn); }
  async click() { for (const fn of this._click) await fn(); }
}

function loadErrorBar() {
  const a = panelJs.indexOf('const _errorStack = [];');
  const b = panelJs.indexOf('// Join / Leave Meet');
  assert.ok(a > -1 && b > a);
  const src = panelJs.slice(a, b);
  const byId = { errorRows: new FakeEl('div'), errorClose: new FakeEl('button') };
  const invoked = [];
  const ctx = {
    document: { getElementById: (id) => byId[id] || null, createElement: (t) => new FakeEl(t) },
    errorBar: new FakeEl('div'),
    api: { invoke: async (ch) => { invoked.push(ch); } },
    console: { log() {}, warn() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.showError = showError; this.clearError = clearError;', ctx);
  const rows = () => byId.errorRows.children.filter((c) => c.className === 'error-row');
  const more = () => byId.errorRows.children.find((c) => c.className === 'error-more');
  const texts = () => rows().map((r) => r.children[0].textContent);
  return { ctx, byId, invoked, rows, more, texts };
}

test('one error: one row, no "+N more"', () => {
  const t = loadErrorBar();
  t.ctx.showError('only');
  assert.deepEqual(t.texts(), ['only']);
  assert.equal(t.more(), undefined);
  assert.equal(t.ctx.errorBar.style.display, 'flex');
});

test('shows up to three, newest first, then "+N more"', () => {
  const t = loadErrorBar();
  for (const m of ['a', 'b', 'c', 'd', 'e']) t.ctx.showError(m);
  assert.deepEqual(t.texts(), ['e', 'd', 'c']);
  assert.equal(t.more().textContent, '+2 more');
});

test('a newer generic error no longer hides the actionable one under it', () => {
  // The 2026-10-15 sequence.
  const t = loadErrorBar();
  t.ctx.showError('Google is asking Jimmy to confirm its identity', null, { id: 'open-bot-sign-in', label: 'Sign the bot in' });
  t.ctx.showError('Unhandled promise rejection: TypeError');
  assert.deepEqual(t.texts(), ['Unhandled promise rejection: TypeError', 'Google is asking Jimmy to confirm its identity']);
  const signIn = t.rows()[1].children.find((c) => c.tag === 'button');
  assert.ok(signIn, 'the older row keeps its action button');
  assert.equal(signIn.textContent, 'Sign the bot in');
});

test('each row runs its OWN action, and unknown ids get no button', async () => {
  const t = loadErrorBar();
  t.ctx.showError('reveal me', null, { id: 'reveal-bot-view', label: 'Show bot' });
  t.ctx.showError('sign me in', null, { id: 'open-bot-sign-in', label: 'Sign in' });
  t.ctx.showError('bogus', null, { id: 'rm-rf', label: 'Nope' });
  const [bogus, signIn, reveal] = t.rows();
  assert.equal(bogus.children.length, 1, 'unknown action id: text only');
  await signIn.children[1].click();
  await reveal.children[1].click();
  assert.deepEqual(t.invoked, ['open-bot-sign-in', 'reveal-bot-view']);
});

test('keyed re-raise replaces in place, clearError retracts, close drops all', async () => {
  const t = loadErrorBar();
  t.ctx.showError('quiet 1', 'agent-absent');
  t.ctx.showError('other');
  t.ctx.showError('quiet 2', 'agent-absent');
  assert.deepEqual(t.texts(), ['quiet 2', 'other'], 'no duplicate for the same key');
  t.ctx.clearError('agent-absent');
  assert.deepEqual(t.texts(), ['other']);
  for (const m of ['x', 'y', 'z']) t.ctx.showError(m);
  await t.byId.errorClose.click();
  assert.equal(t.rows().length, 0);
  assert.equal(t.ctx.errorBar.style.display, 'none');
});
