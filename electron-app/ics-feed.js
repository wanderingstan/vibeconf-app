// ics-feed.js — calendar auto-join from an iCal (ICS) feed URL (#829).
//
// Google Calendar auto-join needs the vibeconferencing.com login plus Google's
// optional calendar.readonly scope, which Google is strict about. Every calendar
// app can instead PUBLISH a calendar as an iCal feed: a secret URL that returns
// the whole calendar as text. Outlook (Settings → Calendar → Shared calendars →
// Publish a calendar → ICS), Google ("Secret address in iCal format"), Apple
// iCloud (public calendar), Fastmail and the rest. No OAuth, no app
// verification, and it works for people whose calendar isn't Google at all.
//
// This module fetches such a feed and turns its events into the SAME shape the
// Google path produces (api/lib/google-calendar.ts in the website repo), so
// everything downstream — matching, the join gate, the panel banner, link
// finding (resolveEventCallLink) — works on them unchanged:
//
//   { id, summary, description, location, attendees: [email], hangoutLink,
//     conferenceData: { entryPoints: [{ entryPointType: 'video', uri }] } | null,
//     start, end, selfResponseStatus: null, source: 'ics' }
//
// One event per OCCURRENCE: a weekly meeting yields one entry per week in the
// window, each with its own start (eventDedupeKey pairs id with start, so one
// occurrence being joined never suppresses the next). Recurrence (RRULE, RDATE,
// EXDATE), single-occurrence overrides (RECURRENCE-ID) and time zones
// (VTIMEZONE, including Outlook's Windows zone names) are ical.js's job, per
// the issue's "use a library rather than hand-rolling it".
//
// THE URL IS A SECRET: anyone holding it can read the calendar. It is stored as
// the calendarFeedSecretUrl preference (the name matters: SECRET_KEY_RE in
// preferences-schema.js redacts it from the session log) and must never be
// logged — errors here say what went wrong, never where.
'use strict';

const ICAL = require('ical.js');

// Expand occurrences this far around now. Wide enough for the panel's 24h
// "upcoming" list plus a margin; the join gate itself only acts within minutes.
const DEFAULT_PAST_MS = 60 * 60 * 1000;
const DEFAULT_FUTURE_MS = 26 * 60 * 60 * 1000;
// A runaway RRULE (no UNTIL/COUNT, minutely) must not hang the poll.
const MAX_OCCURRENCES_PER_EVENT = 500;

// webcal:// is how calendar apps advertise a subscribable feed; it is plain
// https underneath. Anything that isn't http(s) after that is refused.
function normalizeFeedUrl(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  const https = s.replace(/^webcals?:\/\//i, 'https://');
  return /^https?:\/\//i.test(https) ? https : null;
}

// Register every VTIMEZONE the feed carries, so TZIDs that aren't IANA names
// (Outlook writes "Mountain Standard Time") still resolve to the right offsets.
function registerTimezones(vcalendar) {
  for (const vtz of vcalendar.getAllSubcomponents('vtimezone')) {
    try { ICAL.TimezoneService.register(vtz); } catch { /* malformed zone: times fall back */ }
  }
}

function emailsFromAttendees(vevent) {
  const out = [];
  for (const p of vevent.getAllProperties('attendee')) {
    const v = String(p.getFirstValue() || '').replace(/^mailto:/i, '').trim();
    if (v && v.includes('@')) out.push(v.toLowerCase());
  }
  return out;
}

// An ICAL.Time as the Google API would give it: an RFC3339 instant for a
// timed event, a bare YYYY-MM-DD for an all-day one.
function toApiTime(t) {
  if (!t) return '';
  if (t.isDate) return t.toString().slice(0, 10);
  return t.toJSDate().toISOString();
}

function mapOccurrence(item, start, end) {
  const comp = item.component;
  const prop = (name) => {
    const v = comp.getFirstPropertyValue(name);
    return v == null ? '' : String(v);
  };
  // Teams writes its join link into this Microsoft extension; Google's own
  // export writes the Meet link into X-GOOGLE-CONFERENCE. Surfacing both in the
  // places resolveEventCallLink already looks means no special-casing there.
  const teams = prop('x-microsoft-skypeteamsmeetingurl');
  const googleConf = prop('x-google-conference');
  return {
    id: `ics:${item.uid || ''}`,
    summary: item.summary || '',
    description: item.description || '',
    location: item.location || '',
    attendees: emailsFromAttendees(comp),
    hangoutLink: /meet\.google\.com/i.test(googleConf) ? googleConf : null,
    conferenceData: teams ? { entryPoints: [{ entryPointType: 'video', uri: teams }] } : null,
    start: toApiTime(start),
    end: toApiTime(end),
    // A published feed doesn't say which attendee is the calendar's owner, so
    // there is no RSVP to read. null = "unknown", which the join gate treats as
    // confirmed — the same as a Google event without a self attendee row.
    selfResponseStatus: null,
    source: 'ics',
  };
}

// Parse ICS text into Google-shaped event occurrences that overlap
// [now - pastMs, now + futureMs]. Cancelled events and cancelled occurrences
// are dropped. Throws on text that isn't iCalendar at all.
function parseIcsEvents(icsText, { now = Date.now(), pastMs = DEFAULT_PAST_MS, futureMs = DEFAULT_FUTURE_MS } = {}) {
  const vcalendar = new ICAL.Component(ICAL.parse(String(icsText)));
  registerTimezones(vcalendar);
  const windowStart = now - pastMs;
  const windowEnd = now + futureMs;

  // Group by UID: the master event plus any RECURRENCE-ID overrides of it.
  const byUid = new Map();
  for (const vevent of vcalendar.getAllSubcomponents('vevent')) {
    const uid = vevent.getFirstPropertyValue('uid') || `nouid-${byUid.size}`;
    if (!byUid.has(uid)) byUid.set(uid, { master: null, exceptions: [] });
    const slot = byUid.get(uid);
    if (vevent.hasProperty('recurrence-id')) slot.exceptions.push(vevent);
    else slot.master = vevent;
  }

  const out = [];
  const inWindow = (startMs, endMs) => endMs >= windowStart && startMs <= windowEnd;
  const cancelled = (comp) => String(comp.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED';

  for (const [, { master, exceptions }] of byUid) {
    if (!master) {
      // Overrides with no master in the feed: treat each as a one-off.
      for (const ex of exceptions) {
        const ev = new ICAL.Event(ex);
        if (cancelled(ex) || !ev.startDate) continue;
        const s = ev.startDate.toJSDate().getTime();
        const e = (ev.endDate || ev.startDate).toJSDate().getTime();
        if (inWindow(s, e)) out.push(mapOccurrence(ev, ev.startDate, ev.endDate));
      }
      continue;
    }
    if (cancelled(master)) continue;
    const event = new ICAL.Event(master);
    for (const ex of exceptions) {
      try { event.relateException(ex); } catch { /* mismatched override: ignore it */ }
    }
    if (!event.startDate) continue;

    if (!event.isRecurring()) {
      const s = event.startDate.toJSDate().getTime();
      const e = (event.endDate || event.startDate).toJSDate().getTime();
      if (inWindow(s, e)) out.push(mapOccurrence(event, event.startDate, event.endDate));
      continue;
    }

    const durationMs = event.endDate
      ? event.endDate.toJSDate().getTime() - event.startDate.toJSDate().getTime()
      : 0;
    const it = event.iterator();
    let next;
    let n = 0;
    while ((next = it.next()) && n++ < MAX_OCCURRENCES_PER_EVENT) {
      const occStartMs = next.toJSDate().getTime();
      // Overrides can MOVE an occurrence, so test the window after resolving it;
      // but iteration is in original-start order, so stop well past the window.
      if (occStartMs - durationMs > windowEnd + DEFAULT_FUTURE_MS) break;
      const details = event.getOccurrenceDetails(next);
      if (cancelled(details.item.component)) continue;
      const s = details.startDate.toJSDate().getTime();
      const e = details.endDate.toJSDate().getTime();
      if (!inWindow(s, e)) continue;
      out.push(mapOccurrence(details.item, details.startDate, details.endDate));
    }
  }

  out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return out;
}

// Fetch a feed. Resolves { ok: true, text } or { ok: false, error } — never
// throws, and never puts the URL in the error (it is the secret).
async function fetchIcsFeed(url, { fetchFn = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const target = normalizeFeedUrl(url);
  if (!target) return { ok: false, error: 'not an http(s) or webcal link' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(target, {
      signal: ctl.signal,
      headers: { Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1' },
      redirect: 'follow',
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const text = await res.text();
    if (!/BEGIN:VCALENDAR/i.test(text)) return { ok: false, error: 'the link did not return a calendar (no BEGIN:VCALENDAR)' };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err && err.name === 'AbortError' ? `timed out after ${Math.round(timeoutMs / 1000)}s` : 'network error' };
  } finally {
    clearTimeout(timer);
  }
}

// Fetch + parse in one step, for the poll loop.
async function loadIcsEvents(url, opts = {}) {
  const r = await fetchIcsFeed(url, opts);
  if (!r.ok) return r;
  try {
    return { ok: true, events: parseIcsEvents(r.text, opts) };
  } catch {
    return { ok: false, error: 'the calendar could not be parsed' };
  }
}

// One list from both sources. When the same meeting is on both (someone's
// Google calendar also published as a feed), keep Google's: it carries the
// owner's RSVP, which a feed can't. Same meeting = same start + same title.
function mergeCalendarSources(googleEvents, icsEvents) {
  const g = Array.isArray(googleEvents) ? googleEvents : [];
  const i = Array.isArray(icsEvents) ? icsEvents : [];
  const key = (e) => `${Date.parse(e.start) || e.start}|${String(e.summary || '').trim().toLowerCase()}`;
  const seen = new Set(g.map(key));
  return g.concat(i.filter((e) => !seen.has(key(e))));
}

module.exports = {
  normalizeFeedUrl,
  parseIcsEvents,
  fetchIcsFeed,
  loadIcsEvents,
  mergeCalendarSources,
};
