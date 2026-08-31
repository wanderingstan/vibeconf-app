// call-clock.test.mjs — #617: the bot's sense of time in a call.
//
// Bethany, via Stan: the bots don't know where they are in an hour-long
// meeting. The data was already in the status payload on every poll; nothing
// rendered it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatCallClock, fmtDuration, scheduledLength } from '../mcp-server/call-time.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = fs.readFileSync(join(root, 'mcp-server/server.js'), 'utf8');

const T = (s) => Date.parse(s);
const NOON = T('2026-08-31T19:00:00Z'); // a fixed instant; wall clock is local

test('durations stay compact — this prints on every single turn', () => {
  assert.equal(fmtDuration(9 * 60_000), '9m');
  assert.equal(fmtDuration(52 * 60_000), '52m');
  assert.equal(fmtDuration(64 * 60_000), '1h04m');
  assert.equal(fmtDuration(120 * 60_000), '2h');
  assert.equal(fmtDuration(0), '0m');
});

test('with no call started, it is just the wall clock', () => {
  const out = formatCallClock({}, NOON);
  assert.match(out, /^\[\d{1,2}:\d{2}[ap]m\]$/, out);
});

test('a call in progress reports how long it has been going', () => {
  const out = formatCallClock({ callStartedAt: new Date(NOON - 52 * 60_000).toISOString() }, NOON);
  assert.match(out, /52m into the call/, out);
});

test('a calendar end turns it into "where am I in this meeting"', () => {
  // THE ASK. An hour-long invite, 52 minutes in.
  const out = formatCallClock({
    callStartedAt: new Date(NOON - 52 * 60_000).toISOString(),
    calendarEventContext: {
      start: new Date(NOON - 52 * 60_000).toISOString(),
      end: new Date(NOON + 8 * 60_000).toISOString(),
    },
  }, NOON);
  assert.match(out, /52m into the call/, out);
  assert.match(out, /8m left of the scheduled hour/, out);
});

test('running over is stated plainly — the most useful thing it can say', () => {
  // An agent will never notice this by itself, and it is exactly when it should
  // stop opening new topics.
  const out = formatCallClock({
    callStartedAt: new Date(NOON - 70 * 60_000).toISOString(),
    calendarEventContext: {
      start: new Date(NOON - 70 * 60_000).toISOString(),
      end: new Date(NOON - 10 * 60_000).toISOString(),
    },
  }, NOON);
  assert.match(out, /10m PAST the scheduled end/, out);
  assert.doesNotMatch(out, /left/, 'never says "left" when it is over');
});

test('the scheduled length comes from the BOOKED start, not when the bot joined', () => {
  // A bot that joined ten minutes late would otherwise announce a "50m meeting"
  // and mislead itself about the shape of the call.
  const booked = new Date(NOON - 40 * 60_000).toISOString();
  const joined = new Date(NOON - 30 * 60_000).toISOString();
  const end = new Date(NOON + 20 * 60_000).toISOString();
  const out = formatCallClock({
    callStartedAt: joined,
    calendarEventContext: { start: booked, end },
  }, NOON);
  assert.match(out, /scheduled hour/, out);
  assert.match(out, /30m into the call/, 'still reports the bot\'s OWN time in the room');
});

test('common meeting lengths read as words', () => {
  const s = T('2026-08-31T19:00:00Z');
  assert.equal(scheduledLength({ calendarEventContext: { start: new Date(s).toISOString() } }, s, s + 60 * 60_000), 'hour');
  assert.equal(scheduledLength({ calendarEventContext: { start: new Date(s).toISOString() } }, s, s + 30 * 60_000), 'half hour');
  assert.equal(scheduledLength({ calendarEventContext: { start: new Date(s).toISOString() } }, s, s + 90 * 60_000), '1h30m');
});

test('garbage in the payload never produces a broken line', () => {
  // This renders on every turn, so a malformed timestamp must degrade to the
  // wall clock rather than print "NaNm into the call" forever.
  for (const status of [
    null, undefined, {},
    { callStartedAt: 'not a date' },
    { callStartedAt: null, calendarEventContext: { end: 'nope' } },
    { calendarEventContext: null },
    // A start in the FUTURE (clock skew) must not report negative time.
    { callStartedAt: new Date(NOON + 60_000).toISOString() },
  ]) {
    const out = formatCallClock(status, NOON);
    assert.doesNotMatch(out, /NaN|Invalid|undefined|-\d/, `${JSON.stringify(status)} -> ${out}`);
    assert.match(out, /^\[\d{1,2}:\d{2}[ap]m/, out);
  }
});

test('every wait_for_speech outcome carries the clock, including the silent ones', () => {
  // A bot that has been quiet for ten minutes is the one that most needs to
  // know it. Missing it on the timeout path would be the easiest thing to skip
  // and the worst one to skip.
  assert.match(server, /import \{ formatCallClock \} from '\.\/call-time\.js'/);
  assert.match(server, /const clockLine = '\\n' \+ formatCallClock\(status\)/);
  for (const anchor of [
    'New chat message',            // chat wake
    'No one spoke. Timed out',     // silence
    'BACKGROUND TICK',             // listening while others talk
    'Speech detected',             // the normal turn
  ]) {
    const i = server.indexOf(anchor);
    assert.ok(i > 0, `anchor missing: ${anchor}`);
    const window = server.slice(i - 200, i + 400);
    assert.ok(window.includes('${clockLine}'), `no clock on the "${anchor}" path`);
  }
});
