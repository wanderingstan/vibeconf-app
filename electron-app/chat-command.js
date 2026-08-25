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
// The ref PRINTS as the session name — `claude --resume Jimmy` — because that is
// the form a person can read, retype and remember. But when the caller has a
// cached id for that name (the same one planAgentSession resolves before every
// bot launch, passed in as `cachedSessionId`), the command resumes by THAT id
// instead. `--resume <name>` hard-errors, or falls back to the interactive
// picker, the moment the working directory holds more than one session whose
// title matches — which a long-lived bot folder accumulates over time (renames,
// restarts, old bots). Resolving to an id sidesteps that without giving up the
// readable name: `--name` is what makes the CLI display it, not the arg to
// `--resume`.
//
// Passing an explicit id (the pinned-session escape hatch) always uses the id —
// there is no cache lookup or name to prefer in that case.
function buildChatCommand({ workdir, sessionField, botName, cachedSessionId }) {
  const ref = resolveSessionRef(sessionField, botName);
  const cached = ref.kind === 'name' ? resolveSessionId(cachedSessionId) : '';
  const arg = ref.kind === 'id' ? resolveSessionId(ref.id) : (cached || resolveSessionName(ref.name));
  // No session to resume — starting a fresh one in the right directory is still
  // most of the value, and is what the bot's very first launch does anyway.
  if (!arg) return `cd ${shellQuote(workdir)} && claude`;
  // `arg` is already restricted to [A-Za-z0-9 ._-] (name) or [A-Za-z0-9._-] (id)
  // by agent-session.js, so a name with a space stays one argument under these
  // quotes and nothing else can survive to be interpreted.
  return `cd ${shellQuote(workdir)} && claude --resume ${shellQuote(arg)}`;
}

module.exports = { buildChatCommand, shellQuote };
