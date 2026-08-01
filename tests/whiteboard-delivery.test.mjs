// whiteboard-delivery.test.mjs — update_whiteboard must not report success for a
// write that never reached the shared board (#221).
//
// The board is REMOTE. The app's local copy is a staging area, so "I updated my
// own copy" is not an answer to "did that go on screen". It used to be the only
// answer the bot got, together with an incrementing version number that made it
// look confirmed.
//
// Run: node --test tests/whiteboard-delivery.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const mcp = readFileSync(join(root, 'mcp-server/server.js'), 'utf8');

test('the write awaits the push instead of firing it off', () => {
  assert.match(server, /const push = await this\.onWhiteboardUpdate\(/,
    'the push result has to be observed, or ok:true means nothing');
  assert.doesNotMatch(server, /^\s*this\.onWhiteboardUpdate\(data\.whiteboard\.content/m,
    'a bare call is the bug: it discards the only evidence of delivery');
});

test('ok reflects delivery, and delivery is tri-state', () => {
  // null (no room → no shared board to miss) must not read as failure, or every
  // local-only write starts reporting an error that has no user-visible meaning.
  assert.match(server, /delivered = push\?\.delivered \?\? null/);
  assert.match(server, /ok: delivered !== false/);
  assert.match(server, /\.\.\.\(delivered === false \? \{ error: push\.error \} : \{\}\)/,
    'a failure has to carry its reason — "it failed" is not actionable in a live call');
});

test('a non-2xx from the sync server counts as failure', () => {
  // The bug that hid the Aug 1 outage: the push was fetch().catch(), which only
  // catches NETWORK errors. A 500 is a RESOLVED promise, so an outage rejecting
  // every board write logged nothing and still reported success.
  assert.match(main, /if \(resp\.ok\) return \{ delivered: true \}/);
  assert.match(main, /const error = `sync server \$\{resp\.status\}/);
  assert.match(main, /return \{ delivered: false, error \}/);
  // And the chain must be returned — falling through to the no-room branch would
  // report `delivered: null`, hiding the failure just as well as before.
  assert.match(main, /return fetch\(`\$\{baseUrl\}\/api\/sync\/\$\{roomId\}`/,
    'the fetch chain must be returned, not fired and forgotten');
});

test('the bot is told not to describe an undelivered board as if it were up', () => {
  // The point is not the error string, it is what the bot DOES next: the failure
  // is only recoverable while the bot can still say something in the room.
  const tool = mcp.slice(mcp.indexOf('wb.delivered === false'));
  assert.match(tool.slice(0, 800), /Nobody in the room can see this/);
  assert.match(tool.slice(0, 800), /send_chat/, 'it needs a fallback, not just bad news');
});
