// share-call-log.test.mjs — hand over ONE call's log, on purpose (#255).
//
// remoteLogging is answered once, in the setup wizard, months before it matters.
// That is not meaningful consent; it is a setting people forget they have. This
// is the opposite: someone who has just reported a problem chooses to hand over
// the evidence for that call, knowing what and why.
//
// The prize is that remoteLogging can then default to OFF — the logs worth
// having are the ones attached to a complaint.
//
// Run: node --test tests/share-call-log.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { sliceCallLines } = require('../electron-app/session-log.js');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const panelJs = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');
const panelHtml = readFileSync(join(root, 'electron-app/renderer/panel.html'), 'utf8');

const ONE = 'aaa-111-20260804T120100Z';
const TWO = 'bbb-222-20260804T120600Z';
function fixture() {
  const f = join(mkdtempSync(join(tmpdir(), 'sharelog-')), 'session.log');
  writeFileSync(f, [
    '12:00:00.000 [electron] app start',
    '12:00:01.000 [electron] noise from BEFORE any call',
    `12:01:00.000 [call] id=${ONE} room=aaa-111 status=navigating started=2026-08-04T12:01:00Z`,
    '12:01:05.000 [local-server] Call status: in-call',
    '12:01:09.000 [local-server] Bot speech: hello from call ONE',
    '12:05:00.000 [electron] Call ended (leave-call)',
    `12:06:00.000 [call] id=${TWO} room=bbb-222 status=navigating started=2026-08-04T12:06:00Z`,
    '12:06:10.000 [local-server] Bot speech: hello from call TWO',
  ].join('\n') + '\n');
  return f;
}

test('a slice starts at its call and stops at the next one', () => {
  // The session log spans the whole app run, so "share this call" must not mean
  // "ship the file" — that hands over calls nobody agreed to share. Anchoring on
  // the [call] id= marker (#292) is what guarantees the slice cannot begin
  // before the call did.
  const f = fixture();
  const one = sliceCallLines(ONE, f);
  assert.ok(one.length > 0);
  assert.ok(one[0].includes(`[call] id=${ONE}`), 'starts at its own marker');
  assert.ok(!one.some((l) => l.includes('BEFORE any call')), 'nothing from before the call');
  assert.ok(!one.some((l) => l.includes('call TWO')), 'nothing from the next call');
  assert.ok(one.some((l) => l.includes('hello from call ONE')), 'and it does contain the call');
});

test("a later call's slice does not reach backwards", () => {
  const f = fixture();
  const two = sliceCallLines(TWO, f);
  assert.ok(!two.some((l) => l.includes('call ONE')));
  assert.ok(!two.some((l) => l.includes('BEFORE any call')));
});

test('an unknown call shares nothing at all', () => {
  // Failing open here would ship the whole file.
  assert.deepEqual(sliceCallLines('no-such-call', fixture()), []);
  assert.deepEqual(sliceCallLines('', fixture()), []);
  assert.deepEqual(sliceCallLines(ONE, '/nonexistent/path.log'), []);
});

test('the grant is in memory, never persisted', () => {
  // A crash or force-quit must not leave sharing switched on, and there must be
  // nothing to reconcile at next launch. Storing it as a preference would also
  // confuse a one-call grant with remoteLogging, which is a standing choice.
  assert.match(main, /let _sharedCallId = null;/);
  assert.match(main, /let _sharingWeEnabled = false;/);
  const fn = main.slice(main.indexOf("ipcMain.handle('share-call-log'"));
  const body = fn.slice(0, fn.indexOf('\n  });'));
  assert.doesNotMatch(body, /store\?\.set\(|store\.set\(/, 'the grant must not be written to config');
});

test('backfill first, then stream — not deferred to call end', () => {
  // Deferring loses the log exactly when it is wanted: someone tailing a bot
  // misbehaving right now, and any call where the app dies before it ends.
  const fn = main.slice(main.indexOf("ipcMain.handle('share-call-log'"));
  const body = fn.slice(0, fn.indexOf('\n  });'));
  assert.ok(body.indexOf('sendLinesNow') < body.indexOf('setRemoteLoggingEnabled'),
    'send the backlog before turning the stream on');
  assert.match(body, /sliceCallLines\(callId\)/);
});

test("call end revokes only a grant we made, never the user's own setting", () => {
  // If remoteLogging was already on, that is a standing preference and is not
  // ours to switch off when the call ends. Same class of bug as a cleanup path
  // that does not check what it is cleaning up.
  const fn = main.slice(main.indexOf('function revokeCallLogShare'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /if \(_sharingWeEnabled\)/);
  assert.match(body, /setRemoteLoggingEnabled\(false\)/);
  // And the enable is only claimed when logging was genuinely off.
  const h = main.slice(main.indexOf("ipcMain.handle('share-call-log'"));
  assert.match(h.slice(0, h.indexOf('\n  });')), /store\?\.get\('remoteLogging'\) === false/);
  // Revoked when the call ends, not left for the next call to notice.
  assert.match(main, /revokeCallLogShare\('call ended'\)/);
});

test('sharing twice in one call does nothing the second time', () => {
  const fn = main.slice(main.indexOf("ipcMain.handle('share-call-log'"));
  assert.match(fn.slice(0, 900), /_sharedCallId === callId.*already: true/s);
});

test('the button is separate from the feedback buttons, and says what it sends', () => {
  // The feedback buttons are private guidance to the bot. This sends transcript
  // text off the machine, so it must be its own deliberate click rather than a
  // side effect of reporting a problem.
  assert.match(panelHtml, /id="shareCallLogBtn"/);
  const row = panelHtml.slice(panelHtml.indexOf('share-log-row'));
  assert.match(row.slice(0, 600), /including what was\s+said/, 'say what is in it');
  assert.match(row.slice(0, 600), /This call only/);
  assert.ok(panelHtml.indexOf('data-feedback="other"') < panelHtml.indexOf('shareCallLogBtn'),
    'it sits apart from the one-click feedback row');
});

test('the result is reported, including that sharing continues', () => {
  // A share that silently did nothing is worse than no button: the user walks
  // away believing the evidence was handed over.
  const h = panelJs.slice(panelJs.indexOf("shareCallLogBtn?.addEventListener"));
  const body = h.slice(0, h.indexOf('\n});'));
  assert.match(body, /Could not send/);
  assert.match(body, /sharing the rest of this call/, 'a snapshot and a stream are different promises');
  assert.match(body, /Already shared for this call/);
});

test('shared lines are tagged with the call, so they can be found', () => {
  // room alone is ambiguous — the same room can be joined twice.
  assert.match(main, /callId: localServer\.callId \|\| null/, 'callId travels in the log meta');
  const h = main.slice(main.indexOf("ipcMain.handle('share-call-log'"));
  assert.match(h.slice(0, 1200), /\{ callId, shared: true, sharedAt/);
});
