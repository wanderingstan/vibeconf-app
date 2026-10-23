// telegram-call.js (#843): the allowlist that decides who the bot answers, and
// the reads of Telegram Web A's call screen it is fed from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tg = require('../electron-app/telegram-call.js');

// --- A small fake DOM: enough for tag / .class / [attr] selectors. ---------
function el(tag, { cls = '', attrs = {}, text = '' } = {}, children = []) {
  const node = {
    tagName: tag.toUpperCase(), className: cls, attrs, ownText: text, children: [], parentElement: null,
    getAttribute: (a) => (a in attrs ? attrs[a] : null),
    get innerText() { return [this.ownText, ...this.children.map((c) => c.innerText)].filter(Boolean).join('\n'); },
    querySelectorAll(sel) { const out = []; const walk = (n) => { for (const c of n.children) { if (matches(c, sel)) out.push(c); walk(c); } }; walk(this); return out; },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
  };
  for (const c of children) { c.parentElement = node; node.children.push(c); }
  return node;
}
function matches(n, sel) {
  if (sel.startsWith('.')) return n.className.split(/\s+/).includes(sel.slice(1));
  const a = /^\[([\w-]+)\]$/.exec(sel);
  if (a) return n.getAttribute(a[1]) !== null;
  return n.tagName === sel.toUpperCase();
}
const labelled = (label) => el('div', {}, [el('button', { cls: 'Button IFTVBVL-' }), el('div', { text: label })]);
function page({ ringing = false, active = false, callerId = '4242424', chatIds = ['7', '8'] } = {}) {
  const chatList = el('div', { cls: 'chat-list' }, chatIds.map((id) => el('div', { cls: 'Avatar', attrs: { 'data-peer-id': id }, text: 'x'.repeat(400) })));
  const kids = [chatList];
  if (ringing || active) {
    kids.push(el('div', { cls: 'ActiveCallHeader', text: 'Stanley' }));
    kids.push(el('div', { cls: 'call-dialog' }, [
      el('div', { cls: 'Avatar', attrs: { 'data-peer-id': callerId } }),
      el('div', { text: ringing ? 'Stanley is calling you...' : 'Stanley' }),
      labelled(active ? 'mute' : 'unmute'),
      ...(ringing ? [labelled('accept'), labelled('decline')] : [labelled('end call')]),
    ]));
  }
  return el('body', {}, kids);
}

test('allowlist: ids and @usernames, one per line or comma-separated, comments ignored', () => {
  const a = tg.parseAllowlist('6785998012  # Stan\n@StanJames, jimmy_bot\n\nnot valid!\n12');
  assert.deepEqual([...a.ids], ['6785998012']);
  assert.deepEqual([...a.usernames].sort(), ['jimmy_bot', 'stanjames']);
});

test('allowlist: a caller matches by id, or by a username Telegram has for that id', () => {
  const a = tg.parseAllowlist('4242424\n@friend');
  assert.equal(tg.isCallerAllowed(a, { id: '4242424', usernames: [] }), true);
  assert.equal(tg.isCallerAllowed(a, { id: '99', usernames: ['Friend'] }), true);
  assert.equal(tg.isCallerAllowed(a, { id: '99', usernames: ['stranger'] }), false);
  assert.equal(tg.isCallerAllowed(a, null), false);
});

test('allowlist: empty means nobody, not everybody', () => {
  assert.equal(tg.isCallerAllowed(tg.parseAllowlist(''), { id: '4242424', usernames: ['x'] }), false);
});

test('room code is telegram-<caller id>', () => {
  assert.equal(tg.roomCodeForCaller('6785998012'), 'telegram-6785998012');
  assert.equal(tg.roomCodeForCaller(''), null);
});

test('call phase follows the header and the Accept button', () => {
  assert.equal(tg.callPhase(page()), 'none');
  assert.equal(tg.callPhase(page({ ringing: true })), 'ringing');
  assert.equal(tg.callPhase(page({ active: true })), 'active');
});

test('call buttons are found by their sibling label', () => {
  const doc = page({ ringing: true });
  assert.ok(tg.findCallButton(doc, 'accept'));
  assert.ok(tg.findCallButton(doc, 'Decline'));
  assert.equal(tg.findCallButton(doc, 'end call'), null);
});

test('the caller id comes from the call dialog, never the chat list around it', () => {
  assert.deepEqual(tg.readCaller(page({ ringing: true, callerId: '4242424' })), { name: 'Stanley', id: '4242424' });
  // No avatar in the dialog: the walk must stop before the chat list's
  // avatars (other people), and report no id rather than a wrong one.
  const doc = page({ ringing: true });
  const dialog = doc.querySelector('.call-dialog');
  dialog.children = dialog.children.filter((c) => c.getAttribute('data-peer-id') === null);
  assert.equal(tg.readCaller(doc).id, null);
});

test('the decision is made in main from the profile store, not by a preference the agent can set', () => {
  const schema = readFileSync(join(root, 'electron-app/preferences-schema.js'), 'utf8');
  assert.doesNotMatch(schema, /(telegram|whatsapp)(AllowedCallers|AnswerCalls)/,
    'the allowlists must not be reachable through set_preference');
  const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
  const fn = main.slice(main.indexOf('function decideCallingAppCall('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /store\.get\(app \+ 'AllowedCallers'\)/);
  assert.match(body, /isCallerAllowed\(allow, caller\)/);
  assert.match(main, /ipcMain\.handle\('calling-app-incoming-call'/);
  for (const [file, app] of [['preload-telegram.js', 'telegram'], ['preload-whatsapp.js', 'whatsapp']]) {
    const preload = readFileSync(join(root, 'electron-app', file), 'utf8');
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('calling-app-incoming-call', \\{ app: '${app}', caller \\}\\)`));
    assert.doesNotMatch(preload, /parseAllowlist|isCallerAllowed/, `${file}: the page must not decide for itself`);
  }
});
