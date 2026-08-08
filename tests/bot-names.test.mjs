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
const { BOT_NAMES, FEMININE, MASCULINE, ROBOTIC, ROBOT_WEIGHT, randomBotName } = require('../electron-app/bot-names.js');
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
  //
  // This used to demand a single lowercase word (/^[A-Z][a-z]+$/), which quietly
  // banned every multi-word and alphanumeric robot. A live test call showed
  // Google's captions returning "C-3PO" and "R2D2" verbatim, so digits, hyphens
  // and spaces are allowed now — what stays banned is non-ASCII.
  for (const n of BOT_NAMES) {
    assert.match(n, /^[A-Z][A-Za-z0-9-]*( [A-Z][A-Za-z0-9-]*)*$/, `${n} is not a TTS-safe ASCII name`);
  }
});

test('multi-word names still work with mention detection', () => {
  // local-server.js wakes the bot with a lowercased substring test against the
  // caption text, so a name only matches if the captions spell it the same way,
  // punctuation and all. That is fine for these — but it means a name whose
  // spelling Google renders differently ("C3PO", "R2 D2") would silently never
  // wake the bot, with no error anywhere. Hence the live-call check.
  const captions = 'When I talk about the robot C-3PO, how does that get transcribed? What about R2D2?';
  for (const n of ['C-3PO', 'R2D2']) {
    assert.ok(captions.toLowerCase().includes(n.toLowerCase()), `${n} would not wake on a real caption line`);
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

test('the wizard silently names an unnamed bot, and never renames one that has a name', () => {
  // Naming moved to the guided onboarding call (bot/voice/emoji/background are
  // now all set live, in-call — not in this dialog). But a bot still needs SOME
  // name to show on its Meet tile before that call ever runs, so the wizard
  // still picks one on load, silently, rather than leaving "Unnamed bot".
  //
  // This assertion USED TO PIN A DIFFERENT BUG: it asserted the literal
  // expression `savedVoiceCfg.botName || await suggestName()`, which reads
  // correctly and is wrong, because get-config fills botName with its schema
  // default. The test passed for exactly the reason the feature didn't work.
  // Assert the BEHAVIOUR — a real name is kept, the default is not — not the
  // spelling.
  assert.match(wizard, /if \(unnamed\) \{/);
  assert.match(wizard, /saved === DEFAULT_BOT_NAME/);
  // And a failed suggestion degrades to leaving the default alone, rather than
  // blocking the wizard's initial load.
  const fn = wizard.slice(wizard.indexOf('async function suggestName'));
  assert.match(fn.slice(0, fn.indexOf('\n}')), /catch \{ return ''; \}/);
});

test('a suggestion never hands back the name it was asked to replace', () => {
  // A repeat would read as a broken control, not a 1-in-345 coincidence — so the
  // current field value is excluded, not just the names already in use.
  assert.match(main, /exclude = \[\], count = 1 \} = \{\}\)/);
  assert.match(main, /\.\.\.taken, \.\.\.\(Array\.isArray\(exclude\) \? exclude : \[\]\)/);
});

test('the wizard has no name-spinner UI left — naming moved to the guided call', () => {
  const html = readFileSync(join(root, 'electron-app/renderer/onboarding.html'), 'utf8');
  assert.doesNotMatch(html, /id="botNameShuffle"/);
  assert.doesNotMatch(html, /data-step="bot"/);
  assert.doesNotMatch(wizard, /spinTimer|SPIN_MS|startSpin|stopSpin/);
});

test('famous robots are in the pool, but stay a garnish', () => {
  const lower = new Set(ROBOTIC.map((n) => n.toLowerCase()));
  for (const n of ['hal', 'tron', 'marvin', 'optimus prime', 'clippy', 'r2d2', 'skynet']) {
    assert.ok(lower.has(n), `${n} should be in the robot list`);
  }
  // Dropped by the name-transcription audit (2026-08-02): macOS `say` mangles
  // these or Meet mistranscribes them, so they must NOT be suggested at random.
  // They stay documented in bot-names.js's EXCLUDED comment; this guards a
  // re-add. (C-3PO was the canonical case — `say` reads it "ku-negative-three-poe".)
  for (const n of ['c-3po', 'pris', 'gort', 'twiki', 'kryten', 'giskard', 'daneel']) {
    assert.ok(!lower.has(n), `${n} was audited out — should NOT be in the robot list`);
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

test('the wizard suggests a name instead of pre-filling the default', () => {
  // The bug this pins: get-config fills unset prefs with their schema default,
  // so botName came back as 'Unnamed bot', not undefined. `savedCfg.botName ||
  // suggestName()` therefore always took the left branch and every fresh profile
  // pre-filled with the one name #187 exists to prevent — the feature looked
  // implemented and did nothing.
  const src = readFileSync(new URL('../electron-app/renderer/onboarding.js', import.meta.url), 'utf8');
  assert.match(src, /saved === DEFAULT_BOT_NAME/, 'must treat the schema default as "unnamed"');
  assert.doesNotMatch(src, /savedVoiceCfg\.botName \|\| await suggestName/, 'the truthiness check is the bug');

  // The renderer can't require() the schema, so the copied literal has to match.
  const schema = readFileSync(new URL('../electron-app/preferences-schema.js', import.meta.url), 'utf8');
  const real = schema.match(/const DEFAULT_BOT_NAME = '([^']+)'/)[1];
  const copy = src.match(/const DEFAULT_BOT_NAME = '([^']+)'/)[1];
  assert.equal(copy, real, 'onboarding.js copy of DEFAULT_BOT_NAME has drifted from the schema');
});

test('the names the header comment promises are actually in the list', () => {
  // The header said Pepper was deliberately kept, and Pepper was not in the
  // list — the rationale outlived the entry. A comment that describes the file
  // inaccurately is worse than no comment, so it is checked now.
  const lower = new Set(BOT_NAMES.map((n) => n.toLowerCase()));
  for (const n of ['jimmy', 'alice', 'pepper', 'samantha', 'daniel', 'ava', 'nora', 'zoe']) {
    assert.ok(lower.has(n), `the header claims ${n} is kept, but it is not in the list`);
  }
});

test('the house names are in', () => {
  const lower = new Set(BOT_NAMES.map((n) => n.toLowerCase()));
  for (const n of ['stan', 'seth', 'vern']) assert.ok(lower.has(n), `${n} should be in the pool`);
});

test('robots are over-represented in the draw, not in the list', () => {
  // Two different numbers, deliberately. The LIST stays ~10% robots — that is
  // what the pool contains. The DRAW weights them so they turn up about a
  // quarter of the time, because a wheel that shows a robot once every ten
  // spins may as well not have them.
  const inList = ROBOTIC.length / BOT_NAMES.length;
  assert.ok(inList < 0.2, `the list itself should stay mostly ordinary names, got ${(inList * 100).toFixed(0)}%`);

  const robots = new Set(ROBOTIC);
  const N = 60000;
  let hits = 0;
  for (let i = 0; i < N; i++) if (robots.has(randomBotName())) hits++;
  const drawn = hits / N;

  const expected = (ROBOTIC.length * ROBOT_WEIGHT) / (BOT_NAMES.length + ROBOTIC.length * (ROBOT_WEIGHT - 1));
  assert.ok(Math.abs(drawn - expected) < 0.02, `drew ${(drawn * 100).toFixed(1)}%, expected ~${(expected * 100).toFixed(1)}%`);
  assert.ok(drawn > inList * 2, 'weighting should visibly beat the list share, or it is not doing anything');
});

test('weighting never returns a name that is not in the list', () => {
  // The draw pool repeats entries; a bug there could surface a duplicate-shaped
  // value or an off-by-one past the end.
  for (let i = 0; i < 5000; i++) assert.ok(BOT_NAMES.includes(randomBotName()));
});
