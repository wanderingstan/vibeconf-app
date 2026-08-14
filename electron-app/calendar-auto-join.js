// calendar-auto-join.js — pure matching/selection/eviction logic for
// calendar-triggered auto-join (#299).
//
// WHY a separate file: the polling/IO side (startCalendarPolling in main.js)
// needs Electron (websiteRequest, activateMeetProvider, joinMeetUrl, the
// Store), but the DECISION logic — "does this event belong to this bot?",
// "is it actionable right now?", "which one (if several) should we join?",
// "which dedupe entries are stale?" — has no Electron dependency at all. This
// mirrors call-media-merge.js's split from main.js: pure logic here, fully
// unit-testable with plain Node (see tests/calendar-auto-join.test.mjs);
// orchestration (the setInterval, the HTTP call, the actual join) stays in
// main.js.
//
// Two independent "invite" conventions, OR'd together (#299's final design):
//   1. calendarIdentityEmail (a per-profile pref, preferences-schema.js) is
//      present as a guest on the event — doesn't need to resolve to a real
//      mailbox, Google Calendar accepts arbitrary guest addresses.
//   2. `#vibeconf:<botName>` appears in the event's title or description.
//      Originally a bare `vibeconf` (no name) matched EVERY bot, but that was
//      a plain substring test — any event that merely mentioned the product
//      by name ("Vibeconferencing planning", "vibeconf-app release") matched
//      every single bot as a false positive. The leading `#` and required
//      `:<botName>` make this an unambiguous, deliberately-typed marker
//      instead of prose that can collide with it.

// Default lookahead: only ever treat an event as actionable if it starts
// within this many ms of `now`. Passed as a param (not baked into
// matchesCalendarEvent) specifically so the "is this actionable right now"
// check stays independently testable from wall-clock time — see
// isEventUpcoming below.
const DEFAULT_LOOKAHEAD_MS = 5 * 60 * 1000; // 5 minutes

// Default dedupe retention: how long a joined event id is remembered before
// evictStaleEventIds forgets it. 24h comfortably outlives any single day's
// recurring-instance window without letting the store grow unbounded.
const DEFAULT_DEDUPE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

const MEET_CODE_RE = /meet\.google\.com\/([a-z]+-[a-z]+-[a-z]+)/;

// Case-insensitive substring/equality helpers. Kept tiny and local rather
// than pulling in a string-utils dependency for two one-liners.
function norm(s) {
  return (s || '').toString().trim().toLowerCase();
}

// Trim + lowercase + collapse internal whitespace runs to one space — for
// comparing free-text (a bot name, an event's title/description) where
// "Mr  Roboto" and "Mr Roboto" should read as the same thing.
function normLoose(s) {
  return norm(s).replace(/\s+/g, ' ');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Does `calendarIdentityEmail` appear (case-insensitively) among the event's
// attendee addresses?
function matchesIdentityEmail(event, calendarIdentityEmail) {
  const email = norm(calendarIdentityEmail);
  if (!email) return false;
  const attendees = Array.isArray(event && event.attendees) ? event.attendees : [];
  return attendees.some((a) => norm(a) === email);
}

// Does `#vibeconf:<botName>` appear in the event's title or description?
// botName is free-text a user typed (often multiple words — "Mr Roboto"), not
// a fixed slug someone could look up, so this matches the LITERAL name
// directly rather than parsing a delimited token out of the text: build a
// regex from the bot's own (whitespace-collapsed, case-insensitive) name and
// look for it right after the tag. A negative lookahead stops a short name
// from matching inside a longer one ("Rex" inside "Rexford"). No bare/
// wildcard form: a bot name is always required, so this can never fire on an
// event that merely happens to mention the product.
function matchesVibeconfTag(event, botName) {
  const name = normLoose(botName);
  if (!name) return false;
  const haystack = normLoose(`${event && event.summary ? event.summary : ''} ${event && event.description ? event.description : ''}`);
  const pattern = escapeRegExp(name).replace(/ /g, '\\s+');
  const re = new RegExp(`#vibeconf:\\s*${pattern}(?![a-z0-9])`, 'i');
  return re.test(haystack);
}

// The main matching predicate. Pure, deterministic, no Electron/IO.
function matchesCalendarEvent(event, { calendarIdentityEmail, botName } = {}) {
  if (!event) return false;
  return matchesIdentityEmail(event, calendarIdentityEmail) || matchesVibeconfTag(event, botName);
}

// Has the CALENDAR OWNER (the human whose Google account the backend polls,
// i.e. the user of this machine) confirmed they're attending? Matching an
// event to a bot says "the bot was invited"; this says "the human is actually
// going" — and a bot should only auto-join when both are true (#: an invite
// the owner never accepted, or declined, shouldn't summon their bot).
//
// Reads `event.selfResponseStatus`, the Google Calendar responseStatus of the
// owner's own attendee row (`self: true`), surfaced by the backend:
//   'accepted'                → confirmed, OK to join.
//   'declined' | 'tentative' | 'needsAction' → not confirmed — don't join,
//     but DO still display the event (see selectUpcomingMatches) so the UI
//     can say the bot is waiting on the owner's RSVP.
//   null                      → the event has no self attendee row at all —
//     an event the owner created on their own calendar with no guest list.
//     It's their own event; treat as confirmed.
//   undefined (field absent)  → an older backend that doesn't send the field
//     yet. Fail open (today's behavior) rather than silently never joining
//     anything until the backend deploys.
function ownerHasConfirmed(event) {
  if (!event) return false;
  const status = event.selfResponseStatus;
  if (status === undefined || status === null) return true;
  return norm(status) === 'accepted';
}

// Milliseconds from `now` until `event.start` (negative if already started).
// null if start is missing/unparseable. Shared by isEventUpcoming's window
// check and main.js's join-scheduling (the actual setTimeout delay), so both
// compute the same thing one way.
function msUntilStart(event, now) {
  if (!event || !event.start) return null;
  const startMs = new Date(event.start).getTime();
  return Number.isNaN(startMs) ? null : startMs - now;
}

// Is `event.start` within `lookaheadMs` of `now`? Separate from the matching
// predicate on purpose (per the plan) so it can be tested independent of
// wall-clock time — `now` is always passed in, never read from Date.now()
// here.
//
// Deliberately one-sided in the past: an event that started a minute ago (a
// human just barely running late) is still worth joining; an event an hour
// out is not. Events already well in the past (e.g. yesterday's recurring
// instance the API still echoed back) are excluded via a small grace window
// so a bot doesn't auto-join something that's long over.
// `pastGraceMs` defaults to symmetric with `lookaheadMs` (as late as it is
// early) — right for the 5-minute join-scheduling check this was designed
// for. A caller using a much wider `lookaheadMs` purely for display (see
// selectUpcomingMatches below) should pass an explicit, much smaller
// `pastGraceMs` — otherwise a 24h lookahead would also mean showing an event
// as "upcoming" up to 24h AFTER it started.
function isEventUpcoming(event, now, lookaheadMs = DEFAULT_LOOKAHEAD_MS, pastGraceMs = lookaheadMs) {
  const delta = msUntilStart(event, now);
  if (delta === null) return false;
  return delta <= lookaheadMs && -delta <= pastGraceMs;
}

// The key an event is remembered under once it's been joined (or scheduled).
//
// NOT the bare event id: a recurring meeting's every occurrence can share one
// id — the backend maps our `id` from Google's `iCalUID`, which is constant
// across a whole series by design, and even Google's own instance ids are
// only per-occurrence when the caller expands with singleEvents=true. Keying
// dedupe on the id alone therefore means "joined the standup once" reads as
// "joined the standup forever": the real failure that motivated this
// (2026-08-11 — yesterday's 17:00 join was 23h30m old when today's 16:30
// instance came up, still inside the 24h retention, so it was skipped as
// already-handled and no bot ever joined).
//
// Pairing the id with the occurrence's own start time makes each occurrence a
// distinct thing to remember, which is what the dedupe actually means ("I
// already handled THIS meeting"). Parsed to epoch ms when parseable so two
// polls that render the same instant differently ("...Z" vs "...+00:00")
// still collapse to one key; falls back to the raw string otherwise.
//
// This stands on its own: even against a backend that hands back a
// series-constant id (an old deployment, a different client), a daily standup
// gets a fresh key every day.
function eventDedupeKey(event) {
  const id = (event && event.id) || '';
  const rawStart = (event && event.start) || '';
  const parsed = Date.parse(rawStart);
  const stamp = Number.isFinite(parsed) ? String(parsed) : norm(rawStart);
  return `${id}|${stamp}`;
}

// Evict dedupe entries older than maxAgeMs. `idMap` is a plain object
// { [eventDedupeKey]: joinedAtMs }. Returns a NEW object (no mutation) so
// callers can decide whether/when to persist it.
function evictStaleEventIds(idMap, now, maxAgeMs = DEFAULT_DEDUPE_MAX_AGE_MS) {
  const result = {};
  for (const [id, joinedAt] of Object.entries(idMap || {})) {
    if (typeof joinedAt === 'number' && now - joinedAt <= maxAgeMs) {
      result[id] = joinedAt;
    }
  }
  return result;
}

// Given the events a poll tick fetched, pick AT MOST ONE to join: the first
// (in list order) that is (a) within the lookahead window, (b) matches this
// bot's identity/tag, and (c) has no existing dedupe entry — looked up under
// eventDedupeKey(e), so `joinedIds` must be keyed the same way. Also reports how
// many OTHER events in the same tick also matched, so the caller can log a
// warning about the ones it deliberately didn't join (per the plan: only
// ever join one per tick, don't silently drop the rest either).
//
// Pure: takes `now` and `joinedIds` (the dedupe map) as params rather than
// touching the Store or the clock itself, so it's fully unit-testable.
function selectEventToJoin(events, { calendarIdentityEmail, botName, joinedIds, now, lookaheadMs = DEFAULT_LOOKAHEAD_MS } = {}) {
  const candidates = (events || []).filter((e) => e && e.id
    && isEventUpcoming(e, now, lookaheadMs)
    && matchesCalendarEvent(e, { calendarIdentityEmail, botName })
    && ownerHasConfirmed(e)
    && !(joinedIds && Object.prototype.hasOwnProperty.call(joinedIds, eventDedupeKey(e))));

  if (candidates.length === 0) return { event: null, extraMatchCount: 0 };
  return { event: candidates[0], extraMatchCount: candidates.length - 1 };
}

// All matching events within a WIDE lookahead window (default 24h), sorted
// soonest-first — for showing "your bot's upcoming meetings" in the UI. This
// is deliberately separate from selectEventToJoin: that one only ever picks
// a single actionable (within DEFAULT_LOOKAHEAD_MS) event to actually join;
// this one is for display only, never used to arm a join timer, so it
// doesn't touch the dedupe map — an event already joined/in-progress is
// still fine to list as "upcoming" a moment before its bot leaves it,
// callers that care can cross-reference joinedIds themselves. Same reasoning
// for ownerHasConfirmed: matches the owner hasn't RSVP'd to yet are still
// INCLUDED here (the join gate excludes them) so the UI can show them with a
// "waiting to see if you're attending" notice — callers annotate via
// ownerHasConfirmed(e) rather than this silently dropping them.
function selectUpcomingMatches(events, {
  calendarIdentityEmail, botName, now, lookaheadMs = 24 * 60 * 60 * 1000,
  // Small, NOT symmetric with the 24h lookahead — otherwise a meeting from
  // 20 hours ago would still read as "upcoming". Matches the join-gate's own
  // 5-minute grace, so a meeting that just started still shows briefly.
  pastGraceMs = DEFAULT_LOOKAHEAD_MS,
} = {}) {
  return (events || [])
    .filter((e) => e && e.id
      && isEventUpcoming(e, now, lookaheadMs, pastGraceMs)
      && matchesCalendarEvent(e, { calendarIdentityEmail, botName }))
    .sort((a, b) => msUntilStart(a, now) - msUntilStart(b, now));
}

// hangoutLink from the API is expected to already be a full
// https://meet.google.com/xxx-xxxx-xxx URL. Fall back to constructing one
// from a bare meet code if it's ever passed without the scheme/host — same
// code shape joinMeetUrl itself parses back out.
function resolveMeetUrl(hangoutLink) {
  if (!hangoutLink) return null;
  const trimmed = hangoutLink.toString().trim();
  if (MEET_CODE_RE.test(trimmed)) return trimmed;
  if (/^[a-z]+-[a-z]+-[a-z]+$/.test(trimmed)) return `https://meet.google.com/${trimmed}`;
  return null;
}

module.exports = {
  DEFAULT_LOOKAHEAD_MS,
  DEFAULT_DEDUPE_MAX_AGE_MS,
  matchesCalendarEvent,
  ownerHasConfirmed,
  isEventUpcoming,
  msUntilStart,
  eventDedupeKey,
  evictStaleEventIds,
  selectEventToJoin,
  selectUpcomingMatches,
  resolveMeetUrl,
};
