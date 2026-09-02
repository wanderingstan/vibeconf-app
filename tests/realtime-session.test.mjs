// realtime-session.test.mjs — the broker that stands between the API key and
// the page (EXPERIMENT).
//
// Two things here are worth pinning down, because both failed in the standalone
// prototype before this was ported in:
//
//   1. The switch is per-bot and defaults OFF. A realtime bot has to be able to
//      sit in a call next to normal Claude-backed bots without changing them,
//      and nobody should start paying per-minute audio bills by upgrading.
//
//   2. When a session is refused, the SERVER's message has to survive. The
//      prototype logged only the status code, and a 429 that actually meant
//      "you have no credits" was indistinguishable from rate limiting. That
//      cost a debugging session.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveRealtimeConfig, mintEphemeralSession, buildInstructions } =
  require('../electron-app/realtime-session.js');

const storeOf = (map) => ({ get: (k) => map[k] });

test('off unless this bot asks for it', () => {
  assert.equal(resolveRealtimeConfig({ store: storeOf({}) }).enabled, false);
  // A key alone must not switch it on: that would upgrade every bot at once.
  assert.equal(
    resolveRealtimeConfig({ store: storeOf({ realtimeApiKey: 'sk-x' }) }).enabled,
    false,
  );
});

test('enabled without a key is not ready, and says which key', () => {
  const cfg = resolveRealtimeConfig({ store: storeOf({ realtimeVoice: true }) });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.ready, false);
  assert.deepEqual(cfg.missing, ['realtimeApiKey']);
});

test('a stored key makes it ready; env is a fallback', () => {
  const stored = resolveRealtimeConfig({
    store: storeOf({ realtimeVoice: true, realtimeApiKey: 'sk-stored' }),
  });
  assert.equal(stored.ready, true);
  assert.equal(stored.apiKey, 'sk-stored');

  const fromEnv = resolveRealtimeConfig({
    store: storeOf({ realtimeVoice: true }),
    env: { OPENAI_API_KEY: 'sk-env' },
  });
  assert.equal(fromEnv.ready, true);
  assert.equal(fromEnv.apiKey, 'sk-env');
});

test('voice and model fall back to defaults but are overridable per bot', () => {
  const d = resolveRealtimeConfig({ store: storeOf({ realtimeVoice: true, realtimeApiKey: 'k' }) });
  assert.equal(d.voice, 'cedar');
  assert.equal(d.model, 'gpt-realtime');

  const custom = resolveRealtimeConfig({
    store: storeOf({
      realtimeVoice: true, realtimeApiKey: 'k',
      realtimeVoiceName: 'marin', realtimeModel: 'gpt-realtime-next',
    }),
  });
  assert.equal(custom.voice, 'marin');
  assert.equal(custom.model, 'gpt-realtime-next');
});

test('a store that throws does not take the app down', () => {
  const angry = { get() { throw new Error('config unreadable'); } };
  assert.equal(resolveRealtimeConfig({ store: angry }).enabled, false);
});

test('instructions name the bot and stay short', () => {
  const text = buildInstructions({ botName: 'Pepper' });
  assert.match(text, /You are Pepper/);
  // Realtime models drop clauses from long prompts, so this must not creep.
  //
  // Moved 120 -> 220 once, deliberately, to buy the paragraph telling it that a
  // slower half is listening and it should stop announcing what it cannot do.
  // That paragraph is load-bearing: without it the model said "I can't put that
  // on the whiteboard" about a thing the bot could do easily, and sent the user
  // off to do it by hand.
  //
  // 220 is still far under the ~300 where these prompts start visibly shedding
  // clauses. If this fails again, the question to ask is which paragraph is
  // now doing less work than the one being added, not what the number should be.
  assert.ok(text.split(/\s+/).length < 220, 'instructions should stay under ~220 words');
  assert.match(buildInstructions({}), /^You are a voice teammate/);
});

test('a key that lost a character on paste is flagged, not blocked', () => {
  // The real one: a paste stored "k-proj-..." (163 chars, leading s missing).
  // OpenAI answers that with the same 401 it gives a revoked key, so the app
  // has to notice the shape itself or the user goes hunting for a billing
  // problem that does not exist.
  const bad = resolveRealtimeConfig({
    store: storeOf({ realtimeVoice: true, realtimeApiKey: 'k-proj-abc' }),
  });
  assert.equal(bad.suspicious, true);
  assert.equal(bad.ready, true, 'still tried: an unrecognised prefix is a warning, not a veto');

  for (const good of ['sk-abc', 'sk-proj-abc']) {
    assert.equal(
      resolveRealtimeConfig({ store: storeOf({ realtimeVoice: true, realtimeApiKey: good }) }).suspicious,
      false,
    );
  }
  // No key at all is "missing", not "suspicious" — different message.
  const none = resolveRealtimeConfig({ store: storeOf({ realtimeVoice: true }) });
  assert.equal(none.suspicious, false);
});

test('mints against the current endpoint shape', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    return { ok: true, json: async () => ({ value: 'ek_live' }) };
  };
  const out = await mintEphemeralSession(
    { apiKey: 'k', model: 'gpt-realtime', voice: 'cedar' }, { fetchImpl });
  assert.equal(out.secret, 'ek_live');
  assert.equal(out.shape, 'client_secrets');
  assert.equal(calls.length, 1, 'should not call the legacy endpoint when the first works');
});

test('falls back to the older endpoint shape', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('client_secrets')) {
      return { ok: false, status: 404, text: async () => 'no such endpoint' };
    }
    return { ok: true, json: async () => ({ client_secret: { value: 'ek_old' } }) };
  };
  const out = await mintEphemeralSession(
    { apiKey: 'k', model: 'gpt-realtime', voice: 'cedar' }, { fetchImpl });
  assert.equal(out.secret, 'ek_old');
  assert.equal(out.shape, 'sessions');
  assert.equal(calls.length, 2);
});

test('a refusal carries the server message, not just the status', async () => {
  // The real one: 429 here meant "no credits", not "slow down".
  const fetchImpl = async () => ({
    ok: false,
    status: 429,
    text: async () => JSON.stringify({
      error: { message: 'You have no credits remaining.' },
    }),
  });
  await assert.rejects(
    mintEphemeralSession({ apiKey: 'k', model: 'm', voice: 'v' }, { fetchImpl }),
    (err) => {
      assert.match(err.message, /429/);
      assert.match(err.message, /no credits remaining/);
      return true;
    },
  );
});

test('no key is refused before any network call', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  await assert.rejects(
    mintEphemeralSession({ apiKey: '', model: 'm' }, { fetchImpl }),
    /no API key/,
  );
  assert.equal(called, false);
});

// --- the response gate (the Seth call, 2026-08-31) ---------------------------
//
// Left to itself the voice model answered 117 of 179 human turns in a
// three-way call, including plenty aimed at the other person: it behaves like
// the two-party conversations it was trained on. No VAD setting fixes that,
// because VAD knows when speech ENDED and never who it was for. So the model
// stops deciding (create_response:false) and this decides instead.

const { buildResponsePolicy } = require('../electron-app/realtime-session.js');

const CALL = [
  { name: 'jimmy bot', isSelf: true },
  { name: 'Stan James' },
  { name: 'Seth Goldstein' },
];

test('two in the room is never gated', () => {
  const p = buildResponsePolicy({
    botName: 'Jimmy',
    participants: [{ name: 'jimmy bot', isSelf: true }, { name: 'Stan James' }],
  });
  assert.equal(p.gate, false, 'with one other person, everything said is said to the bot');
});

test('a third person turns the gate on', () => {
  assert.equal(buildResponsePolicy({ botName: 'Jimmy', participants: CALL }).gate, true);
});

test('first names are matched, because that is how people address each other', () => {
  const p = buildResponsePolicy({ botName: 'Jimmy', participants: CALL });
  // "Seth, what do you think?" has to be recognisable as not-for-the-bot.
  assert.ok(p.otherNames.includes('seth'), 'first name');
  assert.ok(p.otherNames.includes('seth goldstein'), 'full name');
});

test("the bot's own tile never counts as somebody else", () => {
  const p = buildResponsePolicy({ botName: 'Jimmy', participants: CALL });
  // Its Meet display name ("jimmy bot") is not its configured name ("Jimmy"),
  // so an equality test would have filed the bot as another participant and
  // then stayed silent every single time it was addressed.
  assert.ok(!p.otherNames.some((n) => n.includes('jimmy')), 'bot must not be in otherNames');
  assert.deepEqual(p.botNames, ['jimmy']);
});

test('a self tile with no isSelf flag is still recognised by name', () => {
  const p = buildResponsePolicy({
    botName: 'Jimmy',
    participants: [{ name: 'jimmy bot' }, { name: 'Stan James' }, { name: 'Seth Goldstein' }],
  });
  assert.ok(!p.otherNames.some((n) => n.includes('jimmy')));
});

test('single initials are not names', () => {
  // A one-character token would match nearly every sentence and mute the bot.
  const p = buildResponsePolicy({
    botName: 'Jimmy',
    participants: [...CALL, { name: 'X' }],
  });
  assert.ok(!p.otherNames.includes('x'));
});

test('pseudo participants are ignored', () => {
  const p = buildResponsePolicy({
    botName: 'Jimmy',
    participants: [{ name: 'jimmy bot', isSelf: true }, { name: 'Stan James' }, { name: 'ghost', isPseudo: true }],
  });
  assert.equal(p.gate, false, 'a pseudo participant must not trip the third-person gate');
});

test('respondWhenUnnamed defaults to speaking, and can be turned off', () => {
  assert.equal(buildResponsePolicy({ botName: 'J', participants: CALL }).respondWhenUnnamed, true);
  assert.equal(
    buildResponsePolicy({ botName: 'J', participants: CALL, respondWhenUnnamed: false }).respondWhenUnnamed,
    false,
  );
});

test('no participants and no name does not throw', () => {
  const p = buildResponsePolicy({});
  assert.equal(p.gate, false);
  assert.deepEqual(p.botNames, []);
  assert.deepEqual(p.otherNames, []);
});

// --- the voice model's own toolbox ------------------------------------------

const { VOICE_TOOLS } = require('../electron-app/realtime-session.js');

test('the voice gets an escape hatch, not a repo', () => {
  const names = VOICE_TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, ['ask_teammate', 'send_chat', 'write_whiteboard']);

  // The line is where the ARGUMENTS come from, not how hard the job is. Every
  // tool here can be called from what was just said in the room; none needs the
  // model to know something it has no way of knowing. A model that has invented
  // staff who do not exist must not be handed a lookup, because a fabricated
  // tool call has consequences a fabricated sentence does not.
  for (const t of VOICE_TOOLS) {
    assert.equal(t.type, 'function');
    assert.ok(t.description.length > 40, `${t.name} needs a real description`);
    assert.equal(t.parameters.type, 'object');
    assert.ok(t.parameters.required.length >= 1, `${t.name} needs a required arg`);
    for (const req of t.parameters.required) {
      assert.ok(t.parameters.properties[req], `${t.name}.${req} must be described`);
    }
  }
});

test('ask_teammate is described as the alternative to saying no', () => {
  const t = VOICE_TOOLS.find((x) => x.name === 'ask_teammate');
  // The failure this exists to prevent: the model confidently declining
  // something the BOT can do, and sending the user off to do it by hand.
  assert.match(t.description, /cannot do yourself/i);
  assert.match(t.description, /do not say it cannot be done/i);
});

test('write_whiteboard is fenced to content from the room', () => {
  const t = VOICE_TOOLS.find((x) => x.name === 'write_whiteboard');
  assert.match(t.description, /came out of this conversation/i);
  assert.match(t.description, /ask_teammate/, 'must point lookups at the slow half');
});

test('the prompt tells it the toolbox exists', () => {
  // A tool it is never told to reach for is a tool it will not reach for.
  assert.match(buildInstructions({ botName: 'Jimmy' }), /ask_teammate/);
});

// --- what the voice is told about the room ----------------------------------

test('the prompt explains the [room] notes it will receive', () => {
  // It hears ONE mixed track for the whole room, so without these notes it
  // cannot tell two people apart even in principle, and cannot know that
  // "Gabe, what do you think?" was not addressed to it.
  const t = buildInstructions({ botName: 'Jimmy' });
  assert.match(t, /\[room\]/);
  assert.match(t, /Never read one out/i, 'a note read aloud is worse than no note');
  assert.match(t, /not yours to answer/i);
});

test('the prompt authorises stalling out loud', () => {
  // Regression from the standalone prototype, which said "say a short filler
  // out loud first so the line is never silent" and did not survive the port.
  // The gap between calling ask_teammate and the answer arriving is seconds.
  const t = buildInstructions({ botName: 'Jimmy' });
  assert.match(t, /one second|let me look/i);
  assert.match(t, /narrated pause/i);
});

test('the prompt no longer duplicates the response gate', () => {
  // "say nothing unless you are addressed" was doing nothing once
  // create_response:false moved that decision to the app, and every clause
  // that does nothing crowds out one that does.
  assert.doesNotMatch(buildInstructions({}), /say nothing unless you are addressed/i);
});
