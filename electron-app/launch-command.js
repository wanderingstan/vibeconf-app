// launch-command.js — build the shell command Join Call runs in Terminal.
//
// The command is handed to Terminal via AppleScript `do script "<cmd>"`, so it's
// quoted TWICE: `\"` in the JS string becomes a real `"` after AppleScript parses
// its string literal, which the shell then sees. The working dir MUST be quoted —
// #305 moved it from /tmp (no spaces) to …/Library/Application Support/… (spaces),
// and an unquoted `cd` split the path at the first space ("string not in pwd").
//
// Pure + tested so that quoting can't silently break again.

// Wrap a value in AppleScript-escaped double quotes, escaping any embedded quote.
function asQuoted(s) {
  return `\\"${String(s == null ? '' : s).replace(/"/g, '\\"')}\\"`;
}

// `cd "<workdir>" && [VIBECONF_LOCAL_PORT=<port> ]<innerCmd>`
// innerCmd is passed through verbatim (it already carries its own escaping for the
// /join-call argument). port is optional.
function buildTerminalCommand({ workdir, port, innerCmd }) {
  const env = (port === undefined || port === null || port === '') ? '' : `VIBECONF_LOCAL_PORT=${port} `;
  return `cd ${asQuoted(workdir)} && ${env}${innerCmd || ''}`;
}

module.exports = { asQuoted, buildTerminalCommand };
