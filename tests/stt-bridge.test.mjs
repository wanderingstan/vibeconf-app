// stt-bridge.test.mjs — every provider can hear by transcription (#850 phase 2):
// the page tap, the preload bridge and main's source must line up end to end,
// or a call that has no captions is silently deaf.
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'electron-app');
// The app's files, or the calls library's (packages/calls) by the same name.
const LIB = ['core', 'providers', 'inject', 'hearing', 'recording'].map((d) => join(root, 'packages', 'calls', d));
const at = (f) => [app, ...LIB].map((d) => join(d, f)).find((p) => existsSync(p)) || join(app, f);
const read = (f) => readFileSync(at(f), 'utf8');
const require = createRequire(import.meta.url);

test('every preload that runs page-inject installs the STT bridge', () => {
  const preloads = readdirSync(app).filter((f) => /^preload-.*\.js$/.test(f));
  // Code that LOADS page-inject, not a comment that mentions it (the bridges do).
  const withInject = preloads.filter((f) => /injectPageScripts\(\{ tag:/.test(read(f)));
  assert.ok(withInject.length >= 4, 'expected the Meet, Slack, Zoom and Teams preloads, found: ' + withInject.join(', '));
  for (const f of withInject) {
    // preload-meet hands the page to google-meet-provider.js, which installs it.
    const src = f === 'preload-meet.js' ? read('google-meet-provider.js') : read(f);
    assert.ok(src.includes('installSttBridge(ipcRenderer)'), `${f} runs page-inject but never forwards the STT tap`);
  }
});

test('one channel name on both sides of the IPC', () => {
  const { STT_AUDIO_CHANNEL: bridge } = require(at('preload-stt-bridge.js'));
  const { STT_AUDIO_CHANNEL: source } = require(at('caption-source.js'));
  assert.equal(bridge, source);
});

test("the page tap answers main's start/stop and posts what the bridge forwards", () => {
  const inject = read('page-inject.js');
  assert.match(inject, /action === 'start-stt-tap'\) sttTap\.start\(\)/);
  assert.match(inject, /action === 'stop-stt-tap'\) sttTap\.stop\(\)/);
  assert.match(inject, /action: 'stt-audio'/);
  const main = read('main.js');
  assert.match(main, /startTap: \(\) => callClient\.startAudioTap\(\)/);
  assert.match(main, /stopTap: \(\) => callClient\.stopAudioTap\(\)/);
  const { CALL_COMMANDS } = require(at('call-provider.js'));
  assert.equal(CALL_COMMANDS.ACTIONS.startSttTap, 'start-stt-tap');
  assert.equal(CALL_COMMANDS.ACTIONS.stopSttTap, 'stop-stt-tap');
});

test('main picks the source per call and drops back to captions after it', () => {
  const main = read('main.js');
  assert.match(main, /if \(status === 'in-call'\) \{[\s\S]{0,600}applyListenSource\(\)/);
  assert.match(main, /_captionSource\.use\(_platformCaptions\)/);
});
