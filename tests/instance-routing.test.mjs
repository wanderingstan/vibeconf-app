// instance-routing.test.mjs — which running app instance (profile) a name targets,
// and whether that name is an ADDRESS or a LABEL.
//
// The motivating setup: several profiles (alice1/alice2/alice3) that deliberately
// share ONE display name ("Alice"), each driving its own call from its own
// terminal. That breaks three ways without the rules pinned here — the profile
// name lands on the Meet tile, the shared display name silently routes every
// terminal to the lowest port, and a pinned terminal starts demanding a name it
// was already configured with.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveInstance, joinNameFromRouting } from '../mcp-server/instance-routing.js';

const inst = (port, profile, botName, extra = {}) => ({
  port,
  baseUrl: `http://127.0.0.1:${port}`,
  profile,
  botName,
  configuredBotName: botName,
  callStatus: null,
  roomId: null,
  ...extra,
});

// The three-Alices fleet: distinct profiles, identical display name.
const ALICES = [inst(7870, 'alice1', 'Alice'), inst(7871, 'alice2', 'Alice'), inst(7872, 'alice3', 'Alice')];

test('a profile name routes to that profile and is flagged as an address', () => {
  const r = resolveInstance('alice2', ALICES);
  assert.equal(r.instance.port, 7871);
  // 'profile' is what tells join_call NOT to type "alice2" into Meet.
  assert.equal(r.matchedBy, 'profile');
});

test('profile matching is case-insensitive and ignores surrounding space', () => {
  assert.equal(resolveInstance('  ALICE3 ', ALICES).instance.port, 7872);
});

test('profile wins over a display name that matches a different instance', () => {
  // Someone names a profile after another bot; the address must still win.
  const fleet = [inst(7870, 'default', 'alice2'), inst(7871, 'alice2', 'Alice')];
  const r = resolveInstance('alice2', fleet);
  assert.equal(r.instance.port, 7871, 'profile alice2, not the bot named alice2');
  assert.equal(r.matchedBy, 'profile');
});

test('a display name shared by several instances errors instead of silently picking one', () => {
  // The old first-hit .find() sent all three terminals to :7870 — and because a
  // join with a different room switches rooms, that DROPPED alice1's live call.
  const r = resolveInstance('Alice', ALICES);
  assert.ok(r.error, 'must not resolve');
  assert.ok(/alice1/.test(r.error) && /alice3/.test(r.error), 'lists the candidates');
  assert.ok(/PROFILE/i.test(r.error), 'says how to disambiguate');
  assert.equal(r.instance, undefined);
});

test('a display name unique among the running instances still routes', () => {
  const fleet = [inst(7870, 'alice1', 'Alice'), inst(7871, 'bob-profile', 'Bob')];
  const r = resolveInstance('Bob', fleet);
  assert.equal(r.instance.port, 7871);
  assert.equal(r.matchedBy, 'botName');
});

test('an unknown name with one instance running is a display-name override', () => {
  const r = resolveInstance('Pepper', [inst(7865, 'default', 'Jimmy')]);
  assert.equal(r.instance.port, 7865);
  assert.equal(r.matchedBy, 'displayName', 'the sole-instance case still lets you rename');
});

test('an unknown name with several running errors and lists the profiles', () => {
  const r = resolveInstance('Pepper', ALICES);
  assert.ok(r.error);
  assert.ok(/alice1/.test(r.error));
});

test('no name, one instance: that one, under its own name', () => {
  const r = resolveInstance(null, [inst(7865, 'default', 'Jimmy')]);
  assert.equal(r.instance.port, 7865);
  assert.equal(r.matchedBy, 'sole');
});

test('no name, several running, session pinned: the pinned instance', () => {
  // The app writes VIBECONF_BASE_URL into each profile's own MCP config, so a
  // profile's own terminal knows which instance it belongs to. Starting a
  // SIBLING profile must not make that terminal ask which one you meant.
  const r = resolveInstance(null, ALICES, { pinnedPort: 7872 });
  assert.equal(r.instance.port, 7872);
  assert.equal(r.matchedBy, 'pinned');
});

test('no name, several running, not pinned: still asks which profile', () => {
  const r = resolveInstance(null, ALICES);
  assert.ok(r.error);
  assert.ok(/alice2/.test(r.error));
});

test('no name, several running, pinned to an instance that is not running: asks', () => {
  // Stale pin (the profile was quit). Guessing here would drive someone else's bot.
  const r = resolveInstance(null, ALICES, { pinnedPort: 7899 });
  assert.ok(r.error);
});

test('an explicit name still beats the pin', () => {
  const r = resolveInstance('alice1', ALICES, { pinnedPort: 7872 });
  assert.equal(r.instance.port, 7870);
});

test('nothing discovered leaves BASE_URL alone', () => {
  // Discovery finding nothing must not break single-instance setups whose port
  // is only known from the env — the caller keeps its current BASE_URL.
  assert.deepEqual(resolveInstance('Alice', []), { keep: true });
  assert.deepEqual(resolveInstance(null, []), { keep: true });
});

// ── the display name a join lands on ─────────────────────────────────────────

test('addressing a profile never renames it — three Alices stay Alice', () => {
  // The whole point: alice1/alice2/alice3 each join their own call as "Alice".
  for (const profile of ['alice1', 'alice2', 'alice3']) {
    const routed = resolveInstance(profile, ALICES);
    assert.equal(joinNameFromRouting(profile, routed), 'Alice', `${profile} must not wear its profile name`);
  }
});

test('a profile with no display name of its own falls back to the argument', () => {
  const fleet = [inst(7870, 'alice1', null, { configuredBotName: null }), inst(7871, 'alice2', 'Alice')];
  const routed = resolveInstance('alice1', fleet);
  assert.equal(joinNameFromRouting('alice1', routed), 'alice1', 'better than "Unnamed bot"');
});

test('a profile-matched join prefers the CONFIGURED name over a past call override', () => {
  // botName can be currentCallBotName — a per-call override from a previous call.
  // The profile's panel name is what it should come back as.
  const fleet = [inst(7870, 'alice1', 'Pepper', { configuredBotName: 'Alice' })];
  const routed = resolveInstance('alice1', fleet);
  assert.equal(joinNameFromRouting('alice1', routed), 'Alice');
});

test('a one-off display name is still honoured on a sole instance', () => {
  const fleet = [inst(7865, 'default', 'Jimmy')];
  const routed = resolveInstance('Pepper', fleet);
  assert.equal(routed.matchedBy, 'displayName');
  assert.equal(joinNameFromRouting('Pepper', routed), 'Pepper', 'renaming by arg must keep working');
});

test('no name given joins under the routed instance configured name', () => {
  const routed = resolveInstance(null, ALICES, { pinnedPort: 7871 });
  assert.equal(joinNameFromRouting(null, routed), 'Alice');
});

test('no routing information yields null so the caller falls back', () => {
  assert.equal(joinNameFromRouting(null, { ok: true }), null);
  assert.equal(joinNameFromRouting('  ', {}), null);
  // An arg with nothing discovered is still a display name (the old env-only path).
  assert.equal(joinNameFromRouting('Pepper', { ok: true }), 'Pepper');
});

test('instances with no display name are still addressable by profile', () => {
  const fleet = [inst(7870, 'alice1', null), inst(7871, 'alice2', null)];
  const r = resolveInstance('alice1', fleet);
  assert.equal(r.instance.port, 7870);
  // ...and a blank display name never matches the empty-ish name branch.
  assert.ok(resolveInstance('', fleet).error, 'blank name with several running is ambiguous');
});

// ── #517: a session's working directory outranks the port its config baked ───
// Live, 2026-08-24: Seth started Buddy in its own terminal. Buddy spoke and the
// words came out of PEPPER's Meet tile. Two healthy apps, two correct ports,
// one terminal addressing the wrong one — because a hand-started terminal picks
// up the user-scoped ~/.claude.json entry, which bakes the PRIMARY app's port.
// Every call succeeded, which is what made it expensive to find.

const two = [
  { port: 7865, baseUrl: 'http://127.0.0.1:7865', profile: 'default', botName: 'Pepper',
    configuredBotName: 'Pepper', agentWorkdir: '/Users/x/App Support/VC/profiles/Default/agent' },
  { port: 7866, baseUrl: 'http://127.0.0.1:7866', profile: 'bot2', botName: 'Buddy',
    configuredBotName: 'Buddy', agentWorkdir: '/Users/x/App Support/VC/profiles/bot2/agent' },
];

test('a session running in a bot’s folder routes to THAT bot, not the baked port', () => {
  const r = resolveInstance(null, two, {
    pinnedPort: 7865,                                             // inherited Pepper's port
    cwd: '/Users/x/App Support/VC/profiles/bot2/agent',           // but it IS Buddy
  });
  assert.equal(r.matchedBy, 'workdir');
  assert.equal(r.instance.port, 7866, 'Buddy must drive Buddy, not Pepper');
});

test('a subdirectory of the bot’s folder still identifies the bot', () => {
  const r = resolveInstance(null, two, {
    pinnedPort: 7865,
    cwd: '/Users/x/App Support/VC/profiles/bot2/agent/calls/abc-20260824T000000Z',
  });
  assert.equal(r.instance.port, 7866);
});

test('the pin still wins when the cwd says nothing', () => {
  // An app-launched session in an unrelated directory is exactly what the pin
  // is for — this must not regress it.
  const r = resolveInstance(null, two, { pinnedPort: 7866, cwd: '/tmp/somewhere-else' });
  assert.equal(r.matchedBy, 'pinned');
  assert.equal(r.instance.port, 7866);
});

test('an explicit name still beats both', () => {
  // Addressing by profile is the unambiguous form and must stay authoritative.
  const r = resolveInstance('default', two, { pinnedPort: 7866, cwd: '/Users/x/App Support/VC/profiles/bot2/agent' });
  assert.equal(r.matchedBy, 'profile');
  assert.equal(r.instance.port, 7865);
});

test('two instances claiming one folder resolve to neither', () => {
  // Guessing between them would reintroduce the bug with extra steps.
  const clashing = [
    { ...two[0], agentWorkdir: '/shared/agent' },
    { ...two[1], agentWorkdir: '/shared/agent' },
  ];
  const r = resolveInstance(null, clashing, { pinnedPort: 7865, cwd: '/shared/agent' });
  assert.equal(r.matchedBy, 'pinned', 'falls back to the pin rather than picking one');
});

test('a trailing slash is not a different folder', () => {
  const r = resolveInstance(null, two, {
    pinnedPort: 7865,
    cwd: '/Users/x/App Support/VC/profiles/bot2/agent/',
  });
  assert.equal(r.instance.port, 7866);
});
