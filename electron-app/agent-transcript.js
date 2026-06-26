// agent-transcript.js — tail a Claude Code session transcript (JSONL) and turn
// its events into compact one-line strings for the on-camera debug overlay.
//
// The driving Claude session reports its transcript_path to the local-server
// (via the auto-installed PostToolUse hook on mcp__vibeconferencing__*). We tail
// that file and surface "what the agent is doing" — proof of life + an early
// "gone off the rails" signal — alongside the existing debug stats. Gated by the
// same `debugOverlay` toggle, so it's testing-only and never bot-controllable.

const fs = require('fs');

const MAX_LINES = 12;          // ring-buffer depth shown on the overlay
const SEED_TAIL_BYTES = 64 * 1024; // how much of an existing transcript to seed from

function clip(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function shortPath(p) {
  return String(p || '').split('/').slice(-2).join('/');
}

// "mcp__vibeconferencing__update_whiteboard" -> "update_whiteboard"; plain tool
// names pass through. Keeps the overlay readable.
function prettyToolName(name) {
  const n = String(name || '?');
  if (n.startsWith('mcp__')) { const p = n.split('__'); return p.slice(2).join('__') || n; }
  return n;
}

// A compact, content-light hint of what a tool call is doing. We deliberately
// surface the salient arg (command / file / pattern), not the whole input.
function briefToolInput(input) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return clip(input.command, 48);
  if (typeof input.file_path === 'string') return shortPath(input.file_path);
  if (typeof input.path === 'string') return shortPath(input.path);
  if (typeof input.pattern === 'string') return clip(input.pattern, 36);
  if (typeof input.query === 'string') return clip(input.query, 36);
  if (typeof input.url === 'string') return clip(input.url, 44);
  if (typeof input.prompt === 'string') return clip(input.prompt, 36);
  if (typeof input.description === 'string') return clip(input.description, 36);
  return '';
}

// One transcript JSONL entry -> 0..N display lines. An assistant turn can carry
// both reasoning text and tool calls, so it may yield several lines.
function formatEntry(entry) {
  const out = [];
  try {
    const type = entry && entry.type;
    const content = entry && entry.message && entry.message.content;
    if (type === 'assistant') {
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text && block.text.trim()) {
            out.push('🗣 ' + clip(block.text, 60));
          } else if (block.type === 'tool_use') {
            const b = briefToolInput(block.input);
            out.push('🔧 ' + prettyToolName(block.name) + (b ? ': ' + b : ''));
          }
        }
      } else if (typeof content === 'string' && content.trim()) {
        out.push('🗣 ' + clip(content, 60));
      }
    } else if (type === 'user') {
      // Real user prompt = string content. tool_result blocks are noise; skip.
      if (typeof content === 'string' && content.trim()) {
        out.push('💬 ' + clip(content, 56));
      } else if (Array.isArray(content)) {
        const txt = content.find((b) => b.type === 'text' && b.text);
        if (txt) out.push('💬 ' + clip(txt.text, 56));
      }
    }
  } catch { /* malformed entry — skip */ }
  return out;
}

class TranscriptTailer {
  constructor({ onLines } = {}) {
    this.path = null;
    this.sessionId = null;
    this.offset = 0;
    this.partial = '';
    this.lines = [];
    this.watcher = null;
    this.poll = null;
    this.onLines = onLines || (() => {});
  }

  // Point the tailer at a (new) transcript. Idempotent for the same path.
  bind(transcriptPath, sessionId) {
    if (!transcriptPath) return;
    if (transcriptPath === this.path) { this.sessionId = sessionId; return; }
    this.stop();
    this.path = transcriptPath;
    this.sessionId = sessionId;
    this.offset = 0;
    this.partial = '';
    this.lines = [];
    this._seed();
    this._pump();
    try {
      this.watcher = fs.watch(transcriptPath, { persistent: false }, () => this._pump());
    } catch { /* watch unsupported here — poll covers it */ }
    this.poll = setInterval(() => this._pump(), 1500);
    if (this.poll.unref) this.poll.unref();
  }

  // Seed the ring buffer from the tail of an already-populated transcript so the
  // overlay isn't blank when we attach mid-session.
  _seed() {
    try {
      const size = fs.statSync(this.path).size;
      this.offset = size;
      const start = Math.max(0, size - SEED_TAIL_BYTES);
      const fd = fs.openSync(this.path, 'r');
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      let text = buf.toString('utf-8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop partial first line
      const seeded = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let entry; try { entry = JSON.parse(line); } catch { continue; }
        for (const l of formatEntry(entry)) seeded.push(l);
      }
      this.lines = seeded.slice(-MAX_LINES);
      if (this.lines.length) this.onLines(this.getLines());
    } catch { /* file may not exist yet — that's fine */ }
  }

  _pump() {
    if (!this.path) return;
    try {
      const size = fs.statSync(this.path).size;
      if (size < this.offset) { this.offset = 0; this.partial = ''; } // truncated/rotated
      if (size <= this.offset) return;
      const fd = fs.openSync(this.path, 'r');
      const buf = Buffer.alloc(size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      fs.closeSync(fd);
      this.offset = size;
      const text = this.partial + buf.toString('utf-8');
      const parts = text.split('\n');
      this.partial = parts.pop(); // trailing fragment (incomplete line)
      let changed = false;
      for (const line of parts) {
        if (!line.trim()) continue;
        let entry; try { entry = JSON.parse(line); } catch { continue; }
        for (const l of formatEntry(entry)) { this.lines.push(l); changed = true; }
      }
      if (this.lines.length > MAX_LINES) this.lines = this.lines.slice(-MAX_LINES);
      if (changed) this.onLines(this.getLines());
    } catch { /* transient read error — next pump retries */ }
  }

  getLines() { return this.lines.slice(); }

  stop() {
    if (this.watcher) { try { this.watcher.close(); } catch { /* ignore */ } this.watcher = null; }
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
  }
}

module.exports = { TranscriptTailer, formatEntry, MAX_LINES };
