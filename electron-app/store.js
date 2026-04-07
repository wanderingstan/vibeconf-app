// store.js — Simple config persistence replacing chrome.storage.local
// Uses a JSON file in the app's userData directory.

const fs = require('fs');
const path = require('path');

class Store {
  constructor(configDir) {
    this.filePath = path.join(configDir, 'config.json');
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
    return key ? this.data[key] : { ...this.data };
  }

  set(key, value) {
    this.data[key] = value;
    this._save();
  }

  delete(key) {
    delete this.data[key];
    this._save();
  }

  getMultiple(keys) {
    const result = {};
    for (const key of keys) {
      if (key in this.data) result[key] = this.data[key];
    }
    return result;
  }
}

module.exports = Store;
