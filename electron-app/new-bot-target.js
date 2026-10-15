// new-bot-target.js — which call should a freshly summoned bot (/call-new-bot) join?
//
// /call-new-bot used to make a bot and stop: no call at all. The case that
// actually comes up is a call ALREADY in progress — you're talking to one bot,
// and you want the session you've been working in to come and join too. There
// was no way to do that: /join-call addresses an existing running profile, and
// with one instance running an unknown name is read as a one-off rename of THAT
// instance, which pulls a working bot out of the call it is in.
//
// So the order is:
//   1. an explicit target the user passed (Meet code/URL, Slack huddle URL,
//      Zoom or Teams link) — always wins;
//   2. a call some running Vibeconferencing instance is in right now;
//   3. a Meet open in the user's browser (Chrome/Brave/Safari tab scan);
//   4. nothing found → start a fresh Meet.
// At steps 2 and 3, several DISTINCT calls means ask, never guess: joining the
// wrong meeting puts a bot in front of people who did not invite it.
//
// Pure (no Electron, no network) so it can be tested; main.js gathers the
// inputs and acts on the verdict. Kept CommonJS like the rest of electron-app.
// mcp-server/meet-room.js has the same Meet parsing for the MCP side; the two
// packages must not import each other (#708, the packaging boundary).

const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i;
const MEET_URL = /^(?:https?:\/\/)?(?:www\.)?meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#]|$)/i;
const SLACK_URL = /^(?:https?:\/\/)?app\.slack\.com\/client\/([A-Za-z0-9]+)\/([A-Za-z0-9]+)/;
// Zoom and Teams: the same shapes mcp-server/server.js's join_call accepts.
const ZOOM_HOST = /^https?:\/\/([a-z0-9-]+\.)*zoom\.us\//i;
const ZOOM_MEETING = /\/(?:j|wc(?:\/join)?)\/(\d{9,11})/;
const TEAMS_URL = /^https?:\/\/([a-z0-9-]+\.)*teams\.(live|microsoft)\.com\//i;

// The call statuses that mean "this instance is in, or on its way into, a call".
// Same set local-server.js treats as active.
const ACTIVE_CALL_STATUSES = new Set(['navigating', 'joining', 'waiting-to-be-admitted', 'in-call']);

function isActiveCallStatus(status) {
  return ACTIVE_CALL_STATUSES.has(String(status || ''));
}

// Whatever the user typed → { ok, provider, url, roomId } or { ok: false, error }.
// The url is what the new instance is launched to join; roomId is only for
// de-duplication and for saying which call in prose.
function parseCallTarget(raw) {
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

  if (/meet\.google\.com/i.test(s)) {
    return { ok: false, error: `"${s}" is a Google Meet link, but no meet code (abc-defg-hij) could be read from it. Open it in a browser and pass the code from the address bar.` };
  }
  return { ok: false, error: `"${s}" is not a call this can join. Pass a Meet code (abc-defg-hij), a Meet URL, a Slack huddle URL, or a Zoom or Teams meeting link.` };
}

// A running instance reports its ROOM ID, not the link it joined. Turn that back
// into something a new instance can join. Meet codes and Slack huddles round-
// trip (Slack team/channel ids are uppercase; the room id lowercased them).
// Zoom loses its passcode and Teams its whole link, so those return null and the
// caller has to ask for the link instead of joining something half-formed.
function roomIdToJoinUrl(roomId) {
  const r = String(roomId || '').trim();
  if (!r || r === 'no-room') return null;
  if (MEET_CODE.test(r)) return `https://meet.google.com/${r.toLowerCase()}`;
  const slack = r.match(/^slack-([a-z0-9]+)-([a-z0-9]+)$/i);
  if (slack) return `https://app.slack.com/client/${slack[1].toUpperCase()}/${slack[2].toUpperCase()}`;
  return null;
}

// Group by call, keeping the order things were found in. Several bots in the
// same meeting are ONE candidate, not a reason to ask.
function distinctCalls(items) {
  const byRoom = new Map();
  for (const it of items) {
    if (!it.roomId) continue;
    const key = it.roomId.toLowerCase();
    if (!byRoom.has(key)) byRoom.set(key, { roomId: key, url: it.url || null, profiles: [] });
    const entry = byRoom.get(key);
    if (!entry.url && it.url) entry.url = it.url;
    if (it.profile) entry.profiles.push(it.profile);
  }
  return [...byRoom.values()];
}

/**
 * Decide which call a newly summoned bot joins.
 *
 * @param {object} input
 * @param {string|null} input.explicit          what the user passed, if anything
 * @param {Array<{profile, port, callStatus, roomId}>} input.instances
 *        running Vibeconferencing instances (any profile, including the caller's)
 * @param {string[]} input.browserMeetUrls       Meet URLs open in the user's browser
 *
 * @returns one of
 *   { action: 'join',  source: 'explicit'|'in-progress'|'browser', provider, url, roomId, profiles? }
 *   { action: 'ask',   source: 'in-progress'|'browser', candidates: [{ roomId, url, profiles }] }
 *   { action: 'new',   source: 'none' }
 *   { action: 'error', error }
 */
function resolveNewBotTarget({ explicit = null, instances = [], browserMeetUrls = [] } = {}) {
  // 1. Explicit wins, and a bad one is an error — never quietly fall through to
  //    auto-detection, which would put the bot somewhere the user did not say.
  if (explicit != null && String(explicit).trim()) {
    const t = parseCallTarget(explicit);
    if (!t.ok) return { action: 'error', error: t.error };
    return { action: 'join', source: 'explicit', provider: t.provider, url: t.url, roomId: t.roomId };
  }

  // 2. A call some running instance is in.
  const live = distinctCalls((instances || [])
    .filter((i) => i && isActiveCallStatus(i.callStatus) && i.roomId && i.roomId !== 'no-room')
    .map((i) => ({ roomId: String(i.roomId), url: roomIdToJoinUrl(i.roomId), profile: i.profile || null })));
  if (live.length === 1) {
    const only = live[0];
    if (!only.url) {
      return {
        action: 'error',
        error: `${only.profiles.join(', ') || 'A bot'} is in ${only.roomId}, but a Zoom or Teams call can't be rejoined from its room id alone. Pass the meeting link.`,
      };
    }
    const t = parseCallTarget(only.url);
    return { action: 'join', source: 'in-progress', provider: t.provider, url: only.url, roomId: only.roomId, profiles: only.profiles };
  }
  if (live.length > 1) return { action: 'ask', source: 'in-progress', candidates: live };

  // 3. A Meet open in the user's browser.
  const tabs = distinctCalls((browserMeetUrls || [])
    .map((u) => parseCallTarget(u))
    .filter((t) => t.ok && t.provider === 'meet')
    .map((t) => ({ roomId: t.roomId, url: t.url })));
  if (tabs.length === 1) {
    return { action: 'join', source: 'browser', provider: 'meet', url: tabs[0].url, roomId: tabs[0].roomId };
  }
  if (tabs.length > 1) return { action: 'ask', source: 'browser', candidates: tabs };

  // 4. Nothing to join — make a call.
  return { action: 'new', source: 'none' };
}

module.exports = {
  resolveNewBotTarget,
  parseCallTarget,
  roomIdToJoinUrl,
  isActiveCallStatus,
  ACTIVE_CALL_STATUSES,
};
