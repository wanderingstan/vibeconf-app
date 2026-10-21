// claude-sessions.js: the user's recent Claude Code sessions, for the app
// window's Sessions list (Seth's idea: turn a session you already have into a
// bot, so it can talk about the work it has been doing).
//
// Claude Code keeps one transcript per session at
// ~/.claude/projects/<folder-key>/<session-id>.jsonl, a line of JSON per
// record. Besides the conversation it appends small bookkeeping records, and
// three of them are all this list needs:
//   {"type":"custom-title","customTitle":"VA pension", ...}   the session's name, as the
//                                                            Claude app's sidebar shows it
//   {"type":"last-prompt","lastPrompt":"…", ...}              what you last asked it
//   any user/assistant record carries "cwd"                   where it runs
// They are re-appended as the session goes, so the END of the file has the
// current ones. Transcripts can be enormous (a bot's own session reached
// 235 MB), so only the tail is ever read, with a look at the head as a
// fallback for the title.
//
// Pure Node: no Electron, so the tests run it against fixture folders.

const fs = require('fs');
const path = require('path');
const os = require('os');

const TAIL_BYTES = 128 * 1024;
const HEAD_BYTES = 64 * 1024;

function defaultRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

function readSlice(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// Whole JSON records from a slice of the file. A slice that starts mid-file
// starts mid-line, so its first (partial) line is dropped; one that ends
// mid-line loses its last.
function recordsIn(text, { fromStart }) {
  const lines = text.split('\n');
  if (!fromStart) lines.shift();
  const out = [];
  for (const line of lines) {
    if (!line || line[0] !== '{') continue;
    try { out.push(JSON.parse(line)); } catch { /* a cut line */ }
  }
  return out;
}

function tailRecords(file, size, bytes = TAIL_BYTES) {
  const start = Math.max(0, size - bytes);
  return recordsIn(readSlice(file, start, Math.min(bytes, size)), { fromStart: start === 0 });
}

// Title, last prompt and working directory, newest first.
function summarize(file, size) {
  let title = null;
  let lastPrompt = null;
  let cwd = null;
  const take = (recs) => {
    for (let i = recs.length - 1; i >= 0; i--) {
      const r = recs[i];
      if (!title && r.type === 'custom-title' && r.customTitle) title = String(r.customTitle);
      if (!title && r.type === 'agent-name' && r.agentName) title = String(r.agentName);
      if (!lastPrompt && r.type === 'last-prompt' && r.lastPrompt) lastPrompt = String(r.lastPrompt);
      if (!cwd && typeof r.cwd === 'string' && r.cwd) cwd = r.cwd;
    }
  };
  take(tailRecords(file, size));
  if ((!title || !cwd) && size > TAIL_BYTES) {
    take(recordsIn(readSlice(file, 0, Math.min(HEAD_BYTES, size)), { fromStart: true }));
  }
  return { title, lastPrompt, cwd };
}

// The most recently active sessions, newest first. `exclude(cwd)` drops
// sessions by where they run: the app passes "inside a bot's own profile",
// since those are bots already.
function listRecentSessions({ root = defaultRoot(), limit = 8, exclude = () => false } = {}) {
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return []; }
  const files = [];
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, d.name)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const file = path.join(root, d.name, n);
      try {
        const st = fs.statSync(file);
        if (st.isFile() && st.size > 0) files.push({ file, id: n.slice(0, -'.jsonl'.length), mtimeMs: st.mtimeMs, size: st.size });
      } catch { /* vanished */ }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out = [];
  for (const f of files) {
    if (out.length >= limit) break;
    let s;
    try { s = summarize(f.file, f.size); } catch { continue; }
    if (!s.cwd || exclude(s.cwd)) continue;
    out.push({ id: f.id, file: f.file, title: s.title, lastPrompt: s.lastPrompt, cwd: s.cwd, mtimeMs: f.mtimeMs, sizeBytes: f.size });
  }
  return out;
}

// Plain text of a message, or null for one that is not conversation: tool
// calls and results, and the harness's own <command…>/<system…> wrappers.
function messageText(rec) {
  const c = rec && rec.message && rec.message.content;
  let text = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    const parts = c.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text);
    text = parts.length ? parts.join('\n') : null;
  }
  if (!text) return null;
  text = text.trim();
  if (!text || text.startsWith('<')) return null;
  return text;
}

// The last few lines of conversation, oldest first, for the pane's preview.
function sessionExcerpt(file, { max = 6, maxChars = 600 } = {}) {
  let size;
  try { size = fs.statSync(file).size; } catch { return []; }
  const recs = tailRecords(file, size, 512 * 1024);
  const out = [];
  for (let i = recs.length - 1; i >= 0 && out.length < max; i--) {
    const r = recs[i];
    if (r.type !== 'user' && r.type !== 'assistant') continue;
    if (r.isMeta || r.isSidechain) continue;
    const text = messageText(r);
    if (!text) continue;
    out.push({
      role: r.type,
      text: text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text,
      at: r.timestamp || null,
    });
  }
  return out.reverse();
}

module.exports = { listRecentSessions, sessionExcerpt, summarize, messageText, defaultRoot };
