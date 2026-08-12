// agent-activity.js — one activity stream, whatever produced it (#242).
//
// The bot's agent can reach us two ways, and they are not going to converge:
//
//   1. A human types /call or /join-call in their OWN interactive Claude
//      session. We do not own that process and never will, so the only way to
//      see what it is doing is to tail the transcript Claude Code writes.
//
//   2. The app launches the agent itself. Here we DO own the process, so it can
//      hand us its events directly (`--output-format stream-json`) and we never
//      touch a file.
//
// Transport 1 is not a contract. That file is Claude Code's implementation
// detail: undocumented, and it changed twice in a week. App-launched agents
// wrote transcripts on Jul 28, wrote them unreliably by Jul 30, and by Aug 4
// stopped entirely — a session ran three and a half minutes, spoke 22 times,
// and its named transcript was never created. Everything downstream of that
// feed died silently, including the 🧑‍💻 avatar state, and it was only noticed
// because someone asked why the emoji looked wrong.
//
// So this module exists to make the SOURCE irrelevant to everything above it.
// The brain pane, the 🤔→🧑‍💻 escalation and the debug overlay consume one
// interface; when a transport breaks or is replaced, nothing above changes.
//
// The two transports agree more than they look like they should: stream-json
// emits `{type:'assistant', message:{content:[{type:'tool_use',…}]}}`, which is
// the same shape the transcript stores. So there is ONE normaliser
// (formatEntry, already written) and two ways of getting entries to it — not
// two parsers that must be kept in step.

const { TranscriptTailer, formatEntry, entryModel, entryUsage, MAX_LINES } = require('./agent-transcript.js');

// Shared contract for both transports.
//
//   onLines(lines)  — the full display buffer, newest last. A BUFFER rather
//                     than a delta because consumers render the whole thing
//                     (the brain pane, the overlay) and the tailer can only
//                     ever produce a buffer anyway: it re-reads a file.
//   onModel(model)  — which model is authoring, when the source can tell.
//   onUsage(usage)  — per-turn token usage (context size), when the source can
//                     tell. Drives the 📊 [context] session-log marker (#345).
//
// A source is bound, then later replaced or stopped. Nothing above holds a
// reference to the concrete type.
class AgentActivitySource {
  constructor({ onLines, onModel, onUsage } = {}) {
    this.onLines = onLines || (() => {});
    this.onModel = onModel || (() => {});
    this.onUsage = onUsage || (() => {});
  }
  // eslint-disable-next-line no-unused-vars
  bind(_arg) { throw new Error('bind() not implemented'); }
  stop() {}
  get kind() { return 'none'; }
}

// Transport 1 — tail the transcript Claude Code writes.
//
// Thin on purpose: TranscriptTailer already does the work, and wrapping rather
// than rewriting keeps the path that currently serves real users untouched.
class TranscriptActivitySource extends AgentActivitySource {
  constructor(opts) {
    super(opts);
    this._tailer = new TranscriptTailer({
      onLines: (lines) => this.onLines(lines),
      onModel: (model) => this.onModel(model),
      onUsage: (usage) => this.onUsage(usage),
    });
  }
  get kind() { return 'transcript'; }
  get path() { return this._tailer.path; }
  bind({ transcriptPath, sessionId } = {}) { this._tailer.bind(transcriptPath, sessionId); }
  stop() { if (this._tailer.stop) this._tailer.stop(); }
}

// Transport 2 — read the agent's own event stream.
//
// Fed line by line from the child's stdout. Deliberately takes TEXT rather than
// a process handle: the spawn belongs to main (which owns process lifecycle and
// crash handling), and keeping this a pure parser makes it testable without
// launching anything.
class StreamActivitySource extends AgentActivitySource {
  constructor(opts) {
    super(opts);
    this._lines = [];
    this._partial = '';
    this._model = null;
    this._usageMsgId = null;
  }
  get kind() { return 'stream'; }

  bind() { this._lines = []; this._partial = ''; this.onLines([]); }

  // Push raw stdout. Chunks split anywhere, including mid-JSON, so a partial
  // tail is carried to the next call — a dropped boundary here would silently
  // lose whole tool calls rather than erroring.
  push(chunk) {
    this._partial += String(chunk || '');
    const parts = this._partial.split('\n');
    this._partial = parts.pop() || '';
    let changed = false;
    for (const raw of parts) {
      const line = raw.trim();
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; } // not every line is an event
      // stream-json carries system/hook/result frames too. formatEntry returns
      // nothing for those, so filtering is its job rather than a second list of
      // types here that would drift from it.
      const out = formatEntry(entry);
      if (out.length) { this._lines.push(...out); changed = true; }
      const model = entryModel(entry);
      if (model && model !== this._model) { this._model = model; this.onModel(model); }
      const usage = entryUsage(entry);
      if (usage && usage.msgId !== this._usageMsgId) { this._usageMsgId = usage.msgId; this.onUsage(usage); }
    }
    if (!changed) return;
    if (this._lines.length > MAX_LINES) this._lines = this._lines.slice(-MAX_LINES);
    this.onLines(this._lines.slice());
  }

  stop() { this._partial = ''; }
}

module.exports = { AgentActivitySource, TranscriptActivitySource, StreamActivitySource };
