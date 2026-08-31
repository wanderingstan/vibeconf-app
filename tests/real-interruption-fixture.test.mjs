// real-interruption-fixture.test.mjs — the 2026-08-30 talk-over, as a rule.
//
// The etiquette rule itself needs two bots in a live Meet, so what is checked
// here is that the fixture and the rule stay honest: the audio exists, it still
// has the gap structure that makes it the fixture rather than any clip, and the
// verdict leads with the question that actually distinguishes the bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(root, 'scripts/fixtures/interrupt-2026-08-30-30s.mp3');
const src = fs.readFileSync(join(root, 'scripts/etiquette-test.mjs'), 'utf8');

test('the recording is present and roughly the right length', () => {
  const st = fs.statSync(FIXTURE);
  assert.ok(st.size > 50_000, `suspiciously small: ${st.size} bytes`);
  assert.ok(st.size < 1_000_000, `too big for the repo: ${st.size} bytes`);
});

test('it still has the GAPS that make it this fixture', { skip: !hasFfmpeg() }, () => {
  // The whole reason a recording is used instead of test-speech.mp3: an angry
  // person leaves 200-660ms of silence between words, and every one of those
  // falling edges read as "stopped speaking". A re-encode that smoothed the
  // gaps out, or a well-meaning swap to a gapless clip, would silently turn
  // this back into the rule that already passes.
  // silencedetect reports on STDERR, like everything else ffmpeg says about a
  // stream. Reading stdout returns an empty string and every assertion below
  // then fails for the wrong reason.
  const out = spawnSync('ffmpeg',
    ['-nostdin', '-i', FIXTURE, '-af', 'silencedetect=noise=-35dB:d=0.2', '-f', 'null', '-'],
    { encoding: 'utf8' }).stderr || '';
  const gaps = [...out.matchAll(/silence_duration: ([0-9.]+)/g)].map((m) => Number(m[1]));
  assert.ok(gaps.length >= 5, `expected several inter-word gaps, found ${gaps.length}`);
  const inRange = gaps.filter((g) => g >= 0.15 && g <= 0.8).length;
  assert.ok(inRange >= 4,
    `the 0.15-0.8s gaps are the point; found ${inRange} of ${gaps.length}: ${gaps.slice(0, 8)}`);
});

test('the rule asks "did it ARM" before "did it stop"', () => {
  // The 2026-08-30 log had zero `[barge-in] armed` across the whole 30 seconds.
  // A bot that never armed did not exercise bad judgement — it never saw him,
  // which is a different bug with a different fix. Reporting only "it didn't
  // stop" would send the next person to the grace window, which is not it.
  const i = src.indexOf("id: 'real-interruption-2026-08-30'");
  assert.ok(i > 0, 'the rule is gone');
  const rule = src.slice(i, src.indexOf("id: 'name-mention-priority'", i));
  const armedAt = rule.indexOf("saw(w, 'armed')");
  const stoppedAt = rule.indexOf("saw(w, 'backedOff')");
  assert.ok(armedAt > 0 && stoppedAt > 0, 'both checks must exist');
  assert.ok(armedAt < stoppedAt, 'arming is checked FIRST — it is the distinguishing question');
  assert.match(rule, /NEVER ARMED/);
});

test('it distinguishes every way of failing', () => {
  const i = src.indexOf("id: 'real-interruption-2026-08-30'");
  const rule = src.slice(i, src.indexOf("id: 'name-mention-priority'", i));
  // A single "it didn't yield" verdict would be true and useless. Each of these
  // sends a reader somewhere different.
  for (const m of ['armed', 'backedOff', 'rodeOut', 'endedEarly']) {
    assert.ok(rule.includes(`saw(w, '${m}')`), `no branch for ${m}`);
  }
});

test('the interrupter is NOT uninterruptible', () => {
  // Half the rules here play uninterruptible audio to hold the floor. This one
  // is a person interrupting, and marking it uninterruptible would change what
  // the subject is being asked to do.
  const i = src.indexOf("id: 'real-interruption-2026-08-30'");
  const rule = src.slice(i, src.indexOf("id: 'name-mention-priority'", i));
  const play = rule.slice(rule.indexOf('playAudio'), rule.indexOf('playAudio') + 140);
  assert.doesNotMatch(play, /uninterruptible:\s*true/, play);
  assert.match(play, /REAL_INTERRUPTION_PATH/);
});

test('the subject is given something long enough to still be talking', () => {
  // The clip is 28s. A short prompt means the bot "stops" by finishing, and the
  // rule passes without testing anything.
  const i = src.indexOf("id: 'real-interruption-2026-08-30'");
  const rule = src.slice(i, src.indexOf("id: 'name-mention-priority'", i));
  assert.match(rule, /speakAndHoldFloor/);
  const prompt = rule.slice(rule.indexOf('speakAndHoldFloor'), rule.indexOf('if (!held.ok)'));
  assert.ok(prompt.length > 200, 'the prompt must ask for a long answer');
});

test('the fixture documents where it came from', () => {
  const readme = fs.readFileSync(join(root, 'scripts/fixtures/README.md'), 'utf8');
  assert.match(readme, /vph-sbmo-uic-20260830T203346Z/, 'the call id');
  assert.match(readme, /2057/, 'the offset it was cut at');
  assert.match(readme, /armed/, 'why it exists');
});

function hasFfmpeg() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}
