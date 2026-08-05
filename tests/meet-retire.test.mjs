// meet-retire.test.mjs — the app must not end a meeting it merely left.
//
// The bug: leaving a call POSTed /api/meet/retire, and that endpoint runs
// closeSpace + endActiveConference (see retireSpawn in the website repo's
// api/lib/meet-lifecycle.ts). endActiveConference EJECTS everyone still in the
// room.
//
// So asking a bot to drop off a call it had created — "thanks, you can go" —
// ended the meeting for the humans who stayed to keep talking. The bot leaving
// and the meeting being over are different events, and the app was treating the
// first as the second.
//
// Nothing is lost by dropping it. The retire endpoint's own header calls client
// retire "best-effort… the durable TTL reaper is the real guarantee" (api/meet/reap),
// and a create returns your existing room rather than 429ing, so an un-retired
// room costs a lingering TTL and nothing else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
// Comments are where the REASON lives — the checks below target code, so that
// explaining the trap doesn't read as falling into it.
const codeOnly = main
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n');

test('the app never calls /api/meet/retire', () => {
  // The whole point. If this comes back, so does ejecting live participants.
  assert.ok(!/meet\/retire/.test(codeOnly), 'main must not POST to the retire endpoint');
  assert.ok(!/retireLiveMeet/.test(codeOnly), 'the retire helper must stay gone');
});

test('no leftover room tracking to tempt a re-add', () => {
  // liveMeetSpaceName existed ONLY to feed retire. Leaving it behind would
  // invite someone to "finish the job" by wiring it back up.
  assert.ok(!/liveMeetSpaceName/.test(codeOnly), 'the tracking variable should be gone with it');
});

test('leaving a call tears down the app side only', () => {
  // Leaving must still do its local cleanup — this change removes the REMOTE
  // effect, not the local one.
  //
  // #254 moved the steps out of the IPC handler and into performLeaveTeardown,
  // so main can run them itself when the renderer never replies. The handler now
  // just delegates; the cleanup this test protects is unchanged, so follow it to
  // its new home rather than asserting on the delegating one-liner.
  assert.match(main, /ipcMain\.on\('leave-meet', \(\) => performLeaveTeardown\('panel'\)\)/);
  const fn = main.slice(main.indexOf('function performLeaveTeardown'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /localServer\.clearRoom\(\)/);
  assert.match(body, /closeClaudeTerminal\(\)/);
  assert.match(body, /showIdle\(\)/);
});

test('quitting does not end other people\'s meeting either', () => {
  // before-quit was the last retire call site. Quitting the app is not a reason
  // to eject everyone from a room that is still in use.
  const fn = main.slice(main.indexOf("app.on('before-quit'"));
  const body = fn.slice(0, fn.indexOf('\n});'));
  assert.ok(!/retire/i.test(body), 'quit must not retire the room');
  assert.match(body, /closeAllClaudeTerminalsSync\(\)/, 'but it must still close our own terminals');
});

test('the reason the client can skip this is written down', () => {
  // Whoever next wonders "shouldn't we clean up the room we made?" should find
  // the answer at the place the room is created, not have to rediscover it.
  assert.match(main, /api\/meet\/reap/, 'name the reaper that owns retirement now');
  assert.match(main, /endActiveConference/, 'and why the client must not do it');
});
