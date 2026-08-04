// leave-and-new-bot.test.mjs — two long-standing papercuts.
//
// 1. leave_call cut the bot off mid-goodbye. speak() returns when text is
//    QUEUED, not when it is heard, so the usual `speak("Bye!")` → `leave_call`
//    pair landed milliseconds apart and the goodbye died in the teardown. From
//    the room it read as the bot hanging up on you.
//
// 2. "New bot" prompted for a name. That prompt is a fossil: it asked for the
//    profile DIRECTORY, from back when that was also the bot's name. It isn't
//    any more, so it made people name the bot twice — the first time in a field
//    that only accepts [A-Za-z0-9._-].
//
// Run: node --test tests/leave-and-new-bot.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const panelJs = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

test('leaving waits for speech that is still playing', async () => {
  const s = new LocalServer({ port: 0 });
  s.speakingAloud = true;
  const done = s.waitForSpeechDrain(2000, 10);
  setTimeout(() => { s.speakingAloud = false; }, 120);
  const r = await done;
  assert.equal(r.drained, true);
  assert.ok(r.waited >= 100, `should have waited for the audio, waited ${r.waited}ms`);
});

test('…and for speech still queued behind it', async () => {
  // Two different states, both meaning "not finished": pendingBotSpeech is text
  // awaiting its turn, speakingAloud is audio playing right now (#368).
  const s = new LocalServer({ port: 0 });
  s.pendingBotSpeech = [{ text: 'one more thing' }];
  const done = s.waitForSpeechDrain(2000, 10);
  setTimeout(() => { s.pendingBotSpeech = []; }, 120);
  const r = await done;
  assert.equal(r.drained, true);
  assert.ok(r.waited >= 100);
});

test('a silent bot leaves immediately', async () => {
  // The common case must not pay for the fix.
  const s = new LocalServer({ port: 0 });
  const r = await s.waitForSpeechDrain(2000, 10);
  assert.deepEqual(r, { waited: 0, drained: true });
});

test('a stuck voice cannot make leave_call hang forever', async () => {
  // A bot that will not hang up is worse than one that clips its goodbye.
  const s = new LocalServer({ port: 0 });
  s.speakingAloud = true; // never clears
  const r = await s.waitForSpeechDrain(180, 10);
  assert.equal(r.drained, false, 'reports honestly that it gave up');
  assert.ok(r.waited >= 180 && r.waited < 1500, `bounded, waited ${r.waited}ms`);
});

test('the leave route actually awaits the drain', async () => {
  // The helper existing is not the fix; calling it before onLeaveCall is.
  const src = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');
  const block = src.slice(src.indexOf("if (data.meta?.action === 'leave')"));
  const body = block.slice(0, block.indexOf('\n    }'));
  assert.match(body, /await this\.waitForSpeechDrain\(\)/);
  assert.ok(body.indexOf('waitForSpeechDrain') < body.indexOf('this.onLeaveCall()'),
    'wait BEFORE tearing the call down');
});

test('new bot: no prompt, auto-named, opens on Settings', () => {
  const add = panelJs.slice(panelJs.indexOf("add.textContent = '＋ New bot…'"));
  const handler = add.slice(0, add.indexOf('profileMenu.appendChild(add)'));
  assert.match(handler, /api\.invoke\('create-new-bot'\)/);
  assert.doesNotMatch(handler, /inlinePrompt/, 'the name prompt is the thing being removed');

  assert.match(main, /ipcMain\.handle\('create-new-bot'/);
  const h = main.slice(main.indexOf("ipcMain.handle('create-new-bot'"));
  assert.match(h.slice(0, 300), /nextBotProfileName\(\)/);
  assert.match(h.slice(0, 300), /openSettings: true/);
});

test('auto-naming fills the first gap rather than counting up forever', () => {
  // Deleting bot3 and adding a bot should reuse bot3, not creep to bot4.
  const fn = main.slice(main.indexOf('function nextBotProfileName'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /for \(let i = 2;/, 'starts at 2 — the default profile is 1');
  assert.match(body, /if \(!taken\.has\(candidate\)\) return candidate/);
  assert.match(body, /toLowerCase\(\)/, 'case-insensitive, since these are directory names');
  assert.match(body, /i < 1000/, 'bounded');
});

test('the settings hand-off does not masquerade as a pop-out', () => {
  // 'screen' is the pop-out marker (IS_POPOUT_WINDOW). Reusing it here would
  // suppress this panel's height reporting and freeze the main window's size —
  // the bug that made the troubleshooting column vanish, in a new place.
  assert.match(main, /search: 'startScreen=settings'/);
  assert.doesNotMatch(main, /search: 'screen=settings'/);
  assert.match(panelJs, /get\('startScreen'\) === 'settings'/);
});
