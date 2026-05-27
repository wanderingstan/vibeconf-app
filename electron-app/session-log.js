// Session log (#173): tee process.stdout / process.stderr to a per-session
// file so we can post-mortem when something went weird mid-call. The
// `get_session_log` MCP tool reads from the same file so agents can inspect
// their own recent log lines without leaving the call.

const fs = require('fs');
const path = require('path');

const MAX_RETAINED_SESSIONS = 10;

let _filePath = null;
let _logStream = null;

function pad(n) { return String(n).padStart(2, '0'); }

function timestampForFilename(d = new Date()) {
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
  ].join('-') + 'T' + [
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join('-');
}

function pruneOldSessions(dir) {
  try {
    const entries = fs.readdirSync(dir)
      .filter(f => f.startsWith('session-') && f.endsWith('.log'))
      .map(f => ({ name: f, full: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const entry of entries.slice(MAX_RETAINED_SESSIONS)) {
      try { fs.unlinkSync(entry.full); } catch {}
    }
  } catch {}
}

// Tee stdout/stderr to a file under {userDataDir}/logs/session-{ts}.log.
// Idempotent: subsequent calls return the existing file path.
function initSessionLog({ userDataDir, header = {} } = {}) {
  if (_filePath) return _filePath;
  if (!userDataDir) throw new Error('initSessionLog requires userDataDir');

  const logsDir = path.join(userDataDir, 'logs');
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch {}
  pruneOldSessions(logsDir);

  const filePath = path.join(logsDir, `session-${timestampForFilename()}.log`);
  const logStream = fs.createWriteStream(filePath, { flags: 'a' });

  // Header. Helps when comparing two bots' logs side by side.
  const headerLines = [
    `[session-log] Vibeconferencing session log`,
    `[session-log] started=${new Date().toISOString()}`,
    `[session-log] pid=${process.pid}`,
    ...Object.entries(header).map(([k, v]) => `[session-log] ${k}=${v}`),
    `[session-log] ---`,
    '',
  ].join('\n');
  try { logStream.write(headerLines); } catch {}

  // Tee stdout/stderr. We wrap .write so that console.log/warn/error and any
  // direct writes all land in the file too. Async-iterator and stream-pipe
  // cases also funnel through .write so this is comprehensive.
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = (chunk, ...rest) => {
    try { logStream.write(typeof chunk === 'string' ? chunk : chunk); } catch {}
    return origStdoutWrite(chunk, ...rest);
  };
  process.stderr.write = (chunk, ...rest) => {
    try { logStream.write(typeof chunk === 'string' ? chunk : chunk); } catch {}
    return origStderrWrite(chunk, ...rest);
  };

  _filePath = filePath;
  _logStream = logStream;
  return filePath;
}

// Append a header line after init — used to backfill bot name / room id once
// they're known (they're not available at app startup).
function logSessionHeaderUpdate(key, value) {
  if (!_logStream) return;
  try {
    _logStream.write(`[session-log] ${key}=${value} (updated at ${new Date().toISOString()})\n`);
  } catch {}
}

// Read recent lines from the current session's log. Used by the local-server
// endpoint that backs the get_session_log MCP tool.
function getRecentSessionLog({ lines = 200, grep = null } = {}) {
  if (!_filePath) return { filePath: null, content: '', truncated: false };
  let content;
  try {
    content = fs.readFileSync(_filePath, 'utf8');
  } catch (err) {
    return { filePath: _filePath, content: '', error: String(err) };
  }
  let arr = content.split('\n');
  const totalLines = arr.length;
  if (grep) {
    let re;
    try { re = new RegExp(grep, 'i'); }
    catch { return { filePath: _filePath, content: '', error: `invalid grep pattern: ${grep}` }; }
    arr = arr.filter(l => re.test(l));
  }
  const truncated = arr.length > lines;
  arr = arr.slice(-lines);
  return {
    filePath: _filePath,
    content: arr.join('\n'),
    truncated,
    totalLines,
    returnedLines: arr.length,
  };
}

function getSessionLogPath() {
  return _filePath;
}

module.exports = {
  initSessionLog,
  logSessionHeaderUpdate,
  getRecentSessionLog,
  getSessionLogPath,
};
