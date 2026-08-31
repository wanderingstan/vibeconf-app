// realtime-response-gate.test.mjs — the decision the voice model no longer makes.
//
// With create_response:false the realtime model detects the end of a turn but
// does not answer it; _shouldRespond in page-inject.js decides. That method is
// the difference between a bot that talks over a three-way call and one that
// does not, and page-inject is injected script rather than a module, so it
// cannot be imported.
//
// So the method is EXTRACTED FROM THE SHIPPED FILE and evaluated. Slower to
// read than an import, but it cannot silently drift from what actually runs,
// which a hand-copied version would do on the first edit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function extractShouldRespond() {
  const src = readFileSync(join(root, 'electron-app/page-inject.js'), 'utf8');
  const start = src.indexOf('_shouldRespond(text) {');
  assert.ok(start > 0, '_shouldRespond not found in page-inject.js');
  let depth = 0, i = src.indexOf('{', start);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  const body = src.slice(from, i + 1);
  // Rebuild it as an object method so `this` works as it does on the class.
  return new Function(`return { _shouldRespond(text) ${body} }`)();
}

const gate = extractShouldRespond();

function decide(text, policy, holdUntil = 0) {
  const o = Object.create(gate);
  o.policy = policy;
  o.holdUntil = holdUntil;
  return o._shouldRespond(text);
}

const THREE_WAY = {
  gate: true,
  botNames: ['jimmy'],
  otherNames: ['stan james', 'stan', 'seth goldstein', 'seth'],
  respondWhenUnnamed: true,
};

test('two in the room: answer everything', () => {
  const p = { ...THREE_WAY, gate: false };
  assert.equal(decide('what do you think, Seth?', p).ok, true,
    'with nobody else to address, even another name is not a reason to stay quiet');
});

test('named directly: answer', () => {
  assert.equal(decide('Jimmy, what landed today?', THREE_WAY).ok, true);
  assert.equal(decide('hey jimmy can you check that', THREE_WAY).ok, true, 'case-insensitive');
});

test('somebody else named: stay quiet', () => {
  // The actual complaint from the 45-minute call: it answered turns aimed at
  // the other person.
  const d = decide('Seth, what do you reckon about the pricing?', THREE_WAY);
  assert.equal(d.ok, false);
  assert.match(d.why, /addressed to seth/);
});

test('nobody named: answers by default, and can be told not to', () => {
  assert.equal(decide('so what happened with the deploy', THREE_WAY).ok, true);
  assert.equal(
    decide('so what happened with the deploy', { ...THREE_WAY, respondWhenUnnamed: false }).ok,
    false,
  );
});

test('being named beats somebody else being named', () => {
  // "Seth, ask Jimmy about the tests" is for the bot.
  assert.equal(decide('Seth, ask Jimmy about the tests', THREE_WAY).ok, true);
});

test('a hold silences everything, including being named', () => {
  const until = Date.now() + 10_000;
  const d = decide('Jimmy, are you there?', THREE_WAY, until);
  assert.equal(d.ok, false);
  assert.match(d.why, /held/);
});

test('an expired hold is not a hold', () => {
  assert.equal(decide('Jimmy, are you there?', THREE_WAY, Date.now() - 1).ok, true);
});

test('empty transcript does not throw', () => {
  assert.equal(typeof decide('', THREE_WAY).ok, 'boolean');
  assert.equal(typeof decide(undefined, THREE_WAY).ok, 'boolean');
});

test('an empty policy never silences the bot', () => {
  // A policy that failed to build must not be a mute switch.
  assert.equal(decide('anything at all', { gate: true, respondWhenUnnamed: true }).ok, true);
});
