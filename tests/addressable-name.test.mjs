// addressable-name.test.mjs — can a bot actually be CALLED this? (#500 follow-up)
//
// Adopting an existing Claude session as a bot wants to reuse the SESSION's name:
// it is the user's own word for the thing, so it beats a random one. But session
// names are not chosen with speech in mind, and a bot's name is load-bearing —
// name-mention detection over Meet's captions is how it knows it is being spoken
// to, and in passive mode it is the only thing that wakes it.
//
// Conservative on purpose. A false NO costs a random name from the pool. A false
// YES ships a bot that never answers to itself, with nothing to tell the user why.
//
// Run: node --test tests/addressable-name.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isAddressableBotName } = require('../electron-app/addressable-name.js');

test('ordinary names people already use for sessions', () => {
  for (const n of ['Jimmy', 'Pepper', 'Coltrane', 'Samantha', 'Rowan', 'Otto']) {
    assert.equal(isAddressableBotName(n), true, n);
  }
});

test('two words are fine — people say both', () => {
  assert.equal(isAddressableBotName('Doctor Who'), true);
  assert.equal(isAddressableBotName('Jean-Luc'), true);
  assert.equal(isAddressableBotName("O'Brien"), true);
});

test('the case this exists for: a session named after the work', () => {
  // Real shapes people name sessions. All perfectly good session names, all
  // hopeless to say across a call.
  for (const n of ['pr-482-refactor', 'auth-migration-v2', 'issue-500', 'wip3']) {
    assert.equal(isAddressableBotName(n), false, n);
  }
});

test('digits are out — nobody says them and captions render them inconsistently', () => {
  assert.equal(isAddressableBotName('bot3'), false);
  assert.equal(isAddressableBotName('Jimmy2'), false);
});

test('words that are not names even when they look like one', () => {
  // A bot called "Bot" cannot be told apart from someone saying the word.
  for (const n of ['bot', 'Agent', 'claude', 'session', 'test', 'main', 'default']) {
    assert.equal(isAddressableBotName(n), false, n);
  }
});

test('a phrase is not a name', () => {
  assert.equal(isAddressableBotName('the auth refactor session'), false);
});

test('length bounds: it goes on a Meet tile and gets shouted across a call', () => {
  assert.equal(isAddressableBotName('J'), false, 'too short to detect reliably');
  assert.equal(isAddressableBotName('Bartholomewcuthbertsonwigglesworth'), false, 'too long');
});

test('junk and nullish are handled, not crashed on', () => {
  for (const n of [null, undefined, '', '   ', '🤖', '!!!', 42, {}]) {
    assert.equal(isAddressableBotName(n), false, JSON.stringify(n));
  }
});

test('surrounding whitespace does not decide it', () => {
  assert.equal(isAddressableBotName('  Rowan  '), true);
});
