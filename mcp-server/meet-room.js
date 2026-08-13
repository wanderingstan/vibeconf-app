// meet-room.js — turn whatever someone pasted into a Meet room code.
//
// Why this exists: `join_call`'s room_id was documented as "the meet code", and
// the URL→code extraction lived only in the `/join-call` skill. That is fine for
// Claude Code users, who get the skill — but the raw MCP tool is the front door
// for every other integrator (Codex, Cursor, a hand-rolled client), and they
// have no skill. Every one of them pastes a URL at least once (#314).
//
// Before this, a pasted URL was POSTed verbatim as the room id, which fails
// somewhere further down as an unrecognised room rather than as "that was a URL".
//
// Slack huddle URLs are NOT handled here — join_call detects those first and
// routes them to the Slack provider on a separate path.
//
// Pure + testable; server.js is a thin caller. ESM, like server.js itself.

// Meet codes are three groups: xxx-xxxx-xxx (lowercase letters).
const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i;

// meet.google.com, with or without a scheme or a www./ prefix.
const MEET_HOST = /^(?:https?:\/\/)?(?:www\.)?meet\.google\.com\/(.+)$/i;

// Returns { ok: true, roomId } or { ok: false, error }.
//
// Anything that is not recognisably a Meet URL passes through UNCHANGED. That
// matters: room_id also carries slack-<team>-<channel> ids and the literal
// 'no-room', and this must not mangle them.
function parseMeetRoomId(raw) {
  const trimmed = String(raw == null ? '' : raw).trim();
  if (!trimmed) return { ok: false, error: 'No room_id given. Pass a Meet code (abc-defg-hij) or a Meet URL.' };

  // Already a bare code — the documented form, and the common one.
  if (MEET_CODE.test(trimmed)) return { ok: true, roomId: trimmed.toLowerCase() };

  const m = trimmed.match(MEET_HOST);
  if (!m) return { ok: true, roomId: trimmed };   // not ours to touch

  // Strip query + hash: real pasted URLs carry ?authuser=0, ?pli=1, #heading.
  const firstSegment = m[1].split(/[?#]/)[0].replace(/\/+$/, '');

  if (MEET_CODE.test(firstSegment)) return { ok: true, roomId: firstSegment.toLowerCase() };

  // A meet.google.com URL we can't reduce to a code. The two common shapes are
  // a lookup/nickname link (meet.google.com/lookup/<hash>) and a landing page.
  // Both resolve to a real code only by following a redirect in a browser, which
  // is not this process's job — so say what's wrong instead of POSTing a URL as
  // a room id and failing later as "unknown room".
  return {
    ok: false,
    error: `"${trimmed}" is a Google Meet URL, but no meet code (abc-defg-hij) could be read from it. `
      + `Open the link in a browser and pass the code from the address bar.`,
  };
}

export { parseMeetRoomId, MEET_CODE };
