// zoom-session.js: a Zoom call, start to finish, in the page (#318).
//
// ZoomProvider (zoom-provider.js) is the DOM: buttons, panes, the caption
// overlay. This is what runs it: a 1s heartbeat that gets the bot through
// pre-join and reports the call as it changes (in-call, shares, roster, unread
// chat, captions), and a 250ms poll of who is speaking. It used to live in the
// app's preload-zoom.js; in the library it runs the same under any host.
//
//   const provider = startZoom({ getBotName: () => Promise<string> });
//   provider.on(CALL_EVENTS.captionTurns, …)   // every report is an event
//
// Like every provider it knows nothing of the wire: commands are method calls
// on the returned provider, reports are its events (provider-events.js).

const { ZoomProvider } = require('./zoom-provider');
const { ZOOM } = require('./zoom-selectors');
const { ZoomCaptionTracker } = require('../hearing/zoom-captions');
const { CALL_EVENTS } = require('../core/call-provider');
const { addEvents } = require('../core/provider-events');

function startZoom(host) {
  const provider = addEvents(new ZoomProvider(), { tag: '[zoom]' });
  const emit = (channel, payload) => (payload === undefined ? provider.emit(channel) : provider.emit(channel, payload));

  // Unread tracking: the newest message from someone else that the agent hasn't
  // read yet. wait_for_speech surfaces chat-unread on lulls, which is how a bot
  // that can't hear (v1) finds out someone typed to it.
  let lastReadChatId = null;
  let lastChatUnread = false;
  function newestOtherChatId(messages) {
    for (let i = messages.length - 1; i >= 0; i--) if (!messages[i].self) return messages[i].id;
    return null;
  }
  function setChatUnread(unread) {
    if (unread === lastChatUnread) return;
    lastChatUnread = unread;
    emit(CALL_EVENTS.chatUnread, { unread });
  }
  // A read clears the badge.
  const readChat = provider.readChat.bind(provider);
  provider.readChat = async () => {
    const messages = await readChat();
    lastReadChatId = newestOtherChatId(messages);
    setChatUnread(false);
    return messages;
  };

  // ---------------------------------------------------------------------------
  // Heartbeat: get through pre-join, then report in-call and push the roster.
  // ---------------------------------------------------------------------------
  let botName = '';
  Promise.resolve().then(() => host.getBotName()).then((n) => { botName = n || ''; }).catch(() => {});

  let lastSharing = false;
  let lastPresenter = null;
  let lastSharesKey = '[]';
  let prejoinTried = false;
  let captchaReported = false;
  let audioJoinTried = false;
  let waitingLogged = false;
  let reportedInCall = false;
  let captionsReported = null; // null = not checked yet; true/false once known
  let fiberProbed = false;
  const captions = new ZoomCaptionTracker();
  let inCallAt = 0;
  let lastRoster = '';

  function tick() {
    try {
      provider.dismissModals();

      if (!provider.inMeeting()) {
        if (provider.captchaFailed()) {
          if (!captchaReported) {
            captchaReported = true;
            prejoinTried = true; // never click Join again on our own
            console.warn('[zoom] Zoom rejected the guest join (reCAPTCHA). Not retrying. '
              + 'Sign the bot in to a Zoom account (--zoom-url=https://zoom.us/signin), or click Join in the bot view yourself.');
            emit(CALL_EVENTS.statusUpdate, 'Error: Zoom blocked the guest join (reCAPTCHA). Sign the bot in to a Zoom account, or click Join in the bot view.');
          }
          return;
        }
        if (provider.inWaitingRoom()) {
          if (!waitingLogged) { waitingLogged = true; console.log('[zoom] in the waiting room — the host has to admit the bot'); }
          return;
        }
        if (!prejoinTried && botName) { provider.fillPrejoin(botName).then((ok) => { prejoinTried = ok; }); }
        return;
      }

      if (!audioJoinTried) { audioJoinTried = true; provider.joinComputerAudio(); }

      if (!reportedInCall) {
        reportedInCall = true;
        inCallAt = Date.now();
        const meetCode = ZOOM.roomCodeFromUrl(location.href) || '';
        emit(CALL_EVENTS.statusUpdate, 'In call (Zoom)');
        emit(CALL_EVENTS.botJoinedCall, { meetCode, botName });
        console.log('[zoom] in the meeting — reported in-call (' + meetCode + ')');
        // Camera on so the virtual-camera avatar shows; open the roster so
        // participants can be read; turn on live transcription (host-only).
        setTimeout(async () => {
          try { console.log('[zoom] setCameraOn →', await provider.setCameraOn(true)); } catch (e) { console.warn('[zoom] setCameraOn error:', e.message); }
          try { console.log('[zoom] openParticipants →', await provider.openParticipants()); } catch (e) { console.warn('[zoom] openParticipants error:', e.message); }
          // Chat open too: it's how people reach a bot that can't hear yet. Whether
          // both panes stay open together is unverified — this log line says.
          try {
            const chatOk = await provider._ensureChatOpen();
            const d = provider.doc();
            console.log('[zoom] chat open →', chatOk, '| participants list still mounted:', !!d.querySelector(ZOOM.people.list));
            lastReadChatId = newestOtherChatId(provider.scrapeChatMessages()); // history at join isn't "unread"
          } catch (e) { console.warn('[zoom] open chat error:', e.message); }
          try { console.log('[zoom] enableCaptions →', await provider.enableCaptions()); } catch (e) { console.warn('[zoom] enableCaptions error:', e.message); }
        }, 2000);
      }

      // Our own share: report edges so the app's `sharing` follows Zoom (the app
      // retries Share until it hears this). On start, pause the share's computer
      // audio so Zoom gives the bot its mic back.
      const sharing = provider.isSharing();
      if (sharing !== lastSharing) {
        lastSharing = sharing;
        emit(CALL_EVENTS.selfPresenting, { presenting: sharing });
        console.log('[zoom] self-presenting:', sharing);
        if (sharing) setTimeout(() => provider.setShareAudioPaused(true), 500);
      }

      // Someone else's share: someone-presenting drives shared-screen reading and
      // the change-wake (#673); screen-shares-updated lists every share, ours
      // included, the way Meet's people pane does.
      const remote = provider.remoteShares();
      const presenter = remote.length ? remote[0].name : null;
      if (presenter !== lastPresenter) {
        lastPresenter = presenter;
        emit(CALL_EVENTS.someonePresenting, { presenting: !!presenter, presenterName: presenter });
        console.log('[zoom] someone presenting:', presenter);
      }
      const shares = sharing ? [...remote, { name: botName || 'self', id: 'self' }] : remote;
      const sharesKey = JSON.stringify(shares);
      if (sharesKey !== lastSharesKey) {
        lastSharesKey = sharesKey;
        emit(CALL_EVENTS.screenSharesUpdated, shares);
      }

      const parts = provider.getParticipants();
      const pk = JSON.stringify(parts);
      if (parts.length && pk !== lastRoster) {
        lastRoster = pk;
        emit(CALL_EVENTS.participantsUpdated, parts);
        console.log('[zoom] participants:', pk);
      }

      const newest = newestOtherChatId(provider.scrapeChatMessages());
      if (newest && newest !== lastReadChatId) setChatUnread(true);

      // Hearing: the caption overlay, attributed by avatar (#318). captions-state
      // follows whether the overlay exists (Show Captions is on), checked after
      // ~10s of setup so a slow enable doesn't flap it.
      // The overlay box mounts when Show Captions is on; #live-transcription-
      // subtitle only appears with the first words, so it can't be the test.
      const captionsOn = !!provider.doc().querySelector(ZOOM.captions.overlayBox);
      if (captionsReported !== captionsOn && Date.now() - inCallAt > 10000) {
        captionsReported = captionsOn;
        emit(CALL_EVENTS.captionsState, { on: captionsOn });
        if (!captionsOn) console.warn('[zoom] captions are off — the bot cannot hear until Show Captions is on');
      }
      // Drop the bot's own lines (its TTS gets captioned too), as Meet does, so it
      // never answers itself. Self = the roster row marked "me", or the name we
      // joined as if the roster isn't readable.
      const selfName = (parts.find((p) => p.isSelf) || {}).name || botName;
      const rows = provider.readOverlay().filter((r) => !selfName || r.speaker !== selfName);
      if (rows.length && !fiberProbed) { fiberProbed = true; provider.probeCaptionFiber(); }
      if (captions.update(rows)) {
        const turns = captions.snapshot();
        emit(CALL_EVENTS.captionTurns, { turns });
        const last = turns[turns.length - 1];
        if (last) console.log('[zoom] caption:', JSON.stringify({ speaker: last.speaker, text: last.text }));
      }
    } catch { /* DOM not ready yet */ }
  }

  // Who is speaking (#847 follow-up), from each participants-pane row's speaking
  // icon. Same shape as Teams' poll: faster than the 1s heartbeat, and it sends
  // the two events Meet's speaker tracker does — participantsUpdated with
  // speaking flags (the floor: anyoneSpeaking / peakSpeakers / barge-in) and
  // speakingChanged per edge (room presence). Shares lastRoster with tick().
  // The signal only exists while the pane is open, so reopen it if it closed.
  const lastSpeaking = new Map(); // name -> boolean (non-self only)
  let lastPaneReopenAt = 0;
  function pollSpeaking() {
    if (!reportedInCall) return;
    const d = provider.doc();
    // Test for the ROWS, not the list container: live (2026-10-16) the rows were
    // there and readable while #participants-ul was not, and a container check
    // read the open pane as closed and skipped every poll.
    if (!d.querySelector(ZOOM.people.item)) {
      if (Date.now() - lastPaneReopenAt > 10000) {
        lastPaneReopenAt = Date.now();
        provider.openParticipants().then((ok) => console.log('[zoom] participants pane was closed; reopened for speaking detection →', ok)).catch(() => {});
      }
      return;
    }
    let parts;
    try { parts = provider.getParticipants(); } catch { return; }
    const seen = new Set();
    let changed = false;
    for (const p of parts) {
      if (p.isSelf) continue;
      seen.add(p.name);
      if (lastSpeaking.get(p.name) !== p.speaking) {
        if (lastSpeaking.has(p.name) || p.speaking) {
          emit(CALL_EVENTS.speakingChanged, { name: p.name, speaking: p.speaking });
          console.log('[zoom] speaking:', p.name, p.speaking ? 'started' : 'stopped');
        }
        lastSpeaking.set(p.name, p.speaking);
        changed = true;
      }
    }
    // Left (or scrolled out of the virtualized list) while speaking: close the edge.
    for (const [name, was] of lastSpeaking) {
      if (seen.has(name)) continue;
      if (was) emit(CALL_EVENTS.speakingChanged, { name, speaking: false });
      lastSpeaking.delete(name);
      changed = true;
    }
    if (!changed) return;
    const pk = JSON.stringify(parts);
    if (parts.length && pk !== lastRoster) {
      lastRoster = pk;
      emit(CALL_EVENTS.participantsUpdated, parts);
    }
  }

  const run = () => {
    console.log('[zoom] starting heartbeat (1s) and speaking poll (250ms)');
    setInterval(tick, 1000);
    setInterval(pollSpeaking, 250);
  };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', run);
  else run();

  return provider;
}

module.exports = { startZoom };
