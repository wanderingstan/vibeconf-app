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
// Reading a link (which platform, which room) lives in call-target.js.

const { platformFromUrl: parseCallTarget, roomIdToJoinUrl, providerRoomIdForUrl } = require('./call-target');

// The call statuses that mean "this instance is in, or on its way into, a call".
// Same set local-server.js treats as active.
const ACTIVE_CALL_STATUSES = new Set(['navigating', 'joining', 'waiting-to-be-admitted', 'in-call']);

function isActiveCallStatus(status) {
  return ACTIVE_CALL_STATUSES.has(String(status || ''));
}

// What a new bot should load to join the call a running instance is in.
// Meet and Slack: rebuilt from the room id. Zoom and Teams: the room id is not
// enough (no passcode, no link), but the instance LOADED the full link and
// reports it (its currentMeetUrl), so that is used — 2026-10-16, Stan in a
// Teams call: "the app is the one that's in this call now, so it should know".
// Only when that link produces the SAME room the instance reports: a link left
// over from some earlier call must never send a bot into a different meeting.
// Null when neither works; the caller then asks for the link.
function instanceJoinUrl(roomId, joinUrl) {
  const fromRoom = roomIdToJoinUrl(roomId);
  if (fromRoom) return fromRoom;
  if (!joinUrl || !roomId) return null;
  const room = providerRoomIdForUrl(joinUrl);
  if (!room || room.toLowerCase() !== String(roomId).trim().toLowerCase()) return null;
  return parseCallTarget(joinUrl).ok ? String(joinUrl) : null;
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
 * @param {Array<{profile, port, callStatus, roomId, joinUrl?}>} input.instances
 *        running Vibeconferencing instances (any profile, including the caller's).
 *        joinUrl is the link the instance loaded (its currentMeetUrl); it is
 *        what makes a Zoom or Teams call rejoinable. It can carry a passcode:
 *        it travels only over 127.0.0.1 (instance → this app → the local
 *        caller, and as --join-url to the new instance) and is not logged.
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
    .map((i) => ({ roomId: String(i.roomId), url: instanceJoinUrl(i.roomId, i.joinUrl), profile: i.profile || null })));
  if (live.length === 1) {
    const only = live[0];
    if (!only.url) {
      return {
        action: 'error',
        error: `${only.profiles.join(', ') || 'A bot'} is in ${only.roomId}, but its meeting link isn't known (an older build, or a link that doesn't match the room), and a Zoom or Teams call can't be rejoined from its room id alone. Pass the meeting link.`,
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
  providerRoomIdForUrl,
  roomIdToJoinUrl,
  instanceJoinUrl,
  isActiveCallStatus,
  ACTIVE_CALL_STATUSES,
};
