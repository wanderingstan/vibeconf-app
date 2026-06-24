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

const { BrowserView } = require('electron');
const path = require('path');
const { SLACK } = require('./slack-selectors');

// Build the Slack surface bound to a session partition.
//   mainWindow — the app's BrowserWindow (for layout; caller addBrowserView's it)
//   opts.partition — session partition (reuse the bot's; login carries to popup)
//   opts.url       — initial URL to load (app.slack.com or a channel deep-link)
//   opts.devtools  — open DevTools on the popup (handy for live driving)
// Returns { view, getPopups }.
function createSlackSurface(mainWindow, opts = {}) {
  const { partition, url, devtools } = opts;

  const view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-slack-main.js'),
      contextIsolation: false,
      sandbox: false,
      partition,
    },
  });

  // The huddle opens an about:blank popup — allow it and inject our scrape
  // preload so we can read/drive the huddle UI. about:blank inherits the
  // opener's origin + session, so the popup is same-partition and freely
  // injectable. (#264 two-surface — the genuinely new piece vs Meet.)
  view.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
    console.log('[slack-surface] window.open intercepted →', popupUrl || '(about:blank)');
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        webPreferences: {
          preload: path.join(__dirname, 'preload-slack-huddle.js'),
          contextIsolation: false,
          sandbox: false,
        },
      },
    };
  });

  const popups = [];
  view.webContents.on('did-create-window', (win, details) => {
    popups.push(win);
    console.log('[slack-surface] popup created (url=' + (details && details.url) + ')');

    // Huddle detection: the popup title flips to "Huddle: …" when a huddle is
    // live. Watch it (in-process — no AppleScript needed for OUR own window).
    const reportTitle = (title) => {
      const live = SLACK.isHuddleWindowTitle(title);
      console.log('[slack-surface] popup title: ' + JSON.stringify(title) + (live ? '  ← HUDDLE LIVE' : ''));
    };
    win.webContents.on('page-title-updated', (_e, title) => reportTitle(title));
    try { reportTitle(win.getTitle()); } catch { /* not ready */ }

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
