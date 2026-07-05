// store.js — Simple config persistence replacing chrome.storage.local
// Uses a JSON file in the app's userData directory.

const fs = require('fs');
const path = require('path');

class Store {
  // `fresh: true` makes the store safe for a file SHARED across processes
  // (#366: the app-level config in BASE_USER_DATA, which every running
  // profile instance reads and writes): reads reload from disk, and writes
  // are read-merge-write so one instance's set can't clobber keys another
  // instance wrote since our last load. The default (cached) mode is right
  // for a per-profile config.json that only this process owns.
  constructor(configDir, { fresh = false } = {}) {
    this.filePath = path.join(configDir, 'config.json');
    this.fresh = fresh;
    this.data = {};
    this._loadedMtimeMs = -1;
    this._loadedSize = -1;
    this._load();
  }

  _load() {
    try {
      // mtime/size gate: skip the read+parse when the file hasn't changed
      // since we last loaded it. This keeps fresh-mode gets cheap on hot
      // paths (getWebsiteUrl per sync fetch, ttsApiKey per utterance) — a
      // stat is ~µs vs a read+parse — while still picking up other
      // processes' writes immediately.
      const st = fs.statSync(this.filePath);
      if (st.mtimeMs === this._loadedMtimeMs && st.size === this._loadedSize) return;
      this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      this._loadedMtimeMs = st.mtimeMs;
      this._loadedSize = st.size;
    } catch (err) {
      if (err.code === 'ENOENT') return; // no config yet — keep current data
      // Unreadable/torn content: KEEP the last-known-good data rather than
      // resetting to {} — a reset here would make the next set() persist an
      // EMPTY config, wiping every key (fatal for the SHARED app-level file:
      // ElevenLabs key + login gone for all profiles). The atomic-rename
      // _save below makes torn reads near-impossible anyway; this is the
      // second line of defense.
      console.error('[store] Failed to load config (keeping previous data):', err.message);
      this._loadedMtimeMs = -1;
      this._loadedSize = -1;
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      // Atomic replace: write a sibling temp file, then rename over the real
      // one. Readers never observe a half-written file (rename is atomic on
      // POSIX), which matters for the SHARED app-level config that several
      // profile instances read concurrently (#366). The pid suffix keeps two
      // instances' temp files from colliding.
      const tmpPath = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmpPath, this.filePath);
      try {
        const st = fs.statSync(this.filePath);
        this._loadedMtimeMs = st.mtimeMs;
        this._loadedSize = st.size;
      } catch { /* stat after write is best-effort cache priming */ }
    } catch (err) {
      console.error('[store] Failed to save config:', err.message);
    }
  }

  get(key) {
    if (this.fresh) this._load();
    return key ? this.data[key] : { ...this.data };
  }

  set(key, value) {
    if (this.fresh) this._load();
    this.data[key] = value;
    this._save();
  }

  delete(key) {
    if (this.fresh) this._load();
    delete this.data[key];
    this._save();
  }

  getMultiple(keys) {
    if (this.fresh) this._load();
    const result = {};
    for (const key of keys) {
      if (key in this.data) result[key] = this.data[key];
    }
    return result;
  }
}

module.exports = Store;
