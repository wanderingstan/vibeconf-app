// room-adoption.test.mjs — adopting a room must CREATE its state, not just
// name it.
//
// The bug: the HTTP layer adopted an unknown room with `this.roomId = roomId`,
// a bare assignment. setRoom is what builds this.whiteboard / transcripts /
// turns, so roomId went truthy while whiteboard stayed undefined — and the
// first whiteboard write died with "Cannot set properties of undefined
// (setting 'content')". Reproduced on 0.8.0-beta1 and -beta2.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// local-server.js is loaded by main.js via require() but publishes itself on
// globalThis rather than module.exports (it predates being importable). Same
// contract here: require for the side effect, then read the global.
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

const fresh = () => new LocalServer({ port: 0 });

test('a fresh server has no room state at all', () => {
  const s = fresh();
  assert.ok(!s.roomId, 'no room adopted yet');
  assert.equal(s.whiteboard, undefined, 'and therefore no whiteboard — this is the trap');
});

test('setRoom creates the whiteboard the write path assumes', () => {
  const s = fresh();
  s.setRoom('aaa-bbbb-ccc');
  assert.equal(s.roomId, 'aaa-bbbb-ccc');
  assert.deepEqual(s.whiteboard, { content: '', version: 0, lastModified: null, lastEditor: null });
});

test('a whiteboard write works once the room is adopted through setRoom', () => {
  const s = fresh();
  s.setRoom('aaa-bbbb-ccc');
  s.whiteboard.content = '# hello';   // what _handlePost does
  assert.equal(s.whiteboard.content, '# hello');
});

test('naming a room WITHOUT setRoom is what broke — kept as the counter-example', () => {
  const s = fresh();
  s.roomId = 'aaa-bbbb-ccc';          // the old adoption line
  assert.throws(() => { s.whiteboard.content = '# hello'; }, TypeError,
    'assigning roomId alone leaves whiteboard undefined');
});
