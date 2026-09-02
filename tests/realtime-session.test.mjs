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
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
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
  assert.deepEqual(names, ['ask_teammate', 'extend_session', 'send_chat', 'write_whiteboard']);

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

// --- one command, two contracts ---------------------------------------------
//
// /realtime-call was a stopgap. Which kind of bot this is belongs to the BOT,
// not to how you started it, so /join-call branches on its realtimeVoice
// preference. The agent is handed one contract or the other and never both.

test('join_call answers a realtime bot with a different contract', () => {
  const src = readFileSync(join(root, 'mcp-server/server.js'), 'utf8');

  // The branch exists on both paths: a fresh join AND an already-in-call
  // rejoin. Missing the second is the subtle one — a reconnecting agent would
  // silently get the speak-loop contract for a bot that has no voice of its own.
  const branches = [...src.matchAll(/data\.results\.join\.realtimeVoice/g)];
  assert.ok(branches.length >= 2, `expected fresh + already-in-call branches, found ${branches.length}`);

  const fn = src.slice(src.indexOf('function realtimeJoinInstructions'));
  // It must not hand a realtime agent the verb it does not own.
  assert.match(fn, /You never speak/i);
  assert.match(fn, /Do not call/i);
  // And it must carry the things that only exist in this mode.
  for (const t of ['brief', 'hold_voice', 'THE VOICE ASKED YOU FOR THIS']) {
    assert.ok(fn.includes(t), `realtime join instructions must mention ${t}`);
  }
});

test('the stopgap command is gone, not just unused', () => {
  // A slash command that still installs and quietly does the wrong thing is
  // worse than one that is absent: it would join with the realtime prompt
  // whatever the bot is actually set to.
  assert.equal(existsSync(join(root, 'mcp-server/realtime-call-skill.md')), false);
  const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
  assert.doesNotMatch(main, /realtime-call-skill\.md/);
  // And copies already on disk are removed rather than left behind.
  assert.match(main, /skills', 'realtime-call'/);
  assert.match(main, /rmSync/);
});

test('brief and hold_voice stay reachable from /join-call', () => {
  // /join-call now drives realtime bots too, so its whitelist has to carry the
  // tools that mode depends on or they are silently unreachable.
  const skill = readFileSync(join(root, 'mcp-server/join-call-skill.md'), 'utf8');
  for (const t of ['brief', 'hold_voice']) {
    assert.match(skill, new RegExp(`mcp__vibeconferencing__${t}\\b`), `${t} must be whitelisted`);
  }
});

// --- the time limit ---------------------------------------------------------
//
// Realtime audio bills per minute in BOTH directions for as long as the session
// is open, including while nobody is talking. A bot forgotten in an empty room
// is a meter left running, and it is the only failure here that stays invisible
// until the bill arrives.

const { realtimeBudget } = require('../electron-app/realtime-session.js');
const T0 = 1_700_000_000_000;
const at = (mins, over = {}) =>
  realtimeBudget({ startedAt: T0, now: T0 + mins * 60000, maxMinutes: 60, ...over });

test('no cap means no cap', () => {
  for (const max of [0, undefined, null, NaN, -5]) {
    const b = realtimeBudget({ startedAt: T0, now: T0 + 99999 * 60000, maxMinutes: max });
    assert.equal(b.capped, false, `maxMinutes=${max}`);
    assert.equal(b.expired, false);
    assert.equal(b.shouldWarn, false);
  }
});

test('warns once, five minutes out, and not before', () => {
  assert.equal(at(54).shouldWarn, false, 'six minutes left is not yet');
  assert.equal(at(56).shouldWarn, true, 'four minutes left is');
});

test('a warning does not repeat every tick', () => {
  const first = at(56);
  assert.equal(first.shouldWarn, true);
  // Having warned for THIS deadline, the next tick must stay quiet.
  assert.equal(at(57, { warnedAt: first.warnKey }).shouldWarn, false);
  assert.equal(at(59, { warnedAt: first.warnKey }).shouldWarn, false);
});

test('expiry is the boundary, not a range', () => {
  assert.equal(at(59.9).expired, false);
  assert.equal(at(60).expired, true, 'exactly at the limit is over it');
  assert.equal(at(75).expired, true);
});

test('an extension buys time AND a fresh warning', () => {
  const warned = at(56).warnKey;
  // Extended by 15 minutes at the 56 minute mark.
  const ext = 15 * 60000;
  assert.equal(at(58, { extraMs: ext, warnedAt: warned }).expired, false, 'still running');

  // The old warnedAt belongs to the OLD deadline, so the new one can warn again.
  // Without this an extension would buy silence rather than time: the bot would
  // stop a second time with no warning at all.
  const near = at(71, { extraMs: ext, warnedAt: warned });
  assert.equal(near.shouldWarn, true, 'the new deadline announces itself too');
  assert.notEqual(near.warnKey, warned, 'and it is a different deadline');
});

test('a cap shorter than the warning lead just stops', () => {
  // Warning instantly and then stopping is noise, not notice.
  const b = realtimeBudget({ startedAt: T0, now: T0 + 60000, maxMinutes: 3 });
  assert.equal(b.shouldWarn, false);
  assert.equal(b.expired, false);
  assert.equal(realtimeBudget({ startedAt: T0, now: T0 + 4 * 60000, maxMinutes: 3 }).expired, true);
});

test('minutesLeft rounds up, so it never reads zero while running', () => {
  assert.equal(at(59.5).minutesLeft, 1, 'thirty seconds left is "1 minute", not "0"');
  assert.equal(at(60).minutesLeft, 0);
});

test('extend_session is fenced to an explicit request', () => {
  const t = VOICE_TOOLS.find((x) => x.name === 'extend_session');
  assert.ok(t, 'the voice can extend its own session when asked');
  // The hazard is a model that extends because the conversation feels useful.
  // The person paying is not necessarily the person talking.
  assert.match(t.description, /ONLY when somebody then actually asks/i);
  assert.match(t.description, /costs money by the minute/i);
});

test('the default cap clears a scheduled hour, and its overrun', () => {
  // Not a round number on purpose. Warning five minutes out, a 60 minute cap
  // fires at 55 — the wrap-up of every scheduled one-hour call, with every
  // realtime bot in every such call saying it at the same moment. 70 warns at
  // 65, in the awkward minutes of a call running over, when the clock is
  // already what everyone is worried about.
  const { PREFERENCES } = require('../electron-app/preferences-schema.js');
  const cap = PREFERENCES.realtimeMaxMinutes.default;

  const warnsAt = (mins) => {
    for (let m = 0; m <= mins; m += 0.5) {
      if (realtimeBudget({ startedAt: T0, now: T0 + m * 60000, maxMinutes: cap }).shouldWarn) return m;
    }
    return null;
  };

  assert.ok(warnsAt(cap) > 60, `must not warn during a scheduled hour (warns at ${warnsAt(cap)})`);
  assert.ok(warnsAt(cap) >= 68, 'and should clear a few minutes of overrun too');
  assert.equal(realtimeBudget({ startedAt: T0, now: T0 + 60 * 60000, maxMinutes: cap }).expired, false,
    'an hour-long call must never be cut off');
});
