// tick-state.test.mjs — a background tick is a glance, not a turn.
//
// The tick (#245) surfaces the slow model mid-conversation so it can keep up and
// bank a probe. It fires on a word-count DELTA, with no check that the speaker
// has stopped or finished a phrase, so it routinely lands mid-sentence:
//
//   09:01:32  🫧 tick — 44 new words ≥ threshold 42, peakSpeakers=1
//             proc: "...reduced to just the response time. Everything else."
//   09:01:33  caption grows: "...everything else kind of crowds the screen."
//
// Routing it through the same 'thinking' state as a real turn made it wear 🤔
// AND overwrite lastProcessingText — so the avatar and the debug overlay both
// showed the bot committing to answer half a sentence. It never was.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

function makeServer(prefs = {}) {
  const states = [];
  const s = new LocalServer({
    port: 0,
    onBotStateChange: (state, extra) => states.push({ state, extra }),
    getPref: (k) => ({ defaultSilenceSeconds: 1.4, backgroundTickWords: 100, probeFiring: false, ...prefs })[k],
  });
  s.setRoom('test-room');
  s.callStatus = 'in-call';
  s.mode = 'active';
  s.states = states;
  return s;
}

// Resolve a waiter directly with a chosen reason, having seeded one caption turn.
function resolveWith(s, reason, text = 'it should be reduced to just the response time. Everything else.') {
  s.turns.set('t1', {
    id: 't1', speaker: 'Stan', text, settled: false,
    firstSeen: Date.now() - 5000, lastUpdated: Date.now(),
  });
  const waiter = { resolve: () => {}, since: null, bot: 'jimmy', silence: 1.4, startTime: Date.now() - 5000, resolved: false };
  s.waiters.push(waiter);
  s._resolveWaiter(waiter, reason);
}

test('a tick shows 👀 ticking, never the 🤔 reply face', () => {
  const s = makeServer();
  resolveWith(s, 'background_tick');
  assert.equal(s.botState, 'ticking');
  assert.ok(!s.states.some((e) => e.state === 'thinking'), 'a tick must never enter thinking');
});

test('a real turn still shows 🤔 thinking', () => {
  const s = makeServer();
  resolveWith(s, 'silence');
  assert.equal(s.botState, 'thinking');
});

test('a tick does NOT clobber lastProcessingText — that is what proc: renders', () => {
  const s = makeServer();
  s.lastProcessingText = { speaker: 'Stan', text: 'an earlier, real turn', at: Date.now() };
  resolveWith(s, 'background_tick');
  assert.equal(s.lastProcessingText.text, 'an earlier, real turn',
    'the overlay must not claim the bot is processing a mid-sentence snapshot');
});

test('a real turn DOES set lastProcessingText', () => {
  const s = makeServer();
  resolveWith(s, 'silence', 'what do you think about the latency numbers?');
  assert.match(s.lastProcessingText.text, /latency numbers/);
});

test('a tick never fires the ack — no backgroundTick thinking event reaches main.js', () => {
  const s = makeServer();
  resolveWith(s, 'background_tick');
  const thinking = s.states.filter((e) => e.state === 'thinking');
  assert.equal(thinking.length, 0);
  const tick = s.states.find((e) => e.state === 'ticking');
  assert.ok(tick, 'ticking state was emitted');
  assert.equal(tick.extra.backgroundTick, true, 'still flagged, so consumers can tell');
});

test('a raised hand outranks a glance — a tick cannot lower 🙋', () => {
  const s = makeServer();
  s.bargeInStash = { entries: [{ text: 'held thought' }], at: Date.now(), wordsAtStash: 0 };
  s._setBotState('yielding', { reason: 'user-speaking' }, { force: true });
  resolveWith(s, 'background_tick');
  assert.equal(s.botState, 'yielding', 'a queued reply is more important than a glance');
});

test('the glance arms a backstop so the bot cannot live in it', () => {
  const s = makeServer();
  resolveWith(s, 'background_tick');
  assert.equal(s.botState, 'ticking');
  assert.ok(s._tickFaceTimer, 'expiry backstop is armed');
  clearTimeout(s._tickFaceTimer); // don't leak into the test runner
});

test('the agent re-arming wait_for_speech clears the glance immediately', () => {
  const s = makeServer();
  resolveWith(s, 'background_tick');
  assert.equal(s.botState, 'ticking');
  clearTimeout(s._tickFaceTimer);
  // This is the normal path: the agent reads the tick, says nothing, and loops
  // back to listening. The backstop only matters when it doesn't.
  s._setBotState('listening', undefined, { force: true });
  assert.equal(s.botState, 'listening');
});

test('the backstop is a no-op once something realer took over', () => {
  const s = makeServer();
  resolveWith(s, 'background_tick');
  s._setBotState('speaking', {}, { force: true }); // a real reply began
  const before = s.botState;
  clearTimeout(s._tickFaceTimer);
  s._tickFaceTimer = null;
  // Simulate the timer body firing late: it must not yank the bot out of speaking.
  if (s.botState === 'ticking') s._setBotState('listening', undefined, { force: true });
  assert.equal(s.botState, before, 'a late glance-expiry must not clobber a real state');
});

test('speaking outranks a tick — a glance cannot interrupt audio', () => {
  const s = makeServer();
  s._setBotState('speaking', {}, { force: true });
  s.speakingAloud = true;
  resolveWith(s, 'background_tick');
  assert.equal(s.botState, 'speaking');
});
