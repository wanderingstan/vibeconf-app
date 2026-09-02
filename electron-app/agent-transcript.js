// agent-transcript.js — tail a Claude Code session transcript (JSONL) and turn
// its events into compact one-line strings for the on-camera debug overlay.
//
// The driving Claude session reports its transcript_path to the local-server
// (via the auto-installed PostToolUse hook on mcp__vibeconferencing__*). We tail
// that file and surface "what the agent is doing" — proof of life + an early
// "gone off the rails" signal — alongside the existing debug stats. Gated by the
// same `debugOverlay` toggle, so it's testing-only and never bot-controllable.

const fs = require('fs');

// Ring-buffer depth — and why there are two of these now (#532).
//
// There used to be exactly one, `MAX_LINES = 16`, and its own comment said what
// it had been sized for: "fills the side column next to the stats". That is the
// on-camera debug overlay — a narrow column drawn onto the bot's virtual camera
// next to the health stats. 16 lines is right for that surface.
//
// The brain window (#242) then reused this same buffer, deliberately: it is "a
// surface over an existing signal rather than a new pipeline". Reusing the
// signal was the correct call, but it silently inherited a depth chosen for a
// 16-line strip on a video tile and applied it to a full-height scrollable
// window. The window could never show more than 16 lines of scrollback, because
// nothing above it had kept any — the history was discarded here, at the source.
//
// So the BUFFER is deep and the overlay slices its own tail at draw time
// (page-inject.js). One pipeline, two depths, and neither consumer can shrink
// the other's.
const BUFFER_MAX_LINES = 1000;  // what we KEEP — the brain window's scrollback
const OVERLAY_MAX_LINES = 16;   // what the camera overlay DRAWS, sliced at render time

// How much of an already-populated transcript to seed from when we attach
// mid-session.
//
// MEASURED 2026-09-02 over the 12 largest local Claude Code transcripts (58.7 MB,
// 7,576 display lines): a JSONL transcript costs ~7.7 KB per line this module
// actually displays. Nearly all of that is tool_result payloads, which
// formatEntry deliberately drops — so the ratio is brutal and stable.
//
// The old 64 KB window therefore seeded about EIGHT lines. That was invisible
// while the buffer was 16 deep; with a 1000-line buffer it would have been the
// whole bug again one layer down — a deep buffer that still starts nearly empty,
// on a transcript already sitting complete on disk. 8 MB is the tail that
// actually fills 1000 lines (measured: 8 MB -> 1,003 lines, read + parsed in
// 25 ms, once per bind). Sessions smaller than that are simply read whole.
const SEED_TAIL_BYTES = 8 * 1024 * 1024;

// Collapse whitespace to a single line. No ellipsis truncation — the overlay
// lets text run to (and off) the canvas edge, using as much surface as fits.
// The generous cap only guards per-frame draw cost against a pathological
// multi-KB tool arg; it sits far beyond the visible width, so it never shows
// as a cut-off line.
function oneLine(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > 200 ? t.slice(0, 200) : t;
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
  if (typeof input.command === 'string') return oneLine(input.command);
  if (typeof input.file_path === 'string') return shortPath(input.file_path);
  if (typeof input.path === 'string') return shortPath(input.path);
  if (typeof input.pattern === 'string') return oneLine(input.pattern);
  if (typeof input.query === 'string') return oneLine(input.query);
  if (typeof input.url === 'string') return oneLine(input.url);
  if (typeof input.prompt === 'string') return oneLine(input.prompt);
  if (typeof input.description === 'string') return oneLine(input.description);
  return '';
}

// The model that authored an assistant entry, or null. '<synthetic>' entries
// (Claude Code's own summarization/compaction turns) aren't the bot replying,
// so they don't count as a model observation.
function entryModel(entry) {
  const model = entry && entry.type === 'assistant' && entry.message && entry.message.model;
  return (model && model !== '<synthetic>') ? model : null;
}

// Token usage off an assistant entry, or null. `input` is the FULL prompt the
// model processed for that turn — fresh tokens plus cache reads plus cache
// writes — i.e. the per-round context size. This is the ground truth for "how
// big is the prompt we hand the agent each round" (#345): the API reports it
// per turn and the transcript already carries it; nothing else in the app can
// see it. One API turn can span several JSONL entries (one per content block)
// sharing the same message id and usage, so callers dedupe on `msgId`.
function entryUsage(entry) {
  if (!entry || entry.type !== 'assistant' || !entry.message) return null;
  if (entry.message.model === '<synthetic>') return null;
  const u = entry.message.usage;
  if (!u) return null;
  const fresh = u.input_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheCreate = u.cache_creation_input_tokens || 0;
  return {
    msgId: entry.message.id || null,
    input: fresh + cacheRead + cacheCreate,
    fresh,
    cacheRead,
    cacheCreate,
    output: u.output_tokens || 0,
  };
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
            out.push('🗣 ' + oneLine(block.text));
          } else if (block.type === 'thinking') {
            // Reasoning, when we are given any.
            //
            // MEASURED 2026-08-04, CLI 2.1.219: we are not. The block arrives
            // with `signature` set and `thinking` an EMPTY STRING — 1,159 of them
            // in one session's transcript, zero characters between them. Same
            // through the stream transport, with or without
            // --include-partial-messages (thinking_delta is empty too), and
            // --thinking-display only accepts summarized|omitted, neither of
            // which populates it.
            //
            // So this is plumbing for a payload the CLI currently withholds. Kept
            // because it is three lines, it serves BOTH transports through the one
            // normaliser, and it starts working by itself if that ever changes.
            // The empty guard is what stops it rendering a column of blank 💭 in
            // the meantime.
            if (block.thinking && block.thinking.trim()) {
              out.push('💭 ' + oneLine(block.thinking));
            }
          } else if (block.type === 'tool_use') {
            const b = briefToolInput(block.input);
            out.push('🔧 ' + prettyToolName(block.name) + (b ? ': ' + b : ''));
          }
        }
      } else if (typeof content === 'string' && content.trim()) {
        out.push('🗣 ' + oneLine(content));
      }
    } else if (type === 'user') {
      // Real user prompt = string content. tool_result blocks are noise; skip.
      if (typeof content === 'string' && content.trim()) {
        out.push('💬 ' + oneLine(content));
      } else if (Array.isArray(content)) {
        const txt = content.find((b) => b.type === 'text' && b.text);
        if (txt) out.push('💬 ' + oneLine(txt.text));
      }
    }
  } catch { /* malformed entry — skip */ }
  return out;
}

class TranscriptTailer {
  constructor({ onLines, onModel, onUsage } = {}) {
    this.path = null;
    this.sessionId = null;
    this.offset = 0;
    this.partial = '';
    this.lines = [];
    this.watcher = null;
    this.poll = null;
    this.model = null;
    this._usageMsgId = null;
    this.onLines = onLines || (() => {});
    this.onModel = onModel || (() => {});
    this.onUsage = onUsage || (() => {});
  }

  // Point the tailer at a (new) transcript. Idempotent for the same path.
  // Model tracking survives a rebind (a fresh transcript from the same driving
  // session is still the same model) — only reset when the model itself changes.
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
  // overlay and the brain window aren't blank when we attach mid-session. The
  // brain window is the demanding one: it exists to be scrolled back through, so
  // "attached late, therefore has no history" is the failure it was filed for
  // (#532) even though the history is right there in the file.
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
        const model = entryModel(entry);
        if (model && model !== this.model) { this.model = model; this.onModel(model); }
      }
      this.lines = seeded.slice(-BUFFER_MAX_LINES);
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
        const model = entryModel(entry);
        if (model && model !== this.model) { this.model = model; this.onModel(model); }
        // Live entries only (not _seed): seeding replays history and would spam
        // one stale 📊 line per past turn on every mid-session attach.
        const usage = entryUsage(entry);
        if (usage && usage.msgId !== this._usageMsgId) { this._usageMsgId = usage.msgId; this.onUsage(usage); }
      }
      if (this.lines.length > BUFFER_MAX_LINES) this.lines = this.lines.slice(-BUFFER_MAX_LINES);
      if (changed) this.onLines(this.getLines());
    } catch { /* transient read error — next pump retries */ }
  }

  getLines() { return this.lines.slice(); }

  stop() {
    if (this.watcher) { try { this.watcher.close(); } catch { /* ignore */ } this.watcher = null; }
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
  }
}

module.exports = { TranscriptTailer, formatEntry, entryModel, entryUsage, BUFFER_MAX_LINES, OVERLAY_MAX_LINES };
