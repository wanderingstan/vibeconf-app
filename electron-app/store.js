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
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      }
    } catch (err) {
      console.error('[store] Failed to load config:', err.message);
      this.data = {};
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
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
