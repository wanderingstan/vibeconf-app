// supervisor.js — the decision core of the fleet supervisor (#301).
//
// The gap #301 names: with every bot window closed, ZERO JavaScript runs for
// this app. `window-all-closed` quits (main.js), the single-instance lock only
// covers the default profile, and there is no tray, login item or daemon. So a
// calendar auto-join cannot fire, because nothing is alive to notice the time.
//
// docs/multi-bot-architecture.md settled the shape on 2026-08-24 — build the
// supervisor, don't merge the processes — and lists the eight open issues that
// are all restatements of "nothing owns the fleet" (#511, #517, #518, #201,
// #218, #233, #301, #515). This module is the first piece of it.
//
// ── Why this file has no Electron in it ──────────────────────────────────────
//
// `main.js` is 13,599 lines built around one implicit bot: 101 module-level
// `let`s, 142 IPC handlers that mean "the bot in this process", and a
// process-global `app.setPath('userData')` everything hangs off. A supervisor
// mode bolted into that inherits all of it, and inherits the thing it is
// supposed to be immune to — a bot's own state.
//
// Everything the decision actually needs is already pure Node:
//
//     store.js             config.json, no Electron import
//     profile-manager.js   reads any profile's config off disk
//     calendar-auto-join.js  260 lines of pure matchers
//
// So the supervisor's brain is a function of (profiles on disk, events, clock,
// what is already running) with no ambient state at all — which is why it can be
// tested by `node --test` without launching an app.

const {
  matchesCalendarEvent, ownerHasConfirmed, isEventUpcoming,
  msUntilStart, eventDedupeKey, evictStaleEventIds,
} = require('./calendar-auto-join.js');

// Decide which profiles to wake, given everything knowable at one tick.
//
// Returns the wakeups plus the NEXT dedupe map, rather than mutating anything:
// the caller owns persistence, and a decision that writes nothing can be tested
// by reading its return value.
//
// `profiles`: [{ name, calendarIdentityEmail, botName }] — from
//   profileManager.listProfileNames + readConfigFields, no live process needed.
// `running`:  Set of profile names that already have an instance up.
// `launched`: the persisted dedupe map, `{ '<eventDedupeKey>:<profile>': ts }`.
function decideWakeups({ profiles = [], events = [], now = 0, running = new Set(), launched = {} } = {}) {
  // Evict here rather than at the call site so the map cannot grow without
  // bound while the machine sits idle for a week — which, for a process whose
  // entire job is to be always-on, is the normal case rather than the edge one.
  const next = evictStaleEventIds({ ...(launched || {}) }, now);
  const wakeups = [];

  for (const profile of profiles) {
    if (!profile || !profile.name) continue;

    // A RUNNING profile is deliberately skipped, and this is the one rule that
    // differs from the in-bot version of this logic
    // (checkOtherProfilesForCalendarMatch in main.js).
    //
    // That version runs inside a bot and asks "does this event belong to one of
    // my SIBLINGS", so waking a running sibling is a focus and roughly free.
    // The supervisor is nobody's bot, so the same call would fire for a profile
    // that is already awake and already polling this very event for itself —
    // producing a stolen window focus, and two independent things racing to
    // join one meeting.
    //
    // The supervisor's job is only what nothing else covers. A bot that is
    // running looks after itself.
    if (running.has(profile.name)) continue;

    // Nothing to match against — no placeholder address and no name for the
    // `#vibeconf:<name>` tag — so this profile cannot be the subject of any
    // event. Skipped before the event loop because it is a property of the
    // profile, not of any one event.
    if (!profile.calendarIdentityEmail && !profile.botName) continue;

    let best = null;
    for (const event of events) {
      if (!event || !event.id) continue;
      if (!isEventUpcoming(event, now)) continue;
      if (!matchesCalendarEvent(event, {
        calendarIdentityEmail: profile.calendarIdentityEmail,
        botName: profile.botName,
      })) continue;
      // The same owner-RSVP gate the local join path applies: do not boot a
      // whole profile for a meeting its owner has not said they are attending.
      // If they accept later, a subsequent tick wakes it then.
      if (!ownerHasConfirmed(event)) continue;

      // Keyed by eventDedupeKey (id + occurrence start), never the bare event
      // id — a recurring series shares one id, so "handled once" would
      // otherwise mean "never again". Suffixed with the profile so two
      // profiles invited to the same meeting do not cancel each other out.
      const key = `${eventDedupeKey(event)}:${profile.name}`;
      if (Object.prototype.hasOwnProperty.call(next, key)) continue;

      // At most ONE wakeup per profile per tick, and the soonest one wins.
      // Waking a profile twice in a tick is at best a redundant focus, and the
      // second event is not lost: it is simply not marked handled, so the next
      // tick reconsiders it against a profile that is by then running.
      const delta = msUntilStart(event, now);
      if (best === null || delta < best.delta) best = { event, key, delta };
    }

    if (!best) continue;
    next[best.key] = now;
    wakeups.push({ profile: profile.name, event: best.event, dedupeKey: best.key, msUntilStart: best.delta });
  }

  return { wakeups, launched: next };
}

// Read every locally-configured profile as the decision wants it — flat records,
// off disk, with no running instance required. Injectable so the tests can
// describe a fleet without building one on the filesystem.
function readFleet(profilesRoot, { profileManager = require('./profile-manager.js'), path = require('path') } = {}) {
  let names = [];
  try { names = profileManager.listProfileNames(profilesRoot); } catch { return []; }
  const fleet = [];
  for (const name of names) {
    // Per profile, not around the loop: one unreadable config.json must not
    // hide every profile after it in the listing. A supervisor that silently
    // stops watching the rest of the fleet because one folder is malformed is
    // the failure mode this whole issue is about.
    try {
      const fields = profileManager.readConfigFields(path.join(profilesRoot, name));
      fleet.push({
        name,
        calendarIdentityEmail: fields.calendarIdentityEmail || '',
        botName: fields.botName || '',
        // The small PNG each bot renders of its own avatar (a data: URL). Kept
        // off /api/instances: the window wants faces, the agents only want ports.
        avatarThumb: fields.avatarThumb || null,
      });
    } catch { /* skip this one, keep the fleet */ }
  }
  return fleet;
}

// The Meet calls open in the user's browser, as the running bots report them.
//
// Every idle bot scans the browser's tabs and publishes what it found
// (detectedMeetUrls on /api/sync/no-room), so with three bots up the same tab
// arrives three times: merged here by meet code, first-seen order kept so the
// window's pick does not jump around between refreshes.
//
// Only IDLE bots count. A bot stops scanning when it enters a call, and does
// not clear its last result, so an in-call bot's list is a stale snapshot of
// the moment it joined. Interim, until the scan itself moves into the
// supervisor (#301 step 3) and there is exactly one, always-current source.
function detectedCalls(instances) {
  const byCode = new Map();
  for (const inst of instances || []) {
    if (!inst || (inst.callStatus && inst.callStatus !== 'idle')) continue;
    for (const raw of inst.detectedMeetUrls || []) {
      const code = String(raw).match(/meet\.google\.com\/([a-z]+-[a-z]+-[a-z]+)/)?.[1];
      if (code && !byCode.has(code)) byCode.set(code, { code, url: `https://meet.google.com/${code}` });
    }
  }
  return [...byCode.values()];
}

// Call or Add on a CLOSED bot: launch it, wait until it answers, then act.
//
// Launch-then-HTTP rather than a new launch flag, so a closed bot and a running
// one take the same /api/call/* path and cannot drift apart. It is safe to act
// the moment the bot answers: main.js awaits its local server's start and then
// creates the window in the same tick, so no request is handled before there
// is a window to join from (the same point --meet-url auto-joins at).
//
// "Answers" means the PROFILE is found running, not that its registered port
// is open: the default bot can land on a port other than 7865, and a stale
// process on the registered port is exactly the confusion #517 was about.
//
// Everything is injected so the timing can be tested without launching apps.
async function launchThenAct({
  isRunning, launch, act,
  timeoutMs = 60_000, intervalMs = 1000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
}) {
  if (await isRunning()) return act();
  const launched = await launch();
  if (!launched?.ok) return launched || { ok: false, error: 'launch failed' };
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(intervalMs);
    if (await isRunning()) return act();
  }
  return { ok: false, error: `the bot did not start within ${Math.round(timeoutMs / 1000)}s` };
}

module.exports = { decideWakeups, readFleet, detectedCalls, launchThenAct };
