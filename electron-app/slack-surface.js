// slack-surface.js — Slack two-surface wiring (main process).
//
// Self-contained so it doesn't entangle main.js's Meet flow. createSlackSurface()
// builds the MAIN app.slack.com BrowserView (media preload) and, via
// setWindowOpenHandler, injects the scrape preload into the huddle popup
// (about:blank) the main window opens. The popup's TITLE ("Huddle: …") is how we
// know a huddle is live — the popup URL is useless (about:blank). #264.
//
// This is the Slack analog of main.js's createMeetView + the (Meet) preload's
// page-message plumbing, split across the two surfaces.

const { BrowserView, session } = require('electron');
const path = require('path');
const { SLACK } = require('./slack-selectors');

// Slack sniffs the UA and rejects Electron (and older Chrome) — "your browser is
// not supported". Spoof a CURRENT desktop Chrome, set explicitly on the
// webContents (overrides the session UA and guarantees it reaches the page).
// Isolated to the Slack surface so Meet's CHROME_UA is untouched. Bump the
// version when Slack tightens its cutoff.
const SLACK_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// Poll for `selector` in a webContents and click it once it appears (Slack is a
// SPA, so toolbar/lobby buttons render well after load). Runs in-page via
// executeJavaScript so the preloads stay media/scrape-only. Logs with a [slack]
// prefix so the console-message forwarder surfaces it in the main stdout.
function clickWhenReady(webContents, selector, label, { tries = 60, intervalMs = 500 } = {}) {
  const js = `(() => {
    const sel = ${JSON.stringify(selector)}, label = ${JSON.stringify(label)};
    let n = 0;
    const t = setInterval(() => {
      const el = document.querySelector(sel);
      if (el) { el.click(); clearInterval(t); console.log('[slack] autojoin: clicked ' + label); }
      else if (++n > ${tries}) { clearInterval(t); console.warn('[slack] autojoin: timed out waiting for ' + label); }
    }, ${intervalMs});
  })();`;
  webContents.executeJavaScript(js).catch(() => {});
}

// Build the Slack surface bound to a session partition.
//   mainWindow — the app's BrowserWindow (for layout; caller addBrowserView's it)
//   opts.partition — session partition (reuse the bot's; login carries to popup)
//   opts.url       — initial URL to load (app.slack.com or a channel deep-link)
//   opts.devtools  — open DevTools on the popup (handy for live driving)
// Returns { view, getPopups }.
function createSlackSurface(mainWindow, opts = {}) {
  const { partition, url, devtools, userAgent = SLACK_UA, autojoin = false } = opts;

  // Spoof Chrome at the SESSION level so EVERY window in this partition — main,
  // workspace ("Redirecting…"), huddle popup — inherits it and stays in the one
  // authenticated session. (Slack rejects Electron / old Chrome.)
  if (partition) { try { session.fromPartition(partition).setUserAgent(userAgent); } catch { /* ignore */ } }

  const view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-slack-main.js'),
      contextIsolation: false,
      sandbox: false,
      partition,
    },
  });
  // Spoof Chrome BEFORE the first load so app.slack.com's UA check passes.
  view.webContents.setUserAgent(userAgent);

  // Surface the main view's [slack] logs (incl. autojoin) in the main stdout.
  view.webContents.on('console-message', (_e, _level, message) => {
    if (typeof message === 'string' && message.includes('[slack]')) console.log(message);
  });

  // Auto-join: once the channel SPA has loaded, click the channel-header
  // "Huddle" button (start OR join the active one). That opens the lobby popup,
  // which we auto-confirm in did-create-window below.
  if (autojoin) {
    view.webContents.on('did-finish-load', () => {
      console.log('[slack] autojoin: channel loaded — waiting for the Huddle button');
      clickWhenReady(view.webContents, SLACK.huddle.startButton, 'channel Huddle button');
    });
  }

  // The huddle opens an about:blank popup — allow it and inject our scrape
  // preload so we can read/drive the huddle UI. about:blank inherits the
  // opener's origin + session, so the popup is same-partition and freely
  // injectable. (#264 two-surface — the genuinely new piece vs Meet.)
  view.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
    // Slack opens TWO kinds of child window:
    //   • the huddle UI — about:blank → inject the SCRAPE preload (our target).
    //   • a real app.slack.com window (e.g. picking a workspace, "Redirecting…")
    //     → it's another main surface; give it the MEDIA preload.
    // BOTH must stay in the authenticated `partition`, else Slack bounces them
    // through a logged-out redirect (the blank "Redirecting…" window).
    const isHuddlePopup = !popupUrl || popupUrl === 'about:blank';
    const preload = path.join(__dirname, isHuddlePopup ? 'preload-slack-huddle.js' : 'preload-slack-main.js');
    console.log('[slack-surface] window.open →', popupUrl || '(about:blank)',
      isHuddlePopup ? '[huddle popup → scrape]' : '[slack window → media]');
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        // Open WIDE: the huddle UI is responsive and HIDES the Thread/Captions
        // side-panel below a width threshold — and the chat editor / transcript
        // live in that panel, so a narrow popup means those selectors aren't in
        // the DOM at all. Force a width that keeps the side-panel mounted.
        width: 1280,
        height: 860,
        webPreferences: { preload, contextIsolation: false, sandbox: false, partition },
      },
    };
  });

  const popups = [];
  view.webContents.on('did-create-window', (win, details) => {
    popups.push(win);
    try { win.webContents.setUserAgent(userAgent); } catch { /* ignore */ }
    console.log('[slack-surface] popup created (url=' + (details && details.url) + ')');

    // Surface OUR popup logs ([slack-huddle]/[slack]) in the main stdout so they
    // sit alongside [slack-surface] — the popup is a separate renderer, so its
    // console doesn't reach here otherwise. Filtered to avoid Slack's own noise.
    win.webContents.on('console-message', (_e, _level, message) => {
      if (typeof message === 'string' && (message.includes('[slack-huddle]') || message.includes('[slack]'))) {
        console.log(message);
      }
    });

    // Huddle detection: the popup title flips to "Huddle: …" when a huddle is
    // live. Watch it (in-process — no AppleScript needed for OUR own window).
    const reportTitle = (title) => {
      const live = SLACK.isHuddleWindowTitle(title);
      console.log('[slack-surface] popup title: ' + JSON.stringify(title) + (live ? '  ← HUDDLE LIVE' : ''));
    };
    win.webContents.on('page-title-updated', (_e, title) => reportTitle(title));
    try { reportTitle(win.getTitle()); } catch { /* not ready */ }

    // Auto-confirm the lobby/preview ("Slack - Huddle Preview" → "Start Huddle").
    if (autojoin) clickWhenReady(win.webContents, SLACK.huddle.lobbyStartButton, 'lobby Start Huddle');

    if (devtools) { try { win.webContents.openDevTools({ mode: 'detach' }); } catch { /* ignore */ } }
    win.on('closed', () => {
      const i = popups.indexOf(win);
      if (i >= 0) popups.splice(i, 1);
      console.log('[slack-surface] popup closed');
    });
  });

  if (url) view.webContents.loadURL(url);
  return { view, getPopups: () => popups.slice() };
}

module.exports = { createSlackSurface };
