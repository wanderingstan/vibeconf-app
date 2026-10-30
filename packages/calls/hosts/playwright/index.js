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
// Google Meet, Zoom, Teams and Slack: the providers whose whole session runs in
// the library. Slack's huddle spans two windows: the media core goes in the
// main app.slack.com page, the provider in the about:blank popup it opens. The
// calling apps (answered, not joined) are not here yet.
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
const { SLACK } = require('../../providers/slack-selectors');
const { clickWhenReadyJs, clickButtonByTextRepeatingJs } = require('../../providers/slack-session');
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
  slack: { entry: 'page-slack.js', startUrl: (u) => u, before: NO_AUDIO_HOOK, huddlePopup: true },
};

// Slack's join clicks (slack-session.js), the same ones the Electron host runs:
// the channel's Huddle button in the main page; the lobby's Start Huddle in the
// popup; and in both, the two interstitials that block a join.
const SLACK_MAIN_NUDGES = [
  clickWhenReadyJs(SLACK.huddle.startButton, 'channel Huddle button'),
  clickButtonByTextRepeatingJs('Slack in your browser', '"use Slack in your browser" interstitial (main)', { tries: 40 }),
  clickButtonByTextRepeatingJs('Switch to this device', '"Switch to this device" (main)'),
];
const SLACK_POPUP_NUDGES = [
  clickWhenReadyJs(SLACK.huddle.lobbyStartButton, 'lobby Start Huddle'),
  clickButtonByTextRepeatingJs('Switch to this device', '"Switch to this device" (popup)'),
  clickButtonByTextRepeatingJs('Slack in your browser', '"use Slack in your browser" interstitial (popup)'),
];

// Electron loads preloads into the top frame only (nodeIntegrationInSubFrames
// is off); an init script runs in every frame, so each is fenced to the top,
// and kept out of a popup's initial about:blank (Slack's huddle window, which
// gets the provider instead).
const MAIN_PAGE_ONLY = 'window === window.top && !(window.opener && location.href === "about:blank")';
const fenced = (src) => `if (${MAIN_PAGE_ONLY}) {\n${src}\n}\n`;

// The media core, plus the one message of its the host needs: an utterance
// finished playing (on Electron, each preload relays the same).
const TTS_ENDED_RELAY = `window.addEventListener('message', (e) => {
  if (e.source === window && e.data && e.data.__botsInCalls && e.data.action === 'tts-ended') {
    try { window.__vibeconfEmit(${JSON.stringify(CALL_EVENTS.ttsEnded)}, []); } catch (_) { /* page closing */ }
  }
});`;

function pageScripts(platform) {
  const p = PLATFORMS[platform];
  return {
    media: fenced(p.before + '\n' + fs.readFileSync(MEDIA_CORE_PATH, 'utf8') + '\n' + TTS_ENDED_RELAY),
    provider: bundlePageScript(path.join(__dirname, p.entry)),
  };
}

class PlaywrightCall extends CallProvider {
  static get id() { return 'playwright'; }

  constructor(page) {
    super();
    this.page = page;      // where the provider runs (Slack: the huddle popup)
    this.mediaPage = page; // where the media core runs (Slack: the main window)
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
  // Straight to the media core, wherever it runs: on Slack that's the main
  // window, not the provider's popup.
  async speak(payload) {
    return this.mediaPage.evaluate(([action, p]) => {
      window.postMessage({ __botsInCalls: true, __fromExtension: true, action, payload: p }, '*');
    }, ['play-tts', payload]);
  }
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
    if (call && (source.page === call.page || source.page === call.mediaPage)) call._emit(channel, a || []);
  });
  return {
    context,
    /**
     * Join a call and resolve once the bot is in it (CALL_EVENTS.botJoinedCall).
     * @param {string} url  a Google Meet, Zoom or Teams link, or a Slack channel (its huddle)
     * @param {object} [o]
     * @param {string} [o.botName='AI Assistant']
     * @param {'guest'|'account'} [o.mode='guest']  'account' when the profile is signed in to Google
     * @param {object} [o.config]   the provider's config values (speakingDetectionMode, …)
     * @param {number} [o.timeoutMs=120000]
     */
    async join(url, { botName = 'AI Assistant', mode = 'guest', config = {}, timeoutMs = 120000 } = {}) {
      const target = platformFromUrl(url);
      const platform = target.ok && PLATFORMS[target.provider] ? target.provider : null;
      if (!platform) throw new Error('the Playwright host joins Google Meet, Zoom, Teams and Slack links: ' + (target.error || target.provider));
      if (call) throw new Error('this host already has a call; launch another host for a second bot');
      answers = { botName, mode, config };
      const startUrl = PLATFORMS[platform].startUrl(target.url || url);
      const scripts = pageScripts(platform);
      await context.addInitScript(scripts.media);
      if (!PLATFORMS[platform].huddlePopup) await context.addInitScript(`if (window === window.top) {\n${scripts.provider}\n}\n`);
      await context.grantPermissions(['microphone', 'camera'], { origin: new URL(startUrl).origin });
      const page = context.pages()[0] || await context.newPage();
      call = new PlaywrightCall(page);
      if (PLATFORMS[platform].huddlePopup) {
        // The huddle opens as an about:blank popup that Slack fills from the main
        // window. The provider and the lobby clicks go in it, and from then on
        // it is where the call is driven; the media stays in the main page.
        context.on('page', async (popup) => {
          if (popup.url() !== 'about:blank' || (await popup.opener()) !== page) return;
          call.page = popup;
          try {
            await popup.evaluate(scripts.provider);
            for (const js of SLACK_POPUP_NUDGES) await popup.evaluate(js);
          } catch (e) { console.warn('[playwright-host] huddle popup setup failed:', e.message); }
        });
        page.on('load', () => { for (const js of SLACK_MAIN_NUDGES) page.evaluate(js).catch(() => {}); });
      }
      // In the call: botJoinedCall (Meet, Zoom, Teams), or the "In call" status
      // Slack's huddle reports (it sends no botJoinedCall, so the Electron app
      // plays no join chime there).
      const waits = [
        call.waitFor(CALL_EVENTS.botJoinedCall, () => true, timeoutMs),
        call.waitFor(CALL_EVENTS.statusUpdate, (s) => /^In call/.test(s), timeoutMs),
      ];
      waits.forEach((w) => w.catch(() => {})); // the loser times out later, unheard
      const joined = Promise.race(waits);
      await page.goto(startUrl);
      await joined;
      return call;
    },
    async close() { await context.close(); },
  };
}

module.exports = { launchPlaywrightHost, PlaywrightCall };
