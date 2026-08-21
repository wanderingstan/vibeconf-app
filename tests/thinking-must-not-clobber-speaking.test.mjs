// thinking-must-not-clobber-speaking.test.mjs — #412.
//
// Two bots overlapped for ~15 seconds on the 2026-08-20 call and barge-in never
// armed. Not armed-and-decided-wrong: never armed. The peer's tile was visible
// throughout (meter mode reported spk=1 with real levels), so it was not the
// detection failure the issue originally described.
//
// Both barge-in gates require botState === 'speaking':
//
//   _armBargeIn:      if (this._bargeInTimer || this.botState !== 'speaking') return;
//   _evaluateBargeIn: if (this.botState !== 'speaking' || !this.floorBusy) ...
//
// and _resolveWaiter wrote `this.botState = 'thinking'` as a raw field
// assignment. It did that to dodge _setBotState's equal-state guard — the ack
// handler must run on every resolve, even when the state is already thinking —
// and dodged every other guard with it, including "thinking must never override
// speaking".
//
// A stash replay dispatches one tick before _buildResponse in the SAME resolve,
// so a replayed utterance lost 'speaking' about a millisecond after its audio
// started and then played for seconds with no interrupt monitor. Measured over
// one 56-minute call: normal speech held 'speaking' for a median 3137ms,
// replayed speech for 48ms, and 18 of 23 replays lost it inside 200ms.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { readFileSync } from 'fs';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

function makeServer() {
  const s = new LocalServer({
    port: 0,
    onBotSpeech: () => {},
    getPref: (k) => ({ backgroundTickWords: 0 })[k],
  });
  s.setRoom('test-room');
  s.callStatus = 'in-call';
  s.stateChanges = [];
  s.onBotStateChange = (state, meta) => s.stateChanges.push({ state, meta });
  // One real utterance from someone else, which is what a silence resolve hands
  // to the agent. Stubbed at the reader so the test drives _resolveWaiter for
  // real rather than reimplementing its guard.
  s._entriesSince = () => ([{
    speaker: 'Stan James',
    text: 'So what do you think we should do about the migration ordering?',
    timestamp: new Date().toISOString(),
  }]);
  return s;
}

function waiter() {
  return { resolved: false, since: null, bot: 'Jimmy', startTime: Date.now() - 1000,
           resolve: () => {}, timer: null, silenceTimer: null, tickTimer: null };
}

test('a silence resolve does not knock a live utterance out of speaking', () => {
  // The #412 case: audio is playing when the captions land, and the bot must
  // still be interruptible afterwards.
  const s = makeServer();
  s._setBotState('speaking', { emoji: '🎬' });
  s._resolveWaiter(waiter(), 'silence');
  assert.equal(s.botState, 'speaking', 'still speaking — barge-in can still arm');
});

test('the ack callback still fires on that resolve', () => {
  // The reason the raw write existed. Losing it would skip the ack on every
  // second consecutive wait_for_speech, so the fix has to keep it.
  const s = makeServer();
  s._setBotState('speaking', { emoji: '🎬' });
  s._resolveWaiter(waiter(), 'silence');
  const thinking = s.stateChanges.filter((c) => c.state === 'thinking');
  assert.ok(thinking.length >= 1, 'onBotStateChange("thinking") still fired');
  assert.ok(thinking.at(-1).meta.wordCount > 0, 'and carried the word count');
});

test('a held reply (yielding) is protected the same way', () => {
  // 'yielding' means a stash is held and the hand is up. Overwriting it loses
  // the hand and the stash's meaning, as overwriting 'speaking' loses the
  // interrupt monitor.
  const s = makeServer();
  s._setBotState('yielding', undefined, { force: true });
  s._resolveWaiter(waiter(), 'silence');
  assert.equal(s.botState, 'yielding');
});

test('a resting bot still gets the thinking face', () => {
  // The fix must not stop the avatar reflecting agent work — the whole point of
  // the line (#339).
  for (const st of ['idle', 'listening', 'thinking', 'working']) {
    const s = makeServer();
    s.botState = st;
    s._resolveWaiter(waiter(), 'silence');
    assert.equal(s.botState, 'thinking', `${st} should escalate to thinking`);
  }
});

test('the resting list is defined once, and excludes the two live states', () => {
  // _onAgentActivity and the resolve path were written separately — one as an
  // inline array, one as nothing at all — which is how they drifted. Both read
  // the same constant now.
  const src = readFileSync(new URL('../electron-app/local-server.js', import.meta.url), 'utf8');
  const def = src.match(/^const RESTING_STATES = \[[^\]]*\];/m);
  assert.ok(def, 'RESTING_STATES defined once at module scope');
  assert.doesNotMatch(def[0], /speaking/, 'speaking is never a resting state');
  assert.doesNotMatch(def[0], /yielding/, 'yielding is never a resting state');
  assert.ok((src.match(/RESTING_STATES/g) || []).length >= 3, 'and is actually shared');
});

test('no unguarded raw write to botState survives', () => {
  // The shape of the original bug: bypassing _setBotState bypasses every guard
  // in it, not just the one you meant to dodge.
  const src = readFileSync(new URL('../electron-app/local-server.js', import.meta.url), 'utf8');
  // Only the BUSY faces: the constructor's `this.botState = 'idle'` is a
  // legitimate initialisation, and there is nothing live for it to clobber.
  assert.doesNotMatch(src, /^\s*this\.botState = '(thinking|working|speaking|yielding)';\s*$/m,
    'set state through _setBotState, or guard the write with RESTING_STATES');
});
