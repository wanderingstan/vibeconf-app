// barge-in-liveness.test.mjs — when the grace timer fires, the decision must
// read the room as it is NOW, not as the participant tracker remembers it (#392).
//
// Live evidence (call ded-iika-yrs, 2026-08-15): Stan's ~0.4s blip started and
// ended entirely inside the grace window — the analyser logged speech OFF 2ms
// BEFORE the back-off fired — yet the bot still cut a substantive reply,
// because _evaluateBargeIn read `p.speaking` off the tracker and that flag's
// release (polled) trailed reality by 2.5s. The grace period was delaying the
// decision by roughly the same amount the state it decided on was stale by,
// i.e. doing almost nothing.
//
// The fix: at evaluation time, if the ANALYSER has heard sustained quiet
// (bargeInQuietConfirmMs) since the monitor armed, the interruption is over —
// ride it out, which is the grace period's entire job. The guard is
// deliberately one-sided: it can only ever SUPPRESS a back-off, and only on
// positive analyser evidence (an OFF edge after arming). No analyser events,
// or an OFF that predates the arm (analyser missed this speaker), fall back to
// the old tracker-flag decision — a broken analyser must degrade to "yields a
// bit too eagerly", never to "never yields to a human".
//
// Composes with #395/PR 396 (tracker reports true stop edges): even with that
// merged, the mutation-window release can lag by over a second, so this
// re-check still decides from fresher state than the flag.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js'); // registers globalThis.LocalServer
const LocalServer = globalThis.LocalServer;

const GRACE_MS = 60;      // short + fixed: these tests are about evaluation, not #367
const CONFIRM_MS = 20;    // scaled-down bargeInQuietConfirmMs to keep tests fast

function makeServer(prefs = {}) {
  const stops = [];
  const s = new LocalServer({
    port: 0,
    onStopTts: (reason) => stops.push(reason),
    getPref: (k) => ({
      fastFloorDetection: true,
      bargeInUrgencyScaling: false,
      bargeInGraceMs: GRACE_MS,
      bargeInQuietConfirmMs: CONFIRM_MS,
      probeFiring: false,
      ...prefs,
    })[k],
  });
  s.setRoom('test-room');
  s.callStatus = 'in-call';
  s.mode = 'active';
  s.stops = stops;
  return s;
}

// The room as the DOM speaker tracker sees it. In every stale-flag scenario
// below, Stan STAYS flagged speaking well past his actual utterance — that is
// the lag this whole file is about.
function setDom(s, speaking = []) {
  s.setParticipants(
    ['Stan', 'Seth'].map((name) => ({ name, speaking: speaking.includes(name), isSelf: false })),
  );
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test('a blip that ends inside the grace does not cost the bot its sentence', async () => {
  // The #392 incident in miniature: tracker flags Stan and never clears him
  // (release lags), the analyser hears the blip start AND end inside the
  // grace. At evaluation the floor has been quiet longer than the confirm
  // window ⇒ the interruption no longer exists ⇒ keep talking.
  const s = makeServer();
  s._setBotState('speaking');
  setDom(s, ['Stan']);           // DOM rising edge arms the monitor
  assert.ok(s._bargeInTimer, 'monitor armed');
  s.setAudioFloor(true);         // the blip
  s.setAudioFloor(false);        // ...is already over
  // DOM still says Stan is speaking (stale flag) — do NOT clear it.

  await settle(GRACE_MS + 40);
  assert.deepEqual(s.stops, [], 'interruption ended during grace — no back-off');
  assert.equal(s.botState, 'speaking');
});

test('a speaker still live at evaluation takes the floor', async () => {
  // The guard must not weaken real barge-in: analyser still ON when the grace
  // expires means they are genuinely still going, so the bot yields.
  const s = makeServer();
  s._setBotState('speaking');
  setDom(s, ['Stan']);
  s.setAudioFloor(true);         // and it stays on

  await settle(GRACE_MS + 40);
  assert.deepEqual(s.stops, ['human-interrupt'], 'still talking — the human wins the floor');
  assert.equal(s.botState, 'yielding');
});

test('quiet shorter than the confirm window still yields (inter-word dip)', async () => {
  // The analyser dips between syllables. An OFF edge moments before the
  // evaluation is not proof the turn ended — with the confirm window scaled
  // up past the grace, the fresh OFF must not suppress the back-off.
  const s = makeServer({ bargeInQuietConfirmMs: 10_000 });
  s._setBotState('speaking');
  setDom(s, ['Stan']);
  s.setAudioFloor(true);
  await settle(GRACE_MS - 20);
  s.setAudioFloor(false);        // dips just before the timer fires

  await settle(60);
  assert.deepEqual(s.stops, ['human-interrupt'],
    'a just-now dip is not sustained quiet — treat the speaker as live');
});

test('no analyser events at all falls back to the tracker flag', async () => {
  // The failure direction that matters: if the analyser is absent or broken
  // (no floor-audio events this call), the bot must degrade to the OLD
  // behavior — yield on the tracker flag — not refuse to yield forever.
  const s = makeServer();
  s._setBotState('speaking');
  setDom(s, ['Stan']);           // DOM-only evidence; analyser never speaks up

  await settle(GRACE_MS + 40);
  assert.deepEqual(s.stops, ['human-interrupt'],
    'without analyser evidence the quiet verdict is not trusted — old behavior');
});

test('an analyser OFF that predates the arm cannot vouch for quiet', async () => {
  // Partial-failure case: the analyser worked earlier in the call but missed
  // THIS speaker (threshold too high, no remote track). Its stale OFF must
  // not read as "the room is quiet" — that would suppress every yield to
  // that speaker for as long as the analyser stays deaf to them.
  const s = makeServer();
  s.setAudioFloor(true);         // some earlier utterance, long resolved
  s.setAudioFloor(false);
  await settle(CONFIRM_MS + 20); // stale OFF is now older than the confirm window
  s._setBotState('speaking');
  setDom(s, ['Stan']);           // arms; analyser hears nothing of Stan

  await settle(GRACE_MS + 40);
  assert.deepEqual(s.stops, ['human-interrupt'],
    'quiet evidence from before the arm is no evidence about this interruption');
});
