// calendar-auto-join.test.mjs — pure matching/selection/eviction logic behind
// calendar-triggered auto-join (#299): a bot auto-joins an upcoming Google
// Calendar event where it's been "invited" via a placeholder guest email or a
// #vibeconf:<botName> tag in the title or description.
//
// This module has no Electron dependency (the HTTP call + the actual join
// live in main.js's startCalendarPolling/handleCalendarEvents), so it's fully
// testable with plain Node — same split as call-media-merge.js/
// call-media-merge.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  matchesCalendarEvent,
  ownerHasConfirmed,
  isEventUpcoming,
  msUntilStart,
  eventDedupeKey,
  evictStaleEventIds,
  selectEventToJoin,
  selectUpcomingMatches,
  resolveMeetUrl,
  DEFAULT_LOOKAHEAD_MS,
  DEFAULT_DEDUPE_MAX_AGE_MS,
} = require('../electron-app/calendar-auto-join.js');

function makeEvent(overrides = {}) {
  return {
    id: 'evt-1',
    summary: 'Team standup',
    description: '',
    attendees: [],
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
    start: new Date().toISOString(),
    ...overrides,
  };
}

// ── matchesCalendarEvent: identity email ────────────────────────────────────

test('matchesCalendarEvent: matches when calendarIdentityEmail is an attendee', () => {
  const event = makeEvent({ attendees: ['human@example.com', 'bot-placeholder@example.com'] });
  assert.equal(
    matchesCalendarEvent(event, { calendarIdentityEmail: 'bot-placeholder@example.com', botName: 'Jimmy' }),
    true,
  );
});

test('matchesCalendarEvent: identity email match is case-insensitive', () => {
  const event = makeEvent({ attendees: ['Bot-Placeholder@Example.com'] });
  assert.equal(
    matchesCalendarEvent(event, { calendarIdentityEmail: 'bot-placeholder@example.com', botName: 'Jimmy' }),
    true,
  );
});

test('matchesCalendarEvent: no match when calendarIdentityEmail is unset and no tag present', () => {
  const event = makeEvent({ attendees: ['human@example.com'] });
  assert.equal(
    matchesCalendarEvent(event, { calendarIdentityEmail: '', botName: 'Jimmy' }),
    false,
  );
});

test('matchesCalendarEvent: no match when attendees list does not include the identity email', () => {
  const event = makeEvent({ attendees: ['someone-else@example.com'] });
  assert.equal(
    matchesCalendarEvent(event, { calendarIdentityEmail: 'bot@example.com', botName: 'Jimmy' }),
    false,
  );
});

// ── matchesCalendarEvent: #vibeconf:<botName> tag ───────────────────────────

test('matchesCalendarEvent: "#vibeconf:<botName>" in the summary targets only the matching bot', () => {
  const event = makeEvent({ summary: '1:1 #vibeconf:Jimmy' });
  assert.equal(matchesCalendarEvent(event, { calendarIdentityEmail: '', botName: 'Jimmy' }), true);
  assert.equal(matchesCalendarEvent(event, { calendarIdentityEmail: '', botName: 'Rex' }), false);
});

test('matchesCalendarEvent: "#vibeconf:<botName>" in the description also matches', () => {
  const event = makeEvent({ summary: 'Design review', description: 'notes: #vibeconf:Jimmy should join' });
  assert.equal(matchesCalendarEvent(event, { calendarIdentityEmail: '', botName: 'Jimmy' }), true);
});

test('matchesCalendarEvent: "#vibeconf:<botName>" comparison is case-insensitive and trims', () => {
  const event = makeEvent({ summary: 'Standup #vibeconf:JIMMY' });
  assert.equal(matchesCalendarEvent(event, { calendarIdentityEmail: '', botName: '  jimmy  ' }), true);
});

test('matchesCalendarEvent: "#vibeconf:othername" does not match a different bot', () => {
  const event = makeEvent({ summary: 'Standup #vibeconf:Rex' });
  assert.equal(matchesCalendarEvent(event, { calendarIdentityEmail: '', botName: 'Jimmy' }), false);
});

test('matchesCalendarEvent: no "#vibeconf:" tag anywhere → no match', () => {
  const event = makeEvent({ summary: 'Totally unrelated meeting', description: 'nothing here' });
  assert.equal(matchesCalendarEvent(event, { calendarIdentityEmail: '', botName: 'Jimmy' }), false);
});

// Bot names are free text a user typed, not a lookup-able slug — multi-word
// names must work directly, tolerant of extra/irregular whitespace.
test('matchesCalendarEvent: a multi-word bot name matches, whitespace and all', () => {
  const event = makeEvent({ summary: 'Weekly sync #vibeconf:Mr Roboto' });
  assert.equal(matchesCalendarEvent(event, { calendarIdentityEmail: '', botName: 'Mr Roboto' }), true);
});

test('matchesCalendarEvent: multi-word name tolerates extra internal whitespace', () => {
  const event = makeEvent({ summary: '#vibeconf:Mr   Roboto weekly sync' });
  assert.equal(matchesCalendarEvent(event, { calendarIdentityEmail: '', botName: 'Mr Roboto' }), true);
});

test('matchesCalendarEvent: a short name does not match as a prefix of a longer one', () => {
  const event = makeEvent({ summary: 'Standup #vibeconf:Rexford' });
  assert.equal(matchesCalendarEvent(event, { calendarIdentityEmail: '', botName: 'Rex' }), false);
});

// #299 regression: a bare "vibeconf" substring must NOT match — this used to
// be a wildcard ("matches any bot"), which false-positived on any event that
// merely mentioned the product by name.
test('matchesCalendarEvent: mentioning the product name (no #tag) does not match', () => {
  const productMention = makeEvent({ summary: 'Vibeconferencing planning sync' });
  assert.equal(matchesCalendarEvent(productMention, { calendarIdentityEmail: '', botName: 'Jimmy' }), false);

  const appMention = makeEvent({ summary: 'Test: vibeconf-app release review' });
  assert.equal(matchesCalendarEvent(appMention, { calendarIdentityEmail: '', botName: 'Jimmy' }), false);

  const bareWord = makeEvent({ summary: 'vibeconf standup', description: 'notes: vibeconf should join' });
  assert.equal(matchesCalendarEvent(bareWord, { calendarIdentityEmail: '', botName: 'Jimmy' }), false);
});

test('matchesCalendarEvent: either signal alone is sufficient (OR, not AND)', () => {
  const emailOnly = makeEvent({ attendees: ['bot@example.com'], summary: 'Nothing special' });
  assert.equal(matchesCalendarEvent(emailOnly, { calendarIdentityEmail: 'bot@example.com', botName: 'Jimmy' }), true);

  const tagOnly = makeEvent({ attendees: [], summary: '#vibeconf:Jimmy standup' });
  assert.equal(matchesCalendarEvent(tagOnly, { calendarIdentityEmail: 'bot@example.com', botName: 'Jimmy' }), true);
});

// ── isEventUpcoming: lookahead window, as a separate pure function ─────────

test('isEventUpcoming: true for an event starting a couple minutes from now', () => {
  const now = Date.parse('2026-08-08T10:00:00Z');
  const event = makeEvent({ start: '2026-08-08T10:02:00Z' });
  assert.equal(isEventUpcoming(event, now), true);
});

test('isEventUpcoming: false for an event starting an hour from now', () => {
  const now = Date.parse('2026-08-08T10:00:00Z');
  const event = makeEvent({ start: '2026-08-08T11:00:00Z' });
  assert.equal(isEventUpcoming(event, now), false);
});

test('isEventUpcoming: true for an event that started a minute ago (running slightly late)', () => {
  const now = Date.parse('2026-08-08T10:00:00Z');
  const event = makeEvent({ start: '2026-08-08T09:59:00Z' });
  assert.equal(isEventUpcoming(event, now), true);
});

test('isEventUpcoming: false for an event that started well in the past', () => {
  const now = Date.parse('2026-08-08T10:00:00Z');
  const event = makeEvent({ start: '2026-08-08T08:00:00Z' });
  assert.equal(isEventUpcoming(event, now), false);
});

test('isEventUpcoming: respects a custom lookaheadMs', () => {
  const now = Date.parse('2026-08-08T10:00:00Z');
  const event = makeEvent({ start: '2026-08-08T10:09:00Z' });
  assert.equal(isEventUpcoming(event, now, DEFAULT_LOOKAHEAD_MS), false);
  assert.equal(isEventUpcoming(event, now, 10 * 60 * 1000), true);
});

test('isEventUpcoming: false for a missing/unparseable start', () => {
  const now = Date.parse('2026-08-08T10:00:00Z');
  assert.equal(isEventUpcoming(makeEvent({ start: undefined }), now), false);
  assert.equal(isEventUpcoming(makeEvent({ start: 'not-a-date' }), now), false);
});

// ── msUntilStart: the shared delta both isEventUpcoming and main.js's actual
//    join-scheduling setTimeout delay are computed from ──────────────────

test('msUntilStart: positive for a future start, negative for a past one', () => {
  const now = Date.parse('2026-08-08T10:00:00Z');
  assert.equal(msUntilStart(makeEvent({ start: '2026-08-08T10:05:00Z' }), now), 5 * 60 * 1000);
  assert.equal(msUntilStart(makeEvent({ start: '2026-08-08T09:55:00Z' }), now), -5 * 60 * 1000);
});

test('msUntilStart: null for a missing/unparseable start', () => {
  const now = Date.parse('2026-08-08T10:00:00Z');
  assert.equal(msUntilStart(makeEvent({ start: undefined }), now), null);
  assert.equal(msUntilStart(makeEvent({ start: 'not-a-date' }), now), null);
  assert.equal(msUntilStart(null, now), null);
});

// ── evictStaleEventIds ───────────────────────────────────────────────────

test('evictStaleEventIds: drops entries older than maxAgeMs, keeps recent ones', () => {
  const now = Date.parse('2026-08-08T12:00:00Z');
  const idMap = {
    'recent': now - 1000,
    'stale': now - (DEFAULT_DEDUPE_MAX_AGE_MS + 1000),
    'boundary': now - DEFAULT_DEDUPE_MAX_AGE_MS,
  };
  const result = evictStaleEventIds(idMap, now);
  assert.deepEqual(result, { recent: idMap.recent, boundary: idMap.boundary });
});

test('evictStaleEventIds: does not mutate the input map', () => {
  const now = Date.parse('2026-08-08T12:00:00Z');
  const idMap = { a: now - (DEFAULT_DEDUPE_MAX_AGE_MS + 1) };
  const snapshot = { ...idMap };
  evictStaleEventIds(idMap, now);
  assert.deepEqual(idMap, snapshot);
});

test('evictStaleEventIds: handles an empty/undefined map', () => {
  const now = Date.now();
  assert.deepEqual(evictStaleEventIds({}, now), {});
  assert.deepEqual(evictStaleEventIds(undefined, now), {});
});

test('evictStaleEventIds: respects a custom maxAgeMs', () => {
  const now = Date.parse('2026-08-08T12:00:00Z');
  const idMap = { a: now - 5000 };
  assert.deepEqual(evictStaleEventIds(idMap, now, 1000), {});
  assert.deepEqual(evictStaleEventIds(idMap, now, 10000), idMap);
});

// ── ownerHasConfirmed ───────────────────────────────────────────────────
// The bot only auto-joins when the CALENDAR OWNER (the human this machine
// belongs to) has accepted the event — being invited itself isn't enough.

test('ownerHasConfirmed: accepted means confirmed (case-insensitive)', () => {
  assert.equal(ownerHasConfirmed(makeEvent({ selfResponseStatus: 'accepted' })), true);
  assert.equal(ownerHasConfirmed(makeEvent({ selfResponseStatus: 'Accepted' })), true);
});

test('ownerHasConfirmed: needsAction/tentative/declined are NOT confirmed', () => {
  assert.equal(ownerHasConfirmed(makeEvent({ selfResponseStatus: 'needsAction' })), false);
  assert.equal(ownerHasConfirmed(makeEvent({ selfResponseStatus: 'tentative' })), false);
  assert.equal(ownerHasConfirmed(makeEvent({ selfResponseStatus: 'declined' })), false);
});

test('ownerHasConfirmed: null (own event, no self attendee row) counts as confirmed', () => {
  assert.equal(ownerHasConfirmed(makeEvent({ selfResponseStatus: null })), true);
});

test('ownerHasConfirmed: absent field (older backend) fails open as confirmed', () => {
  assert.equal(ownerHasConfirmed(makeEvent()), true);
});

test('ownerHasConfirmed: no event at all is not confirmed', () => {
  assert.equal(ownerHasConfirmed(null), false);
});

// ── selectEventToJoin ───────────────────────────────────────────────────

test('selectEventToJoin: picks the first matching, upcoming, not-yet-joined event', () => {
  const now = Date.parse('2026-08-08T10:00:00Z');
  const events = [
    makeEvent({ id: 'later', start: '2026-08-08T10:02:00Z', attendees: ['bot@example.com'] }),
  ];
  const { event, extraMatchCount } = selectEventToJoin(events, {
    calendarIdentityEmail: 'bot@example.com',
    botName: 'Jimmy',
    joinedIds: {},
    now,
  });
  assert.equal(event.id, 'later');
  assert.equal(extraMatchCount, 0);
});

test('selectEventToJoin: skips events already recorded in joinedIds', () => {
  const now = Date.parse('2026-08-08T10:00:00Z');
  const events = [makeEvent({ id: 'evt-1', start: '2026-08-08T10:02:00Z', attendees: ['bot@example.com'] })];
  const { event } = selectEventToJoin(events, {
    calendarIdentityEmail: 'bot@example.com',
    botName: 'Jimmy',
    joinedIds: { [eventDedupeKey(makeEvent({ id: 'evt-1', start: '2026-08-08T10:02:00Z' }))]: now - 1000 },
    now,
  });
  assert.equal(event, null);
});

test('selectEventToJoin: reports extraMatchCount when multiple events match in one tick', () => {
  const now = Date.parse('2026-08-08T10:00:00Z');
  const events = [
    makeEvent({ id: 'first', start: '2026-08-08T10:01:00Z', attendees: ['bot@example.com'] }),
    makeEvent({ id: 'second', start: '2026-08-08T10:02:00Z', attendees: ['bot@example.com'] }),
  ];
  const { event, extraMatchCount } = selectEventToJoin(events, {
    calendarIdentityEmail: 'bot@example.com',
    botName: 'Jimmy',
    joinedIds: {},
    now,
  });
  assert.equal(event.id, 'first');
  assert.equal(extraMatchCount, 1);
});

test('selectEventToJoin: ignores non-matching and out-of-window events', () => {
  const now = Date.parse('2026-08-08T10:00:00Z');
  const events = [
    makeEvent({ id: 'no-match', start: '2026-08-08T10:01:00Z', attendees: [] }),
    makeEvent({ id: 'too-far', start: '2026-08-08T11:00:00Z', attendees: ['bot@example.com'] }),
  ];
  const { event, extraMatchCount } = selectEventToJoin(events, {
    calendarIdentityEmail: 'bot@example.com',
    botName: 'Jimmy',
    joinedIds: {},
    now,
  });
  assert.equal(event, null);
  assert.equal(extraMatchCount, 0);
});

test('selectEventToJoin: never picks an event the owner has not accepted', () => {
  const now = Date.parse('2026-08-08T10:00:00Z');
  const events = [
    makeEvent({ id: 'unconfirmed', start: '2026-08-08T10:01:00Z', attendees: ['bot@example.com'], selfResponseStatus: 'needsAction' }),
    makeEvent({ id: 'confirmed', start: '2026-08-08T10:02:00Z', attendees: ['bot@example.com'], selfResponseStatus: 'accepted' }),
  ];
  const { event, extraMatchCount } = selectEventToJoin(events, {
    calendarIdentityEmail: 'bot@example.com',
    botName: 'Jimmy',
    joinedIds: {},
    now,
  });
  assert.equal(event.id, 'confirmed');
  assert.equal(extraMatchCount, 0);
});

test('selectEventToJoin: returns null when the only match is owner-unconfirmed', () => {
  const now = Date.parse('2026-08-08T10:00:00Z');
  const events = [
    makeEvent({ id: 'unconfirmed', start: '2026-08-08T10:01:00Z', attendees: ['bot@example.com'], selfResponseStatus: 'tentative' }),
  ];
  const { event } = selectEventToJoin(events, {
    calendarIdentityEmail: 'bot@example.com',
    botName: 'Jimmy',
    joinedIds: {},
    now,
  });
  assert.equal(event, null);
});

test('selectEventToJoin: returns null/0 for an empty events list', () => {
  const { event, extraMatchCount } = selectEventToJoin([], {
    calendarIdentityEmail: 'bot@example.com',
    botName: 'Jimmy',
    joinedIds: {},
    now: Date.now(),
  });
  assert.equal(event, null);
  assert.equal(extraMatchCount, 0);
});

// ── selectUpcomingMatches ───────────────────────────────────────────────

test('selectUpcomingMatches: includes a match well beyond the 5-minute join window', () => {
  const now = Date.now();
  const events = [makeEvent({
    id: 'evt-far',
    attendees: ['bot@example.com'],
    start: new Date(now + 6 * 60 * 60 * 1000).toISOString(), // 6h out
  })];
  const matches = selectUpcomingMatches(events, { calendarIdentityEmail: 'bot@example.com', botName: 'Jimmy', now });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, 'evt-far');
});

test('selectUpcomingMatches: excludes events outside the 24h lookahead', () => {
  const now = Date.now();
  const events = [makeEvent({
    attendees: ['bot@example.com'],
    start: new Date(now + 25 * 60 * 60 * 1000).toISOString(),
  })];
  const matches = selectUpcomingMatches(events, { calendarIdentityEmail: 'bot@example.com', botName: 'Jimmy', now });
  assert.equal(matches.length, 0);
});

test('selectUpcomingMatches: excludes events well in the past (not symmetric with the wide lookahead)', () => {
  const now = Date.now();
  const events = [makeEvent({
    attendees: ['bot@example.com'],
    start: new Date(now - 20 * 60 * 60 * 1000).toISOString(), // 20h ago
  })];
  const matches = selectUpcomingMatches(events, { calendarIdentityEmail: 'bot@example.com', botName: 'Jimmy', now });
  assert.equal(matches.length, 0);
});

test('selectUpcomingMatches: sorted soonest-first and ignores non-matching events', () => {
  const now = Date.now();
  const soon = makeEvent({ id: 'soon', attendees: ['bot@example.com'], start: new Date(now + 60 * 60 * 1000).toISOString() });
  const later = makeEvent({ id: 'later', attendees: ['bot@example.com'], start: new Date(now + 5 * 60 * 60 * 1000).toISOString() });
  const other = makeEvent({ id: 'other', attendees: ['someone-else@example.com'], start: new Date(now + 30 * 60 * 1000).toISOString() });
  const matches = selectUpcomingMatches([later, other, soon], { calendarIdentityEmail: 'bot@example.com', botName: 'Jimmy', now });
  assert.deepEqual(matches.map((e) => e.id), ['soon', 'later']);
});

test('selectUpcomingMatches: still lists owner-unconfirmed matches (display shows the waiting notice)', () => {
  const now = Date.now();
  const events = [makeEvent({
    id: 'evt-unconfirmed',
    attendees: ['bot@example.com'],
    selfResponseStatus: 'needsAction',
    start: new Date(now + 60 * 60 * 1000).toISOString(),
  })];
  const matches = selectUpcomingMatches(events, { calendarIdentityEmail: 'bot@example.com', botName: 'Jimmy', now });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, 'evt-unconfirmed');
});

// ── resolveMeetUrl ───────────────────────────────────────────────────────

test('resolveMeetUrl: passes through an already-full Meet URL', () => {
  assert.equal(resolveMeetUrl('https://meet.google.com/abc-defg-hij'), 'https://meet.google.com/abc-defg-hij');
});

test('resolveMeetUrl: builds a full URL from a bare meet code', () => {
  assert.equal(resolveMeetUrl('abc-defg-hij'), 'https://meet.google.com/abc-defg-hij');
});

test('resolveMeetUrl: returns null for empty/unrecognizable input', () => {
  assert.equal(resolveMeetUrl(''), null);
  assert.equal(resolveMeetUrl(null), null);
  assert.equal(resolveMeetUrl('not a meet link'), null);
});

// ── eventDedupeKey ──────────────────────────────────────────────────────────
// The 2026-08-11 miss: yesterday's standup was joined at 17:00, today's 16:30
// instance came back with the SAME id (the backend mapped it from the
// series-constant iCalUID), and at 23h30m the dedupe entry was still inside
// the 24h retention — so today read as already-handled and no bot joined.

test('eventDedupeKey: two occurrences sharing one series id get different keys', () => {
  const monday = makeEvent({ id: 'series@google.com', start: '2026-08-10T23:00:00Z' });
  const tuesday = makeEvent({ id: 'series@google.com', start: '2026-08-11T22:30:00Z' });
  assert.notEqual(eventDedupeKey(monday), eventDedupeKey(tuesday));
});

test('eventDedupeKey: the same occurrence is one key across polls', () => {
  const a = makeEvent({ id: 'evt-1', start: '2026-08-11T22:30:00Z' });
  const b = makeEvent({ id: 'evt-1', start: '2026-08-11T22:30:00Z', summary: 'renamed since last poll' });
  assert.equal(eventDedupeKey(a), eventDedupeKey(b));
});

test('eventDedupeKey: equivalent start renderings collapse to one key', () => {
  const z = makeEvent({ id: 'evt-1', start: '2026-08-11T22:30:00Z' });
  const offset = makeEvent({ id: 'evt-1', start: '2026-08-11T16:30:00-06:00' });
  assert.equal(eventDedupeKey(z), eventDedupeKey(offset));
});

test('eventDedupeKey: distinct events at the same instant stay distinct', () => {
  const a = makeEvent({ id: 'evt-a', start: '2026-08-11T22:30:00Z' });
  const b = makeEvent({ id: 'evt-b', start: '2026-08-11T22:30:00Z' });
  assert.notEqual(eventDedupeKey(a), eventDedupeKey(b));
});

test('eventDedupeKey: an unparseable start still yields a stable key', () => {
  const a = makeEvent({ id: 'evt-1', start: 'not-a-date' });
  const b = makeEvent({ id: 'evt-1', start: 'not-a-date' });
  assert.equal(eventDedupeKey(a), eventDedupeKey(b));
  assert.notEqual(eventDedupeKey(a), eventDedupeKey(makeEvent({ id: 'evt-1', start: '2026-08-11T22:30:00Z' })));
});

test('selectEventToJoin: yesterday\'s occurrence does not suppress today\'s', () => {
  // Exactly the 2026-08-11 shape: one series id, yesterday's entry still
  // inside the 24h retention when today's instance comes up.
  const now = Date.parse('2026-08-11T22:28:00Z');
  const yesterday = makeEvent({ id: 'series@google.com', start: '2026-08-10T23:00:00Z', attendees: ['bot@example.com'] });
  const today = makeEvent({ id: 'series@google.com', start: '2026-08-11T22:30:00Z', attendees: ['bot@example.com'] });
  const joinedIds = { [eventDedupeKey(yesterday)]: Date.parse('2026-08-10T23:00:00Z') };
  assert.ok(now - joinedIds[eventDedupeKey(yesterday)] < DEFAULT_DEDUPE_MAX_AGE_MS, 'entry is still live');

  const { event } = selectEventToJoin([today], {
    calendarIdentityEmail: 'bot@example.com',
    botName: 'Jimmy',
    joinedIds,
    now,
  });
  assert.equal(event && event.start, today.start);
});

test('selectEventToJoin: today\'s occurrence, once joined, is not re-joined', () => {
  const now = Date.parse('2026-08-11T22:28:00Z');
  const today = makeEvent({ id: 'series@google.com', start: '2026-08-11T22:30:00Z', attendees: ['bot@example.com'] });
  const { event } = selectEventToJoin([today], {
    calendarIdentityEmail: 'bot@example.com',
    botName: 'Jimmy',
    joinedIds: { [eventDedupeKey(today)]: now - 1000 },
    now,
  });
  assert.equal(event, null);
});
