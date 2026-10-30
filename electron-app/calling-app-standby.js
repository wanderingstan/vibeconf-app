// calling-app-standby.js: keeping a bot that answers calling-app calls
// (Telegram, WhatsApp, the Twilio phone: #843/#882) actually waiting for them.
//
// Standby IS the bot's one call view: it sits on web.whatsapp.com (or the
// Telegram/phone page) and its preload watches for incoming calls. So anything
// else that wants the view (a Meet join, Google/Slack/Zoom sign-in) has to tear
// standby down, and nothing used to put it back unless a CALL ended (showIdle).
// Seen live 2026-10-27: the owner clicked "Sign in to Google" on a bot in
// WhatsApp standby, the sign-in failed, the view sat on accounts.google.com,
// and every WhatsApp call after that went unanswered with no error anywhere.
//
// These are the decisions, pure so they can be pinned without a desktop. main.js
// owns the side effects (which view, which window, the panel error).

const { isInCall, isFinished } = require('@vibeconferencing/calls/core/call-phase');

// A non-call use of the view (Slack or Zoom sign-in, say) gets at least this
// long before standby is put back, so the view is not yanked mid-transition.
const STANDBY_GRACE_MS = 60 * 1000;

// A teardown made FOR a call (a Meet link pasted, a calendar join) gets longer:
// the agent may still be starting, and the call status only leaves 'idle' once
// it asks to join. If no call has started by then, the join is dead anyway.
const STANDBY_CALL_GRACE_MS = 10 * 60 * 1000;

// While the owner has the bot's view on screen (popped out, as every sign-in
// route does), it is theirs until it has sat untouched (no navigation) this
// long. Typing a password does not navigate, but it does not take five minutes.
const STANDBY_ABANDON_MS = 5 * 60 * 1000;

// Google sign-in for the bot: in its own side window (openBotSignInWindow) or
// by navigating the bot's view. The view is the call during a call, and the
// calling-app standby between calls, so either of those means the side window.
// It is on the same cookie jar, so the login lands in the same place.
function googleSignInRoute({ callStatus, callingAppMode, standbyWanted } = {}) {
  if (isInCall(callStatus)) return 'window';
  if (callingAppMode || standbyWanted) return 'window';
  return 'view';
}

// Google sign-out clears cookies, then used to reload Meet home in the view so
// the panel showed the logged-out state. That reload is only safe when the view
// is free: mid-call it hangs up, in standby it stops answering calls. The
// cookies are gone either way, and the panel re-reads them.
function signOutMayNavigateView({ callStatus, callingAppMode, standbyWanted } = {}) {
  if (isInCall(callStatus)) return false;
  if (callingAppMode || standbyWanted) return false;
  return true;
}

// Something just replaced the standby view. How loud should that be?
//   'none'   : nothing to report (no standby was up, or it was not wanted any
//              more, i.e. deliberately switched off)
//   'call'   : a call is taking the view; routine, showIdle puts standby back
//   'warn'   : standby is gone with no call to bring it back: calls to the bot
//              go unanswered until it returns, so say so, in the log and the panel
function standbyTeardownSeverity({ callingAppMode, standbyWanted, callStatus, forCall } = {}) {
  if (!callingAppMode || !standbyWanted) return 'none';
  if (forCall || isInCall(callStatus)) return 'call';
  return 'warn';
}

// The safety net, run on a timer. Returns { action, reason }:
//   'ok'      : standby is up (or not wanted); clear any warning
//   'busy'    : a call or its after-call work owns the view; showIdle restores
//   'wait'    : the view was taken for something that may still be in progress
//   'restore' : nothing is using the view any more; put standby back
//
// `interruption` is what took the view: { at, forCall }, or null when nobody
// recorded it (an unknown path), in which case `firstSeenAt` (when the timer
// first noticed) stands in for it.
function standbyRecovery({
  standbyWanted,
  callingAppMode,
  callStatus,
  interruption = null,
  firstSeenAt = null,
  viewRevealed = false,
  lastViewActivityAt = null,
  now = Date.now(),
} = {}) {
  if (!standbyWanted || callingAppMode === standbyWanted) return { action: 'ok', reason: 'standby up or not wanted' };
  if (!isFinished(callStatus)) return { action: 'busy', reason: 'call status ' + callStatus };
  const since = (interruption && interruption.at) || firstSeenAt || now;
  const grace = interruption && interruption.forCall ? STANDBY_CALL_GRACE_MS : STANDBY_GRACE_MS;
  if (now - since < grace) return { action: 'wait', reason: 'within ' + Math.round(grace / 1000) + 's of the view being taken' };
  if (viewRevealed) {
    const last = Math.max(since, lastViewActivityAt || 0);
    if (now - last < STANDBY_ABANDON_MS) return { action: 'wait', reason: 'the bot view is on screen and in use' };
  }
  return { action: 'restore', reason: viewRevealed ? 'the bot view has sat untouched' : 'nothing is using the bot view' };
}

module.exports = {
  STANDBY_GRACE_MS,
  STANDBY_CALL_GRACE_MS,
  STANDBY_ABANDON_MS,
  googleSignInRoute,
  signOutMayNavigateView,
  standbyTeardownSeverity,
  standbyRecovery,
};
