// barge-in-rode-it-out.test.mjs — continuing is a decision, and it has to say so.
//
// _evaluateBargeIn logged every outcome except one: the early return taken when
// the interrupter stopped inside the grace window and the bot kept talking.
// That is the RIGHT answer to a backchannel ("mm-hm" is not a bid for the
// floor), but from outside the process it is indistinguishable from the wrong
// one — both look like "armed, then nothing". The etiquette suite duly read a
// correct run as "yielded to a 1s backchannel and never attempted a resume".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

function makeServer() {
  const s = new LocalServer({
    port: 0,
    onBotSpeech: () => {},
    getPref: (k) => ({ fastFloorDetection: true, bargeInQuietConfirmMs: 250 })[k],
  });
  s.setRoom('test-room');
  s.callStatus = 'in-call';
  return s;
}

// Run fn with console.log captured, and return everything it printed.
function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { fn(); } finally { console.log = orig; }
  return lines.join('\n');
}

test('riding out a backchannel is logged, not silent', () => {
  const s = makeServer();
  s.botState = 'speaking';
  s.anyoneSpeaking = false;          // the interrupter stopped during the grace
  s.audioFloorSpeaking = false;
  const out = capture(() => s._evaluateBargeIn());
  assert.match(out, /rode it out/, 'the decision to continue is on the record');
  assert.match(out, /interrupter stopped/, 'and says which of the two reasons it was');
});

test('the already-finished case is distinguishable from the ridden-out one', () => {
  // Same early return, different meaning: nothing was riding anything out, the
  // utterance had simply ended. Conflating them would make the marker lie.
  const s = makeServer();
  s.botState = 'idle';
  s.anyoneSpeaking = true;
  const out = capture(() => s._evaluateBargeIn());
  assert.match(out, /rode it out/);
  assert.match(out, /already finished speaking/);
});

test('a real interruption still backs off rather than riding it out', () => {
  // The guard against an over-broad fix: if the floor IS busy and the bot IS
  // speaking, we must fall through to the back-off decision as before.
  const s = makeServer();
  s.botState = 'speaking';
  s.anyoneSpeaking = true;
  s.audioFloorSpeaking = true;
  s._audioFloorOffAt = 0;
  s.participants = [];               // analyser hears someone, DOM has no name
  let backedOff = null;
  s._performBackOff = (why) => { backedOff = why; };
  const out = capture(() => s._evaluateBargeIn());
  assert.doesNotMatch(out, /rode it out/, 'not the continue path');
  assert.equal(backedOff, 'human-interrupt', 'unknown interrupter still means yield');
});
