// call-phase.js — the bot's lifecycle through one call, in one place.
//
// A bot's participation has a beginning, a middle, and — new here — an END that
// outlasts the meeting. The phases bookend each other:
//
//   idle → navigating → joining → waiting-to-be-admitted → in-call
//                                                            ↓
//                                        after-call-work → call-complete
//
// `after-call-work` is the bot's wrap-up: it has left the Meet, but its agent is
// still working (summarising, filing, writing a receipt). The name is the term
// of art — "After-Call Work" is what contact-centre software calls exactly this
// state. It also dodges `post`, which in this codebase reads as HTTP.
//
// Two things make this a PHASE rather than an afterthought:
//
//   · The bot leaving is not the meeting ending. Other people — and other bots —
//     may still be talking. Only this bot's participation is over.
//   · Teardown belongs at the END of the phase, not at the start. clearRoom()
//     and closeClaudeTerminal() run at `call-complete`, so the transcript, the
//     room and every tool keep working while the agent wraps up.
//
// WHY THESE ARE PREDICATES, NOT COMPARISONS. Every consumer used to ask the same
// question negatively — `status !== 'idle' && status !== 'left'` — which means a
// newly added phase silently counts as "in a call". Both `after-call-work` and
// `call-complete` would have inherited that: the bot's-view region would have
// stayed expanded after the call, and updates would have stayed blocked forever.
// Naming the groups makes a new phase opt IN to each meaning instead.

// In lifecycle order. `left` used to sit at the end, declared and read but never
// set by anything; it is replaced by the two states below, which say what it was
// reaching for.
const CALL_PHASES = [
  'idle',
  'navigating',
  'joining',
  'waiting-to-be-admitted',
  'in-call',
  'after-call-work',
  'call-complete',
];

// The bot is in the meeting, or on its way in. Drives the bot's-view region and
// anything else that should track "is the bot actually in a room right now".
// after-call-work is deliberately NOT here — the bot has left.
const IN_CALL_PHASES = new Set(['navigating', 'joining', 'waiting-to-be-admitted', 'in-call']);

// Nothing is running: either we never started, or everything is torn down. This
// is what teardown-ish work should wait for.
const FINISHED_PHASES = new Set(['idle', 'call-complete']);

function isInCall(status) {
  return IN_CALL_PHASES.has(String(status || ''));
}

function isAfterCallWork(status) {
  return String(status || '') === 'after-call-work';
}

function isFinished(status) {
  return FINISHED_PHASES.has(String(status || ''));
}

// "Something is going on — don't yank the app out from under it."
//
// Broader than isInCall on purpose: an update that quits to install during
// after-call-work would kill the agent mid-wrap-up, which is the same failure as
// dropping it mid-sentence, just less visible.
function isBusy(status) {
  return isInCall(status) || isAfterCallWork(status);
}

// A call just ENDED, as opposed to never having started. `idle` covers both a
// fresh launch and a torn-down call, so anything that wants "we just finished a
// call" — offering a staged update, say — needs this narrower signal.
function isCallComplete(status) {
  return String(status || '') === 'call-complete';
}

module.exports = {
  CALL_PHASES,
  IN_CALL_PHASES,
  FINISHED_PHASES,
  isInCall,
  isAfterCallWork,
  isFinished,
  isBusy,
  isCallComplete,
};
