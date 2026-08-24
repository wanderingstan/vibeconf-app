// chat-command.js — the command a HUMAN runs to talk to a bot in a terminal.
//
// A bot keeps one Claude session, named after itself (see agent-session.js), so
// the session the bot uses on calls is the same one a person can open directly.
// The only thing standing between them is knowing to cd into the right
// directory — which is buried under ~/Library/Application Support/… — and that
// `--resume` takes the bot's name.
//
// So this builds that one line. It is deliberately the SHELL form, not the
// AppleScript-escaped form: this string is shown to people and copied to the
// clipboard, and a pasted `cd \"/Users/…` is a confusing error on top of
// whatever they were already trying to do (the same lesson as asShellCommand in
// launch-command.js). Callers that need the Terminal path re-escape it there.
//
// Pure and tested for the reason every other command builder here is: it is
// interpolated into a shell command, and on macOS into an AppleScript string
// wrapping that shell command, so a quoting bug is an injection bug.

const { resolveSessionRef, resolveSessionId, resolveSessionName } = require('./agent-session.js');

// Single-quote for POSIX shells: everything inside is literal, and the only
// character that needs handling is the quote itself ('\'' closes, escapes, and
// reopens). Double quotes would leave $ and ` live inside a path we did not
// choose.
function shellQuote(s) {
  return `'${String(s == null ? '' : s).replace(/'/g, `'\\''`)}'`;
}

// `cd '<workdir>' && claude --resume <ref>`
//
// The ref is the session NAME by default, because that is the form a person can
// read, retype and remember — `claude --resume Jimmy`. The app itself resolves
// the name to an id before launching (planAgentSession), since `--resume <name>`
// hard-errors when a directory holds two sessions by the same name. That failure
// mode is worth avoiding for an unattended bot; for a human at a prompt it is a
// legible error they can act on, and the readable name is worth more.
//
// Passing an explicit id (the pinned-session escape hatch) uses the id instead —
// there is no name to prefer in that case.
function buildChatCommand({ workdir, sessionField, botName }) {
  const ref = resolveSessionRef(sessionField, botName);
  const arg = ref.kind === 'id' ? resolveSessionId(ref.id) : resolveSessionName(ref.name);
  // No session to resume — starting a fresh one in the right directory is still
  // most of the value, and is what the bot's very first launch does anyway.
  if (!arg) return `cd ${shellQuote(workdir)} && claude`;
  // `arg` is already restricted to [A-Za-z0-9 ._-] by agent-session.js, so a
  // name with a space stays one argument under these quotes and nothing else
  // can survive to be interpreted.
  return `cd ${shellQuote(workdir)} && claude --resume ${shellQuote(arg)}`;
}

module.exports = { buildChatCommand, shellQuote };
