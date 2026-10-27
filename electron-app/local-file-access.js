// local-file-access.js: turn an agent-supplied file reference into a real path,
// and prove the app can actually READ it before we promise anything.
//
// Two failures this exists for, both seen on a bot showing photos from a USB
// archive drive at "/Volumes/Stan-Exos14-Archive/Family Archives/...":
//
// 1. file:// URLs were opened with their percent-escapes intact, so
//    "Family%20Archives" hit ENOENT. A file URL is a URL: decode it with
//    fileURLToPath (spaces, %23, unicode, Windows drive letters), never by
//    stripping the scheme off.
//
// 2. macOS TCC (Privacy & Security > Files and Folders / Removable Volumes)
//    lets stat() through but denies open() with EPERM. The whiteboard asset
//    server only stat()ed at registration, so the asset registered "fine" and
//    the board then showed nothing. probeReadable() opens the file and reads a
//    byte, which is the check TCC actually enforces.
//
// Pure Node, no Electron: unit-tested from tests/local-file-access.test.mjs.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');

// Resolve a file reference to an absolute filesystem path. Accepts a file://
// URL (percent-decoded), "~/..." (home-relative), or an absolute path (used
// literally: a raw path is not a URL, so "%20" in it is a real "%20").
// Returns null for anything else (http:, data:, relative paths).
// Throws on a malformed file URL (e.g. a remote host, or an encoded "/").
function localPathFromRef(ref, { platform = process.platform, homedir = os.homedir() } = {}) {
  if (typeof ref !== 'string' || !ref) return null;
  if (/^file:/i.test(ref)) {
    return fileURLToPath(ref, { windows: platform === 'win32' });
  }
  if (ref.startsWith('~/')) return path.join(homedir, ref.slice(2));
  if (ref.startsWith('/')) return ref;
  if (platform === 'win32' && /^[a-zA-Z]:[\\/]/.test(ref)) return ref;
  return null;
}

// Why the app cannot read `p`, phrased for the AGENT (it is what the bot sees in
// the tool result) and loud enough for the log.
function describeReadError(err, p, { platform = process.platform } = {}) {
  const code = err && err.code;
  const base = `cannot read ${p}`;
  if (code === 'ENOENT') return `${base}: file not found (ENOENT)`;
  if (code === 'EISDIR') return `${base}: it is a directory, not a file`;
  const copyHint = 'Or copy the file somewhere readable (e.g. /tmp) and use that path.';
  // EPERM on macOS is the privacy-controls (TCC) signature: stat() works,
  // open() is refused. EACCES is ordinary Unix permissions, which matters
  // here because bots run as their own macOS users.
  if (code === 'EPERM' && platform === 'darwin') {
    const where = p.startsWith('/Volumes/')
      ? 'Removable Volumes (or Network Volumes)'
      : 'Files and Folders (Desktop/Documents/Downloads) or Full Disk Access';
    return `${base}: permission denied (EPERM). The file exists but macOS privacy settings are `
      + `blocking this app from reading it. Grant the app access under System Settings > `
      + `Privacy & Security > ${where}, signed in as the macOS user the bot runs as, then try again. `
      + copyHint;
  }
  if (code === 'EPERM' || code === 'EACCES') {
    return `${base}: permission denied (${code}). The file's permissions do not let the user this `
      + `app runs as read it (bots may run as their own OS user). ${copyHint}`;
  }
  return `${base}: ${(err && err.message) || String(err)}`;
}

// Open the file and read one byte. Returns the fs.Stats on success; throws an
// Error carrying a describeReadError() message (and the original .code) if the
// app cannot really read it. Synchronous on purpose: callers are registration
// paths that must answer before they hand out a URL.
function probeReadable(p, opts) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      const e = new Error('not a regular file');
      e.code = stat.isDirectory() ? 'EISDIR' : 'ENOTFILE';
      throw e;
    }
    if (stat.size > 0) fs.readSync(fd, Buffer.alloc(1), 0, 1, 0);
    return stat;
  } catch (err) {
    const e = new Error(describeReadError(err, p, opts));
    e.code = err && err.code;
    throw e;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

// load_url with a file:// URL: is the target something the app can read?
// Non-file URLs pass through untouched (the window reports its own load
// failures). Returns { ok } or { ok: false, error } phrased for the agent.
function checkLoadUrlTarget(url) {
  if (!/^file:/i.test(String(url))) return { ok: true };
  let p;
  try {
    p = localPathFromRef(String(url));
  } catch (err) {
    return { ok: false, error: `invalid file:// URL ${url}: ${err.message}. Percent-encode spaces (%20) and use file:///absolute/path.` };
  }
  try {
    probeReadable(p);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `load_url ${err.message}` };
  }
}

module.exports = { localPathFromRef, describeReadError, probeReadable, checkLoadUrlTarget };
