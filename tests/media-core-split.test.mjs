// media-core-split.test.mjs: Phase 2 of the calls library. page-inject.js is
// the media core (virtual mic and camera, the getUserMedia / getDisplayMedia
// overrides, the audio taps, the recorder); what the app draws or says through
// it are page plugins on window.__vibeconfMedia: the emoji avatar
// (page-avatar.js) and the realtime voice (page-realtime-voice.js). These pin
// that line, so app code doesn't drift back into the core.
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const read = (f) => readFileSync(new URL('../electron-app/' + f, import.meta.url), 'utf8');
const core = readFileSync(new URL('../packages/calls/inject/page-inject.js', import.meta.url), 'utf8');
const avatar = read('page-avatar.js');
const realtime = read('page-realtime-voice.js');

test('the core holds no face and no realtime voice', () => {
  for (const app of ['class AvatarFace', 'MODE_EMOJIS', 'avatarState', 'emojiSetGlobal', 'class RealtimeVoice',
    'class Whiteboard', "case 'set-bot-state'", "case 'set-emoji-set'"]) {
    assert.ok(!core.includes(app), `page-inject.js should not contain ${app}`);
  }
  assert.match(core, /class CameraSurface \{/);
  assert.match(core, /class VirtualMic \{/);
});

test('the core exposes its media API, and the plugins use only that', () => {
  assert.match(core, /window\.__vibeconfMedia = media;/);
  for (const m of ['setCameraRenderer(', 'on(event, fn)', 'emit(event, data)', 'mic()', 'remoteAudio()',
    'speechLevel()', 'outputTapTracks()', 'currentMic()', 'setOwnVoice(on)']) {
    assert.ok(core.includes('    ' + m), `media.${m}`);
  }
  for (const [name, src] of [['page-avatar.js', avatar], ['page-realtime-voice.js', realtime]]) {
    assert.match(src, /const media = window\.__vibeconfMedia;\n\s*if \(!media\)/, name + ' reads the core API and bails without it');
  }
});

test('the camera draws a video source, else the renderer, else black', () => {
  const r = core.slice(core.indexOf('class CameraSurface'), core.indexOf('class VirtualMic'));
  const render = r.slice(r.indexOf('    _render() {'));
  const video = render.indexOf('if (this.videoSource)');
  const renderer = render.indexOf('this.renderer.render();');
  const black = render.indexOf("ctx.fillStyle = '#000';");
  assert.ok(video > 0 && renderer > video && black > renderer);
  // A renderer registered after a camera exists still reaches it.
  assert.match(core, /for \(const cam of cameras\.values\(\)\) cam\.renderer = factory \? factory\(cam\) : null;/);
  // Runway's bridge still works, through the core.
  assert.match(core, /window\.__vibeSetAvatarVideo = \(el\) =>/);
  assert.match(core, /window\.__vibeMicTrack = \(\) =>/);
});

test('the avatar draws a face per camera and follows the core\'s events', () => {
  assert.match(avatar, /media\.setCameraRenderer\(\(surface\) => \{\n\s*const face = new AvatarFace\(surface\);/);
  assert.match(avatar, /media\.on\('bot-speaking'/);
  assert.match(avatar, /media\.on\('recording'/);
  assert.match(avatar, /const amp = media\.speechLevel\(\);/, 'lip-sync reads the voice level through the core');
});

test('every playback path tells the face through the core, not by touching cameras', () => {
  assert.doesNotMatch(core, /cam\.speaking\s*=/);
  assert.doesNotMatch(core, /cam\.isRecording\s*=/);
  assert.ok((core.match(/media\.emit\('bot-speaking'/g) || []).length >= 6, 'TTS, speech test, test tone');
  assert.match(core, /media\.emit\('recording', \{ on: true \}\)/);
  assert.match(realtime, /media\.emit\('bot-speaking', \{ speaking: on, emoji: null \}\)/);
});

test('each avatar message is handled in exactly one place', () => {
  const cases = (src) => new Set([...src.matchAll(/^\s+case '([^']+)':/gm)].map((m) => m[1]));
  const c = cases(core);
  const a = cases(avatar);
  for (const name of a) assert.ok(!c.has(name), `${name} is handled by both the core and the avatar`);
  for (const name of ['set-bot-state', 'set-call-status', 'set-emoji-set', 'set-avatar-background', 'set-debug-overlay', 'name-mentioned']) {
    assert.ok(a.has(name), name);
  }
  for (const name of ['play-tts', 'stop-tts', 'set-share-audio']) assert.ok(c.has(name), name);
});

test('the loader evals the core before the plugins, and a plugin failing never stops the media', () => {
  const { CORE, PLUGINS } = require('../electron-app/page-scripts.js');
  assert.equal(CORE, 'page-inject.js');
  assert.deepEqual(PLUGINS, ['page-avatar.js', 'page-realtime-voice.js']);
  const loader = read('page-scripts.js');
  const body = loader.slice(loader.indexOf('function injectPageScripts('));
  assert.ok(body.indexOf('injectMediaCore()') < body.indexOf('for (const file of PLUGINS)'));
  assert.match(body, /for \(const file of PLUGINS\) \{\n\s*try \{\n\s*evalFile\(dir, file\);\n\s*\} catch/);
});
