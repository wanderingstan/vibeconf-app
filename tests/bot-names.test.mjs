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
const { BOT_NAMES, FEMININE, MASCULINE, randomBotName } = require('../electron-app/bot-names.js');
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
  assert.match(main, /randomBotName\(\{ taken: \[\.\.\.taken/);
  assert.match(main, /listProfiles\(PROFILES_ROOT\)/, 'the taken list should be the real one');
});

test('the wizard pre-fills only when the bot has no name yet', () => {
  // Re-running the wizard for a named bot must not rename it.
  assert.match(wizard, /savedVoiceCfg\.botName \|\| await suggestName\(\)/);
  // And a failed suggestion degrades to the old empty field rather than blocking.
  const fn = wizard.slice(wizard.indexOf('async function suggestName'));
  assert.match(fn.slice(0, fn.indexOf('\n}')), /catch \{ return ''; \}/);
});

test('"Try another" cannot hand back the name it was asked to replace', () => {
  // A 1-in-345 repeat would read as a broken button, not a coincidence — so the
  // current field value is excluded, not just the names already in use.
  assert.match(main, /exclude = \[\] \} = \{\}\)/);
  assert.match(main, /\.\.\.taken, \.\.\.\(Array\.isArray\(exclude\) \? exclude : \[\]\)/);
  assert.match(wizard, /suggestName\(\[\$\('botName'\)\.value\]\)/);
});

test('the shuffle button exists and is wired', () => {
  const html = readFileSync(join(root, 'electron-app/renderer/onboarding.html'), 'utf8');
  assert.match(html, /id="botNameShuffle"/);
  // The input is width:100%, so it needs a flex row to share the line.
  assert.match(html, /class="field-row"/);
  assert.match(wizard, /\$\('botNameShuffle'\)\?\.addEventListener/);
  // Disabled while in flight, so a double-click can't race two suggestions.
  const fn = wizard.slice(wizard.indexOf("$('botNameShuffle')?.addEventListener"));
  assert.match(fn.slice(0, 500), /btn\.disabled = true/);
});
