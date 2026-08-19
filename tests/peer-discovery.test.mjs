// peer-discovery.test.mjs — bots find each other instead of being told (#430).
//
// Ranked speaking order (#426) needs to know which participants are bots. That
// was a hand-typed list, and the list could not be set at all from an MCP client
// — so the feature shipped in v0.8.31 switched off, and nothing said so.
//
// Presence already had everything needed: the endpoint accepts and returns
// `name`, `displayName` and `role`. Nothing ever wrote to it. The room page
// skips registration for whiteboard-only views, which is the only view a bot
// opens, and the app only ever read the list — which is why it "came back
// empty" and why the manual list existed.
//
// Two failure modes are pinned here, because both have bitten before:
//   - the name mismatch that produced "rank 4 of 5" in a room holding three
//     bots (presence has the CONFIGURED name, Meet's roster has the DISPLAY one)
//   - a derived bot set that swallows the whole roster, which does not degrade
//     the ordering but stops it dead: the seed is the last utterance by someone
//     OUTSIDE the bot set, and with everyone inside there is nothing to key on

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;
const namesMatch = LocalServer._namesMatch;

function makeServer(prefs = {}, participants = []) {
  const s = new LocalServer({
    port: 0,
    onBotSpeech: () => {},
    getPref: (k) => ({ peerBotNames: [], botSpeakOrdering: 'ranked', ...prefs })[k],
  });
  s.setRoom('test-room');
  s.callStatus = 'in-call';
  s.participants = participants;
  s.getEffectiveBotName = () => prefs.__self || 'Jimmy';
  s.getWebsiteUrl = () => 'https://example.invalid';
  return s;
}

const roster = (...names) => names.map((n) => ({ name: n }));

// --- the matching that broke ordering before -------------------------------

test('a run-tagged display name matches its configured name', () => {
  // The exact case from the test fleet: presence says "Alice", Meet shows
  // "Alice-r4a32". Compared literally, each bot counted twice.
  assert.ok(namesMatch('Alice-r4a32', 'Alice'));
  assert.ok(namesMatch('Alice', 'Alice-r4a32'), 'and in the other direction');
});

test('punctuation and case do not defeat it', () => {
  assert.ok(namesMatch('jimmy bot', 'Jimmy'));
  assert.ok(namesMatch('Jimmy', 'jimmy-bot'));
});

test('different bots do not match each other', () => {
  assert.equal(namesMatch('Pepper', 'Coltrane'), false);
  assert.equal(namesMatch('Stan James', 'Seth Goldstein'), false);
});

test('empty or missing names never match', () => {
  for (const [a, b] of [[null, 'Jimmy'], ['Jimmy', undefined], ['', 'Jimmy'], ['!!', 'Jimmy']]) {
    assert.equal(namesMatch(a, b), false, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
});

// --- discovery ------------------------------------------------------------

async function withPresence(s, members) {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, members }) });
  await s._refreshPresencePeers();
  await new Promise((r) => setImmediate(r));   // the .then chain
}

test('peers are discovered from presence, matched to the roster', async () => {
  const s = makeServer({}, roster('Pepper-r7c1', 'Stan James'));
  await withPresence(s, [
    { name: 'Jimmy', role: 'bot' },                                  // self
    { name: 'Pepper', displayName: 'Pepper-r7c1', role: 'bot' },
  ]);
  assert.deepEqual(s._presencePeers, ['Pepper-r7c1'],
    'the ROSTER name is what ordering ranks over, not the configured one');
});

test('the bot does not discover itself as a peer', async () => {
  const s = makeServer({}, roster('Pepper', 'Stan James'));
  await withPresence(s, [{ name: 'Jimmy', role: 'bot' }, { name: 'Pepper', role: 'bot' }]);
  assert.deepEqual(s._presencePeers, ['Pepper']);
});

test('a peer set covering every participant is REFUSED', async () => {
  // The failure that would look like discovery working. If every roster entry
  // is called a bot, the seed — the last utterance by someone outside the bot
  // set — has nobody left, and ordering stops rather than degrades.
  const s = makeServer({}, roster('Pepper', 'Coltrane'));
  await withPresence(s, [
    { name: 'Pepper', role: 'bot' },
    { name: 'Coltrane', role: 'bot' },
  ]);
  assert.equal(s._presencePeers, null, 'better to fall back than to rank everyone');
});

test('an unreachable backend leaves the previous peers intact', async () => {
  const s = makeServer({}, roster('Pepper', 'Stan James'));
  await withPresence(s, [{ name: 'Pepper', role: 'bot' }]);
  assert.deepEqual(s._presencePeers, ['Pepper']);
  globalThis.fetch = async () => { throw new Error('offline'); };
  await s._refreshPresencePeers();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s._presencePeers, ['Pepper'], 'a blip must not disable ordering');
});

// --- how ordering consumes it ---------------------------------------------

test('the configured list still wins over discovery', () => {
  // An explicit answer beats a derived one, and stays the escape hatch when
  // discovery is wrong.
  const s = makeServer({ peerBotNames: ['Coltrane'] }, roster('Pepper', 'Coltrane', 'Stan James'));
  s._presencePeers = ['Pepper'];
  s._entriesSince = () => [{ text: 'hello', participantName: 'Stan James' }];
  const r = s._rankedSpeakDelay({ text: 'hi' });
  assert.ok(r, 'ordering should engage');
  assert.match(r.why, /^ranked/);
});

test('discovery alone is enough to order — no preference needed', () => {
  // The whole point: this used to require typing a list that could not be typed.
  const s = makeServer({}, roster('Pepper', 'Stan James'));
  s._presencePeers = ['Pepper'];
  s._entriesSince = () => [{ text: 'what do you think?', participantName: 'Stan James' }];
  const r = s._rankedSpeakDelay({ text: 'hi' });
  assert.ok(r, 'ranked ordering must engage with discovered peers only');
  assert.match(r.why, /^ranked/);
});

test('with neither source, ordering says so instead of silently jittering', () => {
  const s = makeServer({}, roster('Pepper', 'Stan James'));
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    assert.equal(s._rankedSpeakDelay({ text: 'hi' }), null);
  } finally { console.log = orig; }
  assert.match(logs.join('\n'), /no peer bots known/);
});
