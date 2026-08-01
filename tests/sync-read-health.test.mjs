// sync-read-health.test.mjs — the sync poll notices when room state stops being
// readable, and escalates instead of logging into the void (#221).
//
// Why this exists: on Aug 1 the sync server accepted every whiteboard WRITE and
// returned 500 for every READ of room state. The board was blank for the whole
// call. The app knew — its own poll hits the same endpoint the viewer does — and
// the only trace was `console.error('[sync] Poll failed:', 500)` on a console
// nobody was watching. The bot went on reporting "Whiteboard updated".
//
// Run: node --test tests/sync-read-health.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// sync-client.js has no module.exports — it is also loaded as a plain script, so
// it publishes itself on globalThis. require() runs it for that side effect.
require('../electron-app/sync-client.js');
const SyncClient = globalThis.SyncClient;

// A client with the callback captured, never started — we drive the health
// methods directly rather than standing up a server and waiting on real polls.
function makeClient() {
  const events = [];
  const c = new SyncClient({ onReadHealthChange: (e) => events.push(e) });
  return { c, events };
}

test('a single failure does not cry wolf', () => {
  const { c, events } = makeClient();
  c._noteReadFailure(500);
  assert.deepEqual(events, [], 'one blip at a 1s poll means nothing');
});

test('a sustained run reports exactly once', () => {
  const { c, events } = makeClient();
  for (let i = 0; i < SyncClient.READ_FAILURE_THRESHOLD; i++) c._noteReadFailure(500);
  assert.equal(events.length, 1, 'fires on crossing the threshold');
  assert.equal(events[0].healthy, false);
  assert.equal(events[0].status, 500, 'the status has to travel — "it failed" is not actionable');

  // Still broken 60 polls later: the operator has been told, and repeating it
  // every second would be its own denial of service.
  for (let i = 0; i < 60; i++) c._noteReadFailure(500);
  assert.equal(events.length, 1, 'must not re-report while still down');
});

test('recovery is reported, once', () => {
  const { c, events } = makeClient();
  for (let i = 0; i < SyncClient.READ_FAILURE_THRESHOLD; i++) c._noteReadFailure(500);
  c._noteReadSuccess();
  assert.equal(events.length, 2);
  assert.equal(events[1].healthy, true, 'the bot needs to know it can use the board again');

  c._noteReadSuccess();
  assert.equal(events.length, 2, 'healthy polls are not events');
});

test('a flap resets the counter rather than accumulating', () => {
  // Four failures, one success, four failures is not eight — it is two runs of
  // four, and neither should trip an outage alarm.
  const { c, events } = makeClient();
  for (let i = 0; i < SyncClient.READ_FAILURE_THRESHOLD - 1; i++) c._noteReadFailure(500);
  c._noteReadSuccess();
  for (let i = 0; i < SyncClient.READ_FAILURE_THRESHOLD - 1; i++) c._noteReadFailure(500);
  assert.deepEqual(events, [], 'intermittent failures are not an outage');
});

test('the poll routes non-404 failures into the tracker, and 404 stays out', () => {
  // 404 is "room gone / viewer not signed in" (#274) and has its own handling;
  // treating it as an outage would fire the alarm on every unauthenticated view.
  const src = readFileSync(join(root, 'electron-app/sync-client.js'), 'utf8');
  // Anchor the end AFTER the start — `const data = await resp.json()` also
  // appears earlier in the file, and slicing to that gave an empty string, so
  // every assertion below passed vacuously.
  const start = src.indexOf('if (!resp.ok) {');
  const block = src.slice(start, src.indexOf('const data = await resp.json()', start));
  assert.ok(block.length > 0, 'the poll block must actually be found');
  assert.match(block, /if \(resp\.status !== 404\)/);
  assert.match(block, /this\._noteReadFailure\(resp\.status\)/);
  assert.ok(block.indexOf('_noteReadFailure') > block.indexOf('!== 404'),
    'the 404 guard must enclose the tracker call');
});

test('an unreadable board reaches the operator, the agent, and the write path', () => {
  // Three audiences, because each can do something different: the operator can
  // investigate, the agent can say it aloud and fall back to chat, and the write
  // path can stop reporting success nobody can see.
  const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
  const handler = main.slice(main.indexOf('onReadHealthChange: ({ healthy, status })'));
  const body = handler.slice(0, 1400);
  assert.match(body, /localServer\.setBoardReadHealthy\(healthy\)/, 'the write path needs the flag');
  assert.match(body, /localServer\.addError\(/, 'the agent needs to be told');
  assert.match(body, /broadcastError\(/, 'the operator needs the panel error + notification');
  assert.match(body, /send_chat/, 'and the agent needs a fallback, not just bad news');
});

test('a write to an unreadable board is not reported as displayed', () => {
  const server = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');
  const mcp = readFileSync(join(root, 'mcp-server/server.js'), 'utf8');
  // `readable` rides ALONGSIDE `delivered`: "it didn't save" and "it saved and
  // nobody can see it" are different failures and the bot should say different
  // things about them.
  assert.match(server, /const readable = this\.boardReadHealthy !== false/);
  assert.match(server, /\n\s*readable,\n/);
  assert.match(mcp, /wb\.readable === false/);
  assert.match(mcp, /CANNOT BE DISPLAYED/);
});
