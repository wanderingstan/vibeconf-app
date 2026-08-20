// speaking-state-role.test.mjs — announcing WHO IS SPEAKING must not change
// WHO SOMEONE IS (#473).
//
// The presence endpoint assigns a role on every write, and a body without one
// resolves to 'member'. main.js posts speaking state to that endpoint on every
// speaking edge, for every participant the tracker sees — so each bot was
// demoting every other bot it heard talk, several times a minute, purely as a
// side effect of saying who was talking. Each bot's own 60s registration
// heartbeat promoted it back, so the room's roles oscillated.
//
// Measured on paz-sqoa-npe: a bot read as `member` 56 seconds after it had
// announced itself as `bot`, and at one point BOTH bots in a two-bot call read
// as members.
//
// It matters because role is the bot/human answer everywhere downstream:
// _botNameSet() feeds ranked speaking order (#443) and the human-vs-bot split in
// _evaluateBargeIn (#154). A bot misread as a human is yielded to instantly and
// loses its own turn slot — and "unknown ⇒ human" is a deliberate default there,
// so the mistake is silent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

// The function under inspection, isolated so a match elsewhere cannot satisfy it.
const fn = main.slice(main.indexOf('function updateSpeakingState('),
  main.indexOf('\n}', main.indexOf('function updateSpeakingState(')));

test('a speaking-state POST carries a role when the name is a known bot', () => {
  assert.match(fn, /_botNameSet\(\)/, 'it has to consult the roster to know');
  assert.match(fn, /role = 'bot'/);
  assert.match(fn, /\.\.\.\(role \? \{ role \} : \{\}\)/,
    'and send it, rather than computing it and dropping it');
});

test('an UNKNOWN name is still posted without a role', () => {
  // Deliberate. Unknown resolves to 'member', which is correct for the humans in
  // the room — and this code asserting an identity it is only guessing at is the
  // exact mistake that caused the bug. A bot not yet learned self-heals on its
  // own next registration heartbeat.
  assert.match(fn, /role \? \{ role \} : \{\}/);
  assert.doesNotMatch(fn, /role: 'member'/, 'never assert "this is a human"');
});

test('a missing roster does not break the speaking announcement', () => {
  // This runs on every speaking edge during a live call. A roster lookup that
  // threw would take the announcement down with it, and the silence gate on the
  // website's /api/sync long-poll reads that `speaking` flag.
  const guarded = fn.slice(fn.indexOf('let role;'), fn.indexOf('fetch('));
  assert.match(guarded, /try \{/);
  assert.match(guarded, /catch/);
});

test('the speaking flag is still sent — the silence gate depends on it', () => {
  // api/sync/[roomId].ts computes anyoneSpeaking from presence `speaking`, so
  // dropping this POST entirely (the tempting fix) would break that.
  assert.match(fn, /JSON\.stringify\(\{ name, speaking/);
});
