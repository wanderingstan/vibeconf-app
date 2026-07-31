// bot-names.test.mjs — the suggested names a new bot can be given (#187).
//
// The wizard's name field used to start empty, and saveCurrent() only writes a
// non-blank name — so skipping the step fell through to the schema default and
// put "Unnamed bot" on someone's Meet tile, in front of the room.
//
// The list itself has one rule that prevents a real bug rather than being taste:
// a bot wakes on hearing its own name in the captions, so a name that is also a
// common word would fire on ordinary conversation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BOT_NAMES, FEMININE, MASCULINE, ROBOTIC, randomBotName } = require('../electron-app/bot-names.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const wizard = readFileSync(join(root, 'electron-app/renderer/onboarding.js'), 'utf8');

test('there are enough names, split evenly', () => {
  assert.ok(BOT_NAMES.length >= 300, `expected a wide pool, got ${BOT_NAMES.length}`);
  // Even enough that a first-run bot is not reliably one gender.
  const skew = Math.abs(FEMININE.length - MASCULINE.length) / BOT_NAMES.length;
  assert.ok(skew < 0.1, `lists are lopsided: ${FEMININE.length} vs ${MASCULINE.length}`);
});

test('no duplicates', () => {
  const seen = new Set(BOT_NAMES.map((n) => n.toLowerCase()));
  assert.equal(seen.size, BOT_NAMES.length, 'a repeated name skews the draw');
});

test('no name is also a common word', () => {
  // THE rule that matters. Name-mention detection scans captions, so a bot called
  // Iris or Dev would wake on ordinary speech — and "Mai" is a homophone of "my",
  // which would fire constantly. Spot-check the ones most likely to creep back in.
  const banned = [
    'iris', 'ivy', 'june', 'hazel', 'grace', 'dawn', 'joy', 'hope', 'faith', 'rose',
    'summer', 'autumn', 'sky', 'amber', 'jade', 'pearl', 'ruby', 'crystal', 'star',
    'dev', 'mai', 'may', 'bell', 'belle', 'reed', 'art', 'will', 'mark', 'rich',
    'sunny', 'melody', 'harmony', 'angel', 'faye',
    // Popular US names that are also ordinary words — the ones most likely to be
    // re-added by someone padding the list for familiarity.
    'lily', 'violet', 'willow', 'daisy', 'autumn', 'nova', 'aria', 'serenity',
    'jack', 'mason', 'hunter', 'cooper', 'parker', 'carter', 'brooks', 'miles',
    'roman', 'christian', 'maverick', 'chase', 'colt', 'ace',
  ];
  const lower = new Set(BOT_NAMES.map((n) => n.toLowerCase()));
  const found = banned.filter((w) => lower.has(w));
  assert.deepEqual(found, [], `these would wake the bot on ordinary speech: ${found.join(', ')}`);
});

test('every name is plain ASCII, for the TTS', () => {
  // The bot says its own name aloud. Diacritics and non-English phonology get
  // mangled by `say` and SAPI, so the spellings have to be ones they read.
  for (const n of BOT_NAMES) {
    assert.match(n, /^[A-Z][a-z]+$/, `${n} should be a plain capitalised ASCII name`);
  }
});

test('no name is so short it invites a false match', () => {
  // Two-letter names ("Al", "Bo") are substrings of ordinary words and would make
  // mention detection unreliable no matter how the matching is written.
  for (const n of BOT_NAMES) {
    assert.ok(n.length >= 3, `${n} is too short to match safely`);
  }
});

test('common American names are well represented', () => {
  // The audience is mostly US, so the list should feel familiar more often than
  // not — an all-international list reads as deliberately exotic.
  const lower = new Set(BOT_NAMES.map((n) => n.toLowerCase()));
  const common = ['emma', 'olivia', 'liam', 'noah', 'james', 'henry', 'michael', 'elizabeth'];
  const present = common.filter((n) => lower.has(n));
  assert.ok(present.length >= 6, `expected common US names, found ${present.length}`);
});

test('randomBotName avoids names already taken', () => {
  // Someone setting up a second bot must not be handed the first one's name.
  const taken = BOT_NAMES.slice(1);
  assert.equal(randomBotName({ taken }), BOT_NAMES[0], 'should pick the only free name');
  // Case and whitespace shouldn't defeat it.
  assert.equal(randomBotName({ taken: BOT_NAMES.slice(1).map((n) => `  ${n.toUpperCase()} `) }), BOT_NAMES[0]);
});

test('randomBotName still returns something when everything is taken', () => {
  // A duplicate name is worse than a unique one; no name at all is worse than
  // both, because the empty field is exactly what this feature exists to prevent.
  const n = randomBotName({ taken: BOT_NAMES });
  assert.ok(BOT_NAMES.includes(n));
});

test('the suggestion is made in main, not the renderer', () => {
  // Two wizards open at once must not land on the same name, and only main can
  // see which names are already in use on this machine.
  assert.match(main, /ipcMain\.handle\('onboarding:suggest-bot-name'/);
  assert.match(main, /const avoid = \[\.\.\.taken/, 'main merges the taken list itself');
  assert.match(main, /listProfiles\(PROFILES_ROOT\)/, 'the taken list should be the real one');
});

test('the wizard pre-fills only when the bot has no name yet', () => {
  // Re-running the wizard for a named bot must not rename it.
  assert.match(wizard, /savedVoiceCfg\.botName \|\| await suggestName\(\)/);
  // And a failed suggestion degrades to the old empty field rather than blocking.
  const fn = wizard.slice(wizard.indexOf('async function suggestName'));
  assert.match(fn.slice(0, fn.indexOf('\n}')), /catch \{ return ''; \}/);
});

test('a suggestion never hands back the name it was asked to replace', () => {
  // A repeat would read as a broken control, not a 1-in-345 coincidence — so the
  // current field value is excluded, not just the names already in use.
  assert.match(main, /exclude = \[\], count = 1 \} = \{\}\)/);
  assert.match(main, /\.\.\.taken, \.\.\.\(Array\.isArray\(exclude\) \? exclude : \[\]\)/);
});

test('the spinner exists and toggles Spin/Stop', () => {
  const html = readFileSync(join(root, 'electron-app/renderer/onboarding.html'), 'utf8');
  assert.match(html, /id="botNameShuffle"/);
  assert.match(html, />Spin</, 'starts as Spin');
  // The input is width:100%, so it needs a flex row to share the line — and the
  // button needs a min-width so Spin↔Stop doesn't resize it mid-spin.
  assert.match(html, /class="field-row"/);
  assert.match(html, /min-width: 92px/);
  assert.match(wizard, /btn\.textContent = 'Stop'/);
  assert.match(wizard, /btn\.textContent = 'Spin'/);
});

test('Stop keeps exactly the name on screen', () => {
  // No deceleration, no settling elsewhere. A wheel that coasts past what you
  // were looking at when you clicked is infuriating — and here it would mean the
  // button lied about what you were choosing.
  const fn = wizard.slice(wizard.indexOf('function stopSpin'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /clearInterval\(spinTimer\)/);
  assert.ok(!/botName'\)\.value =/.test(body), 'stopping must not change the field');
});

test('the spin speed sits at the reaction-time cusp', () => {
  // Tuned so you can ALMOST stop on a name you liked. Simple reaction time is
  // ~250ms, so at ~220ms the wheel advances about one name while you react.
  const m = wizard.match(/const SPIN_MS = (\d+)/);
  assert.ok(m, 'SPIN_MS should exist');
  const ms = Number(m[1]);
  assert.ok(ms >= 180 && ms <= 300, `${ms}ms is outside the cusp: <180 is pure luck, >300 is easy to aim`);
});

test('one batch per spin, not an IPC per frame', () => {
  // At ~4.5 names/sec a round trip per frame would make the wheel stutter.
  assert.match(wizard, /suggestNames\(SPIN_BATCH/);
  assert.match(main, /names\.push\(randomBotName\(\{ taken: \[\.\.\.avoid, \.\.\.names\] \}\)\)/,
    'a batch must not repeat a name back-to-back');
});

test('typing beats spinning, and navigating away stops it', () => {
  // Otherwise the wheel overwrites what someone has begun to type, and a spin
  // left running keeps rewriting a field nobody is looking at.
  assert.match(wizard, /\$\('botName'\)\?\.addEventListener\('focus', stopSpin\)/);
  assert.match(wizard, /\$\('botName'\)\?\.addEventListener\('keydown', stopSpin\)/);
  const save = wizard.slice(wizard.indexOf('async function saveCurrent'));
  assert.match(save.slice(0, 300), /stopSpin\(\);/);
});

test('famous robots are in the pool, but stay a garnish', () => {
  const lower = new Set(ROBOTIC.map((n) => n.toLowerCase()));
  for (const n of ['hal', 'tron', 'marvin', 'optimus', 'clippy']) {
    assert.ok(lower.has(n), `${n} should be in the robot list`);
  }
  // A joke name is fun once and tiresome as the usual outcome. Most people
  // should still be handed an ordinary name.
  const share = ROBOTIC.length / BOT_NAMES.length;
  assert.ok(share > 0.03 && share < 0.2, `robots are ${(share * 100).toFixed(0)}% of the pool`);
});

test('no robot name wakes a real assistant in the room', () => {
  // This is the one exclusion that is not about the bot at all. It says its own
  // name out loud, in a room of phones and laptops — a bot called Alexa or Siri
  // would set off every device within earshot of the speaker, every time it
  // introduced itself. Cortana is allowed only because it is discontinued.
  const wakeWords = ['alexa', 'siri', 'cortana', 'bixby'];
  const lower = new Set(BOT_NAMES.map((n) => n.toLowerCase()));
  const live = wakeWords.filter((w) => w !== 'cortana').filter((w) => lower.has(w));
  assert.deepEqual(live, [], `these would trigger nearby devices: ${live.join(', ')}`);
});
