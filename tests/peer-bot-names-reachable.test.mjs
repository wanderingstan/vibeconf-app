// peer-bot-names-reachable.test.mjs — a shipped feature must be switchable on
// (#430).
//
// #426 landed ranked speaking order, which stops two bots rolling dice against
// each other, and it shipped in v0.8.31. It could not be turned on.
//
// `botSpeakOrdering: "ranked"` needs `peerBotNames`, and on 2026-08-17 two
// agents on two different machines each tried to set it, minutes apart and
// without knowing the other was trying:
//
//     set_preference("peerBotNames", ["Jimmy"])   -> Expected array of strings
//     set_preference("peerBotNames", "Jimmy")     -> Expected array of strings
//
// The array does not reliably survive the MCP boundary, so from a client there
// was no value that satisfied the validator. Worse, `botSpeakOrdering` DID
// accept "ranked" and reported success — so the observable state was "the tool
// says the feature is on, the feature is off, and nothing says so". Anyone
// testing #426 by setting the pref and listening would conclude the ordering
// does not work, when it had never turned on.
//
// Two things are pinned here: the value can be set from any client, and a
// setting that is stored but inert says so.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validate, inertWarning, PREFERENCES } =
  require('../electron-app/preferences-schema.js');

test('a real array still works — the form the schema always documented', () => {
  const r = validate('peerBotNames', ['Pepper', 'Coltrane']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, ['Pepper', 'Coltrane']);
});

test('a stringified JSON array is accepted — this is what MCP clients send', () => {
  const r = validate('peerBotNames', '["Pepper","Coltrane"]');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, ['Pepper', 'Coltrane']);
});

test('a comma-separated string is accepted — what a person types', () => {
  const r = validate('peerBotNames', 'Pepper, Coltrane');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, ['Pepper', 'Coltrane']);
});

test('a bare name is accepted — the exact call that failed on 2026-08-17', () => {
  const r = validate('peerBotNames', 'Jimmy');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, ['Jimmy']);
});

test('an empty string clears the list rather than erroring', () => {
  const r = validate('peerBotNames', '');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, []);
});

test('blanks and stray whitespace are dropped, not stored as names', () => {
  // "Pepper, , Coltrane," is what a half-edited list looks like. An empty
  // string in this list would match nothing and quietly cost a rank slot.
  const r = validate('peerBotNames', ' Pepper , , Coltrane , ');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, ['Pepper', 'Coltrane']);
});

test('a non-string array member is still rejected', () => {
  // The leniency is about transport, not about accepting nonsense.
  const r = validate('peerBotNames', ['Pepper', 42]);
  assert.equal(r.ok, false);
  assert.match(r.error, /array of strings/);
});

test('a broken JSON array reports THAT, not a generic type error', () => {
  const r = validate('peerBotNames', '["Pepper"');
  assert.equal(r.ok, false);
  assert.match(r.error, /does not parse/);
});

test('ranked ordering with no peers points at discovery, and at the fallback', () => {
  // Peers are normally discovered from room presence, so an empty list is no
  // longer proof the feature is off. But discovery only works once every bot in
  // the room registers itself, so during a rollout this is precisely the case
  // that quietly does nothing — the note has to say what to look for.
  const w = inertWarning('botSpeakOrdering', 'ranked', () => []);
  assert.ok(w, 'must say something');
  assert.match(w, /peers discovered/, 'name the log line that confirms it worked');
  assert.match(w, /falls back to jitter/);
  assert.match(w, /set_preference/, 'and how to fix it by hand');
});

test('ranked ordering WITH peers does not warn', () => {
  assert.equal(inertWarning('botSpeakOrdering', 'ranked', () => ['Pepper']), null);
});

test('peers recorded while ordering is still jitter warns the other way round', () => {
  // The mirror mistake: set the list, forget the mode.
  const w = inertWarning('peerBotNames', ['Pepper'], () => 'jitter');
  assert.ok(w);
  assert.match(w, /botSpeakOrdering/);
});

test('peers recorded with ranked already on does not warn', () => {
  assert.equal(inertWarning('peerBotNames', ['Pepper'], () => 'ranked'), null);
});

test('an unrelated preference never warns', () => {
  assert.equal(inertWarning('botName', 'Jimmy', () => undefined), null);
});

test('inertWarning survives a store that throws', () => {
  // It runs on the write path of a live endpoint. A missing or exploding store
  // must not turn a successful preference change into a 500.
  const boom = () => { throw new Error('no store'); };
  assert.doesNotThrow(() => inertWarning('botSpeakOrdering', 'ranked', boom));
});

test('the pref documents the forms it accepts', () => {
  // The description is what an agent reads before calling set_preference, and
  // the array-only wording is what sent two agents into a dead end.
  const d = PREFERENCES.peerBotNames.description;
  assert.match(d, /comma-separated/);
  assert.match(d, /#430/);
});
