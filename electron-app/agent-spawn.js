// agent-spawn.js — launch the agent as OUR child process, not a Terminal window (#242).
//
// Today the app drives the agent by writing an AppleScript that types a shell
// command into Terminal.app. That works, and it stays the default, but it costs
// us three things:
//
//   1. We cannot see what the agent is doing. Terminal owns the pipe, so the only
//      window into the session is the transcript file Claude Code happens to
//      write — an undocumented implementation detail that has broken repeatedly.
//      (An earlier version of this comment said transcripts had stopped being
//      written for app-launched agents entirely; that was too strong. A headless
//      agent wrote a 92-line transcript on 2026-08-04. The failures are
//      intermittent, which is worse to build on than a clean absence.)
//   2. We cannot talk TO it. No stdin means the brain pane is read-only, and
//      call feedback has to route the long way round through the MCP server.
//   3. Quoting. The command crosses TWO escaping layers (AppleScript string, then
//      shell), which is why launch-command.js exists and why the workdir moving
//      to a path with spaces was a bug.
//
// Spawning directly fixes all three: argv is an ARRAY (no quoting at any layer),
// stdout is ours, and stdin exists for later.
//
// What it costs, and why this is opt-in for now: the Terminal window is also the
// UI. A user can see the agent think, answer a prompt, read an error, hit Ctrl-C.
// Headless, all of that has to be rebuilt or it is simply gone — so the failure
// modes below are handled explicitly rather than discovered on a call.

const { spawn } = require('child_process');

// Environment variables that identify a PARENT Claude session, which the bot's
// agent must not inherit.
//
// They leak whenever the app is started from inside a Claude Code session —
// which is every `pnpm dev` run during development, and never for a user opening
// the app from the Dock. A difference that exists only in development is exactly
// the kind that gets diagnosed as a product bug.
//
// The concrete damage is visible in the CLI itself. Launched with the marker
// inherited, the TUI prints:
//
//   ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker
//
// A bot agent is a session in its own right, not a subtask of whoever happened
// to launch the app, so strip the identity and let it start clean.
//
// A DENYLIST, not a CLAUDE_* wildcard: CLAUDE_CONFIG_DIR and friends are
// legitimate user configuration, and dropping those would break the very setups
// most likely to be running a customised install.
const PARENT_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
];

// Copy of `env` with any parent-session identity removed.
function cleanAgentEnv(env) {
  const out = { ...env };
  for (const k of PARENT_SESSION_VARS) delete out[k];
  return out;
}

// Build the agent's argv.
//
// Pure and exported for its own sake: this is the part that must be exactly
// right, and testing it should not require launching anything or having Claude
// Code installed. An ARRAY, never a string — the bot name is user-supplied and
// arrives here unescaped, which through the Terminal path meant stripping quotes
// out of it and hoping.
function buildAgentArgs({ meetCode, botName, dangerous, model, mcpConfigPath, onboardingCall = false }) {
  const args = [];
  // -p (print/headless) rather than an interactive session: there is no terminal
  // for an interactive one to draw in. The session still runs as long as the
  // agent keeps working — the /join-call loop only ends when it calls leave_call
  // — so this is "no UI", not "one shot". onboardingCall runs /onboarding-call
  // instead, which walks the user through setup rather than free conversation.
  const slashCmd = onboardingCall ? 'onboarding-call' : 'join-call';
  args.push('-p', `/${slashCmd} ${meetCode} ${botName}`.trim());
  // The whole point: NDJSON events instead of rendered terminal output.
  // --verbose is not optional here; the CLI rejects stream-json without it
  // ("When using --print, --output-format=stream-json requires --verbose").
  args.push('--output-format', 'stream-json', '--verbose');
  if (dangerous) args.push('--dangerously-skip-permissions');
  if (model) args.push('--model', model);
  if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');
  // Claude in Chrome, explicitly. It is not an ordinary MCP server entry the way
  // nanobanana is — the CLI wires it in itself, registering its own mcpConfig,
  // allowedTools and system prompt — so inheriting the user's ~/.claude.json
  // mcpServers above does NOT bring it along, and a bot session ends up without
  // browser tools even on a machine where the extension is installed and enabled.
  //
  // Every skip inside the CLI's chrome wiring is written as
  // `opts.chrome !== true && ENABLE_CFC !== true && <blocker>`, so passing the
  // flag explicitly is what gets past those blockers — including the MCP-related
  // ones this spawn already trips by pinning --strict-mcp-config.
  //
  // Harmless where Chrome is absent: the CLI still checks for the extension and
  // an eligible account, and quietly skips the wiring when either is missing.
  args.push('--chrome');
  return args;
}

// Headless CANNOT prompt for permission.
//
// Interactively, a permission request draws a prompt and waits for a keypress.
// With no terminal attached there is nobody to press it, so the agent stops —
// silently, on its first tool call, looking exactly like a bot that joined and
// then had nothing to say. That is the single worst failure shape in this app
// and the one we keep rediscovering.
//
// So the caller must not spawn headless without --dangerously-skip-permissions.
// Reported as a REASON rather than a boolean so the log can say what to change.
function headlessBlockedReason({ dangerous }) {
  if (!dangerous) {
    return 'permission prompts have nowhere to draw without a terminal — the agent '
      + 'would stall silently on its first tool call. Enable Dangerous Mode in '
      + 'Settings, or use the Terminal launcher.';
  }
  return null;
}

// Spawn the agent and wire its stdout into an activity source.
//
// `source` is a StreamActivitySource (agent-activity.js). Kept as a parameter
// rather than constructed here so that this module owns process lifecycle and
// that one owns parsing — the split that makes both testable alone.
function spawnHeadlessAgent({ claudePath, args, cwd, env, source, onExit, log = console.log }) {
  const child = spawn(claudePath, args, {
    cwd,
    env: cleanAgentEnv(env),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Close stdin at once. Measured: leaving it open costs THREE SECONDS on every
  // launch — under `-p` the CLI treats stdin as more prompt text and waits for it
  // ("Warning: no stdin data received in 3s, proceeding without it"), so an open
  // pipe nobody writes to is a delay on every single join.
  //
  // This is also the honest state of "talking back to the agent": stdin here is
  // prompt input, not a message channel, so holding it open would not have bought
  // the brain pane a write path anyway. That needs `--input-format stream-json`,
  // which changes how the prompt is delivered — a real change, not a flag to
  // sneak in now.
  child.stdin.end();

  child.stdout.on('data', (chunk) => source.push(chunk));

  // stderr is NOT activity — it is the CLI's own diagnostics (auth failures,
  // bad flags, crashes). Logged, never fed to the parser, because a stack trace
  // rendered as bot speech in the brain pane would be worse than losing it.
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) log('[agent-spawn] stderr:', text.slice(0, 500));
  });

  // Without this, a failed spawn (ENOENT — `claude` not on PATH, the usual one
  // for a GUI-launched Electron app) throws an unhandled 'error' event and takes
  // the whole app down. It has to be a caught, reported failure.
  child.on('error', (err) => {
    log('[agent-spawn] failed to launch:', err.code || err.message);
    if (onExit) onExit({ code: null, error: err });
  });

  child.on('exit', (code, signal) => {
    log('[agent-spawn] agent exited', signal ? `on ${signal}` : `with code ${code}`);
    if (onExit) onExit({ code, signal });
  });

  return child;
}

module.exports = { buildAgentArgs, headlessBlockedReason, spawnHeadlessAgent, cleanAgentEnv, PARENT_SESSION_VARS };
