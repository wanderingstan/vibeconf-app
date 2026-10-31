// api/captions.js: the `caption` event from the providers' caption snapshots. A
// provider reports its recent turns each time; this reports what changed. Platform
// captions have no "finished" flag, so a turn counts as final once a newer one
// starts (or the call ends), which is an approximation.

class CaptionStream {
  constructor(onCaption) {
    this.onCaption = onCaption;
    this.turns = new Map(); // id -> { id, speaker, text }
    this.finalized = new Set();
    this.lastId = null;
  }

  update(turns = []) {
    for (const t of turns) {
      const id = t.turnId;
      if (id == null || this.finalized.has(id)) continue;
      const text = t.text || '';
      const known = this.turns.get(id);
      if (known && known.text === text && known.speaker === t.speaker) continue;
      if (this.lastId !== null && this.lastId !== id && !known) this._finalize(this.lastId);
      const turn = { id, speaker: t.speaker || '', text };
      this.turns.set(id, turn);
      if (!known) this.lastId = id;
      this.onCaption({ ...turn, final: false });
    }
  }

  _finalize(id) {
    const turn = this.turns.get(id);
    if (!turn || this.finalized.has(id)) return;
    this.finalized.add(id);
    this.turns.delete(id);
    this.onCaption({ ...turn, final: true });
  }

  /** The call is over: whatever was still open is as final as it gets. */
  end() {
    if (this.lastId !== null) this._finalize(this.lastId);
  }
}

// Slack and Teams number their turns by position in a list that scrolls, so a
// turnId can come to mean a different turn. This gives each turn an ID of its own,
// by finding where the new list overlaps the last one.
class TurnAligner {
  constructor() {
    this.last = []; // [{ turnId, speaker, text }]
    this.nextId = 1;
  }

  align(turns = []) {
    const same = (a, b) => a.speaker === b.speaker && (a.text === b.text || a.text.startsWith(b.text) || b.text.startsWith(a.text));
    let shift = this.last.length; // no overlap: every turn is new
    for (let k = 0; k < this.last.length; k++) {
      const overlap = Math.min(this.last.length - k, turns.length);
      let ok = overlap > 0;
      for (let i = 0; ok && i < overlap; i++) ok = same(this.last[k + i], turns[i]);
      if (ok) { shift = k; break; }
    }
    this.last = turns.map((t, i) => {
      const known = this.last[shift + i];
      return { ...t, turnId: known ? known.turnId : this.nextId++ };
    });
    return this.last;
  }
}

module.exports = { CaptionStream, TurnAligner };
