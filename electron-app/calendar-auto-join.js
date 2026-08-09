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
//   2. `vibeconf` (any bot) or `vibeconf:<botName>` (this bot specifically)
//      appears in the event's title or description.

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

// Does `calendarIdentityEmail` appear (case-insensitively) among the event's
// attendee addresses?
function matchesIdentityEmail(event, calendarIdentityEmail) {
  const email = norm(calendarIdentityEmail);
  if (!email) return false;
  const attendees = Array.isArray(event && event.attendees) ? event.attendees : [];
  return attendees.some((a) => norm(a) === email);
}

// Does a bare `vibeconf` (any bot) or `vibeconf:<botName>` (this bot,
// case-insensitive/trim-normalized — botName is free-text display text, not
// a fixed slug, so nothing fancier than lowercase+trim is warranted) appear
// in the event's title or description?
function matchesVibeconfTag(event, botName) {
  const haystack = `${event && event.summary ? event.summary : ''} ${event && event.description ? event.description : ''}`.toLowerCase();
  if (!haystack.includes('vibeconf')) return false;
  // Bare "vibeconf" anywhere (not immediately followed by ":<something>")
  // targets every bot. "vibeconf:<slug>" targets only the bot whose botName
  // normalizes to that slug.
  const taggedMatch = haystack.match(/vibeconf:([^\s,;)]+)/i);
  if (!taggedMatch) {
    // Plain "vibeconf" mention with no ":slug" suffix — matches any bot.
    return true;
  }
  const slug = norm(taggedMatch[1]);
  return slug === norm(botName);
}

// The main matching predicate. Pure, deterministic, no Electron/IO.
function matchesCalendarEvent(event, { calendarIdentityEmail, botName } = {}) {
  if (!event) return false;
  return matchesIdentityEmail(event, calendarIdentityEmail) || matchesVibeconfTag(event, botName);
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

// Evict dedupe entries older than maxAgeMs. `idMap` is a plain object
// { [eventId]: joinedAtMs }. Returns a NEW object (no mutation) so callers
// can decide whether/when to persist it.
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
// bot's identity/tag, and (c) has no existing dedupe entry. Also reports how
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
    && !(joinedIds && Object.prototype.hasOwnProperty.call(joinedIds, e.id)));

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
// callers that care can cross-reference joinedIds themselves.
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
  isEventUpcoming,
  msUntilStart,
  evictStaleEventIds,
  selectEventToJoin,
  selectUpcomingMatches,
  resolveMeetUrl,
};
