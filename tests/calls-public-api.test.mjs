// calls-public-api.test.mjs: the public Call and join() over a fake host call,
// without a browser. The real thing runs in the conformance suite.
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { join, JoinError, UnsupportedError, MutedError, platforms } = require('../packages/calls');
const { Call, stateFromStatus } = require('../packages/calls/api/call.js');
const { ChatFeed } = require('../packages/calls/api/chat-feed.js');
const { CaptionStream } = require('../packages/calls/api/captions.js');
const { classifyJoinFailure, codeFromStatus, isProfileInUse } = require('../packages/calls/api/errors.js');
const { CALL_EVENTS } = require('../packages/calls/core/call-provider.js');
const { MEET } = require('../packages/calls/providers/meet-selectors.js');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

class FakeInner extends EventEmitter {
  constructor() {
    super();
    this.chat = [];
    this.calls = [];
    this.sendOk = true;
  }
  async setMicMuted(m) { this.calls.push(['mic', m]); }
  async setCameraOn(on) { this.calls.push(['camera', on]); }
  async speak(p) { this.calls.push(['speak', p.audioData]); }
  async stopSpeaking() { this.calls.push(['stop']); this.emit(CALL_EVENTS.ttsEnded); }
  async readChat() { this.calls.push(['read']); return this.chat; }
  async sendChat(t) { this.calls.push(['send', t]); return this.sendOk; }
  async getParticipants() { return ['Ann', { name: 'Bot', speaking: true, isSelf: true }]; }
  async leave() { this.calls.push(['leave']); return true; }
  async screenshot() { return Buffer.from('png'); }
}
const makeCall = (platform = 'zoom', opts = {}) => {
  const inner = new FakeInner();
  return { inner, call: new Call(inner, { platform, name: 'Bot', hostCapabilities: { share: false }, ...opts }) };
};
const count = (inner, what) => inner.calls.filter((c) => c[0] === what).length;

test('capabilities combine the platform and the host', () => {
  assert.deepEqual({ ...makeCall('zoom').call.capabilities }, { captions: true, chat: true, chatEvents: true, share: false, camera: true });
  assert.equal(makeCall('slack').call.capabilities.chatEvents, false);
  assert.equal(makeCall('slack').call.capabilities.chat, true);
});

test('speak opens the mic, and done waits for the clip to end', async () => {
  const { inner, call } = makeCall();
  const playback = await call.speak(Buffer.from('clip'));
  await tick();
  assert.deepEqual(inner.calls, [['mic', false], ['speak', Buffer.from('clip').toString('base64')]]);
  let done = false;
  playback.done.then(() => { done = true; });
  await tick();
  assert.equal(done, false);
  inner.emit(CALL_EVENTS.ttsEnded);
  assert.deepEqual(await playback.done, { cancelled: false });
});

test('clips play one at a time, since tts-ended names no clip', async () => {
  const { inner, call } = makeCall();
  const one = await call.speak(Buffer.from('a'));
  await call.speak(Buffer.from('b'));
  await tick();
  assert.equal(count(inner, 'speak'), 1);
  inner.emit(CALL_EVENTS.ttsEnded);
  await one.done;
  await tick();
  assert.equal(count(inner, 'speak'), 2);
});

test('an explicit mute makes speak reject, and unmuting allows it again', async () => {
  const { inner, call } = makeCall();
  await call.mic.setMuted(true);
  await assert.rejects(call.speak(Buffer.from('a')), MutedError);
  assert.equal(count(inner, 'speak'), 0);
  await call.mic.setMuted(false);
  await call.speak(Buffer.from('a'));
  await tick();
  assert.equal(count(inner, 'speak'), 1);
});

test('cancel stops a playing clip, and drops one that has not started', async () => {
  const { inner, call } = makeCall();
  const first = await call.speak(Buffer.from('a'));
  const second = await call.speak(Buffer.from('b'));
  await tick();
  await second.cancel();
  assert.deepEqual(await second.done, { cancelled: true });
  await first.cancel();
  assert.deepEqual(await first.done, { cancelled: true });
  await tick();
  assert.equal(count(inner, 'speak'), 1);
});

test('chat: history does not fire, new messages fire once, own messages never', async () => {
  const { inner, call } = makeCall();
  inner.chat = [{ id: 'old', sender: 'Ann', text: 'before' }];
  const got = [];
  call.on('chat', (m) => got.push(m));
  await tick();
  inner.chat = [...inner.chat, { id: '1', sender: 'Ann', text: 'hi' }, { id: '2', sender: 'Bot', text: 'mine' }];
  inner.emit(CALL_EVENTS.chatUnread, { unread: true });
  await tick(600);
  inner.emit(CALL_EVENTS.chatUnread, { unread: true });
  await tick(600);
  assert.deepEqual(got, [{ id: '1', sender: 'Ann', text: 'hi' }]);
});

test('chat: no reads happen until someone listens', async () => {
  const { inner } = makeCall();
  inner.emit(CALL_EVENTS.chatUnread, { unread: true });
  await tick(600);
  assert.equal(count(inner, 'read'), 0);
});

test('chat: a message read by chat.read() still fires, since the read cleared the flag', async () => {
  const { inner, call } = makeCall();
  const got = [];
  call.on('chat', (m) => got.push(m.id));
  await tick();
  inner.chat = [{ id: '1', sender: 'Ann', text: 'hi' }];
  assert.deepEqual(await call.chat.read(), [{ id: '1', sender: 'Ann', text: 'hi' }]);
  inner.emit(CALL_EVENTS.chatUnread, { unread: true });
  await tick(600);
  assert.deepEqual(got, ['1']);
});

test('chat: something this Call sent is recognized even without a usable sender', async () => {
  const { inner, call } = makeCall();
  const got = [];
  call.on('chat', (m) => got.push(m.text));
  await tick();
  await call.chat.send('from me');
  inner.chat = [{ id: '1', sender: '', text: 'from me' }, { id: '2', sender: 'Ann', text: 'from me' }];
  inner.emit(CALL_EVENTS.chatUnread, { unread: true });
  await tick(600);
  assert.deepEqual(got, ['from me']); // Ann's copy still counts
});

test('chat: sending looks for messages too, since opening the chat clears the badge', async () => {
  const { inner, call } = makeCall();
  const got = [];
  call.on('chat', (m) => got.push(m.id));
  await tick();
  inner.chat = [{ id: '1', sender: 'Ann', text: 'hi' }];
  await call.chat.send('hello');
  await tick(600);
  assert.deepEqual(got, ['1']);
});

test("Meet's pin icon on a line of its own is not part of the message", () => {
  const strip = (t) => t.replace(MEET.chat.pinChromeTailRe, '');
  assert.equal(strip('hello there\nkeep'), 'hello there'); // seen live on the bot's own messages
  assert.equal(strip('worth a keep'), 'worth a keep');
});

test('chat.send rejects when the platform does not confirm', async () => {
  const { inner, call } = makeCall();
  inner.sendOk = false;
  await assert.rejects(call.chat.send('x'), /didn't confirm/);
});

test('unread signals close together share one read', async () => {
  let reads = 0;
  const feed = new ChatFeed({ read: async () => { reads++; return []; }, isOwn: () => false, onMessage: () => {}, coalesceMs: 20 });
  await feed.start();
  reads = 0;
  feed.onUnread(); feed.onUnread(); feed.onUnread();
  await tick(60);
  assert.equal(reads, 1);
  feed.stop();
});

test('captions: a revised turn updates, and a newer turn finalizes it', () => {
  const got = [];
  const s = new CaptionStream((t) => got.push(t));
  s.update([{ turnId: 1, speaker: 'Ann', text: 'hel' }]);
  s.update([{ turnId: 1, speaker: 'Ann', text: 'hel' }]);
  s.update([{ turnId: 1, speaker: 'Ann', text: 'hello' }]);
  s.update([{ turnId: 1, speaker: 'Ann', text: 'hello' }, { turnId: 2, speaker: 'Bo', text: 'yes' }]);
  s.end();
  assert.deepEqual(got.map((t) => [t.id, t.text, t.final]), [
    [1, 'hel', false], [1, 'hello', false], [1, 'hello', true], [2, 'yes', false], [2, 'yes', true],
  ]);
});

test('events get friendly names and shapes', async () => {
  const { inner, call } = makeCall();
  const got = {};
  for (const e of ['participants', 'speaking', 'share', 'stall', 'state']) call.on(e, (p) => { got[e] = p; });
  inner.emit(CALL_EVENTS.participantsUpdated, ['Ann']);
  inner.emit(CALL_EVENTS.speakingChanged, { name: 'Ann', speaking: true });
  inner.emit(CALL_EVENTS.someonePresenting, { presenting: true, presenterName: 'Ann' });
  inner.emit(CALL_EVENTS.captionStall, { ageMs: 1 });
  inner.emit(CALL_EVENTS.statusUpdate, 'Error: removed from the meeting');
  assert.deepEqual(got, {
    participants: [{ name: 'Ann', speaking: false, isSelf: false }],
    speaking: { name: 'Ann', speaking: true },
    share: { presenter: 'Ann', active: true },
    stall: { what: 'captions' },
    state: 'removed',
  });
  assert.equal(call.state, 'removed');
});

test('what the host or platform cannot do rejects with UnsupportedError', async () => {
  const { call } = makeCall();
  await assert.rejects(call.share.start('x'), UnsupportedError);
  await assert.rejects(call.share.stop(), UnsupportedError);
});

test('leave closes a host join() opened, once, and ends what was playing', async () => {
  let closes = 0;
  const { inner, call } = makeCall('zoom', { closeHost: async () => { closes++; } });
  const states = [];
  call.on('state', (s) => states.push(s));
  const playback = await call.speak(Buffer.from('a'));
  await tick();
  await call.leave();
  await call.leave();
  assert.equal(closes, 1);
  assert.equal(count(inner, 'leave'), 1);
  assert.deepEqual(await playback.done, { cancelled: true });
  assert.deepEqual(states, ['left']);
  await assert.rejects(call.speak(Buffer.from('b')), /ended/);
});

test('status lines map to states', () => {
  assert.equal(stateFromStatus('Waiting to be admitted (1m 3s)...'), 'lobby');
  assert.equal(stateFromStatus('In call (Zoom)'), 'in-call');
  assert.equal(stateFromStatus('Participating in Meet'), 'in-call');
  assert.equal(stateFromStatus('Call ended: the meeting is over'), 'left');
  assert.equal(stateFromStatus('Notice: an unhandled Meet dialog'), null);
});

test('a status that settles a join, and one that does not', () => {
  assert.equal(codeFromStatus('Error: Zoom blocked the guest join (reCAPTCHA). Sign the bot in'), 'bot-check');
  assert.equal(codeFromStatus("Error: can't join this video call (host blocked entry)"), 'denied');
  assert.equal(codeFromStatus('Error: join button not found'), 'ui-changed');
  assert.equal(codeFromStatus('Denied — reloading to retry join (attempt 1/3)'), null);
  assert.equal(codeFromStatus('Error: mic issue detected'), null);
});

test('a join that timed out is classified from what the page showed', () => {
  assert.equal(classifyJoinFailure({ statuses: ['Joining Meet...', 'Waiting to be admitted (2m 0s)...'] }), 'lobby-timeout');
  assert.equal(classifyJoinFailure({ url: 'https://accounts.google.com/v3/signin' }), 'auth-required');
  assert.equal(classifyJoinFailure({ url: 'https://acme.slack.com/signin' }), 'auth-required');
  assert.equal(classifyJoinFailure({ url: 'https://slack.com/signin' }), 'auth-required');
  assert.equal(classifyJoinFailure({ text: 'Complete the CAPTCHA' }), 'bot-check');
  assert.equal(classifyJoinFailure({ text: 'Your administrator has blocked this' }), 'blocked-by-admin');
  assert.equal(classifyJoinFailure({}), 'timeout');
  // Chrome's wording, from launching one profile twice.
  assert.ok(isProfileInUse(new Error('Opening in existing browser session. This usually means that the profile is already in use by another instance of Chromium.')));
});

test('join checks its arguments before opening a browser', async () => {
  const meet = 'https://meet.google.com/abc-defg-hij';
  await assert.rejects(join(meet, { profile: '/tmp/x' }), /`name` is required/);
  await assert.rejects(join(meet, { name: 'A' }), /`profile` is required/);
  await assert.rejects(join('https://example.com', { name: 'A', profile: '/tmp/x' }), UnsupportedError);
  await assert.rejects(join('https://call.whatsapp.com/voice/abc123def456', { name: 'A', profile: '/tmp/x' }), UnsupportedError);
  const aborted = AbortSignal.abort();
  await assert.rejects(join(meet, { name: 'A', profile: '/tmp/x', signal: aborted }));
  assert.deepEqual([...platforms], ['meet', 'zoom', 'teams', 'slack']);
});

test('join settles early on a fatal status, with a host that keeps running', async () => {
  const inner = new FakeInner();
  let closed = false;
  const host = {
    capabilities: {},
    close: async () => { closed = true; },
    join: (_url, { onCall }) => {
      onCall(inner);
      setTimeout(() => inner.emit(CALL_EVENTS.statusUpdate, 'Error: Zoom blocked the guest join (reCAPTCHA).'), 0);
      return new Promise(() => {}); // would wait out the timeout
    },
  };
  const err = await join('https://meet.google.com/abc-defg-hij', { name: 'A', host }).catch((e) => e);
  assert.ok(err instanceof JoinError);
  assert.equal(err.code, 'bot-check');
  assert.equal(closed, false); // the caller owns a host it passed in
});

test('join reports states while joining and resolves with a Call', async () => {
  const inner = new FakeInner();
  const host = {
    capabilities: { share: false },
    close: async () => {},
    join: async (_url, { onCall, botName, mode }) => {
      assert.equal(botName, 'A');
      assert.equal(mode, 'guest');
      onCall(inner);
      inner.emit(CALL_EVENTS.statusUpdate, 'Waiting to be admitted...');
      inner.emit(CALL_EVENTS.statusUpdate, 'Participating in Meet');
      return inner;
    },
  };
  const states = [];
  const call = await join('https://meet.google.com/abc-defg-hij', { name: 'A', host, onState: (s) => states.push(s) });
  assert.deepEqual(states, ['joining', 'lobby', 'in-call']);
  assert.equal(call.platform, 'meet');
  assert.equal(call.state, 'in-call');
  assert.equal(call.capabilities.share, false);
});
