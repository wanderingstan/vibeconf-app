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
  isEventUpcoming,
  msUntilStart,
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
    joinedIds: { 'evt-1': now - 1000 },
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
