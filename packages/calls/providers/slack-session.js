// slack-session.js: a Slack huddle, in the page (#264).
//
// Slack splits a huddle across two windows. The main app.slack.com window owns
// the media (the media core goes there, as on every platform); the huddle UI is
// an about:blank popup it opens, and that popup is where SlackProvider reads and
// drives the call. startSlackHuddle runs in the popup: a 1s heartbeat that
// reports in-call, the roster, captions and our own share. It used to live in
// the app's preload-slack-huddle.js; in the library it runs the same under any
// host.
//
// The clicks that get a bot into a huddle (the channel's Huddle button, the
// lobby's Start Huddle, two interstitials) are slackNudges below: page scripts
// a host runs in the right window. The Electron host injects them with
// executeJavaScript (slack-surface.js); the Playwright host with evaluate.
//
//   const provider = startSlackHuddle({ getBotName });   // in the popup
//   provider.on(CALL_EVENTS.captionTurns, …)

const { SlackProvider } = require('./slack-provider');
const { CALL_EVENTS } = require('../core/call-provider');
const { addEvents } = require('../core/provider-events');

function startSlackHuddle(/* host */) {
  const provider = addEvents(new SlackProvider(), { tag: '[slack-huddle]' });
  const emit = (channel, payload) => (payload === undefined ? provider.emit(channel) : provider.emit(channel, payload));

  // Scrape heartbeat: once the huddle UI is up, push roster + captions so we can
  // watch scraping work end-to-end. Deduped to avoid log/IPC spam.
  let lastRoster = '';
  let lastCaption = '';
  let lastSharing = false;
  let reportedInCall = false;
  function tick() {
    try {
      const parts = provider.getParticipants();
      // Once participant tiles exist we're past the lobby and actually in the
      // huddle — tell the app so it flips to 'in-call' (main.js maps a status
      // containing "In call" → in-call), which unlocks the panel (TTS test, etc.).
      if (!reportedInCall && parts.length) {
        reportedInCall = true;
        emit(CALL_EVENTS.statusUpdate, 'In call (Slack huddle)');
        console.log('[slack-huddle] in a huddle — reported in-call to the app');
        // Standard join setup, after the in-call toolbar settles: turn the camera
        // on (the Slack lobby defaults it OFF, so the bot's virtual-camera avatar
        // wouldn't show otherwise — we already own the toggle, so no lobby DOM is
        // needed), then enable side-by-side captions (the Slack analog of
        // auto-enabling captions on Meet). Camera first: it's a single idempotent
        // click, done before captions opens its menus.
        setTimeout(async () => {
          try {
            const camOk = await provider.setCameraOn(true);
            console.log('[slack-huddle] setCameraOn →', camOk);
          } catch (e) { console.warn('[slack-huddle] setCameraOn error:', e && e.message); }
          provider.enableCaptions()
            .then((ok) => console.log('[slack-huddle] enableCaptions →', ok))
            .catch((e) => console.warn('[slack-huddle] enableCaptions error:', e && e.message));
        }, 2000);
      }
      const pk = JSON.stringify(parts);
      if (parts.length && pk !== lastRoster) {
        lastRoster = pk;
        emit(CALL_EVENTS.participantsUpdated, parts);
        console.log('[slack-huddle] participants:', JSON.stringify(parts));
      }
      const caps = provider.scrapeCaptions();
      if (caps.length) {
        const last = caps[caps.length - 1];
        const ck = last.speaker + '::' + last.text;
        if (ck !== lastCaption) {
          lastCaption = ck;
          emit(CALL_EVENTS.captionTurns, {
            turns: caps.map((c, i) => ({ turnId: i + 1, speaker: c.speaker, text: c.text, isBottommost: i === caps.length - 1 })),
          });
          console.log('[slack-huddle] caption:', JSON.stringify(last));
        }
      }
      // Report the REAL screen-share state (the toggle button's pressed attr) so
      // the app's `sharing` flag reflects what Slack is actually doing — the parity
      // analog of Meet's screen-share-stopped correction. selfPresenting →
      // setSharing(presenting) in main.js. This both CONFIRMS an agent-requested
      // share actually engaged and CATCHES a stop/drop (user clicked the button,
      // stream died) that the optimistic setSharing(true) wouldn't notice.
      const sharing = provider.isSharing();
      if (sharing !== lastSharing) {
        lastSharing = sharing;
        emit(CALL_EVENTS.selfPresenting, { presenting: sharing });
        console.log('[slack-huddle] self-presenting:', sharing);
      }
    } catch { /* DOM not ready yet */ }
  }

  const run = () => {
    console.log('[slack-huddle] starting scrape heartbeat (1s)');
    setInterval(tick, 1000);
  };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', run);
  else run();

  return provider;
}

// ---------------------------------------------------------------------------
// slackNudges: page scripts (strings) that click a bot into a huddle. Each
// polls for its target, so it can be run as soon as the window exists.
// ---------------------------------------------------------------------------

// Poll for `selector` and click it once it appears (Slack is a SPA, so toolbar
// and lobby buttons render well after load). Logs with a [slack] prefix.
function clickWhenReadyJs(selector, label, { tries = 60, intervalMs = 500 } = {}) {
  return `(() => {
    const sel = ${JSON.stringify(selector)}, label = ${JSON.stringify(label)};
    let n = 0;
    const t = setInterval(() => {
      const el = document.querySelector(sel);
      if (el) { el.click(); clearInterval(t); console.log('[slack] autojoin: clicked ' + label); }
      else if (++n > ${tries}) { clearInterval(t); console.warn('[slack] autojoin: timed out waiting for ' + label); }
    }, ${intervalMs});
  })();`;
}

// Watch for a button whose visible text includes `text` and click it whenever
// it appears. For modals with no stable data-qa — notably "You're in this
// huddle on a different device" ("Switch to this device"), which blocks the
// join when the bot account is still in the huddle from another session. No
// clearInterval on click, so a modal that re-appears is dismissed again; the
// button vanishes after a successful click, so it won't double-fire.
function clickButtonByTextRepeatingJs(text, label, { tries = 240, intervalMs = 500 } = {}) {
  return `(() => {
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
}

module.exports = { startSlackHuddle, clickWhenReadyJs, clickButtonByTextRepeatingJs };
