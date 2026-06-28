// Session log (#173): tee process.stdout / process.stderr to a per-session
// file so we can post-mortem when something went weird mid-call. The
// `get_session_log` MCP tool reads from the same file so agents can inspect
// their own recent log lines without leaving the call.

const fs = require('fs');
const path = require('path');

const MAX_RETAINED_SESSIONS = 10;

let _filePath = null;
let _logStream = null;

// --- Remote log shipping (opt-in) -----------------------------------------
// When enabled, every teed line is also queued and periodically POSTed to the
// backend (`/api/logs/{instanceId}`), so a session can be inspected from
// another machine (e.g. debugging Seth's bots) via get_session_log / the logs
// CLI. Off unless the `remoteLogging` pref is set. Lines may contain transcript
// text, so it's deliberately opt-in.
let _remote = null;        // { enabled, endpointBase(), instanceId, token, meta() }
let _queue = [];           // pending complete lines (strings)
let _lineBuf = '';         // partial trailing line not yet newline-terminated
let _flushTimer = null;
let _flushing = false;
const REMOTE_MAX_QUEUE = 5000;  // hard cap so a dead endpoint can't grow memory
const REMOTE_MAX_BATCH = 800;   // lines per POST

function _enqueueChunk(chunk) {
  if (!_remote || !_remote.enabled) return;
  const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  _lineBuf += s;
  let idx;
  while ((idx = _lineBuf.indexOf('\n')) !== -1) {
    const line = _lineBuf.slice(0, idx);
    _lineBuf = _lineBuf.slice(idx + 1);
    if (line.length) _queue.push(line);
  }
  if (_queue.length > REMOTE_MAX_QUEUE) _queue.splice(0, _queue.length - REMOTE_MAX_QUEUE);
}

async function _flushRemote() {
  if (_flushing || !_remote || !_remote.enabled || !_queue.length) return;
  const base = (_remote.endpointBase() || '').replace(/\/$/, '');
  if (!base) return; // backend URL not resolvable yet — keep buffering
  _flushing = true;
  const batch = _queue.splice(0, REMOTE_MAX_BATCH);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (_remote.token) headers['x-vibe-logs-token'] = _remote.token;
    const resp = await fetch(`${base}/api/logs/${encodeURIComponent(_remote.instanceId)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ lines: batch, meta: _remote.meta ? _remote.meta() : {} }),
    });
    // On 4xx (bad token / payload) DROP the batch — requeuing would loop forever.
    // On 5xx / network error (caught below) we requeue once so a blip recovers.
    if (!resp.ok && resp.status >= 500) throw new Error(`HTTP ${resp.status}`);
  } catch (e) {
    // Write the failure straight to the file stream (NOT console) to avoid
    // re-entering the stdout tee and recursing.
    try { _logStream && _logStream.write(`[remote-log] flush failed: ${e && e.message}\n`); } catch {}
    _queue.unshift(...batch);
    if (_queue.length > REMOTE_MAX_QUEUE) _queue.splice(0, _queue.length - REMOTE_MAX_QUEUE);
  } finally {
    _flushing = false;
  }
}

function _ensureFlushTimer(intervalMs = 3000) {
  if (_flushTimer) return;
  _flushTimer = setInterval(_flushRemote, intervalMs);
  if (_flushTimer.unref) _flushTimer.unref();
}

// Configure (or reconfigure) remote shipping. Safe to call before or after the
// log file is opened. `endpointBase` and `meta` are getters so the live
// website URL / current room are read at flush time, not frozen here.
function configureRemoteLog({ enabled = false, endpointBase, instanceId, token = '', meta, intervalMs } = {}) {
  _remote = {
    enabled: !!enabled,
    endpointBase: endpointBase || (() => ''),
    instanceId: instanceId || 'unknown',
    token: token || '',
    meta: meta || (() => ({})),
  };
  if (_remote.enabled) _ensureFlushTimer(intervalMs);
  return _remote.instanceId;
}

// Toggle at runtime (e.g. when the `remoteLogging` pref changes mid-session).
function setRemoteLoggingEnabled(enabled) {
  if (!_remote) return;
  _remote.enabled = !!enabled;
  if (_remote.enabled) _ensureFlushTimer();
}

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
    try { _enqueueChunk(chunk); } catch {}
    return origStdoutWrite(chunk, ...rest);
  };
  process.stderr.write = (chunk, ...rest) => {
    try { logStream.write(typeof chunk === 'string' ? chunk : chunk); } catch {}
    try { _enqueueChunk(chunk); } catch {}
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
  configureRemoteLog,
  setRemoteLoggingEnabled,
};
