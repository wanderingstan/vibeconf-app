// call-phase.test.mjs — the bot's lifecycle, and the after-call-work phase (#139).
//
// The bot leaving a Meet is NOT the meeting ending: other people, and other
// bots, may still be talking. Only this bot's participation is over. So the
// lifecycle gains a phase after `in-call` where the agent can still work, and
// the app-side teardown moves from "bot left" to "session finished".
//
// These pin the two things that made it possible: named predicates instead of
// negative comparisons, and teardown deferred to the end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const phase = require('../electron-app/call-phase.js');
const { PREFERENCES, validate } = require('../electron-app/preferences-schema.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const server = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');
const policy = readFileSync(join(root, 'electron-app/update-policy.js'), 'utf8');

test('the lifecycle runs beginning to end, with the new phase between', () => {
  assert.deepEqual(phase.CALL_PHASES, [
    'idle', 'navigating', 'joining', 'waiting-to-be-admitted',
    'in-call', 'after-call-work', 'call-complete',
  ]);
  // 'left' was declared and read but never set by anything. The two new states
  // say what it was reaching for, so it should not linger as a third spelling.
  assert.ok(!phase.CALL_PHASES.includes('left'));
});

test('after-call-work is NOT "in a call"', () => {
  // The bot has left the meeting. Anything tracking "is the bot in a room" —
  // the bot's-view region above all — must treat this as out.
  assert.equal(phase.isInCall('after-call-work'), false);
  assert.equal(phase.isInCall('in-call'), true);
  for (const s of ['navigating', 'joining', 'waiting-to-be-admitted']) {
    assert.equal(phase.isInCall(s), true, `${s} is on the way in`);
  }
  assert.equal(phase.isInCall('call-complete'), false);
  assert.equal(phase.isInCall('idle'), false);
});

test('after-call-work IS "busy"', () => {
  // Quitting to install an update mid-wrap-up kills the agent just as dead as
  // dropping it mid-sentence — it is only less visible, because nobody is
  // watching the call any more.
  assert.equal(phase.isBusy('after-call-work'), true);
  assert.equal(phase.isBusy('in-call'), true);
  assert.equal(phase.isBusy('call-complete'), false);
  assert.equal(phase.isBusy('idle'), false);
});

test('"a call just ended" is narrower than "nothing is happening"', () => {
  // idle covers a fresh launch too, so offering a staged update on idle fires
  // when no call ever ran. call-complete is the actual signal.
  assert.equal(phase.isCallComplete('call-complete'), true);
  assert.equal(phase.isCallComplete('idle'), false);
  assert.equal(phase.isFinished('idle'), true);
  assert.equal(phase.isFinished('call-complete'), true);
  assert.equal(phase.isFinished('after-call-work'), false);
});

test('an unknown phase is out-of-call, not in-call', () => {
  // The whole reason these are predicates. The old form was
  // `status !== 'idle' && status !== 'left'`, so ANY state added later counted
  // as in-call by default — both new phases would have inherited that.
  for (const bogus of ['', null, undefined, 'something-new']) {
    assert.equal(phase.isInCall(bogus), false, `${bogus} must not count as in a call`);
  }
});

test('no consumer decides by negation any more', () => {
  const negative = /!== 'idle'[\s\S]{0,40}!== 'left'/;
  assert.ok(!negative.test(main), 'main.js should ask call-phase.js');
  assert.ok(!negative.test(policy), 'update-policy.js should ask call-phase.js');
  assert.match(main, /callStatusMeansInCall\(status\) \{\s*return isInCall\(status\);/);
  assert.match(policy, /isBusy\(callStatus\)/);
});

test('teardown waits for the end of the lifecycle', () => {
  // clearRoom() empties transcripts and the turn maps. Running it when the bot
  // leaves is what made a post-call phase impossible — the agent would wake to
  // find the call gone.
  assert.match(server, /if \(isFinished\(status\)\) \{/);
  assert.ok(!/if \(status === 'idle' \|\| status === 'left'\) \{/.test(server));
});

test('the phase is opt-in, and off by default', () => {
  // The machinery lands before anything knows to use it, so the default must
  // reproduce the old teardown-on-leave exactly.
  const p = PREFERENCES.afterCallWorkSeconds;
  assert.ok(p, 'the preference should exist');
  assert.equal(p.type, 'number');
  assert.equal(p.default, 0);
  assert.ok(validate('afterCallWorkSeconds', 300).ok);
  assert.ok(!validate('afterCallWorkSeconds', -1).ok, 'negative time is meaningless');
});

test('leaving enters the phase instead of tearing down', () => {
  const fn = main.slice(main.indexOf('function beginAfterCallWorkOrTeardown'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /afterCallWorkSeconds/);
  assert.match(body, /setCallStatus\('after-call-work'\)/);
  // Zero seconds must behave exactly as before.
  assert.match(body, /if \(seconds <= 0 \|\| !hasAgent\)/);
  // No agent means nobody to do the work — don't wait out a timer for a session
  // that cannot answer. #156 already tracks this.
  assert.match(body, /agentAbsentInCall\(\)/);
});

test('the phase always ends, even if the agent never says so', () => {
  // Nothing reaps a terminal window on its own, so an open-ended phase would
  // reintroduce the stale-process leak.
  const fn = main.slice(main.indexOf('function beginAfterCallWorkOrTeardown'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /setTimeout\(/, 'a backstop must exist');
  assert.match(body, /finishCall\(\)/);
  const finish = main.slice(main.indexOf('function finishCall'));
  const fbody = finish.slice(0, finish.indexOf('\n}\n'));
  assert.match(fbody, /clearTimeout\(_afterCallWorkTimer\)/, 'finishing early must cancel the backstop');
  assert.match(fbody, /setCallStatus\('call-complete'\)/);
});

test('a staged update waits for the call to be fully over', () => {
  assert.match(main, /if \(isCallComplete\(status\)\) \{ try \{ offerStagedUpdate\(\)/);
});
