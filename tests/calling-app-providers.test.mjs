// calling-app-providers.test.mjs: Phase 1 step 4 of the calls library.
// WhatsApp, Telegram and Twilio calls are CallProviders now, like Meet, Zoom,
// Teams and Slack; their preloads keep only the incoming side (deciding,
// answering, standby). These pin the providers' behavior to what the preloads
// did by hand before, error strings included (the agent reads them), and
// bindToIpc's wiring of the app's call commands.
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CallProvider, CALL_COMMANDS, CALL_EVENTS, providerCapabilities } = require('../packages/calls/core/call-provider.js');
const { CallingAppProvider, bindToIpc } = require('../packages/calls/core/calling-app-provider.js');
const { WhatsAppProvider } = require('../packages/calls/providers/whatsapp-provider.js');
const { TelegramProvider } = require('../packages/calls/providers/telegram-provider.js');
const { TwilioProvider } = require('../packages/calls/providers/twilio-provider.js');

const PROVIDERS = { whatsapp: WhatsAppProvider, telegram: TelegramProvider, twilio: TwilioProvider };

test('each calling app is a CallProvider with its own id and capabilities', () => {
  for (const [id, P] of Object.entries(PROVIDERS)) {
    assert.ok(new P() instanceof CallProvider, id);
    assert.ok(new P() instanceof CallingAppProvider, id);
    assert.equal(P.id, id);
    assert.equal(P.capabilities.captions, false, id + ' has no platform captions');
    assert.deepEqual(P.capabilities, providerCapabilities(id));
  }
  assert.deepEqual(providerCapabilities('twilio'), { captions: false, video: false, chat: false, share: false });
  assert.equal(providerCapabilities('telegram').video, false, '#889');
  assert.equal(providerCapabilities('whatsapp').share, true);
  for (const id of ['meet', 'slack', 'zoom', 'teams']) {
    assert.deepEqual(providerCapabilities(id), { captions: true, video: true, chat: true, share: true }, id);
  }
});

test('caption language: the same refusal each preload sent before', async () => {
  assert.deepEqual(await new WhatsAppProvider().setCaptionLanguage(),
    { ok: false, error: 'WhatsApp has no captions; the bot transcribes the call audio itself' });
  assert.deepEqual(await new TelegramProvider().setCaptionLanguage(),
    { ok: false, error: 'Telegram has no captions; the bot transcribes the call audio itself' });
  assert.deepEqual(await new TwilioProvider().setCaptionLanguage(),
    { ok: false, error: 'A phone call has no captions; the bot transcribes the audio itself' });
});

test('chat refusals keep their wording', async () => {
  const idle = () => ({ state: 'idle', caller: null, botName: 'Bot' });
  await assert.rejects(new WhatsAppProvider({ session: idle }).readChat(), /^Error: not in a WhatsApp call$/);
  const linkCall = () => ({ state: 'in-call', caller: null, botName: 'Bot' });
  await assert.rejects(new WhatsAppProvider({ session: linkCall }).readChat(), /A WhatsApp call-link call has no chat/);
  await assert.rejects(new WhatsAppProvider({ session: linkCall }).sendChat('hi'), /A WhatsApp call-link call has no chat/);
  // A caller whose chat isn't known yet reads as empty, not as an error.
  assert.deepEqual(await new WhatsAppProvider({ session: () => ({ state: 'in-call', caller: { name: 'Ann' } }) }).readChat(), []);
  await assert.rejects(new TelegramProvider({ session: idle }).readChat(), /not in a Telegram call/);
  await assert.rejects(new TwilioProvider().readChat(), /A phone call has no chat/);
  await assert.rejects(new TwilioProvider().sendChat('hi'), /A phone call has no chat/);
});

test('Twilio drives the Voice SDK call it is handed', async () => {
  const calls = [];
  const activeCall = { mute: (m) => calls.push(['mute', m]), disconnect: () => calls.push(['disconnect']) };
  const p = new TwilioProvider({ session: () => ({ state: 'in-call', activeCall }) });
  assert.equal(await p.setMicMuted(true), true);
  assert.equal(await p.setMicMuted(false), true);
  assert.equal(await p.leave(), true);
  assert.deepEqual(calls, [['mute', true], ['mute', false], ['disconnect']]);
  const none = new TwilioProvider({ session: () => ({ state: 'idle', activeCall: null }) });
  assert.equal(await none.setMicMuted(true), false);
  assert.equal(await none.leave(), false);
});

test('no camera on Telegram (#889), and nothing to share on a phone', async () => {
  assert.equal(await new TelegramProvider().setCameraOn(true), false);
  assert.equal(await new TwilioProvider().setCameraOn(true), false);
  assert.equal(await new TwilioProvider().startShare(), false);
});

test('the roster is the bot and its caller, during a call only', () => {
  const p = new TelegramProvider({ session: () => ({ state: 'in-call', caller: { name: 'Ann' }, botName: 'Jimmy' }) });
  assert.deepEqual(p.getParticipants(), [
    { name: 'Jimmy', speaking: false, isSelf: true },
    { name: 'Ann', speaking: false, isSelf: false },
  ]);
  assert.deepEqual(new TelegramProvider().getParticipants(), []);
});

// --- bindToIpc -------------------------------------------------------------
function fakeIpc() {
  const handlers = {};
  return { handlers, on: (ch, fn) => { handlers[ch] = fn; } };
}
const tick = () => new Promise((r) => setImmediate(r));

test('bindToIpc handles every call command the app sends', () => {
  const ipc = fakeIpc();
  bindToIpc(ipc, new TwilioProvider(), { emit: () => {} });
  for (const ch of [CALL_COMMANDS.extensionMessage, CALL_COMMANDS.readChat, CALL_COMMANDS.sendChat,
    CALL_COMMANDS.setCaptionLanguage, CALL_COMMANDS.triggerScreenShare, CALL_COMMANDS.triggerStopSharing,
    CALL_COMMANDS.setStudioSound, CALL_COMMANDS.recoverCaptions, 'trigger-leave-call']) {
    assert.equal(typeof ipc.handlers[ch], 'function', ch);
  }
});

test('bindToIpc: mic and camera go to the provider; anything else to page-inject', () => {
  const ipc = fakeIpc();
  const seen = [];
  const p = new TwilioProvider();
  p.setMicMuted = async (m) => seen.push(['mic', m]);
  p.setCameraOn = async (on) => seen.push(['cam', on]);
  const posted = [];
  globalThis.window = { postMessage: (m) => posted.push(m) };
  try {
    bindToIpc(ipc, p, { emit: () => {} });
    const send = (action) => ipc.handlers[CALL_COMMANDS.extensionMessage](null, { action });
    send(CALL_COMMANDS.ACTIONS.muteMic); send(CALL_COMMANDS.ACTIONS.unmuteMic);
    send(CALL_COMMANDS.ACTIONS.cameraOn); send(CALL_COMMANDS.ACTIONS.cameraOff);
    send(CALL_COMMANDS.ACTIONS.playTts);
    ipc.handlers[CALL_COMMANDS.extensionMessage](null, null); // ignored
  } finally { delete globalThis.window; }
  assert.deepEqual(seen, [['mic', true], ['mic', false], ['cam', true], ['cam', false]]);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].action, CALL_COMMANDS.ACTIONS.playTts);
  assert.equal(posted[0].__botsInCalls, true);
});

test('bindToIpc: a chat read reports trimmed rows and runs afterRead; a refusal reports the error', async () => {
  const ipc = fakeIpc();
  const out = [];
  const p = new TwilioProvider();
  p.readChat = async () => [{ id: '1', sender: 'Ann', text: 'hi', fromMe: false }];
  let after = null;
  bindToIpc(ipc, p, { emit: (ch, payload) => out.push([ch, payload]), afterRead: (m) => { after = m; } });
  ipc.handlers[CALL_COMMANDS.readChat](null, { requestId: 'r1' });
  await tick();
  assert.deepEqual(out.pop(), [CALL_EVENTS.chatResult, { requestId: 'r1', ok: true, messages: [{ id: '1', sender: 'Ann', text: 'hi' }] }]);
  assert.equal(after[0].fromMe, false, 'afterRead sees the full rows');

  const ipc2 = fakeIpc();
  bindToIpc(ipc2, new TwilioProvider(), { emit: (ch, payload) => out.push([ch, payload]) });
  ipc2.handlers[CALL_COMMANDS.sendChat](null, { requestId: 'r2', text: 'x' });
  await tick();
  assert.deepEqual(out.pop(), [CALL_EVENTS.chatResult, { requestId: 'r2', ok: false, error: 'A phone call has no chat' }]);
  ipc2.handlers[CALL_COMMANDS.setCaptionLanguage](null, { requestId: 'r3' });
  await tick();
  assert.deepEqual(out.pop(), [CALL_EVENTS.captionLanguageResult,
    { requestId: 'r3', ok: false, error: 'A phone call has no captions; the bot transcribes the audio itself' }]);
});

test('each calling-app preload hands the call to its provider through bindToIpc', () => {
  for (const [file, cls] of [['preload-whatsapp.js', 'WhatsAppProvider'], ['preload-telegram.js', 'TelegramProvider'], ['preload-twilio.js', 'TwilioProvider']]) {
    const src = readFileSync(new URL('../electron-app/' + file, import.meta.url), 'utf8');
    assert.match(src, new RegExp(`const provider = new ${cls}\\(`), file);
    assert.match(src, /bindToIpc\(ipcRenderer, provider, \{/, file);
    assert.doesNotMatch(src, /ipcRenderer\.on\(CALL_COMMANDS\./, file + ' should not wire call commands by hand');
  }
});
