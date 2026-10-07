// supervisor.test.mjs — the fleet supervisor's decision core (#301).
//
// #301: with every bot window closed, no JavaScript runs for this app at all,
// so a calendar auto-join cannot fire. docs/multi-bot-architecture.md settled
// the shape — a supervisor process that owns the fleet — and this is its brain:
// given the profiles on disk, the events, the clock and what is already
// running, which profiles should be woken?
//
// It is a pure function precisely so this file can exist. The equivalent logic
// inside main.js (checkOtherProfilesForCalendarMatch) can only be tested by
// launching an app.
//
// Run: node --test tests/supervisor.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideWakeups, readFleet, upcomingForFleet } = require('../electron-app/supervisor.js');
const { eventDedupeKey } = require('../electron-app/calendar-auto-join.js');

const NOW = 1_800_000_000_000;
const soon = (ms) => new Date(NOW + ms).toISOString();

// A profile whose placeholder address is on the event, which is convention #1.
const bethany = { name: 'bethany', calendarIdentityEmail: 'bethany@vibe.test', botName: 'Bethany' };
const tagged = { name: 'coltrane', calendarIdentityEmail: '', botName: 'Coltrane' };

const event = (over = {}) => ({
  id: 'evt-1',
  summary: 'Office hours',
  start: soon(60_000),
  attendees: ['bethany@vibe.test'],
  ...over,
});

test('a matching event wakes the profile it belongs to', () => {
  const { wakeups } = decideWakeups({ profiles: [bethany], events: [event()], now: NOW });
  assert.equal(wakeups.length, 1);
  assert.equal(wakeups[0].profile, 'bethany');
  assert.equal(wakeups[0].event.id, 'evt-1');
});

test('the #vibeconf tag wakes a profile with no invite address', () => {
  // The second of the two invite conventions — nothing to configure but a name.
  const ev = event({ attendees: [], summary: 'Standup #vibeconf:Coltrane' });
  const { wakeups } = decideWakeups({ profiles: [tagged], events: [ev], now: NOW });
  assert.deepEqual(wakeups.map((w) => w.profile), ['coltrane']);
});

test('a profile that is ALREADY RUNNING is left alone', () => {
  // The one rule that differs from the in-bot version of this logic, and the
  // reason it differs: a running bot polls this very event for itself. Waking
  // it would steal window focus and put two things in a race to join one
  // meeting. The supervisor covers only what nothing else covers.
  const { wakeups } = decideWakeups({
    profiles: [bethany], events: [event()], now: NOW, running: new Set(['bethany']),
  });
  assert.deepEqual(wakeups, []);
});

test('a profile with no identity at all is never woken', () => {
  // No placeholder address and no name means no event can name it.
  const blank = { name: 'blank', calendarIdentityEmail: '', botName: '' };
  const { wakeups } = decideWakeups({ profiles: [blank], events: [event()], now: NOW });
  assert.deepEqual(wakeups, []);
});

test('an event the owner has not accepted does not boot a profile', () => {
  // Booting a whole bot for a meeting its owner has not RSVP'd to is worse than
  // being late to one — and if they accept later, a later tick wakes it.
  const { wakeups } = decideWakeups({
    profiles: [bethany], events: [event({ selfResponseStatus: 'needsAction' })], now: NOW,
  });
  assert.deepEqual(wakeups, []);
  // Accepting flips it, on the same event.
  const accepted = decideWakeups({
    profiles: [bethany], events: [event({ selfResponseStatus: 'accepted' })], now: NOW,
  });
  assert.equal(accepted.wakeups.length, 1);
});

test('an event outside the lookahead window is not yet actionable', () => {
  const { wakeups } = decideWakeups({
    profiles: [bethany], events: [event({ start: soon(60 * 60 * 1000) })], now: NOW,
  });
  assert.deepEqual(wakeups, []);
});

test('a woken profile is not woken again for the same occurrence', () => {
  const events = [event()];
  const first = decideWakeups({ profiles: [bethany], events, now: NOW });
  assert.equal(first.wakeups.length, 1);
  // The returned map is what the caller persists; feeding it back is the next tick.
  const second = decideWakeups({ profiles: [bethany], events, now: NOW + 1000, launched: first.launched });
  assert.deepEqual(second.wakeups, []);
});

test("today's occurrence of a recurring meeting is not suppressed by yesterday's", () => {
  // The reason the dedupe key is (id + occurrence start) and not the bare id: a
  // recurring series shares ONE id, so keying on it would mean a standing 1:1
  // fires once, ever.
  //
  // The earlier occurrence is seeded DIRECTLY, and recently enough to outlive
  // eviction (3h against a 24h retention). Seeding it via an earlier tick would
  // let this pass for the wrong reason: an entry old enough to be a different
  // day is also old enough to be evicted, so the test would still go green with
  // the bare id as the key.
  const threeHoursAgo = NOW - 3 * 60 * 60 * 1000;
  const earlier = event({ start: new Date(threeHoursAgo).toISOString() });
  const launched = { [`${eventDedupeKey(earlier)}:bethany`]: threeHoursAgo };
  const today = decideWakeups({ profiles: [bethany], events: [event()], now: NOW, launched });
  assert.equal(today.wakeups.length, 1, 'a recurring meeting must fire again on its next occurrence');
  // And the seeded entry is still there — this asserts against eviction, so if
  // retention ever shortens past 3h the test says so instead of going quietly green.
  assert.ok(Object.prototype.hasOwnProperty.call(today.launched, `${eventDedupeKey(earlier)}:bethany`),
    'the earlier occurrence was evicted, so this proved nothing about the key');
});

test('two profiles invited to one meeting each get woken', () => {
  // The dedupe key is suffixed with the profile name so they cannot cancel each
  // other out — one shared key would wake whichever was enumerated first and
  // silently drop the other.
  const ev = event({ attendees: ['bethany@vibe.test'], summary: 'Review #vibeconf:Coltrane' });
  const { wakeups } = decideWakeups({ profiles: [bethany, tagged], events: [ev], now: NOW });
  assert.deepEqual(wakeups.map((w) => w.profile).sort(), ['bethany', 'coltrane']);
});

test('a profile with two matching meetings is woken once, for the sooner', () => {
  // Waking twice in one tick is a redundant focus at best. The later event is
  // not lost — it is simply left unmarked, so the next tick reconsiders it.
  const near = event({ id: 'near', start: soon(30_000) });
  const far = event({ id: 'far', start: soon(200_000) });
  const { wakeups, launched } = decideWakeups({ profiles: [bethany], events: [far, near], now: NOW });
  assert.equal(wakeups.length, 1);
  assert.equal(wakeups[0].event.id, 'near');
  assert.ok(!Object.keys(launched).some((k) => k.startsWith('far')), 'the later event must stay unhandled');
});

test('the dedupe map does not grow without bound while the machine idles', () => {
  // A process whose entire job is to be always-on idles for weeks at a time, so
  // this is the normal case rather than the edge one.
  const stale = { 'ancient-key:bethany': NOW - 30 * 24 * 60 * 60 * 1000 };
  const { launched } = decideWakeups({ profiles: [], events: [], now: NOW, launched: stale });
  assert.deepEqual(Object.keys(launched), []);
});

test('deciding never mutates what it was given', () => {
  // The caller owns persistence. A decision that writes through its arguments
  // could not be tested by reading its return value, and could half-apply.
  const launched = {};
  const profiles = [bethany];
  decideWakeups({ profiles, events: [event()], now: NOW, launched });
  assert.deepEqual(launched, {}, 'the dedupe map passed in must be untouched');
  assert.deepEqual(profiles, [bethany]);
});

test('an empty fleet or an empty calendar decides nothing, quietly', () => {
  for (const args of [{ profiles: [], events: [event()] }, { profiles: [bethany], events: [] }]) {
    const { wakeups } = decideWakeups({ ...args, now: NOW });
    assert.deepEqual(wakeups, []);
  }
});

test('junk in the event list cannot stop the tick', () => {
  // These arrive over the network from a calendar the app does not own.
  const junk = [null, undefined, {}, { id: 'x' }, { id: 'y', start: 'not-a-date' }];
  const { wakeups } = decideWakeups({ profiles: [bethany], events: [...junk, event()], now: NOW });
  assert.equal(wakeups.length, 1, 'the real event must still be found');
});

test('one unreadable profile does not hide the rest of the fleet', () => {
  // A supervisor that stops watching the fleet because one folder is malformed
  // is the exact failure mode this issue is about.
  const fake = {
    listProfileNames: () => ['good', 'broken', 'alsogood'],
    readConfigFields: (dir) => {
      if (dir.endsWith('broken')) throw new Error('EACCES');
      return { calendarIdentityEmail: `${dir.split('/').pop()}@vibe.test`, botName: '' };
    },
  };
  const fleet = readFleet('/profiles', { profileManager: fake, path: { join: (a, b) => `${a}/${b}` } });
  assert.deepEqual(fleet.map((p) => p.name), ['good', 'alsogood']);
});

test('an unreadable profiles root yields an empty fleet, not a throw', () => {
  const fake = { listProfileNames: () => { throw new Error('ENOENT'); }, readConfigFields: () => ({}) };
  assert.deepEqual(readFleet('/nope', { profileManager: fake, path: { join: (a, b) => `${a}/${b}` } }), []);
});

// ── The window's Upcoming list ──
//
// upcomingForFleet is the supervisor showing the fleet's meetings with the
// bot's own display rule. Before it, every event on the owner's calendar was
// listed, so an all-day birthday with no bot on it read as the next meeting.

const HOUR = 60 * 60 * 1000;

test('an event no bot is on is not listed, however soon it is', () => {
  const birthday = event({ id: 'bday', summary: 'Chloe Birthday', start: new Date(NOW).toISOString().slice(0, 10), attendees: [] });
  const lunch = event({ id: 'lunch', summary: 'Lunch', start: soon(10 * 60_000), attendees: ['someone@else.test'] });
  assert.deepEqual(upcomingForFleet([birthday, lunch], [bethany, tagged], NOW), []);
});

test('an event a bot is on is listed, naming the bot', () => {
  const rows = upcomingForFleet([event()], [bethany, tagged], NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].forProfile, 'Bethany');
});

test('one event on two bots is one row naming both', () => {
  const both = event({ summary: 'Sync #vibeconf:Coltrane' }); // bethany by address, coltrane by tag
  const rows = upcomingForFleet([both], [bethany, tagged], NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].forProfile, 'Bethany, Coltrane');
});

test('the same 24h window and 5-minute grace as the panel', () => {
  const tomorrow = event({ id: 'far', start: soon(25 * HOUR) });
  const longGone = event({ id: 'gone', start: soon(-30 * 60_000) });
  const justStarted = event({ id: 'now', start: soon(-60_000) });
  const rows = upcomingForFleet([tomorrow, longGone, justStarted], [bethany], NOW);
  assert.deepEqual(rows.map((r) => r.id), ['now']);
});

test('soonest first; an unaccepted invite is listed but marked, and loses a same-minute tie', () => {
  const later = event({ id: 'later', start: soon(2 * HOUR) });
  const tentative = event({ id: 'tent', start: soon(HOUR), selfResponseStatus: 'needsAction' });
  const accepted = event({ id: 'acc', start: soon(HOUR), selfResponseStatus: 'accepted' });
  const rows = upcomingForFleet([later, tentative, accepted], [bethany], NOW);
  assert.deepEqual(rows.map((r) => r.id), ['acc', 'tent', 'later']);
  assert.equal(rows.find((r) => r.id === 'tent').ownerConfirmed, false);
});

test('a bot with neither an invite address nor a name matches nothing', () => {
  assert.deepEqual(upcomingForFleet([event()], [{ name: 'blank', calendarIdentityEmail: '', botName: '' }], NOW), []);
});

// ── Most recently used first ──
//
// Bots behave more like browser tabs than a fixed roster, so the window lists
// them by when they were last used. Each bot stamps lastUsedAt (launch, and
// getting into a call); a bot from before the stamp falls back to the mtime
// of its logs folder, which every launch writes to.

const join = (...parts) => parts.join('/');

test('lastUsedAt comes from the bot\'s own stamp when it has one', () => {
  const pm = { listProfileNames: () => ['a'], readConfigFields: () => ({ botName: 'A', lastUsedAt: 1234 }) };
  const fs = { statSync: () => { throw new Error('must not stat when the stamp exists'); } };
  assert.equal(readFleet('/p', { profileManager: pm, path: { join }, fs })[0].lastUsedAt, 1234);
});

test('an older bot without the stamp falls back to its logs folder\'s mtime', () => {
  const pm = { listProfileNames: () => ['old'], readConfigFields: () => ({ botName: 'Old' }) };
  const seen = [];
  const fs = { statSync: (p) => { seen.push(p); return { mtimeMs: 999 }; } };
  assert.equal(readFleet('/p', { profileManager: pm, path: { join }, fs })[0].lastUsedAt, 999);
  assert.deepEqual(seen, ['/p/old/logs']);
});

test('a bot with neither is simply never-used (null), not dropped', () => {
  const pm = { listProfileNames: () => ['new'], readConfigFields: () => ({ botName: 'New' }) };
  const fs = { statSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } };
  const fleet = readFleet('/p', { profileManager: pm, path: { join }, fs });
  assert.equal(fleet.length, 1);
  assert.equal(fleet[0].lastUsedAt, null);
});

test('profile-manager passes lastUsedAt through, and only as a number', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const pm = require('../electron-app/profile-manager.js');
  const root = mkdtempSync(join(tmpdir(), 'mru-'));
  mkdirSync(join(root, 'agent'));
  writeFileSync(join(root, 'agent', 'config.json'), JSON.stringify({ botName: 'X', lastUsedAt: 42 }));
  assert.equal(pm.readConfigFields(root).lastUsedAt, 42);
  writeFileSync(join(root, 'agent', 'config.json'), JSON.stringify({ botName: 'X', lastUsedAt: 'yesterday' }));
  assert.equal(pm.readConfigFields(root).lastUsedAt, null);
});

test('a bot stamps lastUsedAt at launch and on getting into a call', () => {
  const main = require('node:fs').readFileSync(new URL('../electron-app/main.js', import.meta.url), 'utf8');
  assert.match(main, /store\.set\('lastUsedAt', Date\.now\(\)\)/);
  assert.match(main, /await localServer\.start\(\);\s*\n\s*markLastUsed\(\);/);
  assert.match(main, /if \(status === 'in-call'\) markLastUsed\(\);/);
});
