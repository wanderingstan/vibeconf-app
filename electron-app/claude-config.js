// claude-config.js — safe read + atomic write for ~/.claude.json.
//
// The durable ~/.claude.json holds the user's MCP servers (ours AND everyone
// else's). If we read it, fail to parse, fall back to {}, and then rewrite the
// file, we silently erase every unrelated server. That happens for a truncated
// or momentarily-unreadable file — including one we ourselves truncated with a
// non-atomic write. These two helpers make that impossible:
//
//   readClaudeConfigSafe — distinguishes "no file yet" (safe to create) from
//     "present but unreadable/malformed" (must NOT be rewritten).
//   atomicWriteJson      — writes via a temp file + rename, so a crash mid-write
//     leaves the original intact instead of the truncated state that starts the
//     whole failure over on the next run.
//
// Extracted from main.js for testability (tests/claude-config.test.mjs).

const fs = require('fs');

/**
 * Read ~/.claude.json defensively.
 *   missing file (ENOENT)     -> { config: {}, readable: true }   (safe to create)
 *   present but unreadable     -> { config: {}, readable: false }  (DO NOT rewrite)
 *   present, malformed JSON    -> { config: {}, readable: false }  (DO NOT rewrite)
 *   present, valid JSON object -> { config: <parsed>, readable: true }
 * Callers MUST refuse to write when readable === false.
 */
function readClaudeConfigSafe(claudeJsonPath) {
  let raw;
  try {
    raw = fs.readFileSync(claudeJsonPath, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { config: {}, readable: true };
    return { config: {}, readable: false }; // exists but unreadable (perms/transient)
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { config: parsed, readable: true };
    }
    return { config: {}, readable: false }; // valid JSON but not an object — don't trust it
  } catch {
    return { config: {}, readable: false }; // malformed / truncated JSON
  }
}

/**
 * Serialize `obj` to a sibling temp file, then rename over `filePath`. rename(2)
 * is atomic within a filesystem, so a crash never leaves a half-written config.
 */
function atomicWriteJson(filePath, obj) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

module.exports = { readClaudeConfigSafe, atomicWriteJson };
