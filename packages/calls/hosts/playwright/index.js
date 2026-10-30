// hosts/playwright: run a bot in a call from plain Node, with Playwright
// driving Chromium (Phase 4 of the calls library). No Electron.
//
//   const { launchPlaywrightHost } = require('@vibeconferencing/calls/hosts/playwright');
//   const host = await launchPlaywrightHost({ userDataDir: '/tmp/bot-a' });
//   const call = await host.join(meetZoomOrTeamsLink, { botName: 'Ada' });
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
// Google Meet, Zoom and Teams: the providers whose whole session runs in the
// library. Slack (two windows) and the calling apps (answered, not joined) are
// not here yet.
//
// Headed by default: the design doc expects Meet to detect headless Chromium.
// `channel: 'chrome'` drives the installed Google Chrome, so nothing is
// downloaded; pass `executablePath` to use another Chromium.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { CallProvider, CALL_EVENTS } = require('../../core/call-provider');
const { MEDIA_CORE_PATH } = require('../../inject/load');
const { platformFromUrl } = require('../../core/call-target');
const { ZOOM } = require('../../providers/zoom-selectors');
const { TEAMS } = require('../../providers/teams-selectors');
const { bundlePageScript } = require('./bundle');

// Per platform: the page entry, the URL the bot actually loads, and anything
// the page needs set before the media core runs. Zoom and Teams load their web
// clients directly (as the Electron host does), and neither uses the
// Meet-shaped RTCPeerConnection audio hook.
const NO_AUDIO_HOOK = 'window.__vibeconf_disableAudioCapture = true;';
const PLATFORMS = {
  meet: { entry: 'page-meet.js', startUrl: (u) => u, before: '' },
  zoom: { entry: 'page-zoom.js', startUrl: (u) => ZOOM.webClientJoinUrl(u) || u, before: NO_AUDIO_HOOK },
  teams: { entry: 'page-teams.js', startUrl: (u) => TEAMS.lightMeetingUrl(u) || u, before: NO_AUDIO_HOOK },
};

// Electron loads preloads into the top frame only (nodeIntegrationInSubFrames
// is off); an init script runs in every frame, so each is fenced to the top.
const topFrameOnly = (src) => `if (window === window.top) {\n${src}\n}\n`;

function pageScripts(platform) {
  const p = PLATFORMS[platform];
  return [
    topFrameOnly(p.before + '\n' + fs.readFileSync(MEDIA_CORE_PATH, 'utf8')),
    topFrameOnly(bundlePageScript(path.join(__dirname, p.entry))),
  ];
}

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
  return {
    context,
    /**
     * Join a call and resolve once the bot is in it (CALL_EVENTS.botJoinedCall).
     * @param {string} url  a Google Meet, Zoom or Teams link
     * @param {object} [o]
     * @param {string} [o.botName='AI Assistant']
     * @param {'guest'|'account'} [o.mode='guest']  'account' when the profile is signed in to Google
     * @param {object} [o.config]   the provider's config values (speakingDetectionMode, …)
     * @param {number} [o.timeoutMs=120000]
     */
    async join(url, { botName = 'AI Assistant', mode = 'guest', config = {}, timeoutMs = 120000 } = {}) {
      const target = platformFromUrl(url);
      const platform = target.ok && PLATFORMS[target.provider] ? target.provider : null;
      if (!platform) throw new Error('the Playwright host joins Google Meet, Zoom and Teams links: ' + (target.error || target.provider));
      if (call) throw new Error('this host already has a call; launch another host for a second bot');
      answers = { botName, mode, config };
      const startUrl = PLATFORMS[platform].startUrl(target.url || url);
      for (const src of pageScripts(platform)) await context.addInitScript(src);
      await context.grantPermissions(['microphone', 'camera'], { origin: new URL(startUrl).origin });
      const page = context.pages()[0] || await context.newPage();
      call = new PlaywrightCall(page);
      const joined = call.waitFor(CALL_EVENTS.botJoinedCall, () => true, timeoutMs);
      await page.goto(startUrl);
      await joined;
      return call;
    },
    async close() { await context.close(); },
  };
}

module.exports = { launchPlaywrightHost, PlaywrightCall };
