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

// Undo the AppleScript quoting layer, for a command a HUMAN will handle.
//
// buildTerminalCommand escapes for `do script "…"`, so its output carries \" —
// correct for osascript, wrong for anything else. When the Terminal launch fails
// and we show or copy the command for the user to paste into a shell themselves,
// they need the form the shell would have seen, not the form osascript feeds it.
// Pasting the escaped one yields `cd \"/Users/…` and a confusing shell error on
// top of the failure they are already recovering from.
function asShellCommand(cmd) {
  return String(cmd == null ? '' : cmd).replace(/\\"/g, '"');
}

// The AppleScript that opens `cmd` in Terminal.
//
// Split out of main.js and made pure for the same reason buildTerminalCommand
// was: it broke in production and the inline version could not be tested.
//
// The bug (2026-08-17): the old script branched on `running` and, when Terminal
// was NOT running, did `do script "…" in window 1` — assuming that launching
// Terminal always auto-creates a window to reuse. It died with
//
//   45:287: execution error: Terminal got an error: Can't get window 1. (-1728)
//
// osascript exited non-zero, the agent was never launched, and the bot joined the
// call driverless with the brain pane stuck on "Waiting for the agent…".
//
// What is PROVEN about that failure, and what is not — because this launcher had
// worked since near the start of the project, and "what changed" matters:
//
//   Proven. The 45:287 source range decodes to exactly the `in window 1`
//   statement, so `running` was false and window 1 did not resolve. Terminal had
//   started that same second (pid 37561, 15:37:47) and was STILL showing zero
//   windows minutes later — so it did not merely lag, it never got an untitled
//   window at all.
//
//   NOT reproduced. 15+ cold launches from a shell — idle and under full CPU
//   load — all produced a window and all succeeded. Whatever put Terminal in a
//   windowless launch that day (launch-vs-run event semantics, TCC, Resume
//   state, or the GUI-app parent of the osascript) was not identified. Do not
//   trust a comment here that claims to name it.
//
// So the fix deliberately does not depend on knowing the cause. It removes the
// ASSUMPTION instead, and covers both candidate shapes:
//
//   1. Branch on the WINDOW COUNT, not on `running`. `running` was only ever a
//      proxy for "is there a window to reuse", and it is a wrong one — this
//      handles a Terminal that launches windowless and stays that way.
//   2. Wait briefly for the launch window. When the auto-created window merely
//      appears late, sampling the count immediately would miss it and leave an
//      empty window behind — the very double-window the original `in window 1`
//      existed to prevent.
//
// `wasRunning` is still what gates the reuse: an ALREADY-running Terminal's
// window 1 belongs to the user, and hijacking it to run the agent would be
// worse than opening one more window.
function buildTerminalLaunchScript(cmd) {
  return `tell application "Terminal"
  set wasRunning to running
  if not wasRunning then
    -- Launching Terminal may open a default window, asynchronously. Wait up to
    -- ~1s so we reuse it rather than leaving an empty one next to ours. It may
    -- also open NONE (window restore off) — the count check below covers that.
    repeat 20 times
      if (count of windows) > 0 then exit repeat
      delay 0.05
    end repeat
  end if
  if (not wasRunning) and (count of windows) > 0 then
    do script "${cmd}" in window 1
  else
    do script "${cmd}"
  end if
  activate
  -- Safe unconditionally: a do script always leaves a window, so unlike the old
  -- script this cannot be the thing that raises -1728.
  return id of front window
end tell`;
}

module.exports = { asQuoted, buildTerminalCommand, buildTerminalLaunchScript, asShellCommand };
