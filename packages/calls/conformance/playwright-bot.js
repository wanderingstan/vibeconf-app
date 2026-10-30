// conformance/playwright-bot.js: a ConformanceBot (see suite.js) on the
// Playwright host. One bot = one Chromium profile = one launchPlaywrightHost.

const path = require('path');
const os = require('os');
const { launchPlaywrightHost } = require('../hosts/playwright');
const { CALL_EVENTS } = require('../core/call-provider');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class PlaywrightConformanceBot {
  /**
   * @param {string} name
   * @param {object} [o]
   * @param {string} [o.userDataDir]  defaults to a per-name profile in ~/.config, since macOS clears old temp files and a sign-in has to last
   * @param {object} [o.launch]       more launchPlaywrightHost options
   */
  constructor(name, { userDataDir, launch = {} } = {}) {
    this.name = name;
    this.userDataDir = userDataDir || path.join(os.homedir(), '.config', 'vibeconf', 'conformance-profiles', name);
    this.launch = launch;
    // A share needs an app-owned page to present; on Playwright that's the
    // open WebRTC-loopback question in the design doc.
    this.hostCapabilities = { share: false };
    this.host = null;
    this.call = null;
    this._heard = new Map(); // turnId -> text, since startListening()
    this._listening = false;
  }

  async join(url) {
    this.host = await launchPlaywrightHost({ userDataDir: this.userDataDir, ...this.launch });
    try {
      this.call = await this.host.join(url, { botName: this.name });
    } catch (err) {
      this._failedPage = this.host.context.pages()[0] || null;
      throw err;
    }
    this.call.on(CALL_EVENTS.captionTurns, ({ turns = [] } = {}) => {
      if (!this._listening) return;
      for (const t of turns) this._heard.set(t.turnId ?? this._heard.size, t.text || '');
    });
    // The bot is heard only with its mic open; on Electron the app's mode does this.
    await this.call.setMicMuted(false);
  }

  async participants() {
    const list = (await this.call.getParticipants()) || [];
    return list.map((p) => (typeof p === 'string' ? p : p.name)).filter(Boolean);
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

  async playClip(file) { await this.call.playAudioFile(file); }

  // One retry when the platform didn't confirm the send, as the Electron
  // harness does (meet-test-lib sendChat): a flaky chat pane is a platform
  // hiccup, not a broken chat path.
  async sendChat(text) {
    if (await this.call.sendChat(text)) return;
    console.log(`[${this.name}] sendChat not confirmed; retrying once`);
    await sleep(1500);
    await this.call.sendChat(text);
  }

  async chatContains(needle, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msgs = (await this.call.readChat()) || [];
      if (msgs.some((m) => `${m.sender || ''} ${m.text || ''}`.includes(needle))) return true;
      await sleep(2000);
    }
    return false;
  }

  async share() { return false; }
  async stopShare() { return false; }

  async leave() {
    if (!this.host) return true;
    let clicked = false;
    try { clicked = this.call ? await this.call.leave() : false; } catch { /* page gone */ }
    await sleep(2000);
    await this.host.close();
    this.host = null;
    return clicked || !this.call;
  }

  async snapshot() {
    const page = (this.call && this.call.page) || this._failedPage;
    if (!page) return null;
    const file = path.join(os.tmpdir(), `vibeconf-conformance-${this.name}-${Date.now()}.png`);
    await page.screenshot({ path: file });
    return file;
  }
}

module.exports = { PlaywrightConformanceBot };
