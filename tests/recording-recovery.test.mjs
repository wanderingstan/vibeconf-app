// recording-recovery.test.mjs — #343: a recording interrupted by a quit, a
// crash, or power loss must still be finishable by hand.
//
// The failure this pins is subtle and was worse than it looked. manifest.json
// used to be written ONLY by stop(), and it is the sole carrier of each track's
// startWallClock — the one value that time-aligns the tracks to each other and
// to the transcript. It lives in memory, and the webm files' own timestamps
// start at t=0, not at wall clock. So a process that died before stop() left a
// folder of orphan webm files that NOTHING in the repo could turn back into a
// recording: both recovery paths require a manifest, and no offline tool could
// reconstruct one.
//
// Two things fix that, and both are tested here: write the manifest as tracks
// appear, and leave a note in the folder explaining what it is and how to
// finish it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  CallRecordingSession,
  MANIFEST_REFRESH_MS,
  RECOVERY_NOTE,
} = require('../electron-app/call-recorder.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(join(root, 'electron-app/main.js'), 'utf8');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rec-recover-'));
}
const readManifest = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));

// --- the manifest exists before stop() -------------------------------------

test('a manifest exists as soon as a track does, without stop()', () => {
  const dir = path.join(tmpDir(), 'call');
  const s = new CallRecordingSession(dir, { room: 'r', startedAt: 1000 });
  assert.ok(!fs.existsSync(path.join(dir, 'manifest.json')), 'nothing to describe yet');

  s.chunk('bot', 0, Buffer.from('B0'), 'audio/webm', 12345);
  // Simulating the crash: no stop(), no close, just read what is on disk.
  const m = readManifest(dir);
  assert.equal(m.tracks.length, 1);
  assert.equal(m.tracks[0].file, 'bot.webm');
});

test('startWallClock is on disk from the first chunk, because it cannot be recovered later', () => {
  // This is the whole point. Everything else in the manifest could in principle
  // be rebuilt by looking at the directory; this could not.
  const dir = path.join(tmpDir(), 'call');
  const s = new CallRecordingSession(dir, { room: 'r', startedAt: 1000 });
  s.chunk('bot', 0, Buffer.from('B0'), 'audio/webm', 1712345678901);
  s.chunk('remote-1', 0, Buffer.from('R0'), 'audio/webm', 1712345680000);

  const m = readManifest(dir);
  const byName = Object.fromEntries(m.tracks.map((t) => [t.track, t]));
  assert.equal(byName['bot'].startWallClock, 1712345678901);
  assert.equal(byName['remote-1'].startWallClock, 1712345680000);
});

test('a new track is written through immediately, not left to the throttle', () => {
  // A track created and then crashed on one second later must still be in the
  // manifest, so this specific write cannot be throttled.
  const dir = path.join(tmpDir(), 'call');
  const s = new CallRecordingSession(dir, { room: 'r', startedAt: 1000 });
  s.chunk('bot', 0, Buffer.from('a'), 'audio/webm', 5);
  assert.equal(readManifest(dir).tracks.length, 1);
  s.chunk('video', 0, Buffer.from('v'), 'video/webm', 6, 'video');
  assert.equal(readManifest(dir).tracks.length, 2, 'the second track appeared without waiting');
});

test('ordinary chunks do not rewrite the manifest every time', () => {
  // Chunks arrive ~1/s per track for hours. Byte counts are not needed for
  // recovery, so refreshing them is throttled hard.
  assert.ok(MANIFEST_REFRESH_MS >= 5000, 'a short refresh would rewrite the file constantly');
  const dir = path.join(tmpDir(), 'call');
  const s = new CallRecordingSession(dir, { room: 'r', startedAt: 1000 });
  s.chunk('bot', 0, Buffer.from('a'), 'audio/webm', 5); // creates the track, writes
  const firstWrite = fs.statSync(path.join(dir, 'manifest.json')).mtimeMs;
  for (let i = 1; i < 50; i++) s.chunk('bot', i, Buffer.from('a'), 'audio/webm', 5);
  assert.equal(fs.statSync(path.join(dir, 'manifest.json')).mtimeMs, firstWrite,
    'the manifest was rewritten on a chunk that had nothing new to record');
});

test('stop() still writes the final, complete manifest', () => {
  const dir = path.join(tmpDir(), 'call');
  const s = new CallRecordingSession(dir, { room: 'r', startedAt: 1000 });
  s.chunk('bot', 0, Buffer.alloc(10), 'audio/webm', 5);
  for (let i = 1; i < 5; i++) s.chunk('bot', i, Buffer.alloc(10), 'audio/webm', 5);
  const mid = readManifest(dir);
  s.stop();
  const end = readManifest(dir);
  assert.equal(end.tracks[0].bytes, 50, 'final byte count is exact');
  assert.ok(mid.tracks[0].bytes <= end.tracks[0].bytes);
  assert.ok(Number.isFinite(end.endedAt), 'only the final write knows when it ended');
});

// --- the recovery note ------------------------------------------------------

test('a recovery note is dropped in the folder at the start', () => {
  const dir = path.join(tmpDir(), 'call');
  new CallRecordingSession(dir, { room: 'abc-defg-hij', callId: 'call-1', startedAt: 1000 });
  const note = fs.readFileSync(path.join(dir, RECOVERY_NOTE), 'utf8');
  assert.match(note, /finish-call-recording\.mjs/, 'must name the command that finishes it');
  assert.match(note, /abc-defg-hij/, 'says which call this was');
  assert.ok(note.includes(dir), 'the command is copy-pasteable, with the real path');
});

test('the note survives stop(), because the merge has not happened yet', () => {
  // stop() closes the tracks; the mp4 still does not exist. Removing the note
  // there would mark a recording finished while the expensive half is undone.
  const dir = path.join(tmpDir(), 'call');
  const s = new CallRecordingSession(dir, { room: 'r', startedAt: 1000 });
  s.chunk('bot', 0, Buffer.from('a'), 'audio/webm', 5);
  s.stop();
  assert.ok(fs.existsSync(path.join(dir, RECOVERY_NOTE)));
});

test('the note says which state it is in', () => {
  const dir = path.join(tmpDir(), 'call');
  const s = new CallRecordingSession(dir, { room: 'r', startedAt: 1000 });
  s.chunk('bot', 0, Buffer.from('a'), 'audio/webm', 5);
  const during = fs.readFileSync(path.join(dir, RECOVERY_NOTE), 'utf8');
  assert.match(during, /recording STARTED/, 'a live recording should not read as a failure');
  s.stop();
  const after = fs.readFileSync(path.join(dir, RECOVERY_NOTE), 'utf8');
  assert.match(after, /closed cleanly/);
  assert.notEqual(during, after, 'the note is refreshed to reflect the finalized state');
});

test('removeRecoveryNote clears it and is safe to call twice', () => {
  const dir = path.join(tmpDir(), 'call');
  const s = new CallRecordingSession(dir, { room: 'r', startedAt: 1000 });
  s.removeRecoveryNote();
  assert.ok(!fs.existsSync(path.join(dir, RECOVERY_NOTE)));
  s.removeRecoveryNote(); // must not throw on an already-gone file
});

test('the note never breaks the track files around it', () => {
  // It lands in the same directory as the media, so it must not be mistaken
  // for a track or corrupt the listing.
  const dir = path.join(tmpDir(), 'call');
  const s = new CallRecordingSession(dir, { room: 'r', startedAt: 1000 });
  s.chunk('bot', 0, Buffer.from('B0'), 'audio/webm', 5);
  const m = s.stop();
  assert.ok(!m.tracks.some((t) => t.file === RECOVERY_NOTE));
  assert.equal(fs.readFileSync(path.join(dir, 'bot.webm'), 'utf8'), 'B0');
});

// --- main.js wiring ---------------------------------------------------------

test('quit finalizes the recording synchronously, and does not merge', () => {
  const fn = main.slice(main.indexOf('function finalizeRecordingSync'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  // Comments stripped for the "no await" check: this file explains itself at
  // length, and #606 added a comment in here that talks ABOUT the awaits in
  // stopCallRecording. A bare /await/ over the raw text failed on the prose
  // while the code was fine — the assertion is about code, so read code.
  const code = body.replace(/\/\/.*$/gm, '');
  assert.match(body, /session\.stop\(\)/, 'closes the tracks and writes the manifest');
  assert.ok(!/\bawait\b/.test(code), 'before-quit cannot await — that is the entire design');
  assert.ok(!/mergeCallMedia/.test(code), 'holding up a quit for ffmpeg is the thing we refuse to do');
  // Cleared before stop() so nothing re-enters on the way out.
  assert.ok(code.indexOf('activeRecording = null') < code.indexOf('session.stop()'));
  // #606: a quit can also land while stopCallRecording holds a claimed session
  // and the global is already null. That session must still get finalized —
  // the manifest is the one thing no later pass can reconstruct.
  assert.match(code, /activeRecording \|\| finalizingRecording/,
    'quit must finalize a claimed-but-not-yet-finalized session too');
  assert.ok(code.indexOf('finalizingRecording = null') < code.indexOf('session.stop()'),
    'and clear it before stop(), for the same no-re-entry reason as activeRecording');

  const quit = main.slice(main.indexOf("app.on('before-quit'"));
  assert.match(quit.slice(0, quit.indexOf('\n})')), /finalizeRecordingSync\('quit'\)/);
});

test('the note is removed only once every attempted merge succeeded', () => {
  // A skipped merge (no ffmpeg, no video, cancelled) means the raw tracks are
  // the only copy — exactly when the note is most needed.
  const i = main.indexOf('const allAttemptedMergesOk');
  const after = main.slice(i, i + 900);
  assert.match(after, /if \(allAttemptedMergesOk\) \{[\s\S]*removeRecoveryNote\(\)/);
  // Only a CALL disqualifies; the name also appears in a comment above, where
  // the session is stashed for use down here.
  const before = main.slice(0, i);
  assert.ok(!/\.removeRecoveryNote\(/.test(before), 'nothing may clear the note before the merges are known');
});
