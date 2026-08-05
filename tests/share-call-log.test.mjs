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
  // With the default now OFF, "not explicitly on" is what we enable for.
  assert.match(h.slice(0, h.indexOf('\n  });')), /store\?\.get\('remoteLogging'\) !== true/);
  // Revoked when the call ends, not left for the next call to notice.
  assert.match(main, /revokeCallLogShare\('call ended'\)/);
});

test('sharing twice in one call does nothing the second time', () => {
  const fn = main.slice(main.indexOf("ipcMain.handle('share-call-log'"));
  assert.match(fn.slice(0, fn.indexOf('\n  });')), /_sharedCallId === callId.*already: true/s);
});

test('the button is separate from the feedback buttons, and says what it sends', () => {
  // The feedback buttons are private guidance to the bot. This sends transcript
  // text off the machine, so it must be its own deliberate click rather than a
  // side effect of reporting a problem.
  assert.match(panelHtml, /id="shareCallLogBtn"/);
  // Sliced to the block's end, not a fixed character count: copy gets added
  // here (it just did), and a fixed window silently stops covering the thing it
  // was checking.
  const row = panelHtml.slice(panelHtml.indexOf('share-log-row'));
  const block = row.slice(0, row.indexOf('</div>'));
  assert.match(block, /including what was\s+said/, 'say what is in it');
  assert.match(block, /This call only/);
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

test('the live count keeps moving, and says when sharing stops', () => {
  // Reported from a real call: the window said "Sent 347 lines, and sharing the
  // rest of this call" and the number never changed. Beside "still sharing",
  // a frozen count reads as a stall.
  assert.match(panelJs, /async function renderShareState\(\)/);
  assert.match(panelJs, /lines sent so far/);
  assert.match(panelJs, /Sharing has stopped/, 'the grant ends with the call — say so');
  // Polled with the rest of the troubleshooting view rather than on its own timer.
  const poll = panelJs.slice(panelJs.indexOf("const s = await api.invoke('get-call-state')"));
  assert.match(poll.slice(0, 200), /renderShareState\(\)/);
  // The click result no longer carries a count, so the two cannot disagree.
  const click = panelJs.slice(panelJs.indexOf("shareCallLogBtn?.addEventListener"));
  const body = click.slice(0, click.indexOf('\n});'));
  assert.doesNotMatch(body, /\$\{r\.sent\}/, 'one owner for the number');
});

test('only accepted lines are counted', () => {
  // Counting what we POSTed rather than what landed would overstate the share
  // whenever the backend rejected a batch.
  const sl = readFileSync(join(root, 'electron-app/session-log.js'), 'utf8');
  const flush = sl.slice(sl.indexOf('async function _flushRemote'));
  const ok = flush.indexOf('_sentCount += batch.length');
  const guard = flush.indexOf('if (!resp.ok && resp.status >= 500) throw');
  assert.ok(ok > guard, 'count after the response is known good, not before');
});

test('the counter is reset per share, not per session', () => {
  const h = main.slice(main.indexOf("ipcMain.handle('share-call-log'"));
  assert.match(h.slice(0, h.indexOf('\n  });')), /resetSentCount\(\)/);
});

test('the skill points at the button without being able to press it', () => {
  // Consent has to be the user's click: this sends transcript text off the
  // machine. The bot can say the button exists when it has visibly misbehaved.
  const skill = readFileSync(join(root, 'mcp-server/join-call-skill.md'), 'utf8');
  assert.match(skill, /Share this call's log button in the troubleshooting window/);
  assert.match(skill, /You cannot press it, and should not ask to/);
  assert.match(skill, /Do not raise it on a call that is going fine/, 'not a data-fishing prompt');
});

test('the window says what the feedback buttons do, and do not do', () => {
  // They are NOT inert — an addError notice reaches the agent, which adjusts for
  // the rest of the call, and that works with logging off. What they do not do
  // is reach the developers: nothing is transmitted. Someone pressing "Won't
  // yield" three times is entitled to know nobody is on the other end of it.
  const row = panelHtml.slice(panelHtml.indexOf('share-log-row'));
  const block = row.slice(0, row.indexOf('</div>'));
  assert.match(block, /tell the bot right now, and it\s+adjusts/, 'credit what they DO do');
  assert.match(block, /don't reach us/);
  assert.match(block, /your notes go with it/, 'the two features compose — say so');
});

test('feedback is written to the session log, so a shared slice carries it', () => {
  // This is what makes the pairing real rather than a slogan: the [feedback]
  // line lands in the same log, tagged with the same callId, so it falls inside
  // the shared slice along with the note.
  assert.match(main, /\[feedback\] kind=\$\{k\} status=\$\{status\}/);
  assert.match(main, /call=\$\{callId\}/, 'tagged with the call, so it lands in that slice');
  assert.match(main, /note=\$\{JSON\.stringify\(n\)\}/, 'and the human words travel with it');
});

test('remoteLogging defaults OFF, and unset means off everywhere', () => {
  // The flip (#255) is the point of the whole feature: the logs worth having are
  // the ones attached to a complaint, and the button now covers those.
  //
  // The trap is the READ. Every check was `!== false`, which matches a default
  // of ON — unset counted as enabled. Left alone after the flip, every unset
  // install would have carried on shipping, which is exactly the population the
  // new default exists for.
  const { PREFERENCES } = require('../electron-app/preferences-schema.js');
  assert.equal(PREFERENCES.remoteLogging.default, false);
  assert.doesNotMatch(main, /remoteLogging'\) !== false/,
    'a !== false test treats unset as ON, which is the old default');
  assert.match(main, /const remoteLoggingOn = store\?\.get\('remoteLogging'\) === true;/);
});

test('the share button stands down when everything is already shipped', () => {
  // With global logging on, the streamer has already sent this call's lines.
  // Backfilling would upload them twice, and the button would be promising
  // something already done.
  const h = main.slice(main.indexOf("ipcMain.handle('share-call-log'"));
  const body = h.slice(0, h.indexOf('\n  });'));
  assert.match(body, /alreadyGlobal: true/);
  // The INVOCATION, not the require() destructuring at the top of the handler —
  // matching the import made this assert something trivially true.
  assert.ok(body.indexOf('alreadyGlobal') < body.indexOf('sliceCallLines(callId)'),
    'check BEFORE slicing and uploading');
  // And the panel says why rather than leaving a control that silently no-ops.
  assert.match(panelJs, /if \(st\.globalLogging\)/);
  assert.match(panelJs, /already shared for every call/);
  assert.match(panelJs, /App Settings/, 'point at where the setting lives');
});

test('the button is disabled outside a call', () => {
  assert.match(panelJs, /shareCallLogBtn\.disabled = !st\.inCall/);
  assert.match(panelJs, /Available during a call/);
});

test('the copy says the share covers the wrap-up, not just the call', () => {
  // It runs to the end of after-call work — the agent's wrap-up belongs to the
  // same call, and is often where the interesting part is. Confirmed live: the
  // grant was revoked 46s after the goodbye, when after-call work finished.
  const row = panelHtml.slice(panelHtml.indexOf('share-log-row'));
  assert.match(row.slice(0, row.indexOf('</div>')), /end of\s+the bot's wrap-up afterwards/);
});
