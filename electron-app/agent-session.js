// agent-session.js — resolve the `--resume` flag for the launched agent session.
//
// Pure and separately testable for the same reason claude-model.js is: this
// string is interpolated into an AppleScript-wrapped shell command on the macOS
// Terminal path (`do script "claude --resume <X> …"`), so a resolution bug here
// is a command-injection bug rather than a cosmetic one.
//
// The setting lives in the panel (Settings → "Session name/id"). Empty means
// "start a new session"; the SessionStart hook then records the id the CLI
// picked, so the next launch resumes it. See ensureClaudeReadyHook in main.js.

// Session ids are UUIDs, but the field accepts a name too, so this is the same
// conservative set claude-model.js uses. Everything else is DROPPED rather than
// escaped — quoting is already two layers deep on the Terminal path.
const SAFE_CHARS = /[^A-Za-z0-9._-]/g;

// The session id to resume, or '' for "start a new one".
//
// Unlike resolveClaudeModel there is no fallback: a value that sanitizes away to
// nothing must NOT silently become some other session. Starting fresh is the
// safe failure — the hook will then record the new id over the bad one.
function resolveSessionId(raw) {
  return String(raw ?? '').trim().replace(SAFE_CHARS, '');
}

// The full flag, ready to splice into the command. Empty string when there is no
// session to resume, so callers can concatenate unconditionally.
function claudeResumeFlag(raw) {
  const id = resolveSessionId(raw);
  return id ? ` --resume ${id}` : '';
}

// The DISPLAY name for the session (`--name`), which is what makes a bot's
// session findable as "Jimmy" instead of a UUID — in the CLI's prompt box, in
// /resume, and as `agentName` in the transcript.
//
// Separate from the id on purpose: the id has to be exact and machine-stable,
// the name only has to be readable, so this keeps spaces where resolveSessionId
// strips them. Same drop-don't-escape rule though — the bot name is user-typed
// and reaches the macOS path inside a shell command inside an AppleScript
// string, which is how `botName.replace(/"/g, '')` already exists nearby.
const NAME_SAFE_CHARS = /[^A-Za-z0-9 ._-]/g;

function resolveSessionName(raw) {
  // Collapse runs of whitespace before trimming, so a name that was mostly
  // stripped ("Jimmy 🤖") doesn't end up with a trailing gap.
  const cleaned = String(raw ?? '').replace(NAME_SAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  // Long enough for any real bot name, short enough that a paste accident can't
  // become the command line.
  return cleaned.slice(0, 60);
}

// The full flag, ready to splice into the AppleScript-wrapped command. The
// escaped quotes match how the prompt argument is already passed there, so a
// two-word bot name stays one argument.
function claudeNameFlag(raw) {
  const name = resolveSessionName(raw);
  return name ? ` --name \\"${name}\\"` : '';
}

// Is this session id actually resumable from `cwd`?
//
// This exists because a WRONG id is not a soft failure. Measured against the
// installed CLI:
//
//     $ claude --resume 0000…-4444 -p "say hi"
//     No conversation found with session ID: 0000…-4444
//     {"type":"result","subtype":"error_during_execution","is_error":true,…}
//
// The agent exits before doing anything. Through the app that is the worst
// failure shape there is — the bot joins the call and sits there mute, with the
// explanation in a Terminal window nobody is looking at.
//
// And it is not an edge case: sessions are stored PER WORKING DIRECTORY, so
// changing the Working Directory preference invalidates the recorded id. Two
// settings that are individually correct combine into a silently broken bot.
//
// Sessions live in ~/.claude/projects/<cwd with non-alphanumerics as dashes>/<id>.jsonl.
// That layout is undocumented, which is why the check only ever acts on POSITIVE
// evidence: the project directory exists AND the id is not in it. If the
// directory is missing — including because the CLI changed how it names them —
// this says nothing and the caller passes --resume through unchanged. Being
// wrong then costs a failed launch, exactly what happens today; being wrong the
// other way would silently drop a session the bot could have resumed.
function sessionExists(sessionId, cwd, { fs = require('fs'), path = require('path'), home = process.env.HOME || process.env.USERPROFILE } = {}) {
  const id = resolveSessionId(sessionId);
  if (!id || !cwd || !home) return true;
  try {
    const dir = path.join(home, '.claude', 'projects', String(cwd).replace(/[^A-Za-z0-9]/g, '-'));
    if (!fs.existsSync(dir)) return true; // can't tell — assume resumable
    return fs.existsSync(path.join(dir, `${id}.jsonl`));
  } catch {
    return true; // can't tell
  }
}

module.exports = {
  resolveSessionId, claudeResumeFlag, resolveSessionName, claudeNameFlag, sessionExists,
};
