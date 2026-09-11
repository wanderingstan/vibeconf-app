// chat-send-timeout-false-negative.test.mjs — send_chat must not report a
// timeout for a message it already posted (#572).
//
// Observed on the 2026-08-27 call: five sends came back to the agent as
// "Error sending chat: Chat operation timed out", and all five messages were
// sitting in the chat. The session log said so at the time:
//
//   14:52:24.279 [electron-meet] sendChat via button — sent: true
//   14:52:24.279 [chat] → switching to People pane (attempt 1)
//   14:52:25.489 [chat] People pane not visible after attempt 1 — retrying
//   14:52:25.644 [chat] ✓ People pane restored after attempt 2
//
// `sent: true` came FIRST. What ran the main process's 15s chatRequest budget
// out was everything after it — restorePeoplePane, which needed a retry on
// nearly every send in that call, so ~1.4s of DOM churn happened AFTER the
// message was already posted and before anyone was told it had been.
//
// The cost was not a scary string. The correct response to "the send failed"
// is to send again, so the agent did: one long assessment landed in the call
// chat three times, in front of the participants.
//
// The fix splits the two clocks. The CALLER hears the outcome the moment it is
// known; the QUEUE still waits for the pane restore, so the anti-interleave
// guarantee that chat-send-interleave.test.mjs pins is untouched. These tests
// hold both halves at once — either one alone is a regression:
//   1. the caller is answered before the restore finishes;
//   2. the next send still cannot start until the restore has finished;
//   3. a failure BEFORE any outcome still reaches the caller (it must not now
//      silently hang until the main process's timeout — that would recreate
//      the false timeout by a different route).
//
// Like chat-scrape-attribution.test.mjs, the flow lives in a renderer script
// that requires electron, so slice it out and run it verbatim against fakes —
// if the boundaries move, the slice fails loudly.
//
// Run: node --test tests/chat-send-timeout-false-negative.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'electron-app/google-meet-provider.js'), 'utf8');
const { MEET } = require('../electron-app/meet-selectors.js');

const start = src.indexOf('// Chat sends must be SERIAL.');
const end = src.indexOf("ipcRenderer.on('read-chat'");
assert.ok(start > 0 && end > start, 'could not slice the chat-send flow out of the provider');

const compile = new Function('deps', `
  let chatPaneBusy = false;
  const { openChatPane, getChatInput, typeIntoInput, inputText, delay, findByAriaLabel,
          firePointerClick, restorePeoplePane, chatUnavailableError, MEET,
          KeyboardEvent, console } = deps;
  ${src.slice(start, end)}
  return { sendChatSerial, paneBusy: () => chatPaneBusy };
`);

// --- harness ---------------------------------------------------------------
// A cooperative fake of the bits sendChatFlow drives. The one that matters is
// restorePeoplePane: it does NOT resolve until the test says so, which is how
// "the caller was answered first" becomes an assertion rather than a race.

function harness({ typedText = null, clearsOnSend = true, paneOpens = true } = {}) {
  const calls = { openChatPane: 0, restore: 0 };
  let current = '';
  let release = null;
  let restoresFinished = 0;

  const deps = {
    MEET,
    console: { log() {}, warn() {}, error() {} },
    KeyboardEvent: class { constructor() {} },
    delay: () => Promise.resolve(),
    openChatPane: async () => { calls.openChatPane++; return paneOpens; },
    chatUnavailableError: () => Object.assign(new Error('Chat unavailable'), { reason: 'chat-unavailable' }),
    getChatInput: () => ({ dispatchEvent() {} }),
    typeIntoInput: async (_input, text) => { current = typedText === null ? text : typedText; return true; },
    inputText: () => current,
    findByAriaLabel: (label) => (label === MEET.chat.sendLabelA ? { disabled: false } : null),
    firePointerClick: () => { if (clearsOnSend) current = ''; },
    restorePeoplePane: () => {
      calls.restore++;
      return new Promise((resolve) => {
        release = () => { restoresFinished++; resolve(true); };
      });
    },
  };

  return {
    ...compile(deps),
    calls,
    releaseRestore: () => release(),
    restoresFinished: () => restoresFinished,
  };
}

// Let every already-queued microtask/timer callback run, so "still pending"
// means genuinely blocked rather than merely not-yet-scheduled.
const settleQueue = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

// --- 1. the caller is answered at `sent:`, not after the restore -------------

test('a successful send resolves BEFORE the People-pane restore finishes', async () => {
  const h = harness();
  const sent = await h.sendChatSerial('hello');
  assert.equal(sent, true, 'the send succeeded and must be reported as such');
  assert.equal(h.calls.restore, 1, 'the restore must still happen — it is what un-blinds speaker tracking');
  assert.equal(h.restoresFinished(), 0,
    'the caller was made to wait for the pane restore — this is exactly what burned the 15s budget (#572)');
  h.releaseRestore();
});

test('a restore that never finishes cannot turn a delivered message into a failure', async () => {
  const h = harness();
  // Never released: the worst case from the 2026-08-27 call, where the People
  // pane refused to come back. The message is posted either way, so the answer
  // must be "sent", not a timeout the agent will react to by sending again.
  assert.equal(await h.sendChatSerial('hello'), true);
});

// --- 2. the queue still waits — sends stay serial ---------------------------

test('the next send waits for the previous restore, so two flows never share the input', async () => {
  const h = harness();
  assert.equal(await h.sendChatSerial('first'), true);

  const second = h.sendChatSerial('second');
  await settleQueue();
  assert.equal(h.calls.openChatPane, 1,
    'the second send started while the first was still clicking panes — that overlap is #189/#284 gibberish');

  h.releaseRestore(); // first send's restore completes
  await settleQueue();
  assert.equal(h.calls.openChatPane, 2, 'the second send must run once the first is fully done');
  h.releaseRestore(); // second send's restore
  assert.equal(await second, true);
});

// --- 3. real failures still reach the caller --------------------------------

test('a chat pane that never opens rejects the caller instead of hanging', async () => {
  const h = harness({ paneOpens: false });
  // This throws before any outcome is known, so there is no early answer to
  // give. It must still surface: silently hanging here would hand the agent
  // the same bogus "Chat operation timed out" the fix exists to remove.
  await assert.rejects(h.sendChatSerial('hello'), /Chat unavailable/);
});

test('a send aborted for a mismatched input reports false, and reports it early', async () => {
  const h = harness({ typedText: 'leftover draft' });
  const sent = await h.sendChatSerial('hello');
  assert.equal(sent, false, 'refusing to post text we did not intend is a genuine failure');
  assert.equal(h.restoresFinished(), 0, 'even the failure path must not wait on housekeeping');
  h.releaseRestore();
});

test('a send whose input never clears still reports false', async () => {
  const h = harness({ clearsOnSend: false });
  const sent = await h.sendChatSerial('hello');
  assert.equal(sent, false, 'an uncleared input is the one case where "may not have sent" is honest');
  h.releaseRestore();
});

// --- 4. the agent is told a timeout is not a failure ------------------------

test('the send_chat tool tells the agent NOT to resend after a timeout', () => {
  const server = readFileSync(join(root, 'mcp-server/server.js'), 'utf8');
  const tool = server.slice(server.indexOf('// --- send_chat ---'), server.indexOf('// --- set_avatar_emoji ---'));
  assert.ok(tool.includes("data?.error === 'Chat operation timed out'"),
    'the timeout must be recognized, not folded into the generic "Error sending chat"');
  const branch = tool.slice(tool.indexOf("data?.error === 'Chat operation timed out'"));
  assert.match(branch, /DO NOT send it again/,
    'a resend is the reflex that posted one message three times — the tool must say so');
  assert.match(branch, /read_chat/, 'it must point at the way to actually check');
});
