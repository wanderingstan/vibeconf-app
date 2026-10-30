// zoom-captions.js — turn Zoom's live caption OVERLAY into caption turns (#318).
//
// Zoom's web client shows captions as one ephemeral overlay line, not a log
// (verified 2026-10-14: the "Full transcript" panel isn't offered there, to host
// or guest). Each overlay row is the speaker's AVATAR <img> plus the text; no
// name. The avatar URL is the same one on that person's participants-list row,
// so attribution is avatar → roster name (Stan's call on #318).
//
// The overlay text GROWS while someone talks (and Zoom revises the tail), then
// is replaced. ZoomCaptionTracker keeps a rolling history of turns from those
// snapshots, in the shape local-server.updateTurns ingests: a full snapshot of
// [{ turnId, speaker, text, isBottommost }], grouped server-side by speaker.
//
// Pure: no DOM. preload-zoom reads the overlay + roster and feeds this.

const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

// Same utterance, revised? Zoom extends the line and rewrites its last few
// words as recognition firms up, so compare on a word prefix, not exact text.
function continues(prev, next) {
  const a = norm(prev).toLowerCase();
  const b = norm(next).toLowerCase();
  if (!a || !b) return false;
  if (b.startsWith(a) || a.startsWith(b)) return true;
  const aw = a.split(' ');
  const bw = b.split(' ');
  // Allow the last 3 words of the earlier text to have been revised.
  const keep = Math.max(1, aw.length - 3);
  for (let i = 0; i < keep; i++) if (aw[i] !== bw[i]) return false;
  return true;
}

class ZoomCaptionTracker {
  constructor({ maxTurns = 60 } = {}) {
    this.maxTurns = maxTurns;
    this.turns = []; // [{ turnId, key, speaker, text }]
    this.nextId = 1;
    // Per overlay row key (avatar src, or a fallback), the turn it is filling.
    this.open = new Map();
  }

  // segments: [{ key, speaker, text }] — the overlay's current rows, in order.
  // `key` identifies the row's speaker (the avatar URL); `speaker` is the
  // resolved display name. Returns true if any turn changed.
  update(segments) {
    let changed = false;
    const live = new Set();
    for (const seg of segments || []) {
      const text = norm(seg.text);
      if (!text) continue;
      const key = seg.key || seg.speaker || 'unknown';
      live.add(key);
      const t = this.open.get(key);
      if (t && continues(t.text, text)) {
        if (t.text !== text) { t.text = text; changed = true; }
        // A name that resolved late (roster loaded after the first words).
        if (seg.speaker && seg.speaker !== t.speaker && t.speaker === 'unknown') { t.speaker = seg.speaker; changed = true; }
        continue;
      }
      const turn = { turnId: this.nextId++, key, speaker: seg.speaker || 'unknown', text };
      this.turns.push(turn);
      this.open.set(key, turn);
      changed = true;
    }
    // A row that left the overlay is finished; if that speaker comes back, it
    // is a new turn even if the words happen to match.
    for (const key of [...this.open.keys()]) if (!live.has(key)) this.open.delete(key);
    if (this.turns.length > this.maxTurns) this.turns.splice(0, this.turns.length - this.maxTurns);
    return changed;
  }

  // The full snapshot updateTurns expects.
  snapshot() {
    return this.turns.map((t, i) => ({
      turnId: t.turnId,
      speaker: t.speaker,
      text: t.text,
      isBottommost: i === this.turns.length - 1,
    }));
  }
}

module.exports = { ZoomCaptionTracker, continues };
