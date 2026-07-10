// claude-model.js — resolve the `--model` flag for the launched Claude session.
//
// Pure and separately testable, because this string is interpolated into an
// AppleScript-wrapped shell command (`do script "claude --model <X> …"`). A
// resolution bug here is a command-injection bug, not a cosmetic one.
//
// The setting lives in the panel (Settings → "Claude Model") as a free-text field
// so a full model id works as well as an alias. Empty used to mean "pass no
// --model flag and let Claude pick", which in practice meant a coin flip on
// whichever model the CLI defaulted to that week. Sonnet is the right default for
// this workload, so empty now means sonnet.

// The default model for a launched session. One place, so main.js, the panel's
// placeholder, and the tests can't drift apart.
const DEFAULT_CLAUDE_MODEL = 'sonnet';

// Only characters that can appear in an alias ("sonnet") or a full model id
// ("claude-sonnet-4-5-20250929"). Everything else is dropped rather than escaped:
// this value is spliced into a shell command inside an AppleScript string, where
// quoting is already two layers deep and easy to get wrong.
const SAFE_CHARS = /[^A-Za-z0-9._-]/g;

// Returns the model string to pass to `--model`. Never empty, never unsafe.
//
// A value that sanitizes away to nothing (someone typed `"` or `$(…)`) falls back
// to the default rather than silently dropping the flag — an unexpected model is a
// smaller surprise than an unexpected shell.
function resolveClaudeModel(raw, fallback = DEFAULT_CLAUDE_MODEL) {
  const cleaned = String(raw ?? '').trim().replace(SAFE_CHARS, '');
  return cleaned || fallback;
}

// The full flag, ready to splice into the command. Always present now, so the
// launched session's model is explicit and visible in the Terminal window.
function claudeModelFlag(raw, fallback = DEFAULT_CLAUDE_MODEL) {
  return ` --model ${resolveClaudeModel(raw, fallback)}`;
}

module.exports = { DEFAULT_CLAUDE_MODEL, resolveClaudeModel, claudeModelFlag };
