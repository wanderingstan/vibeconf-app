/**
 * call-time.js — the bot's sense of time in a call.
 *
 * Bethany, via Stan (2026-08-31): the bots have no sense of time. They don't
 * know where they are in an hour-long meeting or how long they have been in it.
 *
 * That is exactly right, and it is a presentation gap rather than a missing
 * capability: `callStartedAt` and the calendar event's `end` are both already
 * in the status payload the agent is handed on every poll. Nothing ever
 * rendered them, so the agent had no way to know a thing the app knew.
 *
 * Why it matters beyond curiosity: an agent that cannot see the clock cannot
 * wind down. It will open a new topic at minute 58, answer at the same length
 * at the end as at the start, and be surprised when the room leaves.
 */

const MIN = 60_000;

/** "9m" · "52m" · "1h04m" — compact, because this prints on every single turn. */
function fmtDuration(ms) {
  const totalMin = Math.round(ms / MIN);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h}h${String(m).padStart(2, '0')}m` : `${h}h`;
}

/**
 * One short bracketed line: wall clock, time in the call, and time left when a
 * calendar event says when this is meant to finish.
 *
 *   [3:47pm · 52m into the call · 8m left of the scheduled hour]
 *
 * Returns '' rather than a partial line when there is no clock worth printing.
 * A line on every turn earns its place only by being short and always true.
 *
 * @param {object} status  the status payload from /api/sync
 * @param {number} [now]   injectable for tests
 */
function formatCallClock(status, now = Date.now()) {
  const wall = new Date(now).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit',
  }).replace(/\s?([AP])M$/i, (_, p) => p.toLowerCase() + 'm');

  const parts = [wall];

  const startedAt = status?.callStartedAt ? Date.parse(status.callStartedAt) : NaN;
  if (Number.isFinite(startedAt) && now >= startedAt) {
    parts.push(`${fmtDuration(now - startedAt)} into the call`);
  }

  // The calendar event's end is the only thing that knows the SHAPE of the
  // meeting — a bot that knows the start but not the end can only guess at the
  // call it walked into. Absent unless this join came from an invite.
  const endAt = status?.calendarEventContext?.end
    ? Date.parse(status.calendarEventContext.end) : NaN;
  if (Number.isFinite(endAt)) {
    const left = endAt - now;
    const scheduled = Number.isFinite(startedAt) && endAt > startedAt
      ? scheduledLength(status, startedAt, endAt) : null;
    if (left >= 0) {
      // "of the scheduled hour" reads better than a bare number and quietly
      // tells the agent how much of the meeting it has already used.
      parts.push(scheduled ? `${fmtDuration(left)} left of the scheduled ${scheduled}` : `${fmtDuration(left)} left`);
    } else {
      // Running over is the single most useful thing this line can say, and the
      // one an agent will otherwise never notice. Say it plainly.
      parts.push(`${fmtDuration(-left)} PAST the scheduled end`);
    }
  }

  return parts.length > 1 ? `[${parts.join(' · ')}]` : `[${wall}]`;
}

/** "hour" / "30m" / "1h30m" — how long the meeting was booked for. */
function scheduledLength(status, startedAt, endAt) {
  const bookedStart = status?.calendarEventContext?.start
    ? Date.parse(status.calendarEventContext.start) : NaN;
  // Prefer the booked start over when the bot happened to join: a bot that
  // joined ten minutes late would otherwise report a "50m" meeting.
  const from = Number.isFinite(bookedStart) ? bookedStart : startedAt;
  const ms = endAt - from;
  if (ms <= 0) return null;
  const mins = Math.round(ms / MIN);
  if (mins === 60) return 'hour';
  if (mins === 30) return 'half hour';
  return fmtDuration(ms);
}

export { formatCallClock, fmtDuration, scheduledLength };
