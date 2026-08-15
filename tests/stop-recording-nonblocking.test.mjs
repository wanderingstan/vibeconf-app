// stop-recording-nonblocking.test.mjs — #388: stop_recording must return as
// soon as the raw tracks are finalized, not when the ffmpeg merge finishes.
//
// The failure this pins: every layer of the stop chain awaited the one below
// it (mcp-server stop_recording → /api/call/record → onRecord →
// setCallRecording → stopCallRecording → await mergeCallMedia), so the MCP
// tool call didn't resolve until ffmpeg finished — 20+ minutes on a long
// call. An agent that stopped a recording mid-call was comatose in the room
// for the duration, and one stopping right before leaving couldn't even issue
// leave_call. The fix splits stopCallRecording: the fast half (close capture
// windows, flush chunks, write manifest.json) stays awaited; the merge moves
// to runPostRecordingMerges, fired without await — the same additive /
// best-effort framing the share merge already used (a failed or killed merge
// just means no combined mp4, never lost material).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const mcp = readFileSync(join(root, 'mcp-server/server.js'), 'utf8');

// Top-level functions in main.js close with an unindented `\n}\n`, so the
// first one after the signature is the function's end (inner braces are all
// indented) — same extraction trick as recording-stops-on-leave.test.mjs.
function fnBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `${signature} not found`);
  const fn = source.slice(start);
  return fn.slice(0, fn.indexOf('\n}\n'));
}

const stopBody = fnBody(main, 'async function stopCallRecording');
const mergeBody = fnBody(main, 'async function runPostRecordingMerges');

// --- the request path no longer waits on ffmpeg ----------------------------

test('stopCallRecording does not await the merge', () => {
  assert.ok(!/await\s+mergeCallMedia/.test(stopBody),
    'the merge must not be awaited in the stop path — that is exactly the #388 bug');
  assert.ok(!/await\s+runPostRecordingMerges/.test(stopBody),
    'the extracted merge runner must be fired, not awaited');
});

test('the detached merge is fired with a rejection handler', () => {
  assert.match(stopBody, /runPostRecordingMerges\(\{[^}]*\}\)\s*\n?\s*\.catch\(/,
    'fire-and-forget still needs a .catch so a reject cannot become an unhandled rejection');
});

test('the merge itself still runs — it moved, it did not disappear', () => {
  assert.match(mergeBody, /await mergeCallMedia\(/,
    'runPostRecordingMerges is where the actual ffmpeg work now lives');
  // The outcome-dependent cleanup moved with it: raw tracks are only ever
  // deleted after every attempted merge succeeded, same as before.
  assert.match(mergeBody, /allAttemptedMergesOk/);
  assert.match(mergeBody, /removeRecoveryNote/);
});

test('the "Preparing recording…" window still opens and closes around the detached merge', () => {
  assert.match(mergeBody, /createMergeProgressWindow\(\)/,
    'the progress window must follow the merge into the detached runner');
  assert.match(mergeBody, /closeMergeProgressWindow\(mergeWin\)/);
  // ...and its Cancel button still has something to abort: the per-run
  // controller is published to the module-level slot the IPC handler reads.
  assert.match(mergeBody, /activeMergeAbortController = abort/);
});

// --- a second stop, or a quick stop→start→stop, cannot double-merge --------

test('a double stop is a no-op before it can reach the merge', () => {
  assert.match(stopBody, /if \(!activeRecording\) return \{ ok: true, already: true \}/,
    'the second stop must bail on the cleared activeRecording, not merge again');
});

test('runPostRecordingMerges has exactly one caller: stopCallRecording', () => {
  const calls = main.match(/runPostRecordingMerges\(/g) || [];
  // one definition + one call site
  assert.equal(calls.length - 1, 1,
    'one merge run per finalized manifest — extra call sites reopen the double-merge door');
});

test('overlapping runs cannot null each other\'s abort controller', () => {
  // With the merge detached, stop→start→stop can (rarely) have two runs
  // alive at once. Each run may only clear the shared slot if it still owns
  // it, so Cancel keeps aborting the NEWEST run.
  assert.match(mergeBody, /if \(activeMergeAbortController === abort\) activeMergeAbortController = null/);
});

// --- a new recording during a running merge picks fresh names --------------

test('nextRecordingSuffix treats a still-merging recording\'s files as in use', () => {
  const body = fnBody(main, 'function nextRecordingSuffix');
  // The tracks dir survives until its merge SUCCEEDS, and the mp4 exists once
  // it has — so checking both means a recording started mid-merge can never
  // collide with the merge's input or its output.
  assert.match(body, /call-recording-tracks\$\{suffix\}/);
  assert.match(body, /call-recording\$\{suffix\}\.mp4/);
});

// --- quit during a detached merge stays honest -----------------------------

test('before-quit acknowledges merges that die with the app', () => {
  assert.match(main, /mergesInFlight > 0/,
    'quitting mid-merge is newly reachable from the stop path — log it rather than pretend');
  assert.match(mergeBody, /mergesInFlight\+\+/);
  assert.match(mergeBody, /mergesInFlight--/);
});

// --- the tool reply matches what is actually known at reply time -----------

test('stop_recording reports the merge as in progress, not done', () => {
  const toolStart = mcp.indexOf('--- stop_recording');
  const tool = mcp.slice(toolStart, mcp.indexOf('--- leave_call'));
  assert.match(tool, /being prepared in the background/,
    'the mp4 does not exist yet when the reply is written — the text must say so');
  assert.ok(!/Recording stopped —/.test(tool),
    'the old wording implied the merge was part of what just finished');
});

test('stopCallRecording tells the tool whether a merge is underway', () => {
  assert.match(stopBody, /merging: !!manifest/,
    'the reply text conditions its background-merge note on this flag');
});
