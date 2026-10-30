// WhatsApp call links (#891): recognised everywhere a link comes in, the same
// room id from every path, joined from the bot's own WhatsApp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wa = require('../packages/calls/providers/whatsapp-call.js');
const { findCallLink } = require('../electron-app/renderer/call-link.js');
const { parseCallTarget } = require('../electron-app/new-bot-target.js');

const LINK = 'https://call.whatsapp.com/video/9ZdwSdAQ0inbIntbYiXJ24';

test('both forms of a call link parse to the same kind and token', () => {
  assert.deepEqual(wa.parseCallLink(LINK), { kind: 'video', token: '9ZdwSdAQ0inbIntbYiXJ24' });
  assert.deepEqual(wa.parseCallLink('https://web.whatsapp.com/call/video/9ZdwSdAQ0inbIntbYiXJ24/'), { kind: 'video', token: '9ZdwSdAQ0inbIntbYiXJ24' });
  assert.deepEqual(wa.parseCallLink('https://call.whatsapp.com/voice/AbC123xyz_-9'), { kind: 'voice', token: 'AbC123xyz_-9' });
  assert.equal(wa.parseCallLink('https://web.whatsapp.com/'), null);
  assert.equal(wa.parseCallLink('https://call.whatsapp.com/video/'), null);
});

test('the link box finds a call link in pasted text', () => {
  assert.deepEqual(findCallLink(`Join my WhatsApp call: ${LINK} see you`), { provider: 'whatsapp', url: LINK });
  assert.equal(findCallLink('https://web.whatsapp.com/'), null, 'the WhatsApp app itself is not a call');
});

test('every path derives the same room id', () => {
  const room = wa.roomCodeForLink('9ZdwSdAQ0inbIntbYiXJ24');
  assert.equal(room, 'whatsapp-link-9zdwsdaq0inbintbyixj24');
  // The local server's room route: what the agent's tools address.
  const server = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');
  const route = new Function('return ' + server.match(/url\.pathname\.match\((\/\^\\\/api\\\/sync\\\/.*\$\/)\);/)[1])();
  for (const tok of ['9ZdwSdAQ0inbIntbYiXJ24', 'Ab_cd-EF_12345']) assert.ok(route.test('/api/sync/' + wa.roomCodeForLink(tok)), 'routable: ' + tok);
  assert.deepEqual(parseCallTarget(LINK), { ok: true, provider: 'whatsapp', roomId: room, url: LINK });
  // mcp-server parses inline (#708): its pattern and room id must match.
  const mcp = readFileSync(join(root, 'mcp-server/server.js'), 'utf8');
  const src = mcp.match(/const waLink = String\(room_id\)\.trim\(\)\.match\((\/.*\/i)\);/)[1];
  const m = LINK.match(new Function('return ' + src)());
  assert.equal(`whatsapp-link-${m[2].toLowerCase().replace(/[^a-z0-9-]/g, '-')}`, room);
  assert.match(mcp, /const waRoomId = `whatsapp-link-\$\{waLink\[2\]\.toLowerCase\(\)\.replace\(\/\[\^a-z0-9-\]\/g, '-'\)\}`;/);
  assert.match(mcp, /meta: \{ action: "join-whatsapp", url: room_id \}/);
});

test('a link call reads as the bot\'s call once connected, with the others by name', () => {
  const me = { _serialized: '229953320788012@lid' };
  const stan = { _serialized: '7022338674810@lid' };
  const win = (connected) => ({
    require: (m) => ({
      WAWebCallCollection: { activeCall: { attributes: { isCallLink: true, callLinkToken: 'tok', outgoing: true, isGroup: true, wasEverConnected: connected, peerJid: stan, groupCallParticipantsConnected: [me, stan] } } },
      WAWebApiContact: { getPhoneNumber: () => null, getMeUserWids: () => ({ lid: me }) },
      WAWebCollections: { Contact: { get: (w) => (w === stan ? { pushname: 'Stan' } : null) } },
    })[m],
    document: { querySelectorAll: () => [] },
  });
  assert.equal(wa.readCall(win(false)).phase, 'connecting');
  const c = wa.readCall(win(true));
  assert.equal(c.phase, 'active', 'not ignored as "outgoing"');
  assert.equal(c.isCallLink, true);
  assert.deepEqual(c.participants, ['Stan'], 'the bot itself left out');
});

test('joining needs the bot signed in to WhatsApp, and a link room is joinable', () => {
  const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
  const fn = main.slice(main.indexOf('function activateWhatsAppCallLink('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /\.whatsapp\)\) \{/);
  assert.match(body, /activateCallingAppStandby\('whatsapp', 'call link', \{ startUrl: canonical \}\)/);
  assert.match(main, /\['join-detected-whatsapp', 'whatsapp', 'WhatsApp'\]/);
  assert.match(main, /case 'whatsapp': return activateWhatsAppCallLink\(t\.url\);/);
  const preload = readFileSync(join(root, 'electron-app/preload-whatsapp.js'), 'utf8');
  assert.match(preload, /whatsappCall\.findJoinCallButton\(document\)/);
});
