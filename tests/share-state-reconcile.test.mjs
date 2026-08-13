// share-state-reconcile.test.mjs — Meet's DOM is the authority on whether the
// room can see us, and the app has to keep agreeing with it (#68).
//
// The bug: `localServer.sharing` has two writers. The capture stream ending sets
// it false, which says nothing about Meet. Meet's Stop-presenting button being
// visible is the real answer. When stop_sharing's click doesn't take — blocked
// by the "still visible to others" dialog (#141), or the button missing after a
// re-render — the app believed the share was off while Meet was still
// presenting, and told the room so out loud.
//
// The probe watched the truth every second and could not notice the
// disagreement, because it only emitted on a change in ITS OWN observation.
//
// Run: node --test tests/share-state-reconcile.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const provider = readFileSync(join(root, 'electron-app/google-meet-provider.js'), 'utf8');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const mcp = readFileSync(join(root, 'mcp-server/server.js'), 'utf8');

test('the probe re-asserts on ticks where nothing changed', () => {
  // An edge detector cannot correct a divergence introduced by someone else: it
  // sees `true`, compares to the `true` it saw last tick, and stays silent while
  // the app believes false.
  const block = provider.slice(provider.indexOf('if (next.selfPresenting !== last.selfPresenting)'));
  const body = block.slice(0, block.indexOf('const someoneElse'));
  assert.match(body, /\} else \{/, 'the unchanged case must also emit');
  assert.match(body, /reconcile: true/, 'and be marked so the receiver can tell it apart');
});

test('a reconcile corrects the flag but never re-fires the edge side effects', () => {
  // The edge path clears the (POC) external-tab share request on a real
  // stop. Running that once a second would clear state that is still
  // legitimately in use.
  const h = main.slice(main.indexOf('ipcMain.on(CALL_EVENTS.selfPresenting'));
  const body = h.slice(0, h.indexOf('\n  });') + 6);
  assert.match(body, /if \(reconcile\) \{/);
  assert.match(body, /return;/, 'the reconcile branch must return before the edge logic');
  assert.ok(body.indexOf('if (reconcile)') < body.indexOf('externalShareRequest = null'),
    'the guard has to come first, or the side effects run every second');
});

test('Meet wins, and a correction is logged rather than silent', () => {
  // A silent correction hides the bug it papers over. A run of these means the
  // stop click keeps failing, which is the thing worth seeing.
  const h = main.slice(main.indexOf('ipcMain.on(CALL_EVENTS.selfPresenting'));
  const body = h.slice(0, h.indexOf('\n  });') + 6);
  assert.match(body, /wasSharing !== !!presenting/, 'only act on an actual disagreement');
  assert.match(body, /state disagreed with Meet/);
  assert.match(body, /localServer\.setSharing\(!!presenting\)/, 'the DOM is the authority');
});

test('stop_sharing waits past one reconcile tick before believing "stopped"', () => {
  // The verification already existed and passed vacuously: it polled the same
  // optimistic flag that had just been set false by our capture ending. Two
  // polls (600ms) can complete inside the 1s window before the first reconcile
  // discovers Meet never stopped.
  const call = mcp.slice(mcp.indexOf('waitForSharingState(roomId, false'));
  const line = call.slice(0, call.indexOf('\n'));
  const m = line.match(/intervalMs: (\d+), stablePolls: (\d+)/);
  assert.ok(m, 'the stop verification must state its polling shape');
  const settleMs = Number(m[1]) * Number(m[2]);
  assert.ok(settleMs > 1000,
    `${settleMs}ms of stability can finish before the 1s reconcile tick — it would confirm from the optimistic flag`);
});

test('the honest failure message survives', () => {
  // With the flag now telling the truth, this branch becomes reachable for the
  // first time. It has to keep saying something the agent can act on rather than
  // reporting success.
  assert.match(mcp, /still reports it is presenting/);
  assert.match(mcp, /manual Stop presenting click/);
});
