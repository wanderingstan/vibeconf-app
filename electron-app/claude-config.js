// claude-config.js — safe read + atomic write for ~/.claude.json.
//
// The durable ~/.claude.json holds the user's MCP servers AND auth tokens. Three ways to corrupt it,
// all guarded here:
//   1. read fails, fall back to {}, rewrite → erase every other MCP server.
//   2. non-atomic write crashes mid-flight → truncated file (which re-triggers #1 next run).
//   3. a plain temp+rename widens 0600 → 0644 (leaks a tokens file) and can clobber a concurrent write.
//
//   readClaudeConfigSafe — distinguishes "no file yet" from "present but unreadable/malformed", and
//     returns the file's mtime so the caller can detect a concurrent modification.
//   atomicWriteJson      — temp file + rename, but PRESERVES the target's permissions (defaults new
//     files to 0600), and refuses to write if the file changed since it was read.
//
// Extracted from main.js for testability (tests/claude-config.test.mjs).

const fs = require('fs');

/**
 * Read ~/.claude.json defensively.
 *   missing file (ENOENT)     -> { config: {}, readable: true,  mtimeMs: undefined } (safe to create)
 *   present but unreadable     -> { config: {}, readable: false, mtimeMs }            (DO NOT rewrite)
 *   present, malformed JSON    -> { config: {}, readable: false, mtimeMs }            (DO NOT rewrite)
 *   present, valid JSON object -> { config: <parsed>, readable: true, mtimeMs }
 * Callers MUST refuse to write when readable === false, and should pass mtimeMs back to
 * atomicWriteJson so a concurrent modification between read and write is caught.
 */
function readClaudeConfigSafe(claudeJsonPath) {
  let raw, mtimeMs;
  try {
    mtimeMs = fs.statSync(claudeJsonPath).mtimeMs;
    raw = fs.readFileSync(claudeJsonPath, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { config: {}, readable: true, mtimeMs: undefined };
    return { config: {}, readable: false, mtimeMs }; // exists but unreadable (perms/transient)
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { config: parsed, readable: true, mtimeMs };
    }
    return { config: {}, readable: false, mtimeMs }; // valid JSON but not an object — don't trust it
  } catch {
    return { config: {}, readable: false, mtimeMs }; // malformed / truncated JSON
  }
}

/**
 * Serialize `obj` to a sibling temp file, then rename over `filePath`. rename(2) is atomic within a
 * filesystem, so a crash never leaves a half-written config.
 *   - Permissions: the temp inherits the target's existing mode (never widens a 0600 tokens file);
 *     a brand-new file defaults to 0600.
 *   - Concurrency: pass opts.expectedMtimeMs (from readClaudeConfigSafe). If the target changed since
 *     the read — or appeared when we expected none — we abort instead of clobbering another writer.
 */
function atomicWriteJson(filePath, obj, opts = {}) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');

  // Preserve the target's permissions; default a new file to 0600 (it can hold auth tokens).
  let mode = 0o600;
  try { mode = fs.statSync(filePath).mode & 0o777; } catch { /* new file → 0600 */ }
  try { fs.chmodSync(tmp, mode); } catch { /* best effort */ }

  // Concurrency guard: bail if the file changed since the caller read it.
  if ('expectedMtimeMs' in opts) {
    let curMtimeMs;
    try { curMtimeMs = fs.statSync(filePath).mtimeMs; } catch { curMtimeMs = undefined; }
    if (curMtimeMs !== opts.expectedMtimeMs) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      throw new Error('claude-config: ~/.claude.json changed since read — aborting to avoid clobber');
    }
  }

  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

module.exports = { readClaudeConfigSafe, atomicWriteJson };
