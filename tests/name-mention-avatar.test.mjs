// name-mention-avatar.test.mjs — the cosmetic "heard my name" avatar signal.
//
// Separate from the passive/silent name-gate in _checkWaiters (#343), which
// decides whether the bot actually RESPONDS. This is just visual: a brief
// head-tilt + lean-in when another participant's speech names the bot, fired
// via onNameMentioned() from updateTurns the first time a caption turn
// contains the bot's own name — the same detection #343 already relies on.
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js'); // registers globalThis.LocalServer
const LocalServer = globalThis.LocalServer;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const inject = fs.readFileSync(path.join(__dirname, '../electron-app/page-inject.js'), 'utf-8');

function makeServer(botName) {
  const s = new LocalServer({ port: 0 });
  s.setRoom('test-room');
  s.currentCallBotName = botName;
  return s;
}

const T = (turnId, speaker, text, isBottommost = false) => ({ turnId, speaker, text, isBottommost });

test('a fresh turn that opens with the bot name fires onNameMentioned once', () => {
  const s = makeServer('Jimmy');
  let fires = 0;
  s.onNameMentioned = () => { fires++; };
  s.updateTurns([T(1, 'Stan', 'Hey Jimmy, what do you think?', true)]);
  assert.equal(fires, 1);
});

test('a turn that never mentions the bot never fires', () => {
  const s = makeServer('Jimmy');
  let fires = 0;
  s.onNameMentioned = () => { fires++; };
  s.updateTurns([T(1, 'Stan', 'I think brighter colors would work better here.', true)]);
  assert.equal(fires, 0);
});

test('matching is case-insensitive', () => {
  const s = makeServer('Jimmy');
  let fires = 0;
  s.onNameMentioned = () => { fires++; };
  s.updateTurns([T(1, 'Stan', 'hey JIMMY, you there?', true)]);
  assert.equal(fires, 1);
});

test('a turn that GROWS to include the name fires exactly once, not on every growth tick', () => {
  const s = makeServer('Jimmy');
  let fires = 0;
  s.onNameMentioned = () => { fires++; };
  s.updateTurns([T(1, 'Stan', 'So about the deploy,')]);
  assert.equal(fires, 0, 'name not present yet');
  s.updateTurns([T(1, 'Stan', 'So about the deploy, Jimmy,')]);
  assert.equal(fires, 1, 'name just appeared — one signal');
  s.updateTurns([T(1, 'Stan', 'So about the deploy, Jimmy, can you check the logs?')]);
  assert.equal(fires, 1, 'same turn still growing — must not re-fire');
  s.updateTurns([T(1, 'Stan', 'So about the deploy, Jimmy, can you check the logs please?', true)]);
  assert.equal(fires, 1, 'settling the turn must not re-fire either');
});

test('two separate turns that each name the bot fire twice, once per turn', () => {
  const s = makeServer('Jimmy');
  let fires = 0;
  s.onNameMentioned = () => { fires++; };
  s.updateTurns([T(1, 'Stan', 'Jimmy, can you help?', true)]);
  assert.equal(fires, 1);
  s.updateTurns([T(2, 'Kate', 'Jimmy, one more thing.', true)]);
  assert.equal(fires, 2);
});

test('no configured bot name means no crash and no false signal', () => {
  const s = new LocalServer({ port: 0 });
  s.setRoom('test-room'); // currentCallBotName left null — nothing configured
  let fires = 0;
  s.onNameMentioned = () => { fires++; };
  s.updateTurns([T(1, 'Stan', 'Jimmy, can you help?', true)]);
  assert.equal(fires, 0, 'an unnamed bot has nothing to match against');
});

test('the bot own speech never reaches updateTurns, so it cannot trigger its own reaction', () => {
  // Documents an invariant this feature relies on rather than re-testing it:
  // google-meet-provider.js filters out the 'You' caption speaker (the bot's
  // own TTS) before CALL_EVENTS.captionTurns is ever emitted, so updateTurns
  // only ever sees OTHER participants' speech. If that filter ever moved,
  // this feature would start reacting to the bot saying its own name.
  const provider = fs.readFileSync(
    path.join(__dirname, '../electron-app/google-meet-provider.js'), 'utf-8');
  assert.match(provider, /speaker === MEET\.captions\.selfSpeaker/);
  const selectors = fs.readFileSync(
    path.join(__dirname, '../electron-app/meet-selectors.js'), 'utf-8');
  assert.match(selectors, /selfSpeaker: 'You'/);
});

test('the avatar composites a head-tilt + lean-in reaction that snaps in fast and lingers', () => {
  assert.match(inject, /MENTION_ATTACK_MS = 150/, 'snaps into the pose almost instantly');
  assert.match(inject, /MENTION_DECAY_MS = 5000/, 'a state change, not a passing tick — must hold for seconds, not fractions of one');
  assert.match(inject, /mentionTilt = mentionPulse \* \(this\._mentionTiltSign \|\| 1\)/);
  assert.match(inject, /mentionPop = 1 \+ mentionPulse \* 0\.22/);
  // It has to actually reach the rotation and scale, alongside the other pulses.
  assert.match(inject, /speakTilt \+ tickTilt \+ agentTiltNow \+ deadFlip \+ mentionTilt/);
  assert.match(inject, /speakScaleX \* tickPop \* mentionPop/);
  assert.match(inject, /breathe \* tickPop \* mentionPop/);
});

test("the 'name-mentioned' IPC case stamps the pulse, alternates tilt SIDE, and varies tilt SIZE", () => {
  const body = inject.slice(inject.indexOf("case 'name-mentioned':"), inject.indexOf("case 'play-join-chime':"));
  assert.match(body, /cam\._nameMentionPulseAt = Date\.now\(\)/);
  // Side must ALTERNATE (deterministic), not be re-rolled — back-to-back
  // mentions need to stay visually distinguishable as separate events.
  assert.match(body, /cam\._mentionTiltSign = -\(cam\._mentionTiltSign \|\| 1\)/);
  // Size, by contrast, must be RANDOM each time so it doesn't read as a
  // mechanical, identical-amplitude tic.
  assert.match(body, /Math\.random\(\)/, 'peak tilt amount should vary randomly per mention');
  assert.match(body, /cam\._mentionTiltMag = mag/);
});

test('the render loop actually applies the randomized magnitude to the tilt', () => {
  assert.match(inject, /mentionTilt = mentionPulse \* \(this\._mentionTiltSign \|\| 1\) \* \(this\._mentionTiltMag \|\| 1\)/);
});
