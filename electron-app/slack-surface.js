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

const { BrowserView, session, globalShortcut, shell } = require('electron');
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

// Watch for a button whose visible text exactly matches `text` and click it
// whenever it appears. Used for modals that have no stable data-qa — notably the
// "You're in this huddle on a different device" dialog ("Switch to this device" /
// "Use both devices"), which blocks auto-join when the bot account is in the
// huddle on another session (e.g. two bot accounts on one machine, or a stale
// session). We DON'T clearInterval on click, so a modal that re-appears later in
// the call is dismissed again; the button vanishes after a successful click, so
// it won't double-fire. Matched by text because Slack ships no data-qa here.
function clickButtonByTextRepeating(webContents, text, label, { tries = 240, intervalMs = 500 } = {}) {
  const js = `(() => {
    const text = ${JSON.stringify(text)}, label = ${JSON.stringify(label)};
    let n = 0;
    const t = setInterval(() => {
      const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
      const el = [...document.querySelectorAll('button, [role="button"], a')]
        .find((e) => norm(e.textContent).includes(text) && e.offsetParent !== null);
      if (el) { el.click(); console.log('[slack] autojoin: clicked ' + label); }
      if (++n > ${tries}) clearInterval(t);
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

  // Mute the bot's audio OUTPUT (playback only — NOT the mic, so TTS still goes
  // out). The bot reads the transcript from captions; if it played the incoming
  // huddle audio through the speakers, a co-located human's mic would pick it up
  // and feed back into an endless reverb. Same as createMeetView's setAudioMuted.
  view.webContents.setAudioMuted(true);

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
    // The huddle UI is an about:blank popup — KEEP it a popup and inject the
    // scrape preload (it's our command/scrape target; the lobby/preview confirm
    // happens inside this same popup, see did-create-window below).
    const isHuddlePopup = !popupUrl || popupUrl === 'about:blank';
    if (isHuddlePopup) {
      console.log('[slack-surface] window.open → (about:blank) [huddle popup → scrape]');
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          // Open WIDE: the huddle UI is responsive and HIDES the Thread/Captions
          // side-panel below a width threshold — and the chat editor / transcript
          // live in that panel, so a narrow popup means those selectors aren't in
          // the DOM at all. Force a width that keeps the side-panel mounted.
          width: 1280,
          height: 860,
          webPreferences: { preload: path.join(__dirname, 'preload-slack-huddle.js'), contextIsolation: false, sandbox: false, partition },
        },
      };
    }

    // Any OTHER window.open is a real navigation — the workspace chooser's
    // "join", a "Redirecting…" bounce, or an SSO step (Slack/Google). As a
    // SEPARATE popup, Slack's first paint races our per-popup UA spoof
    // (did-create-window runs too late), so Slack serves its "browser not
    // supported" gate. Instead, load it in the MAIN view — that webContents
    // already carries the Chrome UA explicitly — and DENY the popup. Same
    // partition, so auth cookies are shared. This is what makes the in-app Slack
    // login flow work (#285); the huddle popup above is unaffected.
    let host = '';
    try { host = new URL(popupUrl).hostname; } catch { /* unparseable */ }
    const isAuthFlow = /(^|\.)slack\.com$/.test(host)
      || /(^|\.)google\.com$/.test(host) || /(^|\.)googleusercontent\.com$/.test(host);
    if (isAuthFlow) {
      console.log('[slack-surface] window.open →', popupUrl, '[load in main view, no popup]');
      try { view.webContents.loadURL(popupUrl); } catch (e) { console.warn('[slack-surface] main-view load failed:', e && e.message); }
      return { action: 'deny' };
    }

    // A genuinely external link (e.g. a URL shared in chat) — open it in the
    // user's real browser rather than hijacking the bot's Slack view.
    console.log('[slack-surface] window.open →', popupUrl, '[external → system browser]');
    shell.openExternal(popupUrl).catch(() => {});
    return { action: 'deny' };
  });

  const popups = [];
  // The live huddle popup (about:blank) — where SlackProvider runs. main.js
  // routes DOM call-commands (mic/camera/chat/share/captions) to its webContents.
  let huddlePopup = null;
  view.webContents.on('did-create-window', (win, details) => {
    popups.push(win);
    try { win.webContents.setUserAgent(userAgent); } catch { /* ignore */ }
    // Mute the popup's audio output too — the huddle media may play from here.
    // (Playback only; the VirtualMic/TTS is unaffected.) Prevents the feedback
    // reverb when a human shares the machine's speakers/mic.
    try { win.webContents.setAudioMuted(true); } catch { /* ignore */ }
    // Force a wide size AND a minimum — the overrideBrowserWindowOptions size
    // doesn't stick (Slack resizes the popup after open), and below a width
    // threshold the huddle hides the chat/captions side-panel (so those
    // selectors leave the DOM). The minimum stops Slack shrinking it back.
    try { win.setMinimumSize(1100, 760); win.setSize(1280, 860); } catch { /* ignore */ }
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

    // Integrate the huddle popup with the main app window instead of leaving it
    // as a 2nd free-floating window: parent it (so they group — move/focus/
    // minimize together; not a separate dock/taskbar entry) and lay it OVER the
    // app. Once in the huddle the underlying app.slack.com view isn't needed, so
    // the popup "becomes" the call surface. Electron can't embed a window.open
    // popup as a BrowserView, so it stays a window — this is the closest to
    // single-window. setMinimumSize keeps it wide enough for the side panel even
    // if the app window is narrower. Only the huddle (about:blank) overlays —
    // not a transient app.slack.com window.
    const isHuddlePopup = !details || !details.url || details.url === 'about:blank';
    if (isHuddlePopup) {
      huddlePopup = win; // command target for main.js (mic/camera/chat/share/captions)
      win.on('closed', () => { if (huddlePopup === win) huddlePopup = null; });
    }
    if (isHuddlePopup && mainWindow && !mainWindow.isDestroyed()) {
      try {
        win.setParentWindow(mainWindow);
        const overlay = () => {
          if (mainWindow && !mainWindow.isDestroyed() && win && !win.isDestroyed()) {
            win.setBounds(mainWindow.getBounds());
          }
        };
        overlay();
        mainWindow.on('move', overlay);
        mainWindow.on('resize', overlay);
        win.on('closed', () => {
          try { mainWindow.removeListener('move', overlay); mainWindow.removeListener('resize', overlay); } catch { /* ignore */ }
        });
      } catch (e) { console.warn('[slack-surface] overlay setup failed:', e && e.message); }
    }

    // Auto-confirm the lobby/preview ("Slack - Huddle Preview" → "Start Huddle").
    if (autojoin) clickWhenReady(win.webContents, SLACK.huddle.lobbyStartButton, 'lobby Start Huddle');

    // The "You're in this huddle on a different device" modal renders in THIS
    // huddle popup (Stan confirmed 2026-06-24) when the bot account is already in
    // the huddle on another session (two bot accounts on one machine, or a stale
    // device) — it blocks the join. Claim the huddle for this bot instance by
    // clicking "Switch to this device" whenever it appears. Runs always (not just
    // autojoin) so a manually-driven bot is unblocked too.
    clickButtonByTextRepeating(win.webContents, 'Switch to this device', '"Switch to this device" (different-device modal)');

    // Slack's "Opening Slack…" interstitial tries to hand off to the native
    // desktop app and offers a "use Slack in your browser" link. The bot has no
    // native app, so click that link to stay in-browser (#287). Match the stable
    // substring to cover "use/open Slack in your browser[ instead]".
    clickButtonByTextRepeating(win.webContents, 'Slack in your browser', '"use Slack in your browser" interstitial');

    if (devtools) { try { win.webContents.openDevTools({ mode: 'detach' }); } catch { /* ignore */ } }
    win.on('closed', () => {
      const i = popups.indexOf(win);
      if (i >= 0) popups.splice(i, 1);
      console.log('[slack-surface] popup closed');
    });
  });

  if (url) view.webContents.loadURL(url);

  // During login/SSO the main view can hit Slack's "Opening Slack…" interstitial
  // (native-app handoff) that offers a "use Slack in your browser" link. Click it
  // so the flow proceeds without a human — needed for in-app Slack login (#285)
  // and first-time profile setup (#287). Harmless when the link never appears.
  //
  // Re-arm on EVERY document load, not once: clickButtonByTextRepeating injects a
  // setInterval into the CURRENT document, but a login is a chain of full-page
  // navigations (email → SSO → redirect → "Opening Slack…"), and each navigation
  // tears down the JS realm and kills that injected interval. Firing it only at
  // surface creation meant that by the time the interstitial's OWN document loaded
  // — often minutes into a human login, well past the old 120s self-expiry too —
  // no clicker was running in it, so it never fired (#287). did-finish-load gives
  // each new page (including the interstitial, whenever it shows up) a fresh,
  // short-lived clicker.
  view.webContents.on('did-finish-load', () => {
    clickButtonByTextRepeating(view.webContents, 'Slack in your browser', '"use Slack in your browser" interstitial (main view)', { tries: 40 });
  });

  // Toggle between the huddle overlay and the app/panel underneath. The huddle
  // is a child window laid OVER the app (always on top of it), so to reach the
  // controls you hide the huddle. A SYSTEM shortcut so it works even while the
  // huddle covers everything; a panel "show controls" button can call the same
  // toggleHuddle() later (exposed on the return value).
  const toggleHuddle = () => {
    let any = false;
    for (const w of popups) {
      if (w.isDestroyed()) continue;
      any = true;
      if (w.isVisible()) w.hide(); else w.show();
    }
    console.log('[slack-surface] toggled huddle visibility' + (any ? '' : ' (no huddle window yet)'));
  };
  const TOGGLE_ACCEL = 'CommandOrControl+Shift+0';
  try {
    globalShortcut.register(TOGGLE_ACCEL, toggleHuddle);
    console.log('[slack-surface] huddle/controls toggle = ' + TOGGLE_ACCEL);
  } catch (e) { console.warn('[slack-surface] toggle register failed:', e && e.message); }

  // webContents of the live huddle popup (the SlackProvider command target), or
  // null if there's no huddle yet / it closed.
  const getHuddleWebContents = () =>
    (huddlePopup && !huddlePopup.isDestroyed()) ? huddlePopup.webContents : null;

  return { view, getPopups: () => popups.slice(), toggleHuddle, getHuddleWebContents };
}

module.exports = { createSlackSurface };
