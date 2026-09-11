// chat-send-interleave.test.mjs — gibberish chat posts from overlapping sends.
//
// Observed in the wild (Scripty, room wcj-odpo-wrb, 2026-08-19): the #189
// whiteboard-link auto-post timed out in the main process three times, each
// retry launching ANOTHER renderer sendChatFlow while the previous one was
// still typing into the same Meet chat input. The interleaved keystrokes were
// then posted verbatim — one chat message containing three partial copies of
// the link mashed together character-by-character.
//
// Three guards prevent a recurrence, each asserted here:
//   1. renderer serializes sends (sendChatSerial promise chain)
//   2. renderer refuses to click Send unless the input holds EXACTLY the
//      intended text
//   3. main never retries a send that merely TIMED OUT (the flow may still be
//      running; retrying is what created the overlap)
//
// Run: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const provider = readFileSync(join(root, 'electron-app/google-meet-provider.js'), 'utf8');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

// --- 1. sends are serialized ------------------------------------------------

test('provider routes sendChat through the serial queue, not straight to the flow', () => {
  assert.match(provider, /sendChat\(text\)\s*{\s*return sendChatSerial\(text\);\s*}/,
    'meetProvider.sendChat must go through sendChatSerial');
});

test('the serial queue chains onto the previous send and survives its failure', () => {
  const def = provider.slice(provider.indexOf('function sendChatSerial'));
  // #572 split the caller's answer (`settled`) from the queue's clock (`run`),
  // so the queue is no longer the thing the caller awaits. It still has to
  // chain — that is what stops two flows typing into one input — and the
  // behaviour of both halves is exercised in chat-send-timeout-false-negative.
  assert.ok(def.includes('chatSendChain.then(() => sendChatFlow(text, settle))'),
    'each send must wait for the previous one');
  assert.match(def, /chatSendChain = run\.catch\(/,
    'a rejected send must not wedge the queue for all later sends');
});

// --- 2. never post text we did not intend ------------------------------------

test('sendChatFlow aborts instead of sending when the input does not match', () => {
  const flow = provider.slice(
    provider.indexOf('async function sendChatFlow'),
    provider.indexOf('ipcRenderer.on(\'read-chat\''));
  const verifyAt = flow.indexOf("inputText(input).trim() !== text.trim()");
  const sendAt = flow.indexOf('let via = trySend()');
  assert.ok(verifyAt !== -1, 'the flow must compare the input to the intended text');
  assert.ok(sendAt !== -1, 'expected the trySend dispatch to exist');
  assert.ok(verifyAt < sendAt, 'the verify must happen BEFORE anything is sent');
  const between = flow.slice(verifyAt, sendAt);
  assert.ok(between.includes('return false'),
    'on mismatch the flow must return false, not fall through to trySend');
});

// --- 3. a timeout is not a failure to retry ----------------------------------

test('chatRequest exposes its timeout error as a named constant callers can test', () => {
  assert.match(main, /const CHAT_TIMEOUT_ERROR = 'Chat operation timed out'/);
  assert.match(main, /error: CHAT_TIMEOUT_ERROR/,
    'the timeout path must resolve with the shared constant, not a string literal');
});

test('#189 whiteboard-link loop stops (no retry) when the send timed out', () => {
  const start = main.indexOf('#189: drop the board-only URL');
  const loop = main.slice(start, main.indexOf('gave up auto-posting whiteboard link', start));
  assert.ok(loop.includes('result?.error === CHAT_TIMEOUT_ERROR'),
    'the loop must special-case the timeout error');
  const timeoutBranch = loop.slice(loop.indexOf('CHAT_TIMEOUT_ERROR'));
  assert.ok(/break;/.test(timeoutBranch),
    'on timeout the loop must break — the renderer flow may still be typing');
});

test('#189 gives the send a generous timeout so "timed out" is trustworthy', () => {
  const start = main.indexOf('#189: drop the board-only URL');
  const loop = main.slice(start, start + 3000);
  assert.ok(loop.includes('}, 45000)') && loop.includes('chatRequest(CALL_COMMANDS.sendChat'),
    'the whiteboard-link send must pass an explicit long timeout');
});
