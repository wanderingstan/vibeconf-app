// video-webm-dropped-after-mux.test.mjs
//
// `keepCallRecordingTracks` exists to preserve the per-participant AUDIO — the
// #422 ground truth, which the merged mp4 mixes together and cannot be
// un-mixed from. It was also, incidentally, keeping video.webm: the raw capture
// of the bot's Meet view, whose footage is already in the mp4 beside it.
//
// That duplicate is the largest thing we write. Measured across a 53-call
// archive on 2026-08-28: video.webm was 30 GB of 39 GB total, while all the
// per-speaker audio the pref exists for came to 2.3 GB.
//
// So on a SUCCESSFUL merge the video track is dropped and everything else kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(join(root, 'electron-app/main.js'), 'utf8');

function cleanupBlock() {
  const i = main.indexOf('const allAttemptedMergesOk');
  assert.ok(i > 0, 'the post-merge cleanup still exists');
  return main.slice(i, i + 2600);
}

test('the video track is removed once the merge has succeeded', () => {
  const b = cleanupBlock();
  assert.match(b, /t\.kind !== 'video'/, 'selects the video track by kind');
  assert.match(b, /already in the muxed mp4/, 'says why, in the log line');
});

test('only on a successful merge — never when it was skipped or cancelled', () => {
  // A skipped or cancelled merge leaves the raw video as the ONLY copy, the
  // recovery note in place, and finish-call-recording.mjs able to complete it.
  // Deleting there would destroy the footage outright.
  const b = cleanupBlock();
  const guard = b.slice(0, b.indexOf('t.kind'));
  assert.match(guard, /if \(allAttemptedMergesOk\)/);
  // The removal must sit INSIDE that guard, not after it.
  const ifIdx = b.indexOf('if (allAttemptedMergesOk)');
  assert.ok(ifIdx >= 0 && ifIdx < b.indexOf("t.kind !== 'video'"));
});

test('the per-speaker audio is not touched', () => {
  // The whole point of keepCallRecordingTracks. If this ever starts removing
  // by extension (*.webm) rather than by track kind, the corpus dies quietly.
  const b = cleanupBlock();
  assert.doesNotMatch(b, /\.webm['"]\s*\)/, 'no extension-based deletion');
  assert.doesNotMatch(b, /bot\.webm|remote-participant/,
    'audio tracks are never named here');
  // Deletion is driven off the manifest's own track list, so a track we do not
  // recognise is left alone by default rather than swept up.
  assert.match(b, /for \(const t of \(manifest\?\.tracks \|\| \[\]\)\)/);
});

test("the share capture is left alone — it is its own recording", () => {
  // 'share' is a separate video track that merges into call-recording-share.mp4.
  // Matching on kind !== 'video' already excludes it; this pins the intent so a
  // later "tidy up all the video-ish tracks" change has to argue with a test.
  const b = cleanupBlock();
  assert.match(b, /'share' is its own capture/);
});

test('the existing whole-directory removal is unchanged for the pref-off case', () => {
  // With keepCallRecordingTracks OFF the entire tracks dir still goes, exactly
  // as before — this change only alters what happens when the pref is ON.
  const b = cleanupBlock();
  assert.match(b, /if \(!keepTracksPref\) \{/);
  assert.match(b, /fs\.rmSync\(dir, \{ recursive: true, force: true \}\)/);
  assert.match(b, /keepCallRecordingTracks is off/);
});

test('a missing file is not an error', () => {
  // The video may already be gone (a hand-run of finish-call-recording.mjs, a
  // previous partial cleanup). That is not worth a warning in the log.
  const b = cleanupBlock();
  assert.match(b, /err\.code !== 'ENOENT'/);
});
