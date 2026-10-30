// call-target.js: the one place a call link is read (Phase 1 of the calls
// library). platformFromUrl says which platform a link belongs to, the URL to
// load and the room it makes; main.js's joinUrl acts on that verdict, so every
// join path (agent, panel, supervisor, calendar, /call-new-bot) classifies a
// link the same way.
//
// Pure (no Electron, no network) so it can be tested. Kept CommonJS like the
// rest of electron-app. Two copies stay apart on purpose: renderer/call-link.js
// runs in the panel without require, and mcp-server/server.js's join_call (and
// meet-room.js) may not import electron-app (#708, the packaging boundary).

const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i;
const MEET_URL = /^(?:https?:\/\/)?(?:www\.)?meet\.google\.com\/(?:meet\/)?([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#]|$)/i;
const SLACK_URL = /^(?:https?:\/\/)?app\.slack\.com\/client\/([A-Za-z0-9]+)\/([A-Za-z0-9]+)/;
// Zoom and Teams: the same shapes mcp-server/server.js's join_call accepts.
const ZOOM_HOST = /^https?:\/\/([a-z0-9-]+\.)*zoom\.us\//i;
const ZOOM_MEETING = /\/(?:j|wc(?:\/join)?)\/(\d{9,11})/;
const TEAMS_URL = /^https?:\/\/([a-z0-9-]+\.)*teams\.(live|microsoft)\.com\//i;

// Whatever the user typed → { ok, provider, url, roomId } or { ok: false, error }.
// The url is what the new instance is launched to join; roomId is only for
// de-duplication and for saying which call in prose.
function platformFromUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: false, error: 'No call given.' };

  if (MEET_CODE.test(s)) {
    const code = s.toLowerCase();
    return { ok: true, provider: 'meet', roomId: code, url: `https://meet.google.com/${code}` };
  }
  const meet = s.match(MEET_URL);
  if (meet) {
    const code = meet[1].toLowerCase();
    return { ok: true, provider: 'meet', roomId: code, url: `https://meet.google.com/${code}` };
  }
  const slack = s.match(SLACK_URL);
  if (slack) {
    const url = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    return { ok: true, provider: 'slack', roomId: `slack-${slack[1].toLowerCase()}-${slack[2].toLowerCase()}`, url };
  }
  const zoom = ZOOM_HOST.test(s) && s.match(ZOOM_MEETING);
  if (zoom) return { ok: true, provider: 'zoom', roomId: `zoom-${zoom[1]}`, url: s };
  if (TEAMS_URL.test(s)) return { ok: true, provider: 'teams', roomId: null, url: s };
  const waLink = require('./whatsapp-call').parseCallLink(s);
  if (waLink) {
    const { roomCodeForLink } = require('./whatsapp-call');
    return { ok: true, provider: 'whatsapp', roomId: roomCodeForLink(waLink.token), url: `https://call.whatsapp.com/${waLink.kind}/${waLink.token}` };
  }

  if (/meet\.google\.com/i.test(s)) {
    return { ok: false, error: `"${s}" is a Google Meet link, but no meet code (abc-defg-hij) could be read from it. Open it in a browser and pass the code from the address bar.` };
  }
  return { ok: false, error: `"${s}" is not a call this can join. Pass a Meet code (abc-defg-hij), a Meet URL, a Slack huddle URL, or a Zoom or Teams meeting link.` };
}

// A running instance reports its ROOM ID. Meet codes and Slack huddles round-
// trip from that alone (Slack team/channel ids are uppercase; the room id
// lowercased them). Zoom loses its passcode and Teams its whole link, so those
// return null here — see instanceJoinUrl for how they are joined anyway.
function roomIdToJoinUrl(roomId) {
  const r = String(roomId || '').trim();
  if (!r || r === 'no-room') return null;
  if (MEET_CODE.test(r)) return `https://meet.google.com/${r.toLowerCase()}`;
  const slack = r.match(/^slack-([a-z0-9]+)-([a-z0-9]+)$/i);
  if (slack) return `https://app.slack.com/client/${slack[1].toUpperCase()}/${slack[2].toUpperCase()}`;
  return null;
}

// The room id a Zoom or Teams link registers as — the same derivation main.js
// uses when it activates the provider (registerProviderRoom), so a link and the
// room it produced compare equal. Null for anything else.
function providerRoomIdForUrl(url) {
  const { TEAMS } = require('./teams-selectors');
  const { ZOOM } = require('./zoom-selectors');
  const s = String(url || '');
  if (TEAMS_URL.test(s)) return TEAMS.roomCodeFromUrl(s);
  if (ZOOM_HOST.test(s)) return ZOOM.roomCodeFromUrl(s);
  const wa = require('./whatsapp-call');
  const waLink = wa.parseCallLink(s);
  if (waLink) return wa.roomCodeForLink(waLink.token);
  return null;
}

module.exports = { platformFromUrl, roomIdToJoinUrl, providerRoomIdForUrl, MEET_CODE };
