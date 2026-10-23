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

test('main isolates WhatsApp Web so its calling engine gets SharedArrayBuffer', () => {
  const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
  assert.match(main, /web\\\.whatsapp\\\.com/);
  assert.match(main, /headers\['Cross-Origin-Opener-Policy'\] = \['same-origin'\]/);
});
