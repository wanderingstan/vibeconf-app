// Telegram chat (#843): the bot's chat with a caller is their 1:1 Telegram
// chat, read and written through Telegram Web A's page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tg = require('../packages/calls/providers/telegram-call.js');

// A minimal element: classes, children, innerText, cloneNode, remove.
function el(cls = '', { id = null, text = '' } = {}, children = []) {
  const n = {
    id, ownText: text, children: [], parentElement: null,
    classList: { contains: (c) => cls.split(/\s+/).includes(c) },
    cls,
    get innerText() { return [this.ownText, ...this.children.map((c) => c.innerText)].join(''); },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const want = sel.replace(/^\./, '');
      const out = [];
      const walk = (x) => { for (const c of x.children) { if (c.cls.split(/\s+/).includes(want)) out.push(c); walk(c); } };
      walk(this);
      return out;
    },
    cloneNode() { return el(cls, { id, text }, this.children.map((c) => c.cloneNode())); },
    remove() { const p = this.parentElement; if (p) p.children = p.children.filter((c) => c !== this); },
  };
  for (const c of children) { c.parentElement = n; n.children.push(c); }
  return n;
}
const textMsg = (id, words, own = false) => el('Message' + (own ? ' own' : ''), { id }, [
  el('text-content', { text: words }, [el('MessageMeta', { text: '09:53 AM' })]),
]);
const callRecord = (id) => el('Message', { id }, [el('content-inner', { text: 'Incoming Call 02:49 PM' })]);

test('chat reads only texts, without the time Telegram nests in them, with the bot\'s marked as its own', () => {
  const doc = el('', {}, [callRecord('message-15'), textMsg('message-16', 'Example text for the test! 123'), textMsg('message-17', 'Hi Stan', true)]);
  assert.deepEqual(tg.readChatMessages(doc, { selfName: 'Jimmy', callerName: 'Stanley' }), [
    { id: 'message-16', sender: 'Stanley', text: 'Example text for the test! 123', fromMe: false },
    { id: 'message-17', sender: 'Jimmy', text: 'Hi Stan', fromMe: true },
  ]);
});

test('a chat counts as open only when it is that caller\'s (by id in the address) and has a message box', () => {
  const doc = (hash, composer = true) => ({
    defaultView: { location: { hash } },
    querySelector: (sel) => (sel === '#editable-message-text' && composer ? {} : null),
  });
  assert.equal(tg.chatIsOpen(doc('#6785998012'), '6785998012'), true);
  assert.equal(tg.chatIsOpen(doc('#1111111111'), '6785998012'), false, 'someone else\'s chat');
  assert.equal(tg.chatIsOpen(doc('#6785998012', false), '6785998012'), false);
  assert.equal(tg.chatIsOpen(doc('#6785998012'), null), false);
});

test('Telegram calls carry no camera: as the answering side it can never reach the caller (#889)', () => {
  // The call commands are TelegramProvider's now (Phase 1 step 4).
  const preload = readFileSync(join(root, 'electron-app/preload-telegram.js'), 'utf8');
  const provider = readFileSync(join(root, 'packages/calls/providers/telegram-provider.js'), 'utf8');
  for (const src of [preload, provider]) assert.doesNotMatch(src, /findCallButton\(document, 'start video'\)/, 'no camera presses');
  assert.doesNotMatch(preload, /setCameraOn/);
  assert.match(provider, /async setCameraOn\(\) \{ return false; \}/);
});

test('page-inject honours a screen request that refuses audio (Telegram takes the first track)', () => {
  const inject = readFileSync(join(root, 'packages/calls/inject/page-inject.js'), 'utf8');
  assert.match(inject, /const refusesAudio = constraints\?\.audio === false;/);
  assert.match(inject, /audio: !refusesAudio/);
  assert.match(inject, /if \(inElectron && !refusesAudio\) installShareAudioGain\(stream\);/);
});

test('a request for a calling-app room that isn\'t the current call is refused, never adopted', () => {
  const server = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');
  const re = new Function('return ' + server.match(/const CALLING_APP_ROOM_RE = (\/.*\/);/)[1])();
  for (const room of ['telegram-6785998012', 'whatsapp-19175752435', 'phone-19175752435']) assert.ok(re.test(room), room + ' is answer-only');
  assert.ok(!re.test('whatsapp-link-9ZdwSdAQ0inbIntbYiXJ24'), 'a WhatsApp call-link room is joinable');
  const guard = server.indexOf('if (CALLING_APP_ROOM_RE.test(roomId) && roomId !== this.roomId) {');
  const adopt = server.indexOf('if (!this.roomId) {\n      this.setRoom(roomId);');
  assert.ok(guard > 0 && adopt > guard, 'the refusal comes before the adoption');
});

test('the preload reads and sends only after checking the open chat is the caller\'s', () => {
  // TelegramProvider does the reading and sending now (Phase 1 step 4).
  const provider = readFileSync(join(root, 'packages/calls/providers/telegram-provider.js'), 'utf8');
  const read = provider.slice(provider.indexOf('async readChat()'));
  const body = read.slice(0, read.indexOf('\n  }\n'));
  assert.match(body, /state !== 'in-call'/);
  assert.match(body, /telegramCall\.openChat\(document, caller\.id\)/);
  const send = provider.slice(provider.indexOf('async sendChat(text)'));
  assert.ok(send.indexOf('await this.readChat()') >= 0, 'send opens the chat first');
  assert.ok(send.indexOf('await this.readChat()') < send.indexOf('telegramCall.sendChatMessage('), 'verify the chat before typing into it');
});
