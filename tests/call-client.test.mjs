// call-client.test.mjs — main.js drives the call through one CallProvider.
//
// Phase 0 of the calling-library extraction: CallClient replaces the raw
// webContents.send('extension-message', …) calls main.js aimed at meetView.
// It must put the SAME bytes on the wire as before (the preloads are
// unchanged), route each command by name the way callCmdWC does, and keep
// the round-trip semantics chatRequest / callViewRequest had.
//
// Run: node --test tests/call-client.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { CallClient, CHAT_TIMEOUT_ERROR, NO_CALL_VIEW_ERROR } = require('../packages/calls/core/call-client.js');
const { CallProvider, CALL_COMMANDS, CALL_EVENTS } = require('../packages/calls/core/call-provider.js');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

// Two fake surfaces, like Slack mode: popup-only names go to `popup`.
function harness({ popupNames = [], noView = false } = {}) {
  const ipc = new EventEmitter();
  const sent = { main: [], popup: [] };
  const view = (name) => ({ send: (...args) => sent[name].push(args) });
  const surfaces = { main: view('main'), popup: view('popup') };
  const warnings = [];
  const client = new CallClient({
    ipc,
    warn: (m) => warnings.push(m),
    resolveTarget: (name) => (noView ? null : popupNames.includes(name) ? surfaces.popup : surfaces.main),
  });
  return { ipc, sent, client, warnings };
}

test('CallClient is a CallProvider', () => {
  assert.ok(new CallClient({ resolveTarget: () => null, ipc: new EventEmitter() }) instanceof CallProvider);
});

test('mic, camera and speech go out as the same extension-message actions as before', async () => {
  const { client, sent } = harness();
  await client.setMicMuted(true);
  await client.setMicMuted(false);
  await client.setCameraOn(true);
  await client.setCameraOn(false);
  await client.speak({ audioData: 'AAA', emoji: '🙂' });
  await client.stopSpeaking();
  await client.stopSpeaking('barge-in');
  await client.resumeSpeaking();
  await client.startAudioTap();
  await client.stopAudioTap();
  await client.setShareAudioMuted(1);
  assert.deepEqual(sent.main, [
    ['extension-message', { action: 'mute-mic' }],
    ['extension-message', { action: 'unmute-mic' }],
    ['extension-message', { action: 'camera-on' }],
    ['extension-message', { action: 'camera-off' }],
    ['extension-message', { action: 'play-tts', payload: { audioData: 'AAA', emoji: '🙂' } }],
    ['extension-message', { action: 'stop-tts', payload: { reason: 'back-off' } }],
    ['extension-message', { action: 'stop-tts', payload: { reason: 'barge-in' } }],
    ['extension-message', { action: 'resume-tts', payload: {} }],
    ['extension-message', { action: 'start-stt-tap' }],
    ['extension-message', { action: 'stop-stt-tap' }],
    ['extension-message', { action: 'set-share-audio', payload: { muted: true } }],
  ]);
});

test('share, studio sound and caption recovery use their dedicated channels', async () => {
  const { client, sent } = harness();
  await client.startShare('window');
  await client.startShare();
  await client.stopShare();
  await client.setStudioSound(false);
  await client.recoverCaptions();
  assert.deepEqual(sent.main, [
    ['trigger-screen-share', { shareType: 'window' }],
    ['trigger-screen-share'],
    ['trigger-stop-sharing'],
    ['set-studio-sound', { enabled: false }],
    ['recover-captions'],
  ]);
});

test('commands are routed by name, so Slack popup commands reach the popup', async () => {
  const popupNames = [CALL_COMMANDS.ACTIONS.muteMic, CALL_COMMANDS.triggerScreenShare];
  const { client, sent } = harness({ popupNames });
  await client.setMicMuted(true);
  await client.startShare('window');
  await client.speak({ audioData: 'AAA' });
  assert.deepEqual(sent.popup.map((a) => a[0]), ['extension-message', 'trigger-screen-share']);
  assert.deepEqual(sent.main, [['extension-message', { action: 'play-tts', payload: { audioData: 'AAA' } }]]);
});

test('a dropped command is logged, not silent (#269)', async () => {
  const { client, warnings } = harness({ noView: true });
  assert.equal(await client.startShare(), false);
  assert.equal(await client.setMicMuted(true), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /trigger-screen-share.*DROPPED/);
});

test('sendChat resolves with the matching chat-result reply and cleans up', async () => {
  const { client, sent, ipc } = harness();
  const pending = client.sendChat('hello', 1000);
  const [channel, payload] = sent.main[0];
  assert.equal(channel, CALL_COMMANDS.sendChat);
  assert.equal(payload.text, 'hello');
  assert.match(payload.requestId, /^chat-/);
  ipc.emit(CALL_EVENTS.chatResult, {}, { requestId: 'someone-else', ok: false });
  ipc.emit(CALL_EVENTS.chatResult, {}, { requestId: payload.requestId, ok: true });
  assert.deepEqual(await pending, { requestId: payload.requestId, ok: true });
  assert.equal(ipc.listenerCount(CALL_EVENTS.chatResult), 0);
});

test('a chat timeout resolves with CHAT_TIMEOUT_ERROR, never rejects', async () => {
  const { client, ipc } = harness();
  const r = await client.readChat(10);
  assert.deepEqual(r, { ok: false, error: CHAT_TIMEOUT_ERROR });
  assert.equal(ipc.listenerCount(CALL_EVENTS.chatResult), 0);
});

test('a request with no call view fails fast', async () => {
  const { client } = harness({ noView: true });
  assert.deepEqual(await client.sendChat('x'), { ok: false, error: NO_CALL_VIEW_ERROR });
});

test('setCaptionLanguage round-trips on caption-language-result', async () => {
  const { client, sent, ipc } = harness();
  const pending = client.setCaptionLanguage('es', 1000);
  const [channel, payload] = sent.main[0];
  assert.equal(channel, CALL_COMMANDS.setCaptionLanguage);
  ipc.emit(CALL_EVENTS.captionLanguageResult, {}, { requestId: payload.requestId, ok: true, language: 'es-ES' });
  assert.equal((await pending).language, 'es-ES');
});

test('events pass through with ipcMain’s (event, data) signature', () => {
  const { client, ipc } = harness();
  const seen = [];
  const handler = (_e, d) => seen.push(d);
  client.on(CALL_EVENTS.participantsUpdated, handler);
  ipc.emit(CALL_EVENTS.participantsUpdated, {}, [{ name: 'Ann' }]);
  client.off(CALL_EVENTS.participantsUpdated, handler);
  ipc.emit(CALL_EVENTS.participantsUpdated, {}, [{ name: 'Bob' }]);
  assert.deepEqual(seen, [[{ name: 'Ann' }]]);
});

// --- main.js uses it -----------------------------------------------------

test('main.js sends no call command straight at meetView any more', () => {
  const direct = /meetView\.webContents\.send\('extension-message', \{\s*action: [^,}]*(mute-mic|camera-on|camera-off|play-tts|stop-tts|resume-tts)/;
  assert.doesNotMatch(main, direct);
  assert.doesNotMatch(main, /function chatRequest\(/);
  assert.match(main, /const callClient = new CallClient\(\{ resolveTarget: callCmdWC, ipc: ipcMain \}\)/);
});

test('main.js subscribes to provider events through the client', () => {
  assert.doesNotMatch(main, /ipcMain\.on\(CALL_EVENTS\./);
  assert.match(main, /callClient\.on\(CALL_EVENTS\.statusUpdate,/);
});
