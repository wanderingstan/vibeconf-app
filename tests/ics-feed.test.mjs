// #829: calendar auto-join from an iCal (ICS) feed URL. Fixtures are shaped like
// what Outlook's "Publish a calendar" and Google's "Secret address in iCal
// format" actually return: CRLF lines, VTIMEZONE blocks with Outlook's Windows
// zone names, folded long lines, Teams' X-MICROSOFT-SKYPETEAMSMEETINGURL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseIcsEvents, normalizeFeedUrl, fetchIcsFeed, loadIcsEvents, mergeCalendarSources } = require('../electron-app/ics-feed.js');
const { resolveEventCallLink, matchesCalendarEvent, eventDedupeKey } = require('../electron-app/calendar-auto-join.js');

const crlf = (lines) => lines.join('\r\n') + '\r\n';

// Outlook: Windows TZID "Mountain Standard Time" defined by its own VTIMEZONE.
const OUTLOOK_TZ = [
  'BEGIN:VTIMEZONE', 'TZID:Mountain Standard Time',
  'BEGIN:STANDARD', 'DTSTART:16011104T020000', 'RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11', 'TZOFFSETFROM:-0600', 'TZOFFSETTO:-0700', 'END:STANDARD',
  'BEGIN:DAYLIGHT', 'DTSTART:16010311T020000', 'RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3', 'TZOFFSETFROM:-0700', 'TZOFFSETTO:-0600', 'END:DAYLIGHT',
  'END:VTIMEZONE',
];

// "now" for every test: 2026-10-15 16:00 MDT (22:00Z), a Thursday.
const NOW = Date.parse('2026-10-15T22:00:00Z');

const OUTLOOK_FEED = crlf([
  'BEGIN:VCALENDAR', 'PRODID:Microsoft Exchange Server 2010', 'VERSION:2.0', 'METHOD:PUBLISH',
  ...OUTLOOK_TZ,
  // One-off Teams meeting at 16:30 local, link only in the Microsoft X- property.
  'BEGIN:VEVENT',
  'UID:040000008200E00074C5B7101A82E00800000000AAAA',
  'SUMMARY:Test run',
  'DTSTART;TZID=Mountain Standard Time:20261015T163000',
  'DTEND;TZID=Mountain Standard Time:20261015T170000',
  'LOCATION:Microsoft Teams Meeting',
  'ATTENDEE;CN=Jimmy;RSVP=TRUE:mailto:jimmy@spiritprotocol.io',
  'ATTENDEE;CN=Stan;RSVP=TRUE:mailto:WanderingStan@gmail.com',
  'X-MICROSOFT-SKYPETEAMSMEETINGURL:https://teams.microsoft.com/l/meetup-join/19%3ameeting_NmFk%40thread.v2/0?context=%7b%22Tid%22%3a%22ff94%22%7d',
  'END:VEVENT',
  // Weekly standup, Thursdays 10:00 local: the 10/22 one is skipped (EXDATE),
  // the 10/29 one is moved to 11:00 (RECURRENCE-ID override).
  'BEGIN:VEVENT',
  'UID:weekly-standup-1',
  'SUMMARY:Standup #vibeconf:Jimmy',
  'DTSTART;TZID=Mountain Standard Time:20261001T100000',
  'DTEND;TZID=Mountain Standard Time:20261001T101500',
  'RRULE:FREQ=WEEKLY;BYDAY=TH',
  'EXDATE;TZID=Mountain Standard Time:20261022T100000',
  'DESCRIPTION:Join: https://zoom.us/j/12345678901?pwd=abc',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:weekly-standup-1',
  'RECURRENCE-ID;TZID=Mountain Standard Time:20261029T100000',
  'SUMMARY:Standup (moved) #vibeconf:Jimmy',
  'DTSTART;TZID=Mountain Standard Time:20261029T110000',
  'DTEND;TZID=Mountain Standard Time:20261029T111500',
  'DESCRIPTION:Join: https://zoom.us/j/12345678901?pwd=abc',
  'END:VEVENT',
  // Cancelled meeting in the window: must not appear.
  'BEGIN:VEVENT',
  'UID:cancelled-1',
  'SUMMARY:Canceled: Sync',
  'STATUS:CANCELLED',
  'DTSTART;TZID=Mountain Standard Time:20261015T180000',
  'DTEND;TZID=Mountain Standard Time:20261015T183000',
  'END:VEVENT',
  // A meeting next month: outside the window.
  'BEGIN:VEVENT',
  'UID:far-future',
  'SUMMARY:Later',
  'DTSTART;TZID=Mountain Standard Time:20261120T100000',
  'DTEND;TZID=Mountain Standard Time:20261120T110000',
  'END:VEVENT',
  'END:VCALENDAR',
]);

test('Outlook feed: one-off Teams meeting, in the right instant despite the Windows TZID', () => {
  const events = parseIcsEvents(OUTLOOK_FEED, { now: NOW });
  const run = events.find((e) => e.summary === 'Test run');
  assert.ok(run, 'Test run should be in the window');
  assert.equal(run.start, '2026-10-15T22:30:00.000Z'); // 16:30 MDT
  assert.equal(run.end, '2026-10-15T23:00:00.000Z');
  assert.equal(run.location, 'Microsoft Teams Meeting');
  assert.deepEqual(run.attendees, ['jimmy@spiritprotocol.io', 'wanderingstan@gmail.com']);
  assert.equal(run.selfResponseStatus, null);
  assert.equal(run.source, 'ics');
});

test('Outlook feed: the Teams X- property reaches resolveEventCallLink', () => {
  const run = parseIcsEvents(OUTLOOK_FEED, { now: NOW }).find((e) => e.summary === 'Test run');
  const link = resolveEventCallLink(run);
  assert.equal(link.provider, 'teams');
  assert.match(link.url, /^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//);
});

test('Outlook feed: matches the bot by invite email, through the normal matcher', () => {
  const run = parseIcsEvents(OUTLOOK_FEED, { now: NOW }).find((e) => e.summary === 'Test run');
  assert.equal(matchesCalendarEvent(run, { calendarIdentityEmail: 'jimmy@spiritprotocol.io', botName: 'Jimmy' }), true);
  assert.equal(matchesCalendarEvent(run, { calendarIdentityEmail: 'pepper@example.com', botName: 'Pepper' }), false);
});

test('cancelled events and events outside the window are dropped', () => {
  const titles = parseIcsEvents(OUTLOOK_FEED, { now: NOW }).map((e) => e.summary);
  assert.ok(!titles.some((t) => /Canceled/.test(t)));
  assert.ok(!titles.includes('Later'));
});

test('recurring: one entry per occurrence, EXDATE skipped, RECURRENCE-ID override moved', () => {
  // A 22-day window from Oct 15 covers Oct 22 (excluded), Oct 29 (moved) and Nov 5.
  const events = parseIcsEvents(OUTLOOK_FEED, { now: Date.parse('2026-10-15T00:00:00Z'), futureMs: 22 * 24 * 3600 * 1000 })
    .filter((e) => e.id === 'ics:weekly-standup-1');
  assert.deepEqual(events.map((e) => e.start), [
    '2026-10-15T16:00:00.000Z', // Oct 15 10:00 MDT
    // Oct 22 excluded
    '2026-10-29T17:00:00.000Z', // Oct 29 moved to 11:00 MDT
    // Nov 5 is after DST ends: 10:00 MST = 17:00Z
    '2026-11-05T17:00:00.000Z',
  ]);
  assert.equal(events[1].summary, 'Standup (moved) #vibeconf:Jimmy');
  // Each occurrence dedupes on its own, so joining one never suppresses the next.
  assert.equal(new Set(events.map(eventDedupeKey)).size, events.length);
  // Matched by the #vibeconf tag, joined over Zoom from the description.
  assert.equal(matchesCalendarEvent(events[0], { calendarIdentityEmail: '', botName: 'Jimmy' }), true);
  assert.equal(resolveEventCallLink(events[0]).provider, 'zoom');
});

test('Google-exported feed: X-GOOGLE-CONFERENCE becomes the Meet link; UTC times; all-day events keep a date', () => {
  const feed = crlf([
    'BEGIN:VCALENDAR', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'VERSION:2.0',
    'BEGIN:VEVENT', 'UID:g1@google.com', 'SUMMARY:Design review',
    'DTSTART:20261015T230000Z', 'DTEND:20261015T233000Z',
    'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij',
    'DESCRIPTION:Agenda in the doc',
    'END:VEVENT',
    'BEGIN:VEVENT', 'UID:g2@google.com', 'SUMMARY:Offsite',
    'DTSTART;VALUE=DATE:20261016', 'DTEND;VALUE=DATE:20261017',
    'END:VEVENT',
    'END:VCALENDAR',
  ]);
  const events = parseIcsEvents(feed, { now: NOW });
  const review = events.find((e) => e.summary === 'Design review');
  assert.equal(review.start, '2026-10-15T23:00:00.000Z');
  assert.deepEqual(resolveEventCallLink(review), { provider: 'meet', url: 'https://meet.google.com/abc-defg-hij' });
  const offsite = events.find((e) => e.summary === 'Offsite');
  assert.equal(offsite.start, '2026-10-16');
});

test('folded long lines (RFC 5545 line folding) are unfolded before link finding', () => {
  const feed = crlf([
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'UID:fold-1', 'SUMMARY:Folded',
    'DTSTART:20261015T230000Z', 'DTEND:20261015T233000Z',
    'DESCRIPTION:Join here: https://teams.microsoft.com/meet/228789313340874?p=uc',
    ' UGCVuh5rAoojfTDy',
    'END:VEVENT', 'END:VCALENDAR',
  ]);
  const ev = parseIcsEvents(feed, { now: NOW })[0];
  assert.equal(resolveEventCallLink(ev).url, 'https://teams.microsoft.com/meet/228789313340874?p=ucUGCVuh5rAoojfTDy');
});

test('normalizeFeedUrl: webcal → https, refuses non-web schemes', () => {
  assert.equal(normalizeFeedUrl(' webcal://outlook.office365.com/owa/calendar/x/calendar.ics '), 'https://outlook.office365.com/owa/calendar/x/calendar.ics');
  assert.equal(normalizeFeedUrl('https://calendar.google.com/calendar/ical/x/private-abc/basic.ics'), 'https://calendar.google.com/calendar/ical/x/private-abc/basic.ics');
  assert.equal(normalizeFeedUrl('file:///etc/passwd'), null);
  assert.equal(normalizeFeedUrl(''), null);
});

test('fetchIcsFeed: errors never include the (secret) URL', async () => {
  const secret = 'https://outlook.office365.com/owa/calendar/SECRET-TOKEN/calendar.ics';
  const cases = [
    async () => ({ ok: false, status: 404, text: async () => '' }),
    async () => ({ ok: true, status: 200, text: async () => '<html>sign in</html>' }),
    async () => { throw new TypeError('fetch failed'); },
  ];
  for (const fetchFn of cases) {
    const r = await fetchIcsFeed(secret, { fetchFn });
    assert.equal(r.ok, false);
    assert.ok(!String(r.error).includes('SECRET-TOKEN'), `error leaked the URL: ${r.error}`);
  }
});

test('loadIcsEvents: fetch + parse end to end, and a fetch that returns garbage fails cleanly', async () => {
  const ok = await loadIcsEvents('webcal://example.test/cal.ics', { now: NOW, fetchFn: async (u) => {
    assert.equal(u, 'https://example.test/cal.ics');
    return { ok: true, status: 200, text: async () => OUTLOOK_FEED };
  } });
  assert.equal(ok.ok, true);
  assert.ok(ok.events.some((e) => e.summary === 'Test run'));
  const bad = await loadIcsEvents('https://example.test/cal.ics', { fetchFn: async () => ({ ok: true, status: 200, text: async () => 'BEGIN:VCALENDAR\r\nthis is not ical' }) });
  assert.equal(bad.ok, false);
});

test('mergeCalendarSources: a meeting on both keeps Google’s copy; feed-only meetings are added', () => {
  const google = [{ id: 'g', summary: 'Test run', start: '2026-10-15T16:30:00-06:00', selfResponseStatus: 'accepted' }];
  const ics = [
    { id: 'ics:a', summary: 'Test run', start: '2026-10-15T22:30:00.000Z', source: 'ics' },
    { id: 'ics:b', summary: 'Other', start: '2026-10-15T23:00:00.000Z', source: 'ics' },
  ];
  const merged = mergeCalendarSources(google, ics);
  assert.deepEqual(merged.map((e) => e.id), ['g', 'ics:b']);
  assert.deepEqual(mergeCalendarSources(null, ics).map((e) => e.id), ['ics:a', 'ics:b']);
});

test('the feed URL never reaches the session log or the agent-facing schema', () => {
  const { snapshotForLog, PREFERENCES } = require('../electron-app/preferences-schema.js');
  // Kept OUT of the schema on purpose: schema prefs are logged with their values
  // and listed to the agent by list_preferences; non-schema keys whose name looks
  // like a credential are redacted (SECRET_KEY_RE), like ttsApiKey.
  assert.equal(PREFERENCES.calendarFeedSecretUrl, undefined);
  const secret = 'https://outlook.office365.com/owa/calendar/SECRET-TOKEN/calendar.ics';
  const data = { calendarFeedSecretUrl: secret };
  const lines = snapshotForLog((k) => (k === undefined ? data : data[k])).join('\n');
  assert.ok(!lines.includes('SECRET-TOKEN'), 'feed URL leaked into the prefs log');
  assert.match(lines, /calendarFeedSecretUrl=<redacted>/);
});

test('the feed is app-wide (it is the person’s calendar, not a bot’s) and a headless --config can set it', () => {
  const { isAppLevel } = require('../electron-app/config-scope.js');
  assert.equal(isAppLevel('calendarFeedSecretUrl'), true);
  const { checkConfigObject } = require('../electron-app/config-file.js');
  const r = checkConfigObject({ calendarFeedSecretUrl: 'https://example.test/cal.ics' });
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.deepEqual(r.entries.map((e) => [e.key, e.appLevel, e.secret]), [['calendarFeedSecretUrl', true, true]]);
});
