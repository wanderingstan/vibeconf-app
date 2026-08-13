// failure-stills.test.mjs — pin the parts of the failure-stills diagnostic that
// can silently rot: WHERE in the recording we sample, and how a model's one-line
// answer becomes the `blocked` bit that headlines a Telegram alert.
//
// Why these two and not the ffmpeg/vision calls: those need a real .mov and a
// real model. What must not break unnoticed is (a) sampling only the edges of a
// recording, which would miss a dialog that appears mid-lane, and (b) a parse
// that turns an ambiguous answer into a confident "a dialog blocked the run" —
// a false banner there is worse than no banner, because it excuses a real
// regression as environmental.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { frameTimestamps, parseVerdict } from '../scripts/failure-stills.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('frames are sampled across the middle, never at the edges', () => {
  const ts = frameTimestamps(100, 3);
  assert.deepEqual(ts, [25, 50, 75]);
  // t=0 is the desktop before the app is even up; the last frame is teardown.
  // Either would report "nothing on screen" for a lane that was blocked
  // throughout, which is the exact failure this tool exists to catch.
  assert.ok(ts.every((t) => t > 0 && t < 100), 'no edge frames');
});

test('the sample scales with the count and stays ordered', () => {
  assert.deepEqual(frameTimestamps(60, 1), [30]);
  const five = frameTimestamps(60, 5);
  assert.equal(five.length, 5);
  assert.deepEqual([...five].sort((a, b) => a - b), five, 'ascending');
});

test('an unusable duration yields no frames rather than a bogus one', () => {
  // ffprobe returns nothing for a truncated/0-byte capture. Asking ffmpeg for a
  // frame at NaN produces noise in the log and no file; better to say nothing.
  for (const bad of [0, -5, NaN, null, undefined, 'abc']) {
    assert.deepEqual(frameTimestamps(bad, 3), [], `duration=${bad}`);
  }
});

test('YES carries the dialog text through to the alert', () => {
  const v = parseVerdict('YES | "Vibeconferencing.app" wants access to control "System Events.app"');
  assert.equal(v.blocked, true);
  // The detail is what a human reads on their phone and acts on — losing it
  // leaves an alarm with no subject.
  assert.match(v.detail, /System Events/);
});

test('YES with no detail still reports blocked, and says so honestly', () => {
  const v = parseVerdict('yes');
  assert.equal(v.blocked, true);
  assert.match(v.detail, /no detail/i);
});

test('NO is a clean negative', () => {
  assert.deepEqual(parseVerdict('NO'), { blocked: false, detail: '' });
  assert.deepEqual(parseVerdict('  no\n'), { blocked: false, detail: '' });
});

test('an unparseable answer is null — never a confident verdict either way', () => {
  // A model that hedges ("I can see a Google Meet window...") must not be read
  // as "nothing blocking" (hides a real dialog) nor as "blocked" (excuses a real
  // regression). null lets the caller fall through to the next frame/backend.
  for (const junk of ['', '   ', 'I think there might be a dialog', 'maybe', 'unclear']) {
    assert.equal(parseVerdict(junk), null, JSON.stringify(junk));
  }
});

test('only the first line is read, so a chatty model cannot flip the verdict', () => {
  const v = parseVerdict('NO\nAlthough there is a Chrome window in the background.');
  assert.deepEqual(v, { blocked: false, detail: '' });
});

test('the nightly runs this only for a failing lane, and never lets it gate', () => {
  // Source-pinned: the value here is that a diagnostic cannot change a lane's
  // result. If someone drops the `|| true` or the code!=0 guard, a missing
  // ffmpeg would start turning green lanes red — the opposite of the point.
  const sh = fs.readFileSync(join(root, 'scripts/scheduled-meet-test.sh'), 'utf8');
  const call = sh.split('\n').find((l) => /node .*failure-stills\.mjs/.test(l));
  assert.ok(call, 'scheduled-meet-test.sh still invokes failure-stills.mjs');
  assert.match(call, /\|\| true/, 'never fails the lane');
  const guard = sh.split('\n').find((l) => l.includes('VIBECONF_STILLS'));
  assert.match(guard, /"\$code" != "0"/, 'only on a red lane');
});

test('a blocked screen is reported above the lane results, not buried', () => {
  // Placement is the whole point: read after the red lines, it explains nothing;
  // read before them, it reframes them. Pin that it goes into the context block.
  const js = fs.readFileSync(join(root, 'scripts/notify-nightly.mjs'), 'utf8');
  assert.match(js, /if \(blockedBy\) ctx\.push\(/, 'blocked notice joins ctx (above the lane lines)');
  const ctxIdx = js.indexOf('if (blockedBy) ctx.push(');
  const textIdx = js.indexOf('let text = [header, ...ctx');
  assert.ok(ctxIdx > -1 && textIdx > ctxIdx, 'pushed before the message is assembled');
});
