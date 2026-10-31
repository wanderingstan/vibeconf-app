// teams-session.js: a Teams call, start to finish, in the page.
//
// TeamsProvider (teams-provider.js) is the DOM. This is what runs it: a 1s
// heartbeat (launcher → pre-join → lobby → in-call, then shares, roster, unread
// chat, captions) and a 250ms poll of who is speaking. It used to live in the
// app's preload-teams.js; in the library it runs the same under any host.
//
//   const provider = startTeams({ getBotName: () => Promise<string> });
//   provider.on(CALL_EVENTS.captionTurns, …)   // every report is an event

const { TeamsProvider } = require('./teams-provider');
const { TEAMS, teamsGuestName } = require('./teams-selectors');
const { CALL_EVENTS } = require('../core/call-provider');
const { addEvents } = require('../core/provider-events');

function startTeams(host) {
  const provider = addEvents(new TeamsProvider(), { tag: '[teams]' });
  const emit = (channel, payload) => (payload === undefined ? provider.emit(channel) : provider.emit(channel, payload));

  let lastReadChatId = null;
  let lastChatUnread = false;
  function newestOtherChatId(messages, selfName) {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].sender !== selfName) return messages[i].id;
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
    lastReadChatId = newestOtherChatId(messages, botName);
    setChatUnread(false);
    return messages;
  };

  // ---------------------------------------------------------------------------
  // Heartbeat: launcher → pre-join → (lobby) → in-call, then captions/roster/chat.
  // ---------------------------------------------------------------------------
  let botName = '';
  Promise.resolve().then(() => host.getBotName()).then((n) => { botName = teamsGuestName(n) || n || ''; provider.selfName = botName; }).catch(() => {});

  let lastSharing = false;
  let lastPresenter = null;
  let lastSharesKey = '[]';
  let launcherClicked = false;
  let prejoinDone = false;
  let lobbyLogged = false;
  let reportedInCall = false;
  let captionsReported = null;
  let inCallAt = 0;
  let lastCaptionKey = '';
  let lastRoster = '';

  function tick() {
    try {
      if (!provider.inMeeting()) {
        if (!launcherClicked && provider.clickJoinOnWeb()) { launcherClicked = true; return; }
        if (provider.inLobby()) {
          if (!lobbyLogged) { lobbyLogged = true; console.log('[teams] in the lobby — the organizer has to admit the bot'); }
          return;
        }
        if (!prejoinDone && botName) { provider.fillPrejoin(botName).then((ok) => { if (ok) prejoinDone = true; }); }
        return;
      }

      if (!reportedInCall) {
        reportedInCall = true;
        inCallAt = Date.now();
        emit(CALL_EVENTS.statusUpdate, 'In call (Teams)');
        emit(CALL_EVENTS.botJoinedCall, { meetCode: '', botName });
        console.log('[teams] in the meeting — reported in-call');
        setTimeout(async () => {
          try {
            const b = document.querySelector(TEAMS.toolbar.mic);
            console.log('[teams] mic button state:', JSON.stringify({ aria: b && b.getAttribute('aria-label'), pressed: b && b.getAttribute('aria-pressed'), checked: b && b.getAttribute('aria-checked') }));
          } catch { /* recon log only */ }
          try { console.log('[teams] enableCaptions →', await provider.enableCaptions()); } catch (e) { console.warn('[teams] enableCaptions error:', e.message); }
          try {
            console.log('[teams] chat open →', await provider._ensureChatOpen());
            lastReadChatId = newestOtherChatId(provider.scrapeChatMessages(), botName);
          } catch (e) { console.warn('[teams] open chat error:', e.message); }
        }, 2000);
      }

      // Our own share: report edges, so the app stops retrying Share (which, on
      // Teams, toggles the share off) once it has started.
      const sharing = provider.isSharing();
      if (sharing !== lastSharing) {
        lastSharing = sharing;
        emit(CALL_EVENTS.selfPresenting, { presenting: sharing });
        console.log('[teams] self-presenting:', sharing);
      }

      // Someone else's share → someone-presenting (screen reading, #673 wake);
      // every share → screen-shares-updated, ours included, as on Meet and Zoom.
      const stageShares = provider.screenShares();
      const others = stageShares.filter((s) => s.name !== botName);
      const presenter = others.length ? others[others.length - 1].name : null;
      if (presenter !== lastPresenter) {
        lastPresenter = presenter;
        emit(CALL_EVENTS.someonePresenting, { presenting: !!presenter, presenterName: presenter });
        console.log('[teams] someone presenting:', presenter);
      }
      const shares = sharing && !stageShares.some((s) => s.name === botName)
        ? [...stageShares, { name: botName || 'self', id: 'self' }] : stageShares;
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
        console.log('[teams] participants:', pk);
      }

      const newest = newestOtherChatId(provider.scrapeChatMessages(), botName);
      if (newest && newest !== lastReadChatId) setChatUnread(true);

      const captionsOn = provider.captionsOn();
      if (captionsReported !== captionsOn && Date.now() - inCallAt > 10000) {
        captionsReported = captionsOn;
        emit(CALL_EVENTS.captionsState, { on: captionsOn });
        if (!captionsOn) console.warn('[teams] captions are off — the bot cannot hear until they are on');
      }
      // Captions are a persistent named list (like Meet's pane): send the visible
      // snapshot, minus the bot's own lines so it never answers itself.
      const caps = provider.scrapeCaptions().filter((c) => !botName || c.speaker !== botName);
      const last = caps[caps.length - 1];
      const key = last ? caps.length + '::' + last.speaker + '::' + last.text : '';
      if (last && key !== lastCaptionKey) {
        lastCaptionKey = key;
        emit(CALL_EVENTS.captionTurns, {
          turns: caps.map((c, i) => ({ turnId: i + 1, speaker: c.speaker, text: c.text, isBottommost: i === caps.length - 1 })),
        });
        console.log('[teams] caption:', JSON.stringify(last));
      }
    } catch { /* DOM not ready yet */ }
  }

  // Who is speaking (#847), from each tile's speaking ring. Polled faster than the
  // 1s heartbeat: Teams moves the ring about once a second, and a 1s poll on top
  // of that would add up to another second before the bot knows to hold its turn.
  //
  // Two outputs, the same pair Meet's speaker tracker produces:
  //   - participantsUpdated with speaking flags: LocalServer.setParticipants turns
  //     these into the floor (anyoneSpeaking / activeSpeakerCount / peakSpeakers)
  //     that the urgency and barge-in gates read. Without it Teams read an empty
  //     floor and the bot talked over people (#847: peakSpeakers=0, 18 of 18).
  //   - speakingChanged per edge: room presence (main.js updateSpeakingState).
  // Shares lastRoster with tick(), so a roster sent here isn't re-sent there.
  const lastSpeaking = new Map(); // name -> boolean (non-self only)
  function pollSpeaking() {
    if (!reportedInCall) return;
    let parts;
    try { parts = provider.getParticipants(); } catch { return; }
    const seen = new Set();
    let changed = false;
    for (const p of parts) {
      if (p.isSelf) continue;
      seen.add(p.name);
      if (lastSpeaking.get(p.name) !== p.speaking) {
        // A first sighting that isn't speaking is not an edge worth announcing.
        if (lastSpeaking.has(p.name) || p.speaking) {
          emit(CALL_EVENTS.speakingChanged, { name: p.name, speaking: p.speaking });
          console.log('[teams] speaking:', p.name, p.speaking ? 'started' : 'stopped');
        }
        lastSpeaking.set(p.name, p.speaking);
        changed = true;
      }
    }
    // Someone left (or their tile scrolled off) while lit: close their edge, or
    // presence would show them talking forever.
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
    console.log('[teams] starting heartbeat (1s) and speaking poll (250ms)');
    setInterval(tick, 1000);
    setInterval(pollSpeaking, 250);
  };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', run);
  else run();

  return provider;
}

module.exports = { startTeams };
