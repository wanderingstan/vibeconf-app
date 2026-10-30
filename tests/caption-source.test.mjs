// caption-source.test.mjs — how the bot hears a call, as its own piece (#850).
//
// Phase 1 is a refactor: PlatformCaptions re-emits the provider caption events
// main.js used to subscribe to directly, and forwards the caption commands. These
// pin that it is a faithful pass-through, that main.js now listens to the source
// rather than the provider, and that a provider without captions is reported
// rather than silently deaf.
//
// Run: node --test tests/caption-source.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { PlatformCaptions, SOURCE_EVENTS, LISTEN_SOURCES, resolveListenSource } = require('../packages/calls/hearing/caption-source.js');
const { CALL_EVENTS, CALL_COMMANDS, providerCapabilities, CallProvider } = require('../packages/calls/core/call-provider.js');
const { PREFERENCES } = require('../electron-app/preferences-schema.js');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

function harness() {
  const ipcMain = new EventEmitter();
  const sent = [];
  const requests = [];
  const source = new PlatformCaptions({
    ipcMain,
    sendCallCmd: (channel, payload) => sent.push({ channel, payload }),
    callViewRequest: async (channel, payload, resultEvent, timeoutMs) => {
      requests.push({ channel, payload, resultEvent, timeoutMs });
      return { ok: true, language: 'es-ES' };
    },
  });
  return { ipcMain, sent, requests, source };
}

test('provider caption events come out of the source unchanged', () => {
  const { ipcMain, source } = harness();
  const got = [];
  for (const ev of Object.values(SOURCE_EVENTS)) source.on(ev, (p) => got.push([ev, p]));
  source.start();
  const turns = { turns: [{ turnId: 1, speaker: 'Stan', text: 'hi', isBottommost: true }] };
  ipcMain.emit(CALL_EVENTS.captionTurns, {}, turns);
  ipcMain.emit(CALL_EVENTS.captionsState, {}, { on: false });
  ipcMain.emit(CALL_EVENTS.captionStall, {}, { ageMs: 30000, nodes: 3 });
  ipcMain.emit(CALL_EVENTS.captionsReady, {});
  assert.deepEqual(got, [
    [SOURCE_EVENTS.turns, turns],
    [SOURCE_EVENTS.state, { on: false }],
    [SOURCE_EVENTS.stall, { ageMs: 30000, nodes: 3 }],
    [SOURCE_EVENTS.ready, undefined],
  ]);
});

test('start is idempotent and stop really detaches', () => {
  const { ipcMain, source } = harness();
  let n = 0;
  source.on(SOURCE_EVENTS.ready, () => n++);
  source.start();
  source.start();
  ipcMain.emit(CALL_EVENTS.captionsReady, {});
  assert.equal(n, 1, 'a second start must not double-subscribe');
  source.stop();
  ipcMain.emit(CALL_EVENTS.captionsReady, {});
  assert.equal(n, 1);
  assert.equal(ipcMain.listenerCount(CALL_EVENTS.captionTurns), 0);
});

test('commands go to the provider on the channels it already handles', async () => {
  const { sent, requests, source } = harness();
  source.recover();
  assert.deepEqual(sent, [{ channel: CALL_COMMANDS.recoverCaptions, payload: undefined }]);
  const r = await source.setLanguage('es');
  assert.deepEqual(r, { ok: true, language: 'es-ES' });
  assert.deepEqual(requests, [{
    channel: CALL_COMMANDS.setCaptionLanguage,
    payload: { language: 'es' },
    resultEvent: CALL_EVENTS.captionLanguageResult,
    timeoutMs: 30000,
  }]);
});

test('every provider we ship has captions; an unknown one does not', () => {
  for (const id of ['google-meet', 'meet', 'slack', 'zoom', 'teams']) {
    assert.equal(providerCapabilities(id).captions, true, id);
  }
  assert.equal(providerCapabilities('telegram').captions, false);
  assert.equal(CallProvider.capabilities.captions, false, 'the abstract base claims nothing');
});

test('listen source: platform captions when they exist, our own transcription when not (#850 phase 2)', () => {
  assert.equal(resolveListenSource({ pref: 'auto', providerId: 'zoom' }).source, 'platform');
  assert.equal(resolveListenSource({ pref: 'platform', providerId: 'meet' }).reason, 'preference');
  assert.equal(resolveListenSource({ pref: 'bogus', providerId: 'teams' }).source, 'platform');
  const calling = resolveListenSource({ pref: 'auto', providerId: 'telegram' });
  assert.equal(calling.source, 'audio');
  assert.match(calling.reason, /no captions/);
  // 'platform' on a platform without captions can't be honoured; it hears anyway.
  assert.equal(resolveListenSource({ pref: 'platform', providerId: 'whatsapp' }).source, 'audio');
  // 'audio' forces our own transcription even where captions exist (comparison, #836).
  assert.deepEqual(resolveListenSource({ pref: 'audio', providerId: 'meet' }), { source: 'audio', reason: 'preference' });
});

test('the preference offers exactly the sources that exist', () => {
  const p = PREFERENCES.listenSource;
  assert.equal(p.default, 'auto');
  assert.deepEqual(p.enum, LISTEN_SOURCES);
  assert.ok(p.enum.includes('audio'));
  for (const v of p.enum) assert.ok(p.enumLabels && p.enumLabels[v], `no label for ${v}`);
});

test('main.js hears through the source, not the provider channels', () => {
  for (const ch of ['captionTurns', 'captionsState', 'captionStall', 'captionsReady']) {
    assert.ok(!main.includes(`ipcMain.on(CALL_EVENTS.${ch}`), `${ch} must arrive via the source`);
  }
  for (const ev of ['turns', 'state', 'stall', 'ready']) {
    assert.match(main, new RegExp(`captionSource\\(\\)\\.on\\(SOURCE_EVENTS\\.${ev},`));
  }
  assert.match(main, /captionSource\(\)\.recover\(\)/, 'self-heal goes through the source');
  assert.match(main, /captionSource\(\)\.setLanguage\(want\)/, 'language goes through the source');
});
