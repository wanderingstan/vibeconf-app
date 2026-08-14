// guest-partition-fallback.test.mjs — the #347 guest fallback, and the #282
// invariants it is not allowed to break.
//
// #347: when Google blocks the bot's own account with an identity challenge
// (#346), fall back to joining the meeting from a cookie-free partition. A
// partition holds cookies and caches and nothing else — botName, voice,
// CLAUDE.md, the agent workdir and logs all live in the profile's userData — so
// the guest bot is the same bot, just not signed in.
//
// The danger is not the feature, it is the mechanism. #282 collapsed three
// partitions into one precisely to stop runtime identity swapping, and gave two
// reasons. This file pins both, because they are exactly what a later
// well-meaning "just make the partition a variable" refactor would undo:
//
//   1. Slack must never follow the swap. The old design needed a third
//      partition only because swapping dragged Slack's login around.
//   2. The identity IPCs must report the PROFILE's account, not the active
//      partition, or one guest fallback makes the panel claim the bot is
//      permanently signed out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const main = fs.readFileSync(path.join(__dirname, '../electron-app/main.js'), 'utf-8');

// The body of a named function, for scoping assertions to one call site.
function bodyOf(signature) {
  const i = main.indexOf(signature);
  assert.ok(i > 0, `expected to find ${signature}`);
  const rest = main.slice(i);
  return rest.slice(0, rest.indexOf('\n}\n'));
}

test('there is a separate, cookie-free guest partition', () => {
  assert.match(main, /const GUEST_PARTITION = 'persist:guest'/);
  // Distinct from home, or the fallback would carry the blocked account's
  // cookies straight back into the retry and change nothing.
  assert.match(main, /const SESSION_PARTITION = 'persist:session'/);
});

test('#282: Slack never follows the partition swap', () => {
  // The one constraint most likely to be broken later. Slack shares the home
  // partition and must stay pinned to it by NAME, never via the mutable
  // binding — that coupling is what forced the old three-partition design.
  const slackBody = bodyOf('function activateSlackProvider(');
  assert.doesNotMatch(slackBody, /activeMeetPartition/,
    'activateSlackProvider must name SESSION_PARTITION literally, never the swappable binding');
  // Not vacuous: it really does hand a partition to the Slack surface, and that
  // one has to be home.
  assert.match(slackBody, /partition: SESSION_PARTITION/);

  assert.doesNotMatch(bodyOf('function setupSlackRoom('), /activeMeetPartition/);
});

test('#347: the swappable binding is confined to the Meet join path', () => {
  // The containment invariant behind both #282 guards above, stated positively
  // so a NEW use of activeMeetPartition anywhere else fails here rather than
  // silently widening the swap's blast radius.
  const allowed = [
    /^let activeMeetPartition = SESSION_PARTITION;$/,          // the declaration
    /^\s*ensureMeetSessionConfigured\(activeMeetPartition\);$/, // provider + join
    /^\s*meetView = createMeetView\(activeMeetPartition\);$/,
    /^\s*activeMeetPartition = guestFallback \? GUEST_PARTITION : SESSION_PARTITION;$/,
    /^\s*const sess = session\.fromPartition\(activeMeetPartition\);$/,
    /^\s*await clearMeetIdentityCache\(activeMeetPartition\);$/,
    /^\s*if \(activeMeetPartition === GUEST_PARTITION && !guestLobbyNotified\) \{$/,
  ];
  const uses = main.split('\n').filter((l) => l.includes('activeMeetPartition') && !l.trim().startsWith('//'));
  assert.ok(uses.length >= 7, `expected the join path to use it; found ${uses.length}`);
  for (const line of uses) {
    assert.ok(allowed.some((re) => re.test(line)),
      `activeMeetPartition used outside the Meet join path: ${line.trim()}`);
  }
});

test('#282: the identity IPCs report the profile, not the active partition', () => {
  // get-meet-mode / get-meet-account-email / meet-sign-out-bot answer "who is
  // this bot signed in as", which is a PROFILE property. Reading the active
  // partition would make a single guest fallback look like a permanent
  // sign-out in the panel, and meet-sign-out-bot would clear the wrong jar.
  for (const handler of ['get-meet-mode', 'get-meet-account-email', 'meet-sign-out-bot', 'get-slack-mode']) {
    const i = main.indexOf(`'${handler}'`);
    assert.ok(i > 0, `expected the ${handler} handler`);
    const body = main.slice(i, i + 900);
    assert.doesNotMatch(body, /activeMeetPartition/,
      `${handler} must read SESSION_PARTITION — it reports the profile's identity`);
  }
});

test('the guest partition is only ever reached by an explicit fallback', () => {
  const body = bodyOf('async function _openMeetInFreshView(meetUrl');
  // Set per join from the parameter, never toggled-and-remembered. This is what
  // stops the fallback becoming sticky regardless of how the previous call
  // ended (host-ended, crash, forced idle).
  assert.match(body, /activeMeetPartition = guestFallback \? GUEST_PARTITION : SESSION_PARTITION/);
  // The guest partition needs its own CSP/permission/display-media wiring.
  assert.match(body, /ensureMeetSessionConfigured\(activeMeetPartition\)/);
  // The view and the signed-in probe both follow the active partition; the
  // probe returning false on a cookie-free jar is the entire mechanism.
  assert.match(body, /session\.fromPartition\(activeMeetPartition\)/);
  assert.match(body, /createMeetView\(activeMeetPartition\)/);
});

test('an ordinary join always resets to the home partition', () => {
  const body = bodyOf('async function _openMeetInFreshView(meetUrl');
  // No branch may leave a previous fallback in place for a normal join.
  assert.doesNotMatch(body, /if \(guestFallback\) activeMeetPartition/,
    'the partition must be assigned unconditionally, not only in the fallback branch');
  assert.match(body, /guestFallbackTriedFor = null/,
    "a fresh join re-arms the fallback, so tomorrow's instance of a recurring room can try again");
});

test('a blocked join falls back exactly once, not in a loop', () => {
  const i = main.indexOf("landing === 'sign-in'");
  assert.ok(i > 0, 'expected the #346 sign-in landing branch');
  const branch = main.slice(i, i + 2500);
  assert.match(branch, /guestFallbackTriedFor !== currentMeetUrl/,
    'a guest attempt that also lands on sign-in must not retry forever');
  assert.match(branch, /loadMeetURL\(currentMeetUrl, \{ guestFallback: true \}\)/);
});

test('the lobby is reported, and only for guests', () => {
  // A guest is normally not auto-admitted, so waiting is the expected resting
  // place of a fallback join rather than a fault. It is worth surfacing because
  // it is actionable by someone else: the host can admit the bot without
  // touching its password.
  const i = main.indexOf("setCallStatus('waiting-to-be-admitted')");
  assert.ok(i > 0, 'expected the waiting-to-be-admitted transition');
  const branch = main.slice(i, i + 900);
  assert.match(branch, /activeMeetPartition === GUEST_PARTITION/,
    'an ordinary lobby wait must stay silent, or every normal call notifies');
  assert.match(branch, /guestLobbyNotified/, 'one notice per fallback, not one per pre-join poll');
  assert.match(branch, /broadcastError\(/, 'the operator hears it; the bot has no voice from the lobby');
});
