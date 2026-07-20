// tts-chunking.test.mjs — unit tests for the sentence-chunked TTS split (#372).
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { splitForTts } = require('../electron-app/tts-chunking.js');

test('short replies are never split', () => {
  assert.deepEqual(splitForTts('Sure, sounds good.'), ['Sure, sounds good.']);
  assert.deepEqual(splitForTts(''), ['']);
  assert.deepEqual(splitForTts(null), ['']);
});

test('long multi-sentence reply splits at the first sentence boundary', () => {
  const first = 'Broad strokes: Indigenous peoples lived here for thousands of years.';
  const rest = 'Then European colonization began in the sixteenth century and everything changed dramatically over the next few hundred years.';
  const [a, b] = splitForTts(`${first} ${rest}`);
  assert.equal(a, first);
  assert.equal(b, rest);
});

test('question and exclamation ends work as boundaries', () => {
  const [a, b] = splitForTts('Do you want the long version or the short one first? Either way I will need a moment to pull the numbers together for you.');
  assert.match(a, /one first\?$/);
  assert.match(b, /^Either way/);
});

test('no split when the tail would be tiny', () => {
  const text = 'This is a fairly long single thought that goes on and on and on without a break until the very end arrives. Ok.';
  assert.deepEqual(splitForTts(text), [text]);
});

test('no split when there is no sentence boundary', () => {
  const text = 'one enormous run-on clause '.repeat(8).trim();
  assert.deepEqual(splitForTts(text), [text]);
});

test('early abbreviation-ish period is skipped by the 25-char floor', () => {
  const [a] = splitForTts('Dr. Smith said the results were quite promising overall. The full report should arrive sometime early next week for us to review.');
  assert.match(a, /promising overall\.$/);
});

test('boundary with closing quote splits after the quote', () => {
  const [a, b] = splitForTts('She said the plan was "basically ready to ship today." The rest of the team still wants another day to double-check the deployment steps.');
  assert.match(a, /ship today\."$/);
  assert.match(b, /^The rest of the team/);
});
