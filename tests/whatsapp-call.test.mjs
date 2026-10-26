// whatsapp-call.js (#843): the phone-number allowlist and the reads of
// WhatsApp Web's call state that feed it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wa = require('../electron-app/whatsapp-call.js');

test('allowlist: phone numbers in any formatting, compared digit for digit', () => {
  const a = wa.parseAllowlist('+1 (917) 575-2435  # Stan\n4915112345678, 123\nnot a number');
  assert.deepEqual([...a.phones].sort(), ['19175752435', '4915112345678']);
  assert.equal(wa.isCallerAllowed(a, { phone: '19175752435' }), true);
  assert.equal(wa.isCallerAllowed(a, { phone: '19175752436' }), false);
  assert.equal(wa.isCallerAllowed(a, { phone: null }), false);
  assert.equal(wa.isCallerAllowed(wa.parseAllowlist(''), { phone: '19175752435' }), false, 'empty means nobody');
});

test('room code is whatsapp-<number>', () => {
  assert.equal(wa.roomCodeForCaller('19175752435'), 'whatsapp-19175752435');
  assert.equal(wa.roomCodeForCaller(''), null);
});

// A fake WhatsApp Web: its module system plus the call pop-up's buttons.
function fakeWin({ call = null, phone = '19175752435@c.us', buttons = [] } = {}) {
  const btns = buttons.map((label) => ({ getAttribute: (a) => (a === 'aria-label' ? label : null) }));
  const modules = {
    WAWebCallCollection: { activeCall: call },
    WAWebApiContact: { getPhoneNumber: () => (phone ? { _serialized: phone } : null) },
    WAWebCollections: { Contact: { get: () => ({ pushname: 'Stan' }) } },
  };
  return {
    require: (m) => { if (!(m in modules)) throw new Error('no module ' + m); return modules[m]; },
    document: { querySelectorAll: () => btns },
  };
}
const incoming = (extra = {}) => ({ attributes: { peerJid: { _serialized: '7022338674810@lid' }, outgoing: false, wasEverConnected: false, ...extra } });

test('call phase: none, ringing, connecting, active, outgoing', () => {
  assert.equal(wa.readCall(fakeWin()).phase, 'none');
  assert.equal(wa.readCall(fakeWin({ call: incoming(), buttons: ['Accept', 'Decline'] })).phase, 'ringing');
  assert.equal(wa.readCall(fakeWin({ call: incoming() })).phase, 'connecting');
  assert.equal(wa.readCall(fakeWin({ call: incoming({ wasEverConnected: true }), buttons: ['End call'] })).phase, 'active');
  assert.equal(wa.readCall(fakeWin({ call: incoming({ outgoing: true }) })).phase, 'outgoing');
});

test('the caller is identified by the phone number WhatsApp maps their id to', () => {
  const c = wa.readCall(fakeWin({ call: incoming(), buttons: ['Accept'] }));
  assert.deepEqual({ phone: c.phone, name: c.name, peerJid: c.peerJid }, { phone: '19175752435', name: 'Stan', peerJid: '7022338674810@lid' });
  // Not mapped (yet): no number, so main won't answer.
  assert.equal(wa.readCall(fakeWin({ call: incoming(), phone: null, buttons: ['Accept'] })).phone, null);
});

test('the preload taps only WhatsApp\'s playback worklet, and keeps the RTC hook off', () => {
  const preload = readFileSync(join(root, 'electron-app/preload-whatsapp.js'), 'utf8');
  assert.match(preload, /window\.__vibeconf_disableAudioCapture = true;/);
  assert.match(preload, /__vibeconfWorkletName === whatsappCall\.PLAYBACK_WORKLET/);
  assert.match(preload, /destination instanceof AudioDestinationNode/);
  assert.equal(wa.PLAYBACK_WORKLET, 'voip-shared-buffer-playback-processor');
  const inject = readFileSync(join(root, 'electron-app/page-inject.js'), 'utf8');
  assert.match(inject, /function outputTapTracks\(\)/);
  assert.equal((inject.match(/outputTapTracks\(\)\)/g) || []).length, 2, 'both the STT tap and the recorder read the output taps');
});

test('one calling app answers at a time: switching one on switches the others off', () => {
  const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
  const hook = main.slice(main.indexOf("if (key === 'telegramAnswerCalls' || key === 'whatsappAnswerCalls')"));
  const body = hook.slice(0, hook.indexOf('refreshCallingAppStandby('));
  assert.match(body, /for \(const app of CALLING_APP_ORDER\)/);
  assert.match(body, /store\.set\(other, false\)/);
  const panel = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');
  assert.match(panel, /if \(other !== app && box\) box\.checked = false;/);
});

// A small DOM for the call bar: elements with aria-label/role, parents, and
// querySelectorAll over the few selectors whatsapp-call.js uses.
function node(attrs = {}, children = []) {
  const n = {
    attrs, children, parentElement: null, clicks: 0,
    getAttribute: (a) => (a in attrs ? attrs[a] : null),
    click() { n.clicks++; if (n.onClick) n.onClick(); },
    querySelectorAll(sel) {
      const out = [];
      const want = (c) => (sel.includes('menuitem') ? c.attrs.role === 'menuitem' : (c.attrs.tag === 'button' || c.attrs.role === 'button'));
      const walk = (x) => { for (const c of x.children) { if (want(c)) out.push(c); walk(c); } };
      walk(n);
      return out;
    },
  };
  for (const c of children) c.parentElement = n;
  return n;
}
function callScreen({ sharing = false } = {}) {
  const headerMenu = node({ tag: 'button', 'aria-label': 'More options' });
  const callMenu = node({ tag: 'button', 'aria-label': 'More options' });
  const end = node({ tag: 'button', 'aria-label': 'End call' });
  const bar = node({}, [node({}, [callMenu]), node({}, [end])]);
  const menu = node({ role: 'menu' });
  const doc = node({}, [node({}, [headerMenu]), node({}, [bar]), menu]);
  doc.dispatchEvent = () => {};
  callMenu.onClick = () => {
    const items = [sharing ? 'Stop sharing screen' : 'Share screen', 'Add people', 'Send message']
      .map((l) => node({ role: 'menuitem', 'aria-label': l }));
    menu.children = items;
    for (const c of items) c.parentElement = menu;
  };
  return { doc, headerMenu, callMenu, menu };
}
const noWait = { wait: () => Promise.resolve() };

test('the call bar\'s ⋮ is the one next to End call, not the chat header\'s', () => {
  const { doc, callMenu } = callScreen();
  assert.equal(wa.callMenuButton(doc), callMenu);
});

test('sharing picks "Share screen" from the call menu, and stopping picks "Stop sharing screen"', async () => {
  const s = callScreen();
  assert.equal(await wa.chooseCallMenuItem({ document: s.doc, KeyboardEvent: class {} }, 'Share screen', noWait), true);
  assert.equal(s.headerMenu.clicks, 0, 'never the chat header menu');
  assert.equal(s.menu.children.find((c) => c.attrs['aria-label'] === 'Share screen').clicks, 1);
  const stop = callScreen({ sharing: true });
  assert.equal(await wa.chooseCallMenuItem({ document: stop.doc, KeyboardEvent: class {} }, 'Stop sharing screen', noWait), true);
  // Not sharing: the item isn't there, so it reports false rather than clicking something else.
  assert.equal(await wa.chooseCallMenuItem({ document: callScreen().doc, KeyboardEvent: class {} }, 'Stop sharing screen', noWait), false);
});

test('main isolates WhatsApp Web so its calling engine gets SharedArrayBuffer', () => {
  const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
  assert.match(main, /web\\\.whatsapp\\\.com/);
  assert.match(main, /headers\['Cross-Origin-Opener-Policy'\] = \['same-origin'\]/);
});
