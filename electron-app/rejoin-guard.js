// rejoin-guard.js — should a join request be ignored as a duplicate? (#26)
//
// Pure so the rule is testable and stated once. It reads as an obvious
// three-way AND, which is exactly why it is worth pinning down: every clause
// has a real case behind it, and dropping any one of them either reintroduces
// the bug or blocks a legitimate join.

/**
 * @param {object} args
 * @param {string} args.requestedRoom  room the caller wants to join
 * @param {string} args.currentRoom    room the app believes it is in
 * @param {string} args.callStatus     idle | joining | waiting-to-be-admitted | in-call | left
 * @param {boolean} args.force         caller insists on rebuilding the session
 * @returns {boolean} true → answer "already in this call" and change nothing
 */
function shouldIgnoreRejoin({ requestedRoom, currentRoom, callStatus, force } = {}) {
  // An explicit force is the escape hatch for a genuinely wedged session.
  if (force) return false;
  // A different room is a real call switch, not a duplicate.
  if (!requestedRoom || !currentRoom || requestedRoom !== currentRoom) return false;
  // Only while the session is alive or on its way. From 'idle' or 'left' there
  // is nothing to protect, and refusing there would strand a bot that dropped
  // out and is trying to come back.
  return callStatus === 'in-call' || callStatus === 'joining';
}

module.exports = { shouldIgnoreRejoin };
