// recording-bridge.test.mjs — every provider that records must be wired for it
// (#814). Until #814 only the Meet preload handled 'trigger-record' and forwarded
// the page recorder's chunks, so Slack, Zoom and Teams recordings came out as
// silent video. Nothing failed; the audio just never arrived.
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'electron-app');
const read = (f) => readFileSync(join(app, f), 'utf8');
const { PAGE_TO_MAIN } = createRequire(import.meta.url)(join(app, 'preload-recording-bridge.js'));

test('every preload that loads page-inject is wired for recording', () => {
  // page-inject holds the recorder; a preload that runs it on the call view must
  // also start it and carry its tracks out, or that provider records silence.
  const preloads = readdirSync(app).filter((f) => /^preload-.*\.js$/.test(f));
  const withInject = preloads.filter((f) => /page-inject\.js/.test(read(f)));
  assert.ok(withInject.length >= 3, 'expected several page-inject preloads, found: ' + withInject.join(', '));
  for (const f of withInject) {
    const src = read(f);
    // Meet's lives in google-meet-provider.js, which preload-meet loads.
    const meet = f === 'preload-meet.js' && /google-meet-provider/.test(src);
    assert.ok(meet || src.includes("installRecordingBridge("), `${f} runs page-inject but never installs the recording bridge`);
  }
});

test('the bridge forwards on exactly the channels the Meet provider does', () => {
  const meet = read('google-meet-provider.js');
  for (const [action, channel] of Object.entries(PAGE_TO_MAIN)) {
    const re = new RegExp(`action === '${action}'\\)\\s*\\{\\s*ipcRenderer\\.send\\('${channel}'`);
    assert.match(meet, re, `${action} → ${channel} disagrees with google-meet-provider.js`);
  }
  // And main listens on each of them.
  const main = read('main.js');
  for (const channel of Object.values(PAGE_TO_MAIN)) {
    assert.ok(main.includes(`'${channel}'`), `main.js does not handle ${channel}`);
  }
});

test('the page recorder taps media-element audio only where the WebRTC hook is off', () => {
  const inject = read('page-inject.js');
  const i = inject.indexOf("querySelectorAll('audio, video')");
  assert.ok(i > 0, 'page recorder no longer scans <audio>/<video> for remote audio');
  // Guarded by the same flag that turns the hook off, so Meet never records the
  // same audio twice (once from the hook, once from its <audio> element).
  const before = inject.slice(Math.max(0, i - 600), i);
  assert.match(before, /if \(window\.__vibeconf_disableAudioCapture\)/);
});

test('the measured crop is Meet-only', () => {
  const main = read('main.js');
  const fn = main.slice(main.indexOf('function recordingCropApplies'), main.indexOf('function recordingCropApplies') + 400);
  for (const flag of ['slackProviderMode', 'zoomProviderMode', 'teamsProviderMode']) {
    assert.ok(fn.includes('!' + flag), `crop still applies on ${flag}`);
  }
  // The measuring loop is what crops; it must only start where the crop applies.
  assert.match(main, /const measured = recordingCropApplies\(\)/);
  assert.match(main, /if \(measured\) startRecordRegionLoop\(\)/);
});
