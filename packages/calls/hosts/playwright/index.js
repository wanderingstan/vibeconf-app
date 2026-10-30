// hosts/playwright: run a bot in a call from plain Node, with Playwright
// driving Chromium (Phase 4 of the calls library). No Electron.
//
//   const { launchPlaywrightHost } = require('@vibeconferencing/calls/hosts/playwright');
//   const host = await launchPlaywrightHost({ userDataDir: '/tmp/bot-a' });
//   const call = await host.join('https://meet.google.com/abc-defg-hij', { botName: 'Ada' });
//   call.on(CALL_EVENTS.captionTurns, ({ turns }) => …);
//   await call.setMicMuted(false);
//   await call.speak({ audioData: base64Mp3 });
//   await call.leave();
//   await host.close();
//
// Like the Electron host it keeps the provider in the page: the media core and
// the provider are added as init scripts (before Meet's own scripts can ask
// for media), and two bindings carry the provider's startup questions and its
// events to Node. The Call returned here is a CallProvider whose methods run
// the page's provider, and whose events are the page provider's events.
//
// Google Meet only, for now. The other providers' polling loops still live in
// the app's preloads (preload-zoom.js, …); each needs the same move into the
// library that Meet's got in Phase 3b before it can run here.
//
// Headed by default: the design doc expects Meet to detect headless Chromium.
// `channel: 'chrome'` drives the installed Google Chrome, so nothing is
// downloaded; pass `executablePath` to use another Chromium.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { CallProvider, CALL_EVENTS } = require('../../core/call-provider');
const { MEDIA_CORE_PATH } = require('../../inject/load');
const { bundlePageScript } = require('./bundle');

const PAGE_HOST_PATH = path.join(__dirname, 'page-host.js');

// Electron loads preloads into the top frame only (nodeIntegrationInSubFrames
// is off); an init script runs in every frame, so each is fenced to the top.
const topFrameOnly = (src) => `if (window === window.top) {\n${src}\n}\n`;

let _pageScripts = null;
function pageScripts() {
  if (!_pageScripts) {
    _pageScripts = [
      topFrameOnly(fs.readFileSync(MEDIA_CORE_PATH, 'utf8')),
      topFrameOnly(bundlePageScript(PAGE_HOST_PATH)),
    ];
  }
  return _pageScripts;
}

const MEET_URL_RE = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:[/?#]|$)/;

class PlaywrightCall extends CallProvider {
  static get id() { return 'playwright'; }

  constructor(page) {
    super();
    this.page = page;
    this._events = new EventEmitter();
    this._events.setMaxListeners(50);
  }

  // Run one method of the page's provider and return its (serialisable) result.
  _run(method, ...args) {
    return this.page.evaluate(([m, a]) => window.__vibeconfCall[m](...a), [method, args]);
  }

  // Events --------------------------------------------------------------------
  on(channel, handler) { this._events.on(channel, handler); return this; }
  off(channel, handler) { this._events.off(channel, handler); return this; }
  _emit(channel, args) { this._events.emit(channel, ...args); }

  /** Resolve with the first `channel` event whose payload passes `test`. */
  waitFor(channel, test = () => true, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(channel, handler);
        reject(new Error(`no ${channel} within ${timeoutMs}ms`));
      }, timeoutMs);
      const handler = (payload) => {
        let ok = false;
        try { ok = test(payload); } catch { /* not this one */ }
        if (!ok) return;
        clearTimeout(timer);
        this.off(channel, handler);
        resolve(payload);
      };
      this.on(channel, handler);
    });
  }

  // The CallProvider methods ---------------------------------------------------
  async leave() { return this._run('leave'); }
  async setMicMuted(muted) { return this._run('setMicMuted', !!muted); }
  async setCameraOn(on) { return this._run('setCameraOn', !!on); }
  /** payload: { audioData: base64 audio, … }, as the media core takes it. */
  async speak(payload) { return this._run('speak', payload); }
  async setStudioSound(enabled) { return this._run('setStudioSound', !!enabled); }
  async setCaptionLanguage(language) { return this._run('setCaptionLanguage', language); }
  async enableCaptions() { return this._run('enableCaptions'); }
  async recoverCaptions() { return this._run('recoverCaptions'); }
  async readChat() { return this._run('readChat'); }
  async sendChat(text) { return this._run('sendChat', text); }
  async startShare(type) { return this._run('startShare', type); }
  async stopShare() { return this._run('stopShare'); }
  async getParticipants() { return this._run('getParticipants'); }

  /** Play an audio file (mp3, wav, …) into the call through the bot's mic. */
  async playAudioFile(file) {
    return this.speak({ audioData: fs.readFileSync(file).toString('base64') });
  }

  async screenshot() { return this.page.screenshot(); }
}

/**
 * @param {object} opts
 * @param {string} opts.userDataDir   the bot's browser profile (kept between runs)
 * @param {boolean} [opts.headless=false]
 * @param {string} [opts.channel='chrome']  Playwright browser channel
 * @param {string} [opts.executablePath]    instead of a channel
 * @param {string[]} [opts.args]            extra Chromium flags
 */
async function launchPlaywrightHost({ userDataDir, headless = false, channel = 'chrome', executablePath, args = [] } = {}) {
  if (!userDataDir) throw new Error('launchPlaywrightHost: userDataDir is required');
  let chromium;
  try { ({ chromium } = require('playwright-core')); } catch {
    throw new Error('launchPlaywrightHost needs playwright-core (npm install playwright-core)');
  }
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    ...(executablePath ? { executablePath } : { channel }),
    viewport: null,
    // Meet's CSP enforces Trusted Types, which refuses the provider's status
    // banner (innerHTML) and breaks Meet's own scripts once the media core is
    // in. The Electron host strips the CSP headers for the same reason.
    bypassCSP: true,
    // Not flagged as automated; the Electron host isn't either.
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--autoplay-policy=no-user-gesture-required',
      // backgroundThrottling: false, as on every Electron call view: a bot's
      // window is rarely in front, and a throttled page drops caption polls.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      ...args,
    ],
  });

  let call = null;
  let answers = {};
  await context.exposeBinding('__vibeconfHostAsk', async (_source, name, a) => {
    if (name === 'getBotName') return answers.botName;
    if (name === 'getMode') return { mode: answers.mode };
    if (name === 'getConfig') return Object.fromEntries((a[0] || []).filter((k) => k in answers.config).map((k) => [k, answers.config[k]]));
    throw new Error('unknown host question: ' + name);
  });
  await context.exposeBinding('__vibeconfEmit', (source, channel, a) => {
    if (call && source.page === call.page) call._emit(channel, a || []);
  });
  for (const src of pageScripts()) await context.addInitScript(src);

  return {
    context,
    /**
     * Join a call and resolve once the bot is in it (CALL_EVENTS.botJoinedCall).
     * @param {string} url  a Google Meet link
     * @param {object} [o]
     * @param {string} [o.botName='AI Assistant']
     * @param {'guest'|'account'} [o.mode='guest']  'account' when the profile is signed in to Google
     * @param {object} [o.config]   the provider's config values (speakingDetectionMode, …)
     * @param {number} [o.timeoutMs=120000]
     */
    async join(url, { botName = 'AI Assistant', mode = 'guest', config = {}, timeoutMs = 120000 } = {}) {
      if (!MEET_URL_RE.test(url)) throw new Error('the Playwright host joins Google Meet links only, for now: ' + url);
      if (call) throw new Error('this host already has a call; launch another host for a second bot');
      answers = { botName, mode, config };
      const origin = new URL(url).origin;
      await context.grantPermissions(['microphone', 'camera'], { origin });
      const page = context.pages()[0] || await context.newPage();
      call = new PlaywrightCall(page);
      const joined = call.waitFor(CALL_EVENTS.botJoinedCall, () => true, timeoutMs);
      await page.goto(url);
      await joined;
      return call;
    },
    async close() { await context.close(); },
  };
}

module.exports = { launchPlaywrightHost, PlaywrightCall };
