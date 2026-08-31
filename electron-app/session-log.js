// Session log (#173): tee process.stdout / process.stderr to a per-session
// file so we can post-mortem when something went weird mid-call. The
// `get_session_log` MCP tool reads from the same file so agents can inspect
// their own recent log lines without leaving the call.

const fs = require('fs');
const path = require('path');

// Keep plenty of history — session logs are the raw material for post-hoc
// analysis (latency audits, turn-taking research) and we're hungry for data,
// not short on disk (Stan, 2026-07-05). Runaway logs are the real disk risk
// and are handled at the write path (EPIPE guards below), not by retention.
const MAX_RETAINED_SESSIONS = 100;

let _filePath = null;
let _logStream = null;
// #255: lines the backend has accepted since the counter was last reset. Reset
// when a call-log share is granted, so the troubleshooting window can show the
// share GROWING rather than a frozen number beside "still sharing" — which reads
// as though it has stalled.
let _sentCount = 0;

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
const REMOTE_MAX_ATTEMPTS = 5;      // requeue a failing batch this many times, then drop it
// #230: idle is where the volume was. The app polls the browser for a Meet
// every 5s while NOT in a call, so the queue was never empty and an idle
// instance POSTed every 3s indefinitely — ~80 Redis ops/minute doing nothing.
// A live tail only matters while something is happening; nobody is watching a
// line-by-line feed of an app sitting there.
const REMOTE_IDLE_INTERVAL_MS = 30_000;
const REMOTE_MAX_BACKOFF_MS = 5 * 60_000;   // never retry more than ~12x/hour while down
let _failures = 0;              // consecutive flush failures — drives the backoff
// Lines the backend REFUSED (4xx) since shipping last succeeded. Distinct from
// _sentCount, which must only ever count lines that were actually accepted —
// conflating the two is what let a silently-refused stream look healthy.
let _rejectedCount = 0;
let _authRefused = false;       // a 401/403 has been reported; stay quiet until recovery
let _flushIntervalMs = 3000;    // healthy cadence, restored on the first success
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
  // The timer that brought us here has now fired, so the handle is spent. Clear
  // it BEFORE any early return: _ensureFlushTimer() bails when _flushTimer is
  // truthy, so a stale handle left lying here disables the safety net that is
  // supposed to restart shipping.
  _flushTimer = null;

  if (_flushing || !_remote || !_remote.enabled) return;

  // #619 — EVERY early return from here down must still reschedule.
  //
  // These two used to `return` bare, and that silently ended remote logging for
  // the rest of the process. The queue is empty on any quiet tick — a 3s cadence
  // against a room where nobody has said anything easily finds one — and the
  // first time it happened, no further flush was ever scheduled. No error, no
  // retry, no log line, because no attempt was ever made again.
  //
  // Observed on vibeconf-cloud-ta 2026-08-31: 60 lines on the server, all from
  // around startup, against a 1.3 MB local log; an hour-long call shipped
  // nothing. `remoteLogging=true`, a valid login, and zero [remote-log] lines —
  // every signal an operator can see said it was working.
  //
  // Note the comment further down blaming the identical symptom on a 401 falling
  // through to the success path. That WAS a real bug and it was fixed. This is a
  // second, independent cause of the same silence, which is why fixing the first
  // one did not make remote logs usable.
  if (!_queue.length) { _rescheduleFlush(); return; }

  const base = (_remote.endpointBase() || '').replace(/\/$/, '');
  if (!base) { _rescheduleFlush(); return; } // backend URL not resolvable yet — keep buffering

  _flushing = true;
  const batch = _queue.splice(0, REMOTE_MAX_BATCH);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (_remote.token) headers['x-vibe-logs-token'] = _remote.token;
    // #386: authorize the write by the logged-in user's session when available.
    const _sess = _remote.sessionToken ? _remote.sessionToken() : '';
    if (_sess) headers['Cookie'] = 'vc_session=' + _sess;
    const resp = await fetch(`${base}/api/logs/${encodeURIComponent(_remote.instanceId)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ lines: batch, meta: _remote.meta ? _remote.meta() : {} }),
    });
    // 429 = the server is deliberately shedding load (it returns this when its
    // store is struggling). Drop the batch like any 4xx, but ALSO back off: a
    // 429 that does not change our cadence is just a politer 500, and the whole
    // point is to take weight off a backend that has asked us to.
    if (resp.status === 429) {
      _failures++;
      try { _logStream && _logStream.write(`[remote-log] shed by server (429), dropping ${batch.length} lines\n`); } catch {}
      return;   // `finally` still reschedules, now with the backoff applied
    }
    // On 5xx / network error (caught below) we requeue so a blip recovers.
    if (!resp.ok && resp.status >= 500) throw new Error(`HTTP ${resp.status}`);
    // On other 4xx (bad credentials / payload) DROP the batch — requeuing would
    // loop forever. But SAY SO, and do not count it as delivered.
    //
    // This fell through to the success path for a long time: a 401 dropped the
    // batch, added it to _sentCount anyway, reset _failures to 0, and wrote
    // nothing anywhere. The app then reported healthy shipping into a void, at
    // full cadence, indefinitely. Measured 2026-08-18: two machines' remote logs
    // held only the first ~96 seconds of a 54-minute call, with `remoteLogging`
    // still reading as ON and the local log running to 12,529 lines. That is the
    // entire reason remote logs have been useless for diagnosing anything.
    //
    // _failures++ so the backoff applies: a refusal that will not change is
    // exactly the traffic worth thinning. It still recovers on its own within
    // one backoff window (capped at 5min) once the cause is fixed.
    if (!resp.ok) {
      _failures++;
      _rejectedCount += batch.length;
      const isAuth = resp.status === 401 || resp.status === 403;
      // Auth refusals repeat every flush for as long as the login is missing,
      // so announce the state ONCE rather than papering the log with it — but
      // name the fix, because "unauthorized" alone has historically sent people
      // off to rotate a shared token that was not the credential in use (#439).
      if (!isAuth || !_authRefused) {
        if (isAuth) _authRefused = true;
        try {
          _logStream && _logStream.write(
            `[remote-log] REJECTED by backend (HTTP ${resp.status}) — dropped ${batch.length} lines`
            + `, ${_rejectedCount} total this session.`
            + (isAuth
              ? ' Not authorized to ship logs: sign in to vibeconferencing.com in the app.'
                + ' A bot profile has no login of its own (#440). Further auth refusals stay quiet'
                + ' until shipping recovers.'
              : '') + '\n');
        } catch { /* stream gone */ }
      }
      return;   // `finally` still reschedules, now with the backoff applied
    }
    _sentCount += batch.length;   // #255: only lines the backend ACCEPTED
    if (_authRefused || _rejectedCount) {
      try {
        _logStream && _logStream.write(
          `[remote-log] shipping recovered — ${_rejectedCount} lines were lost while refused\n`);
      } catch { /* stream gone */ }
    }
    _authRefused = false;
    _rejectedCount = 0;
    _failures = 0;   // recovered — back to the normal cadence
  } catch (e) {
    // Write the failure straight to the file stream (NOT console) to avoid
    // re-entering the stdout tee and recursing.
    try { _logStream && _logStream.write(`[remote-log] flush failed: ${e && e.message}\n`); } catch {}
    _failures++;
    // Give up on THIS batch after a while. The queue cap bounds memory, but the
    // thing that actually hurts is the traffic: a batch that will never be
    // accepted was being re-POSTed every 3s forever, and the newest lines could
    // never get through behind it.
    if (_failures <= REMOTE_MAX_ATTEMPTS) {
      _queue.unshift(...batch);
      if (_queue.length > REMOTE_MAX_QUEUE) _queue.splice(0, _queue.length - REMOTE_MAX_QUEUE);
    } else {
      try { _logStream && _logStream.write(`[remote-log] dropping ${batch.length} lines after ${_failures} failed attempts\n`); } catch {}
    }
  } finally {
    _flushing = false;
    _rescheduleFlush();
  }
}

// Self-scheduling instead of setInterval, so a failing endpoint can be backed
// off (#221).
//
// This is why the Aug 1 whiteboard outage would not recover on its own. The
// backend rate-limited its Redis and started 500ing; every app instance requeued
// its batch and re-POSTed on a FIXED 3s interval, forever, with no counter and
// no backoff despite a comment claiming it retried "once". The retries kept the
// database rate-limited, which is what broke room-state reads — so the logging
// held down the very thing it was waiting on. Whatever started it, this is what
// stopped it ending.
function _rescheduleFlush() {
  if (!_remote || !_remote.enabled) return;
  if (_flushTimer) clearTimeout(_flushTimer);
  // Prompt while a call is in any phase (joining and waiting-to-be-admitted
  // included — that is exactly when someone is tailing to see why a join is
  // failing); relaxed when idle.
  let active = true;
  try { active = _remote.isActive ? !!_remote.isActive() : true; } catch { /* assume active */ }
  const base = active ? (_flushIntervalMs || 3000) : REMOTE_IDLE_INTERVAL_MS;
  // 3s → 6s → 12s … capped. A struggling backend gets geometrically less load
  // from us rather than a constant drumbeat.
  const delay = _failures
    ? Math.min(base * Math.pow(2, Math.min(_failures, 8)), REMOTE_MAX_BACKOFF_MS)
    : base;
  _flushTimer = setTimeout(_flushRemote, delay);
  if (_flushTimer.unref) _flushTimer.unref();
}

// Safety net: schedule a flush if nothing is pending. Only works because
// _flushRemote() clears _flushTimer as its first act — otherwise this sees a
// spent handle, assumes a flush is coming, and never fires again.
function _ensureFlushTimer(intervalMs = 3000) {
  _flushIntervalMs = intervalMs;
  if (_flushTimer) return;
  _rescheduleFlush();
}

// Configure (or reconfigure) remote shipping. Safe to call before or after the
// log file is opened. `endpointBase` and `meta` are getters so the live
// website URL / current room are read at flush time, not frozen here.
function configureRemoteLog({ enabled = false, endpointBase, instanceId, token = '', sessionToken, meta, isActive, intervalMs } = {}) {
  _remote = {
    enabled: !!enabled,
    endpointBase: endpointBase || (() => ''),
    instanceId: instanceId || 'unknown',
    token: token || '',
    // #386: the vibeconferencing.com session (vc_session JWT). A getter so it's
    // read fresh each flush (login/logout changes it). Sent as a cookie so the
    // backend authorizes writes by USER, no bundled secret needed.
    sessionToken: sessionToken || (() => ''),
    meta: meta || (() => ({})),
    // #230: getter, read at schedule time — the call phase changes constantly
    // and freezing it here would pin the cadence to whatever was true at launch.
    isActive: isActive || null,
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

  // Writing to the REAL stdio can throw (EPIPE) when the parent pipe/terminal
  // that owned it has closed — common for a bot launched from a terminal that's
  // since been quit. If we let that throw, it becomes an uncaughtException whose
  // handler logs via console → process.stderr.write → origStderrWrite → EPIPE
  // again → an infinite loop that pegs the CPU and grows the session log without
  // bound (seen in the wild: an 11 GB log of repeated EPIPE traces). Swallow the
  // write error so the tee never throws — the line still reached the file and the
  // remote queue above.
  //
  // The try/catch alone is NOT enough: a socket EPIPE is usually delivered
  // ASYNCHRONOUSLY as an 'error' EVENT on the stream (the write() call itself
  // returns fine), so it bypasses the catch, becomes an uncaughtException, and
  // the loop happens anyway — that's how a beta56 instance still wrote a 26 GB
  // log of EPIPE traces (2026-07-05) despite the guard below. Swallow the
  // async path too by installing no-op error handlers on both streams.
  try { process.stdout.on('error', () => {}); } catch {}
  try { process.stderr.on('error', () => {}); } catch {}
  process.stdout.write = (chunk, ...rest) => {
    try { logStream.write(typeof chunk === 'string' ? chunk : chunk); } catch {}
    try { _enqueueChunk(chunk); } catch {}
    try { return origStdoutWrite(chunk, ...rest); } catch { return true; }
  };
  process.stderr.write = (chunk, ...rest) => {
    try { logStream.write(typeof chunk === 'string' ? chunk : chunk); } catch {}
    try { _enqueueChunk(chunk); } catch {}
    try { return origStderrWrite(chunk, ...rest); } catch { return true; }
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


// ── Sharing ONE call's log (#255) ────────────────────────────────────────────
//
// The session log spans the whole app run, so "share this call" must not mean
// "ship the file": that would hand over earlier calls the user never agreed to.
//
// Call boundaries are already in the content. Since #292 every call opens with
//
//   [call] id=<room>-<utc> room=<room> status=navigating started=<iso>
//
// minted on the first transition into an active state and cleared at the end,
// one per call, explicitly so a single session log can be split by call. So a
// slice is: that call's marker line, up to the next marker (or end of file).
// Anchoring on the marker rather than a byte offset is what guarantees the slice
// cannot begin before the call did.
function sliceCallLines(callId, logPath = getSessionLogPath()) {
  if (!callId || !logPath) return [];
  let text = '';
  try { text = require('fs').readFileSync(logPath, 'utf-8'); } catch { return []; }
  const lines = text.split('\n');
  // A marker for a DIFFERENT call ends the slice. Matching `[call] id=` alone
  // would also match this call's own later status lines, truncating it at the
  // first transition — so the boundary test is "a marker whose id is not ours".
  const isMarker = (l) => /\[call\] id=\S+/.test(l);
  const isOurs = (l) => l.includes(`[call] id=${callId} `) || l.includes(`[call] id=${callId}\n`) || l.includes(`[call] id=${callId}`);
  const start = lines.findIndex((l) => isMarker(l) && isOurs(l));
  if (start === -1) return [];
  const out = [];
  for (let i = start; i < lines.length; i++) {
    if (i > start && isMarker(lines[i]) && !isOurs(lines[i])) break;
    if (lines[i].length) out.push(lines[i]);
  }
  return out;
}

// POST a batch immediately, independent of the streaming queue and of whether
// streaming is enabled — that independence is the point: this is a one-off grant
// for a single call, not a change to the standing preference.
//
// Returns { ok, sent, error } rather than throwing: the caller is a button, and
// a share that silently did nothing is worse than no button at all.
async function sendLinesNow(lines, extraMeta = {}) {
  if (!_remote) return { ok: false, sent: 0, error: 'remote logging not configured' };
  if (!lines || !lines.length) return { ok: false, sent: 0, error: 'nothing to send' };
  const base = (_remote.endpointBase() || '').replace(/\/$/, '');
  if (!base) return { ok: false, sent: 0, error: 'no backend URL' };
  const headers = { 'Content-Type': 'application/json' };
  if (_remote.token) headers['x-vibe-logs-token'] = _remote.token;
  const sess = _remote.sessionToken ? _remote.sessionToken() : '';
  if (sess) headers['Cookie'] = 'vc_session=' + sess;
  const meta = { ...(_remote.meta ? _remote.meta() : {}), ...extraMeta };
  let sent = 0;
  // Chunked at the same batch size the streamer uses — a long call can exceed
  // whatever the backend accepts in one request.
  for (let i = 0; i < lines.length; i += REMOTE_MAX_BATCH) {
    const batch = lines.slice(i, i + REMOTE_MAX_BATCH);
    try {
      const resp = await fetch(`${base}/api/logs/${encodeURIComponent(_remote.instanceId)}`, {
        method: 'POST', headers, body: JSON.stringify({ lines: batch, meta }),
      });
      if (!resp.ok) return { ok: false, sent, error: `HTTP ${resp.status}` };
      sent += batch.length;
      _sentCount += batch.length;
    } catch (e) {
      return { ok: false, sent, error: (e && e.message) || 'network error' };
    }
  }
  return { ok: true, sent, error: null };
}

module.exports = {
  initSessionLog,
  logSessionHeaderUpdate,
  getRecentSessionLog,
  getSessionLogPath,
  configureRemoteLog,
  setRemoteLoggingEnabled,
  sliceCallLines,
  sendLinesNow,
  getSentCount: () => _sentCount,
  resetSentCount: () => { _sentCount = 0; },
  // #255's counter answers "is the share growing?". This answers the question
  // that was previously unanswerable from inside the app: "is anything being
  // refused?" A UI that shows only the sent count cannot tell a healthy stream
  // from one dropping every batch, because the old code advanced sent on both.
  getRejectedCount: () => _rejectedCount,
  isShippingRefused: () => _authRefused,
  // Test seam. Everything above is driven by a timer and by the stdout tee, so
  // the flush decision — the branch that silently counted refusals as delivered
  // for months — had no runtime coverage at all, only assertions about its
  // source text. That is how it survived. Exposing the two internals lets a
  // test stub fetch and assert on real behaviour rather than on a regex.
  __testing: {
    enqueue: (line) => _enqueueChunk(line),
    flush: () => _flushRemote(),
    reset: () => {
      _queue = []; _lineBuf = ''; _sentCount = 0; _rejectedCount = 0;
      _authRefused = false; _failures = 0;
      if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    },
    failures: () => _failures,
    queueLength: () => _queue.length,
  },
};
