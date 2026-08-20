// announce-as-bot.test.mjs — an instance can decline to be known as a bot (#471).
//
// Barge-in treats a peer bot differently from a person: a peer gets an extra
// random tie-break delay before the bot backs off, a human is yielded to at
// once (#154). So "does the bot yield to a person" cannot be tested with a
// second bot in the room — which is exactly what the etiquette suite was doing,
// and it reported peer-bot results as human-barge-in ones until #470.
//
// The identity travels one way and sticks: each bot registers itself in room
// presence as role='bot' (#430), the others fold that into their roster via
// mergeRemoteMembers, and that merge deliberately lets a remote 'bot' upgrade a
// local 'member' but never the reverse. So this has to be off BEFORE the first
// heartbeat — de-registering afterwards cannot undo it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;
const { PREFERENCES } = require('../electron-app/preferences-schema.js');

function serverWith(prefs) {
  const s = new LocalServer({ port: 0, onBotSpeech: () => {}, getPref: (k) => prefs[k] });
  s.setRoom('test-room');
  s.getEffectiveBotName = () => 'Voice';
  s.getWebsiteUrl = () => 'https://example.invalid';
  return s;
}

test('announcing is ON by default — the disguise must be opt-in', () => {
  // Every real bot needs to be discoverable, or ranked ordering (#443) stops
  // working. Only a harness or a deliberate observer wants this off.
  assert.equal(PREFERENCES.announceAsBot.default, true);
});

test('a bot with announcing on POSTs itself to presence', async () => {
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, json: async () => ({}) }; };
  serverWith({ announceAsBot: true })._registerPresence();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/presence$/);
  assert.match(String(calls[0].opts.body), /"role":"bot"/);
});

test('a bot with announcing off never claims to be one', async () => {
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, json: async () => ({}) }; };
  const s = serverWith({ announceAsBot: false });
  s._registerPresence();
  s._registerPresence();                    // heartbeat, repeatedly
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [], 'not one presence POST');
});

test('an unannounced instance still LEARNS who the other bots are', async () => {
  // Asymmetric on purpose. Declining to claim bot status is not the same as
  // going blind: it still needs the roster to decide who a peer is, and the
  // suppression is checked in _registerPresence rather than at the heartbeat so
  // the refresh half keeps running.
  const src = require('node:fs').readFileSync(
    new URL('../electron-app/local-server.js', import.meta.url), 'utf8');
  const beat = src.slice(src.indexOf('const beat = ()'), src.indexOf('const beat = ()') + 120);
  assert.match(beat, /_refreshPresencePeers\(\)/, 'the peer refresh must not be gated by announceAsBot');
});

test('the suppression is announced once, not on every heartbeat', () => {
  // Asserted on the latch rather than on console output: local-server wraps
  // console.log at import to auto-stamp it, so a test that swaps console.log
  // afterwards captures nothing and would pass vacuously either way.
  // _registerPresence runs every 60s for the whole call; without the latch the
  // log would carry one line per minute saying the same thing.
  // A bare instance: serverWith() calls setRoom(), which starts the presence
  // heartbeat and beats immediately — so a server built that way has already
  // latched before the test can look. (That it latches there at all is the
  // wiring working, and test 3 covers it.)
  const s = new LocalServer({ port: 0, onBotSpeech: () => {}, getPref: () => false });
  assert.equal(s._loggedNoAnnounce, undefined, 'nothing said before the first beat');
  s._registerPresence();
  assert.equal(s._loggedNoAnnounce, true, 'said once');
  for (let i = 0; i < 4; i++) s._registerPresence();
  assert.equal(s._loggedNoAnnounce, true, 'and still only latched, not re-armed');
});

test('the harness clears any stale presence row as well as suppressing', () => {
  // Both halves are load-bearing. mergeRemoteMembers is one-way, so a row left
  // by an earlier run would be learned once and never unlearned — and the
  // suppression alone would look like it had worked.
  const harness = require('node:fs').readFileSync(
    new URL('../scripts/etiquette-test.mjs', import.meta.url), 'utf8');
  assert.match(harness, /announceAsBot', false/);
  assert.match(harness, /method: 'DELETE'/);
  assert.match(harness, /makeVoiceHuman\(voice, ROOM\)/);
  // …and before joining, since the subject learns identities on its first poll.
  assert.ok(harness.indexOf('makeVoiceHuman(voice, ROOM)') < harness.indexOf('subject.join()'),
    'the disguise must be in place before anyone joins');
});
