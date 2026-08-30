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
  assert.ok(text.split(/\s+/).length < 120, 'instructions should stay under ~120 words');
  assert.match(buildInstructions({}), /^You are a voice teammate/);
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
