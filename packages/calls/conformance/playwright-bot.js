// conformance/playwright-bot.js: a ConformanceBot (see suite.js) on the
// Playwright host, driven through the public API, so the suite proves what
// developers use. One bot = one Chromium profile = one host.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { join } = require('..');
const { playwrightHost } = require('../hosts/playwright');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class PlaywrightConformanceBot {
  /**
   * @param {string} name
   * @param {object} [o]
   * @param {string} [o.userDataDir]  defaults to a per-name profile in ~/.config, since macOS clears old temp files and a sign-in has to last
   * @param {object} [o.launch]       more playwrightHost options
   */
  constructor(name, { userDataDir, launch = {} } = {}) {
    this.name = name;
    this.userDataDir = userDataDir || path.join(os.homedir(), '.config', 'vibeconf', 'conformance-profiles', name);
    this.launch = launch;
    this.hostCapabilities = { share: false }; // see the host's capabilities
    this.host = null;
    this.call = null;
    this._heard = new Map(); // turnId -> text, since startListening()
    this._listening = false;
  }

  async join(url) {
    this.host = await playwrightHost({ userDataDir: this.userDataDir, ...this.launch });
    try {
      this.call = await join(url, { name: this.name, host: this.host });
    } catch (err) {
      this._failure = err;
      throw err;
    }
    this.call.on('caption', ({ id, text }) => {
      if (this._listening) this._heard.set(id, text);
    });
  }

  async participants() {
    return (await this.call.participants()).map((p) => p.name).filter(Boolean);
  }

  startListening() { this._heard.clear(); this._listening = true; }

  async heard(test, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const text = [...this._heard.values()].join(' ');
      if (test(text)) { this._listening = false; return text; }
      await sleep(500);
    }
    this._listening = false;
    return null;
  }

  async playClip(file) { await this.call.speak(file); }

  // One retry when the platform didn't confirm the send, as the Electron
  // harness does (meet-test-lib sendChat): a flaky chat pane is a platform
  // hiccup, not a broken chat path.
  async sendChat(text) {
    try {
      await this.call.chat.send(text);
    } catch (err) {
      console.log(`[${this.name}] sendChat not confirmed; retrying once (${err.message})`);
      this.chatResent = true; // the first may have posted after all
      await sleep(1500);
      await this.call.chat.send(text);
    }
  }

  async chatContains(needle, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msgs = await this.call.chat.read();
      if (msgs.some((m) => `${m.sender} ${m.text}`.includes(needle))) return true;
      await sleep(2000);
    }
    return false;
  }

  // The chat event, for the suite's exactly-once check.
  get chatEvents() { return this.call.capabilities.chatEvents; }
  startChatEvents() {
    this._chatEvents = [];
    this.call.on('chat', (m) => this._chatEvents.push({ text: m.text, at: Date.now() }));
  }
  chatEventsMatching(needle) { return this._chatEvents.filter((m) => m.text.includes(needle)); }

  async share() { return false; }
  async stopShare() { return false; }

  async leave() {
    if (!this.host) return true;
    if (this.call) { try { await this.call.leave(); } catch { /* page gone */ } }
    await sleep(2000);
    await this.host.close();
    this.host = null;
    return true;
  }

  async snapshot() {
    const shot = this._failure && this._failure.screenshot;
    const file = path.join(os.tmpdir(), `vibeconf-conformance-${this.name}-${Date.now()}.png`);
    if (shot) { fs.writeFileSync(file, shot); return file; }
    if (!this.call) return null;
    fs.writeFileSync(file, await this.call.screenshot());
    return file;
  }
}

module.exports = { PlaywrightConformanceBot };
