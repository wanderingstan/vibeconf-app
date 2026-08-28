// calendar-polls-during-calls.test.mjs — being in a call must not blind the
// calendar poll (#550).
//
// startCalendarPolling's tick used to `return` outright whenever callStatus was
// 'in-call', a guard borrowed from startMeetDetection's pollForMeet ("no reason
// to poll or auto-join while already in a call").
//
// The auto-JOIN half of that is right: nothing should yank a bot out of a live
// call into a different one. The "don't even look" half was too broad, and cost:
//
//   1. Back-to-backs never fire — a bot in a 2:00 call cannot join the 3:00,
//      because it never sees it. Exactly the shape of per-student 1:1s.
//   2. Sibling profiles stranded — checkOtherProfilesForCalendarMatch lives
//      inside handleCalendarEvents, so an app in a call could not launch OTHER
//      bots for THEIR meetings either.
//   3. Nobody could be told a meeting was coming — not the panel, not the agent.
//
// Found live 2026-08-26: a laptop in a call was 25 minutes stale on a meeting
// whose time had changed. Its last [calendar] line was 10:57:03; the call it was
// in started at 10:57:32. A cloud box looked healthy only because it was idle.
//
// Source assertions: the polling loop needs Electron, a live localServer and a
// real backend to run. Same style as calendar-event-context.test.mjs.
//
// Run: node --test tests/calendar-polls-during-calls.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

const sliceOf = (needle, len) => {
  const i = main.indexOf(needle);
  assert.ok(i > 0, `expected to find ${needle}`);
  return main.slice(i, i + len);
};

test('pollCalendar no longer bails out when in a call', () => {
  const body = sliceOf('async function pollCalendar()', 1800);
  const upToFetch = body.slice(0, body.indexOf('websiteRequest'));
  assert.doesNotMatch(upToFetch, /if \(localServer\.callStatus === 'in-call'\) return;/,
    'the poll itself must run during a call — that is the whole point of #550');
  // The in-flight guard is a different thing and must stay.
  assert.match(upToFetch, /if \(calendarPollInFlight\) return;/,
    'overlapping polls are still suppressed');
});

test('handleCalendarEvents still refuses to auto-join out of a live call', () => {
  const body = sliceOf('function handleCalendarEvents(events)', 14000);
  assert.match(body, /if \(localServer\.callStatus === 'in-call'\) return;/,
    'the join half of the old guard must survive — nothing may yank a bot out of a live call');
});

test('the join guard sits AFTER the panel notice, not before it', () => {
  // The ordering IS the fix. Returning any earlier restores the blind spot:
  // the panel (and next the agent) must be able to say "there is another
  // meeting at three" precisely while the bot is in the 2 o'clock.
  const body = sliceOf('function handleCalendarEvents(events)', 14000);
  const notice = body.indexOf('pushUpcomingCalendarEvents(');
  const guard = body.indexOf("if (localServer.callStatus === 'in-call') return;");
  assert.ok(notice > 0 && guard > 0, 'both present');
  assert.ok(notice < guard,
    'the upcoming-meeting notice must be pushed before the in-call join guard returns');
});

test('sibling-profile launching still runs during a call', () => {
  // checkOtherProfilesForCalendarMatch is the first thing handleCalendarEvents
  // does. A bot being busy has nothing to do with whether ANOTHER bot should be
  // launched for its own meeting.
  const body = sliceOf('function handleCalendarEvents(events)', 14000);
  const sibling = body.indexOf('checkOtherProfilesForCalendarMatch(events)');
  const guard = body.indexOf("if (localServer.callStatus === 'in-call') return;");
  assert.ok(sibling > 0, 'still called');
  assert.ok(sibling < guard, 'and reached before the in-call guard returns');
});

test('a skipped join is not marked handled, so it is reconsidered later', () => {
  // The guard must be a plain early return — NOT a path that writes
  // joinedCalendarEventIds. Otherwise the event is remembered as done and never
  // joined once the call ends.
  const body = sliceOf("if (localServer.callStatus === 'in-call') return;", 200);
  assert.doesNotMatch(body.slice(0, 120), /joinedCalendarEventIds/,
    'skipping because we are busy must not mark the event as handled');
});

test("pollForMeet's own in-call guard is untouched", () => {
  // Different guard, different reason: scanning the browser for OTHER Meets
  // mid-call is genuinely pointless and used to spam notifications.
  const body = sliceOf('function pollForMeet()', 700);
  assert.match(body, /if \(localServer\.callStatus === 'in-call'\) return;/,
    'this one should stay exactly as it was');
});
