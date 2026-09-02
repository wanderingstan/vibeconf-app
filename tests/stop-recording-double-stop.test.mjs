// stop-recording-double-stop.test.mjs — #606: two concurrent stops must not
// make the second one throw on a null session.
//
// The failure, from five session logs across 26–30 August 2026 (8 occurrences,
// and visible in the nightly meet-test output too):
//
//   08:05:15.611 [call-record] saved 7 track(s) to …/call-recording-tracks
//   08:05:15.654 [call-record] error finalizing recording: Cannot read properties of null (reading 'stop')
//
// 43 ms apart, from ONE call. The success line is logged inside the same try
// that follows session.stop(), so those cannot be one pass — stopCallRecording()
// ran twice. The old guard was `if (!activeRecording) return {already:true}`
// followed by two awaits (stopShareCaptureIfActive, stopFrameCaptureWindow)
// before `activeRecording.stop()`: a check-then-use across a yield. Correct for
// sequential callers, useless for concurrent ones — and two leave routes overlap
// by design. requestCleanLeave fires the stop fire-and-forget so teardown
// doesn't block on the merge, and performLeaveTeardown runs
// step('stopCallRecording', …) because it is the path every leave route shares
// (#326). Both got past the guard; the first won and nulled the global; the
// second resumed into null.stop().
//
// Nothing was actually lost — the first pass saved every track and its merge
// produced the mp4s (confirmed on xyg-wbfh-yjy-20260830T124710Z: RECOVERY.md
// gone, by-speaker/ produced, both outputs present). The whole cost was that a
// call which recorded perfectly logged "error finalizing recording", which is
// its own kind of expensive: it makes healthy nightly runs look broken.
//
// These tests RUN stopCallRecording rather than reading it, because the bug is
// an interleaving — a source-text assertion can pin the shape of the fix but
// cannot show that the second caller now returns instead of throwing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

// Top-level functions in main.js close with an unindented `\n}\n` — same
// extraction trick as stop-recording-nonblocking.test.mjs, but keeping the
// closing brace so the text is executable.
function fnSource(signature) {
  const start = main.indexOf(signature);
  assert.ok(start !== -1, `${signature} not found`);
  const fn = main.slice(start);
  return fn.slice(0, fn.indexOf('\n}\n') + 3);
}

// Rebuild just enough of main.js's module scope to run the two functions for
// real: the module-level `let`s they reassign have to be actual bindings in the
// same scope (that mutation IS the thing under test), and every collaborator is
// a stub that records what it was asked to do.
function harness({ shareDelay = 0, videoDelay = 0 } = {}) {
  const factory = new Function(`
    const log = { stops: 0, saved: 0, errors: [], merges: 0, quitFinalized: 0 };
    const later = (ms) => new Promise((r) => setTimeout(r, ms));
    const console = {
      log: (m) => { if (String(m).includes('saved')) log.saved++; },
      warn: (m, d) => log.errors.push(String(m) + ' ' + String(d ?? '')),
    };
    const path = { dirname: (p) => p.replace(/\\/[^/]*$/, '') };
    let meetView = null;              // no Meet view: the send is try/caught anyway
    let activeRecording = null;
    let finalizingRecording = null;
    let activeRecordingWindow = null;
    const stopRecordingStatsPush = () => {};
    const stopShareCaptureIfActive = () => later(${shareDelay});
    const stopFrameCaptureWindow = () => later(${videoDelay});
    const runPostRecordingMerges = async () => { log.merges++; };

    ${fnSource('async function stopCallRecording')}
    ${fnSource('function finalizeRecordingSync')}

    return {
      log,
      stopCallRecording,
      finalizeRecordingSync,
      startFakeRecording() {
        activeRecording = {
          dir: '/tmp/call/call-recording-tracks',
          outputSuffix: '',
          closed: false,
          // Mirrors CallRecordingSession.stop(): idempotent, returns the same
          // manifest on a second call rather than redoing the work.
          stop() {
            if (this.closed) return this.manifest;   // idempotent, like the real one
            this.closed = true;
            log.stops++;
            return this.manifest;
          },
          manifest: { tracks: [{ track: 'audio' }] },
        };
        activeRecordingWindow = { id: 'video-window' };
        return activeRecording;
      },
      state: () => ({ activeRecording, finalizingRecording, activeRecordingWindow }),
    };
  `);
  return factory();
}

test('two overlapping stops: one finalizes, the other reports already', async () => {
  // The exact production interleaving — both callers enter while the awaits are
  // still pending, which is what the old guard could not survive.
  const h = harness({ shareDelay: 5, videoDelay: 5 });
  h.startFakeRecording();
  const [first, second] = await Promise.all([h.stopCallRecording(), h.stopCallRecording()]);

  assert.equal(h.log.errors.length, 0,
    'no pass may log "error finalizing recording" — that log line IS the bug (#606)');
  assert.equal(h.log.stops, 1, 'the session must be finalized exactly once');
  assert.equal(h.log.saved, 1, 'and "saved N track(s)" must be logged exactly once');
  assert.equal(h.log.merges, 1, 'exactly one merge — a double stop must not double-merge');

  const results = [first, second];
  assert.equal(results.filter((r) => r.already).length, 1, 'exactly one caller loses the race');
  const winner = results.find((r) => !r.already);
  assert.equal(winner.tracks, 1);
  assert.equal(winner.merging, true, 'the winner is the one that owns the merge');
});

test('the loser is silent — the symptom was a log line, not a rejection', async () => {
  // Why this hid for so long: null.stop() threw INSIDE the try that wraps
  // stop(), so it never escaped as a rejection — both callers still resolved,
  // and both leave routes fire this fire-and-forget anyway (requestCleanLeave's
  // .catch, and the teardown's step()). Nothing broke, nothing was retried,
  // nothing surfaced except one scary warning in a call that had recorded
  // perfectly. So asserting "it resolved" proves nothing here (it always did) —
  // the assertion that has teeth is that the warning is gone.
  const h = harness({ shareDelay: 5 });
  h.startFakeRecording();
  const both = await Promise.allSettled([h.stopCallRecording(), h.stopCallRecording()]);
  assert.deepEqual(both.map((r) => r.status), ['fulfilled', 'fulfilled']);
  assert.deepEqual(h.log.errors, [],
    'the loser must take the {already} exit, not fall through to a caught null.stop()');
});

test('the session is claimed before the first await, not after the last', async () => {
  // The narrow property the whole fix rests on: by the time stopCallRecording
  // has yielded even once, a second caller must already see "nothing active".
  const h = harness({ shareDelay: 20, videoDelay: 20 });
  h.startFakeRecording();
  const inFlight = h.stopCallRecording();
  await null; // let the first caller reach its first await and no further
  assert.equal(h.state().activeRecording, null,
    'activeRecording must be cleared before the awaits, not after session.stop()');
  assert.deepEqual(await h.stopCallRecording(), { ok: true, already: true });
  await inFlight;
});

test('a sequential second stop is still a no-op', async () => {
  // The ordinary case the original guard was written for, and which every leave
  // route relies on: onLeaveCall stops the recording, then teardown stops it
  // again, and that second call must stay harmless.
  const h = harness();
  h.startFakeRecording();
  await h.stopCallRecording();
  assert.deepEqual(await h.stopCallRecording(), { ok: true, already: true });
  assert.equal(h.log.stops, 1);
  assert.equal(h.log.merges, 1);
});

test('a quit during the stop still writes the manifest', async () => {
  // Claiming the session early means activeRecording is null for the couple of
  // awaits stopCallRecording spends closing the capture windows — and
  // 'before-quit' calls finalizeRecordingSync, which used to bail on exactly
  // that null. Losing the manifest is the one unrecoverable outcome here: it
  // carries each track's startWallClock, the only thing that aligns the tracks
  // to each other and to the transcript, and it cannot be rebuilt from the webm
  // files (#343). So the claimed session stays reachable until stop() has run.
  const h = harness({ shareDelay: 20, videoDelay: 20 });
  h.startFakeRecording();
  const inFlight = h.stopCallRecording();
  await null;
  h.finalizeRecordingSync('quit');
  assert.equal(h.log.stops, 1, 'the quit must finalize the in-flight session, not skip it');

  // ...and the stop that is still in flight finishes cleanly on top of it,
  // because CallRecordingSession.stop() is idempotent by design.
  await inFlight;
  assert.equal(h.log.errors.length, 0);
  assert.equal(h.log.stops, 1, 'idempotent stop(): the second call re-uses the manifest');
});

test('finalizeRecordingSync with nothing at all in flight is a no-op', () => {
  const h = harness();
  h.finalizeRecordingSync('quit');
  assert.equal(h.log.stops, 0);
});
