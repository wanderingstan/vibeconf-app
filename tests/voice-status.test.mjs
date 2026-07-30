// voice-status.test.mjs — "can this bot speak?" and what we do when it can't.
//
// The bug these pin: the panel warned "Voice is off: no ElevenLabs key set"
// whenever no key was present. That is a different question from whether the bot
// can speak, and it was wrong for almost everyone — a keyless bot on macOS or
// Windows falls back to the OS voice and speaks fine (#59 asked for exactly that
// fallback, and it already existed), and a Voicebox user has local TTS. It even
// nagged people who had deliberately chosen a built-in voice with set_voice.
//
// Silence is real on exactly one platform: Linux, which has no built-in voice
// until #21 lands.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveVoice, hasBuiltInVoice } = require('../electron-app/voice-status.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const panelJs = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');
const panelHtml = readFileSync(join(root, 'electron-app/renderer/panel.html'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'electron-app/package.json'), 'utf8'));

test('a keyless macOS or Windows bot can speak', () => {
  // #59: "should a keyless macOS install fall back to the system say voice?"
  // It does, and has all along — the warning was the only thing saying otherwise.
  for (const platform of ['darwin', 'win32']) {
    const r = resolveVoice({ platform });
    assert.equal(r.canSpeak, true, `${platform} should fall back to its built-in voice`);
    assert.equal(r.provider, 'macos-say');
    assert.equal(r.usingBuiltIn, true);
  }
});

test('an ElevenLabs key or a Voicebox profile carries any platform', () => {
  assert.equal(resolveVoice({ platform: 'linux', ttsApiKey: 'sk-x' }).provider, 'elevenlabs');
  assert.equal(
    resolveVoice({ platform: 'linux', ttsProvider: 'voicebox', voiceboxProfileId: 'p1' }).provider,
    'voicebox',
  );
});

test('choosing a built-in voice is not a reason to nag about a key', () => {
  // set_voice with an OS voice sets ttsProvider='macos-say' and forces it, at
  // which point the ElevenLabs key is irrelevant by the user's own choice.
  const r = resolveVoice({ platform: 'darwin', ttsProvider: 'macos-say' });
  assert.equal(r.canSpeak, true);
  assert.equal(r.provider, 'macos-say');
});

test('a configured provider with no credential still falls through to the built-in voice', () => {
  // main.js retries on the built-in voice when the primary throws, so reporting
  // the CONFIGURED provider here would claim a voice the bot does not have.
  const r = resolveVoice({ platform: 'darwin', ttsProvider: 'elevenlabs' });
  assert.equal(r.canSpeak, true);
  assert.equal(r.provider, 'macos-say', 'should report what will actually render');
});

test('Linux with nothing configured is the only silent case', () => {
  const r = resolveVoice({ platform: 'linux' });
  assert.equal(r.canSpeak, false);
  assert.equal(r.provider, null);
  assert.match(r.reason, /no built-in voice/);
  // A provider named but not configured is still silence.
  assert.equal(resolveVoice({ platform: 'linux', ttsProvider: 'voicebox' }).canSpeak, false);
  assert.equal(hasBuiltInVoice('linux'), false);
});

test('the banner keys off "cannot speak", not off the ElevenLabs key', () => {
  assert.match(panelJs, /api\.invoke\('get-voice-status'\)/);
  assert.match(panelJs, /status\?\.canSpeak === false \? 'flex' : 'none'/);
  // The old condition must be gone — it is the bug.
  assert.ok(
    !/updateAppSettingsBanner\(!!\s*(result|c)\?\.ttsApiKey\)/.test(panelJs),
    'the banner must not be driven by the presence of an ElevenLabs key',
  );
});

test('the renderer asks main rather than keeping its own copy of the rule', () => {
  // The renderer is context-isolated and cannot require the module, so the only
  // alternative to IPC is a second implementation that drifts.
  assert.match(main, /ipcMain\.handle\('get-voice-status'/);
  assert.match(main, /require\('\.\/voice-status\.js'\)/);
  assert.ok(!/BUILT_IN_VOICE_PLATFORMS/.test(panelJs), 'the platform list must not be duplicated in the renderer');
});

test('the banner copy does not claim voice is off, and offers a way out', () => {
  const banner = panelHtml.slice(panelHtml.indexOf('id="appSettingsBanner"'));
  const block = banner.slice(0, banner.indexOf('</div>'));
  assert.ok(!/Voice is off/.test(block), 'that phrasing was false on macOS and Windows');
  assert.match(block, /can't speak/);
  assert.match(block, /chat/, 'should say what the bot will do instead');
  assert.match(block, /Choose a voice/, 'should link somewhere that fixes it');
});

test('a voiceless bot announces itself in-call, once', () => {
  const fn = main.slice(main.indexOf('function announceNoVoiceOnce'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /if \(status\.canSpeak \|\| !room \|\| _noVoiceAnnouncedFor === room\) return/,
    'must not repeat the notice for the same call');
  assert.match(body, /onPlayAudio\(\{ path: noVoiceClipPath/);
  // The clip is a courtesy; the agent instruction is what keeps the call working,
  // so a failed clip must not skip it.
  const play = body.indexOf('onPlayAudio');
  const addErr = body.indexOf('localServer.addError');
  assert.ok(play < addErr, 'the agent instruction should follow the clip');
  assert.match(body.slice(play, addErr), /catch/, 'a failed clip must not stop the agent being told');
  // And it must tell the agent to stop trying to speak.
  assert.match(body, /Do not call speak/);
  assert.match(body, /send_chat/);
});

test('the announcement re-arms for the next call', () => {
  const hook = main.slice(main.indexOf('onCallStatusChange:'));
  const block = hook.slice(0, hook.indexOf('\n  },'));
  assert.match(block, /announceNoVoiceOnce\(\)/);
  assert.match(block, /_noVoiceAnnouncedFor = null/, 'a new call must be able to announce again');
});

test('a voice name that is not installed cannot mute the bot', () => {
  // The default OS voice is a PREFERENCE, not a promise: no macOS voice name is
  // guaranteed present (on macOS 26.5 even `Alex` is a download now), and the
  // Windows name comes from whatever that machine happens to have. Both paths
  // must degrade to the system default rather than throw, or a bot would go
  // silent because of a string.
  //
  // macOS gets this from `say` itself, which substitutes the default voice and
  // exits 0 for an unknown or empty -v. Windows needs it in our own code:
  assert.match(
    readFileSync(join(root, 'electron-app/system-voices.js'), 'utf8'),
    /if \(\$voice\) \{ try \{ \$synth\.SelectVoice\(\$voice\) \} catch \{ \} \}/,
    'SAPI must fall back to the default voice rather than throw on a missing one',
  );
  // And the reasoning is recorded where the default is set, so the next reader
  // does not "fix" a non-bug.
  const tts = readFileSync(join(root, 'electron-app/tts.js'), 'utf8');
  const line = tts.slice(tts.indexOf('this.macosVoice = config.macosVoice'));
  assert.match(tts.slice(Math.max(0, tts.indexOf('this.macosVoice = config.macosVoice') - 1400)), /PREFERENCE, not a guarantee/);
  assert.match(line.slice(0, 200), /'Daniel'/, 'the macOS default is a real voice name, not empty');
});

test('the recorded clip exists and is packaged', () => {
  const clip = join(root, 'electron-app/no-voice.mp3');
  const size = statSync(clip).size;
  // Real audio, not a stub: the sentence runs ~10s.
  assert.ok(size > 20_000, `no-voice.mp3 looks too small to be speech (${size} bytes)`);
  assert.ok(pkg.build.files.includes('*.mp3'), 'the clip must ship with the app');
  assert.match(main, /noVoiceClipPath = path\.join\(EXT_DIR, 'no-voice\.mp3'\)/);
});
