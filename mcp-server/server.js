#!/usr/bin/env node

/**
 * MCP Server for Vibeconferencing Agent
 *
 * Lets AI agents (Claude Code, etc.) interact with a Google Meet call
 * through the vibeconferencing.com sync API. The Chrome extension
 * handles the Meet-side (virtual camera, mic, captions, TTS).
 *
 * Tools:
 *   - read_transcripts: Read what people are saying in the call
 *   - wait_for_speech: Long-poll — blocks until someone finishes speaking
 *   - speak: Say something in the call (spoken via TTS)
 *   - update_whiteboard: Update the shared whiteboard/screen
 *   - get_room_info: Get current room state
 *
 * Configuration via environment variables:
 *   VIBECONF_ROOM_ID   - The Meet code / room ID (required)
 *   VIBECONF_BOT_NAME  - Bot's display name (default: "Unnamed bot")
 *   VIBECONF_BASE_URL  - API base URL (default: http://127.0.0.1:7865 — the Electron app's local server)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync, execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { resolveInstance, joinNameFromRouting } from "./instance-routing.js";
import { parseMeetRoomId } from "./meet-room.js";

let ROOM_ID = process.env.VIBECONF_ROOM_ID || "";
let BOT_NAME = process.env.VIBECONF_BOT_NAME || "Unnamed bot";
// The local app instance this session drives. Starts at the env/default port, but
// join_call RE-BINDS it to the instance matching the requested profile name, so a
// single agent session can target any running profile regardless of which port
// the app baked into the MCP config (#301). Reassigned in routeToInstance().
let BASE_URL = process.env.VIBECONF_BASE_URL || "http://127.0.0.1:7865";
// The port this session was EXPLICITLY pinned to, captured before anything can
// re-bind BASE_URL. The app writes VIBECONF_BASE_URL into each profile's own MCP
// config, so when it's set we know which instance this terminal belongs to and
// can skip the "which profile did you mean?" prompt. Null when unset — the
// default 7865 happens to be the default profile's port, and inferring from that
// would silently pick a profile the user never named.
const PINNED_PORT = (() => {
  const m = String(process.env.VIBECONF_BASE_URL || "").match(/:(\d+)/);
  return m ? Number(m[1]) : null;
})();
// Backend (Vercel) base — used for REMOTE session logs shipped by other machines
// (get_session_log with an `instance` arg / list_log_instances). Distinct from
// BASE_URL, which is this machine's local Electron app.
const WEBSITE_URL = (process.env.VIBECONF_WEBSITE_URL || "https://vibeconferencing.com").replace(/\/$/, "");
const LOGS_TOKEN = process.env.VIBECONF_LOGS_TOKEN || "";

// #356: attach the local control token to calls aimed at a 127.0.0.1 app instance.
// The Electron app writes a per-launch bearer token to
// ~/.vibeconferencing/local-tokens/<port>.token (0600). We read it per-request and
// send `Authorization: Bearer <token>`; a browser page can't read that file, so it
// can't forge the header. Remote (WEBSITE_URL) calls pass straight through
// unchanged. A missing token file sends no header, which now means a 401 rather
// than nothing (#201 turned enforcement on by default) — and that is the point:
// no token for this port means this is not our app, most likely another macOS
// user account's instance holding the port. Failing loudly there beats driving
// the wrong bot. All local calls go through vfetch(), so this is one choke point.
const _nativeFetch = globalThis.fetch;
function _localToken(port) {
  try {
    return readFileSync(join(homedir(), ".vibeconferencing", "local-tokens", `${port}.token`), "utf8").trim() || null;
  } catch { return null; }
}
function vfetch(url, opts = {}) {
  try {
    const u = new URL(typeof url === "string" ? url : url.url);
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost") {
      const tok = _localToken(u.port || "80");
      if (tok) opts = { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${tok}` } };
    }
  } catch { /* non-URL input — pass through untouched */ }
  return _nativeFetch(url, opts);
}
const MCP_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')).version;
  } catch {
    return "unknown";
  }
})();
const MCP_VERSIONS = {
  mcp: MCP_VERSION,
  node: process.version,
};

// ── Multi-profile instance discovery + routing (#301) ────────────────────────
// Multiple app instances (profiles) can run at once, each on its own local-server
// port. The agent's MCP config bakes ONE port, so without this a single session
// could only ever reach one instance. Instead we discover running instances by
// probing the local port range (each /api/sync/no-room reports its profile, port,
// and bot name) and, on join_call, RE-BIND this session's BASE_URL to the instance
// whose PROFILE matches the requested name. (Per the profile==agent direction, the
// name passed to /join-call is the profile to drive, not a display name.)

function probePorts() {
  // The env BASE_URL's port is always probed; plus a default range. Override the
  // range via VIBECONF_PORT_RANGE="7865-7910".
  const set = new Set();
  const envPort = Number((BASE_URL.match(/:(\d+)/) || [])[1]);
  if (envPort) set.add(envPort);
  const range = process.env.VIBECONF_PORT_RANGE || "7865-7910";
  const [lo, hi] = range.split("-").map(Number);
  if (Number.isFinite(lo) && Number.isFinite(hi)) for (let p = lo; p <= hi; p++) set.add(p);
  return [...set];
}

// Returns [{ port, baseUrl, profile, botName, callStatus, roomId }] for live instances.
async function discoverInstances() {
  const results = await Promise.all(probePorts().map(async (port) => {
    try {
      const resp = await vfetch(`http://127.0.0.1:${port}/api/sync/no-room`, { signal: AbortSignal.timeout(900) });
      if (!resp.ok) return null;
      const d = await resp.json();
      const s = d.status || {};
      return {
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        // The default profile reports null — normalize so it's addressable as "default".
        profile: s.localProfile || "default",
        botName: s.currentCallBotName || s.configuredBotName || null,
        // Kept separate from botName: this is the profile's OWN display name (what
        // the panel is set to), which is what a profile-addressed join should join
        // under — not currentCallBotName, a per-call override from a past call.
        configuredBotName: (s.configuredBotName || "").trim() || null,
        callStatus: s.callStatus || null,
        roomId: d.roomId || null,
      };
    } catch { return null; }
  }));
  return results.filter(Boolean);
}

// resolveInstance lives in ./instance-routing.js (pure, unit-tested). Behaviour:
// name = profile (preferred) or display name. Backward-compatible — a single
// running instance is used as-is (the name is then just the display name), and
// discovery turning up nothing keeps the current BASE_URL (env default) so
// existing single-instance setups are unaffected.

// Bind this session's BASE_URL to the instance the name targets. Returns
// { ok, instance?, matchedBy? } or { error }. matchedBy tells the caller whether
// the name was an ADDRESS (a profile) or a label — see instance-routing.js.
async function routeToInstance(name) {
  let instances;
  try { instances = await discoverInstances(); }
  catch { return { ok: true }; } // discovery failed → keep current BASE_URL, let the join surface a real error
  const r = resolveInstance(name, instances, { pinnedPort: PINNED_PORT });
  if (r.error) return { error: r.error };
  if (r.keep) return { ok: true };
  if (r.instance) { BASE_URL = r.instance.baseUrl; return { ok: true, instance: r.instance, matchedBy: r.matchedBy }; }
  return { ok: true };
}

function botSyncPayload(name = BOT_NAME, payload = {}) {
  return {
    sender: name,
    role: "bot",
    ownerName: name,
    versions: MCP_VERSIONS,
    ...payload,
  };
}

// #360: render the "your previous utterance was cut off" record (from a
// wait_for_speech poll's `speechTruncated` or a speak result's
// `previousSpeechTruncated`) as an agent-facing note. speak() answers at
// dispatch time, so a barge-in that truncated playback is only learnable
// here, after the fact. Empty string when there is nothing to report.
function formatSpeechTruncation(t) {
  if (!t) return '';
  const where = t.cutSeconds != null ? `~${t.cutSeconds}s in` : 'between sentences';
  const heard = t.spoken ? `Heard: ${JSON.stringify(t.spoken)}. ` : 'NOTHING of it was heard. ';
  // A #350 resume replays the cut sentence's tail on its own; only what the
  // synth loop never produced stays unheard in that case.
  if (t.resumed) {
    return `\n[CUT OFF — your previous utterance was interrupted ${where}. ${heard}`
      + `The cut sentence is auto-resuming now — do NOT repeat it. `
      + `But this part was never synthesized and will NOT play: ${JSON.stringify(t.unspokenRest)}. `
      + `If it still matters, work it into your next turn, reworded for where the conversation is now.]`;
  }
  const unheard = [t.unspokenTail, t.unspokenRest].filter(Boolean).join(' ');
  return `\n[CUT OFF — your previous utterance was interrupted ${where}, though speak() reported it as spoken. ${heard}`
    + `NOT heard: ${JSON.stringify(unheard)}. `
    + `The room only got the first part. If the unheard part still matters, work it into your next turn — `
    + `reworded for where the conversation is now, without re-saying what already played. If it's been overtaken, let it go.]`;
}

let lastPollTime = null;
// Locks BOT_NAME for the duration of the current call. Once a join_call
// succeeds, the bot's identity is fixed until the call ends — a mid-call
// rename would leave the Meet display name, the already-registered
// local-server member, and post-rename POST senders mismatched.
//
// The lock auto-clears on leave_call and on the next join_call when the
// local-server reports callStatus is no longer 'in-call' (handles
// host-ended, network drop, user-clicked-Leave, app-restart cases without
// a push channel from the app to the MCP server).
let botNameLocked = false;

// When the agent omits bot_name, prefer the user's live panel preference
// (the local-server's configuredBotName) over the frozen env default — so an
// env default like VIBECONF_BOT_NAME never silently flows into the call and
// overwrites what the user set in the panel (#212). Cached for the process
// lifetime to avoid repeated GETs; falls back to the env BOT_NAME when the
// local-server isn't reachable (cold start).
let cachedConfiguredName; // undefined = not fetched, null = unavailable
async function fetchConfiguredBotName() {
  if (cachedConfiguredName !== undefined) return cachedConfiguredName;
  try {
    const resp = await vfetch(`${BASE_URL}/api/sync/no-room`);
    const data = await resp.json();
    cachedConfiguredName = String(data?.status?.configuredBotName || '').trim() || null;
  } catch {
    cachedConfiguredName = null;
  }
  return cachedConfiguredName;
}

async function resolveBotName(name) {
  const explicit = String(name || '').trim();
  if (explicit) return explicit;
  const configured = await fetchConfiguredBotName();
  return configured || BOT_NAME;
}

// The display name to join under. joinNameFromRouting decides it from the routed
// instance (see instance-routing.js — a profile-matched name is an ADDRESS and
// must not overwrite that profile's own name); only when routing says nothing do
// we fall back to the cached configured name / env default.
async function displayNameForJoin(argName, routed) {
  return joinNameFromRouting(argName, routed) || (await resolveBotName(null));
}

const server = new McpServer({
  name: "vibeconferencing",
  version: "0.1.0",
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function getRoomStatus(roomId) {
  const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}`);
  return resp.json();
}

async function waitForSharingState(roomId, expected, { timeoutMs = 7000, intervalMs = 300, stablePolls = 1 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  let matches = 0;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    lastStatus = await getRoomStatus(roomId);
    if (lastStatus.status?.sharing === expected) {
      matches++;
      if (matches >= stablePolls) return lastStatus;
    } else {
      matches = 0;
    }
  }

  return lastStatus || await getRoomStatus(roomId);
}

// --- get_session_log ---
// Returns recent lines from the Electron app's session log (#173). Useful for
// post-mortem debugging when something went weird mid-call — e.g. a share
// dropped, a whiteboard rendered blank, or two bots in the same room
// diverged in behavior. The log file lives at status.sessionLogPath (also
// returned in get_room_info), and persists across MCP polls.
server.tool(
  "get_session_log",
  "Read recent lines from a Vibeconferencing session log. By default reads THIS machine's local Electron app (post-mortem mid-call weirdness — failed shares, blank whiteboards, unexpected state). Pass 'instance' to instead read a REMOTE bot's log shipped to the backend (another machine running with the remoteLogging pref on, e.g. for debugging Seth's bots) — list available instance IDs with list_log_instances. Optional 'grep' filters by case-insensitive regex (e.g. 'screen|share|present').",
  {
    lines: z.number().optional().describe("How many recent log lines to return. Default 200 (local) / 500 (remote). Max 5000."),
    grep: z.string().optional().describe("Case-insensitive regex filter applied before truncation. E.g. 'screen|share' to focus on screen-share activity."),
    instance: z.string().optional().describe("Remote instance ID (from list_log_instances, e.g. 'seths-mbp--default'). When set, reads the remote log from the backend instead of this machine's local app."),
  },
  async ({ lines, grep, instance }) => {
    const params = new URLSearchParams();
    if (lines) params.set('lines', String(lines));
    if (grep) params.set('grep', grep);
    const isRemote = !!instance;
    const url = isRemote
      ? `${WEBSITE_URL}/api/logs/${encodeURIComponent(instance)}${params.toString() ? '?' + params.toString() : ''}`
      : `${BASE_URL}/api/session-log${params.toString() ? '?' + params.toString() : ''}`;
    const resp = await vfetch(url, isRemote && LOGS_TOKEN ? { headers: { 'x-vibe-logs-token': LOGS_TOKEN } } : undefined);
    const data = await resp.json();
    if (!data.success) {
      return { content: [{ type: "text", text: `Error: ${data.error || "Unknown error"}` }] };
    }
    if (data.error) {
      return { content: [{ type: "text", text: `Error: ${data.error}` }] };
    }
    const label = isRemote ? `Remote log: ${instance}` : (data.filePath ? `Session log: ${data.filePath}` : '');
    const header = label ? `${label} (${data.returnedLines}/${data.totalLines} lines${data.truncated ? ', truncated' : ''})\n---\n` : '';
    return { content: [{ type: "text", text: header + (data.content || '(empty)') }] };
  }
);

// --- get_call_log ---
// Returns just ONE call's slice of this machine's session log (#287), bounded
// by the `[call] id=...` markers written at call start/end (#292). This is the
// after-call-work counterpart to the "share this call's log" UI button (#255):
// same underlying slice, but returned directly instead of uploaded, so an
// agent can save it (e.g. calls/<call-id>/session-log.txt) alongside a
// summary, or a script can pull it for offline analysis. Call IDs come from
// get_room_info / call-status responses seen earlier in the call — this
// works for any past call ID, not just the currently-active one, since
// after-call work runs post-hangup once the live call ID has been cleared.
server.tool(
  "get_call_log",
  "Get just one call's slice of this machine's session log — the events between that call's start and end markers, with no earlier or later calls mixed in. This is for after-call work (e.g. saving a log alongside a call summary) or scripts that need one call's events; unlike get_session_log it returns exactly one call, not a recent-lines window. Pass the call_id seen earlier (e.g. from get_room_info) — works for past calls too, not just the current one.",
  {
    call_id: z.string().describe("The call ID to slice out, e.g. 'abc-defg-hij-20260809T164900Z' (from get_room_info or a `[call] id=...` log line)."),
  },
  async ({ call_id }) => {
    const url = `${BASE_URL}/api/call-log?callId=${encodeURIComponent(call_id)}`;
    const resp = await vfetch(url);
    const data = await resp.json();
    if (!data.success) {
      return { content: [{ type: "text", text: `Error: ${data.error || "Unknown error"}` }] };
    }
    if (!data.lineCount) {
      return { content: [{ type: "text", text: `No log lines found for call_id "${call_id}". Check the ID matches a '[call] id=...' marker in the session log.` }] };
    }
    const header = `Call log: ${call_id} (${data.lineCount} lines, ${data.filePath})\n---\n`;
    return { content: [{ type: "text", text: header + data.content }] };
  }
);

// --- list_log_instances ---
// List remote bots currently shipping session logs to the backend (remoteLogging
// pref on). Returns instance IDs to pass to get_session_log({ instance }).
server.tool(
  "list_log_instances",
  "List remote Vibeconferencing instances that are shipping their session logs to the backend (machines/bots with the remoteLogging pref on). Returns each instance's ID, app version, profile, current room, and how long ago it was last seen. Use the returned instanceId with get_session_log({ instance }) to read that bot's log — handy for debugging another person's bots (e.g. Seth's) without terminal access to their machine.",
  {},
  async () => {
    const resp = await vfetch(`${WEBSITE_URL}/api/logs`, LOGS_TOKEN ? { headers: { 'x-vibe-logs-token': LOGS_TOKEN } } : undefined);
    const data = await resp.json();
    if (!data.success) return { content: [{ type: "text", text: `Error: ${data.error || "Unknown error"}` }] };
    const insts = data.instances || [];
    if (!insts.length) return { content: [{ type: "text", text: "No instances are reporting (remoteLogging may be off everywhere)." }] };
    const lines = insts.map((i) => {
      const age = i.lastSeen ? `${Math.round((Date.now() - new Date(i.lastSeen).getTime()) / 1000)}s ago` : '?';
      return `• ${i.instanceId} — v${i.version || '?'}, profile=${i.profile || '?'}, room=${i.room || '—'}${i.callStatus ? ` (${i.callStatus})` : ''}, seen ${age}`;
    });
    return { content: [{ type: "text", text: `Remote logging instances (${insts.length}):\n${lines.join('\n')}\n\nRead one: get_session_log({ instance: "<id>" })` }] };
  }
);

// --- read_transcripts ---
server.tool(
  "read_transcripts",
  "Read recent transcripts from the Google Meet call. Returns what participants have said. Use the 'since' parameter for incremental updates (pass the 'asOf' value from the previous call).",
  {
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
    since: z.string().optional().describe("ISO timestamp for incremental polling. Omit for recent history. Use the asOf value from the previous response."),
  },
  async ({ room_id, since }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) {
      return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    }

    const sinceParam = since ? `?since=${since}` : "";
    const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}${sinceParam}`);
    const data = await resp.json();

    if (!data.success) {
      return { content: [{ type: "text", text: `Error: ${data.error || "Unknown error"}` }] };
    }

    lastPollTime = data.asOf;

    const entries = data.transcript?.entries || [];
    const members = data.members || [];

    // Each entry is now one logical speaker turn (#178 snapshot model); no
    // dedup needed. The old dedup-by-keep-longest was a workaround for the
    // accumulating-text bug and would now drop legitimate consecutive turns
    // from the same speaker.
    const deduped = entries;

    const transcriptText = deduped
      .filter((e) => e.participantName !== BOT_NAME || e.role === "bot")
      .map((e) => `[${e.participantName}]: ${e.text}`)
      .join("\n");

    const memberList = members.map((m) => m.name).join(", ");

    const result = [
      `Room: ${roomId}`,
      `Polled at: ${data.asOf}`,
      `Members: ${memberList || "none detected"}`,
      ``,
      transcriptText || "(no new transcripts)",
    ].join("\n");

    return { content: [{ type: "text", text: result }] };
  }
);

// --- wait_for_speech ---
server.tool(
  "wait_for_speech",
  "Long-poll: blocks until someone in the call finishes speaking (a pause in conversation). Returns the complete transcript of what was said. Much more efficient than polling read_transcripts repeatedly. The server waits for new speech, then waits for a conversation break (silence) before returning, so you get complete thoughts rather than fragments.",
  {
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
    silence_seconds: z.number().optional().describe("How many seconds of silence to wait before considering speech 'done'. If omitted, the app's defaultSilenceSeconds preference is used (1.4 by default)."),
    timeout_seconds: z.number().optional().describe("Maximum seconds to wait before returning even if nobody speaks. Default: 55"),
  },
  async ({ room_id, silence_seconds, timeout_seconds }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) {
      return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    }

    // Only send silence= when the agent explicitly overrides it; otherwise omit
    // it so the server applies the defaultSilenceSeconds preference (tunable via
    // set_preference). Previously this hardcoded a default and ALWAYS sent it,
    // which dead-lettered the pref entirely.
    const silenceParam = silence_seconds != null ? `&silence=${silence_seconds}` : '';
    const waitSec = Math.min(55, timeout_seconds || 55);

    // Get baseline timestamp if we don't have one
    if (!lastPollTime) {
      const baseline = await vfetch(`${BASE_URL}/api/sync/${roomId}`);
      const baseData = await baseline.json();
      lastPollTime = baseData.asOf;
    }

    // Single server-side long-poll request
    const url = `${BASE_URL}/api/sync/${roomId}?since=${lastPollTime}&wait=${waitSec}${silenceParam}&bot=${encodeURIComponent(BOT_NAME)}`;
    const startTime = Date.now();
    const resp = await vfetch(url);
    const data = await resp.json();

    lastPollTime = data.asOf;

    // Terminal conditions — exit the conversation loop without retrying.
    if (data.callFailed) {
      return {
        content: [{
          type: "text",
          text: "Call failed: the bot couldn't enter the Meet (denied or removed). Exiting the conversation loop. Do not retry — tell the user the join failed.",
        }],
      };
    }
    // Single-agent enforcement: server displaced us because another agent
    // started a wait_for_speech against this room. Bail out cleanly so the
    // skill ends its loop instead of fighting for the call.
    if (data.displaced) {
      return {
        content: [{
          type: "text",
          text: "Session displaced: another agent started listening on this call. Exiting the conversation loop. Do not retry wait_for_speech.",
        }],
      };
    }
    // Auto-leave: the bot was alone in the call (everyone else left) and
    // signed off on its own (#145). Exit the loop — leave_call already fired.
    if (data.autoLeft) {
      return {
        content: [{
          type: "text",
          text: "Auto-left the call: everyone else left and the bot was alone. The app has already hung up. "
            + "Do not retry wait_for_speech and do not call leave_call."
            + afterCallWorkNote(data.afterCallWork),
        }],
      };
    }

    const entries = (data.transcript?.entries || []).filter(
      (e) => e.participantName !== BOT_NAME
    );

    const status = data.status || {};
    const statusLine = status.callStatus && status.callStatus !== 'in-call'
      ? `\n[Call status: ${status.callStatus}]` : '';
    const errorLines = (status.errors || []).length > 0
      ? '\n[Errors: ' + status.errors.map(e => e.message).join('; ') + ']' : '';
    // Surface unread chat on every lull — this is the natural moment to check
    // chat without missing speech. The agent should call read_chat when it sees this.
    const chatLine = data.chatUnread
      ? '\n[Unread chat messages — call read_chat to see them, then respond.]' : '';
    // Continuation: this window is the same speaker extending the utterance you
    // already answered. Stay quiet unless there's genuinely new content, to
    // avoid responding twice to one thought.
    const continuationLine = data.continuationOfPriorResponse
      ? '\n[Note: this continues what you already responded to — only reply if it adds genuinely new information; otherwise stay silent and wait again.]' : '';
    // Fast-ack feedback: a short discourse filler (e.g. "Mm-hmm.", "Got it.")
    // already played for the user before your previous response. If your last
    // reply contradicted the ack's tone (e.g. the ack said "Uh-huh." but you
    // ended up saying "no" / "actually I disagree"), you may briefly clarify
    // the mismatch in your next turn. If the ack and your response were
    // consistent, ignore this note.
    const ackLine = data.previousAckPhrase
      ? `\n[Previous fast-ack played: ${JSON.stringify(data.previousAckPhrase)}. If it didn't fit your real response, you may briefly clarify.]`
      : '';
    // The local-server auto-replayed bot speech that had been queued before
    // a barge-in interruption — the queued thought went out as soon as the
    // floor was clear. Don't try to repeat it; either build on it or stay
    // silent if it already covered what you wanted to say.
    const replayLine = Array.isArray(data.replayedBargeInStash) && data.replayedBargeInStash.length
      ? `\n[Auto-replayed your previously-yielded speech on the silence gap: ${data.replayedBargeInStash.map(s => JSON.stringify(s)).join(' · ')}. That speech already played — do NOT repeat it. Either build on it or stay silent.]`
      : '';

    // #109: the opposite outcome. speak() promised the held reply would
    // auto-replay, and it didn't — so say so out loud. Until now the only
    // signal was the ABSENCE of the replay note above, which is a negative an
    // agent can't read reliably; the reply just vanished and the agent carried
    // on as though the room had heard it.
    const d = data.discardedBargeInStash;
    const discardLine = d && Array.isArray(d.texts) && d.texts.length
      ? `\n[NOT SPOKEN — your held reply was dropped, not replayed (${d.reason}): ${d.texts.map(s => JSON.stringify(s)).join(' · ')}. The room never heard this. If it still matters, say it again — reworded for where the conversation is NOW, not where it was. If it's been overtaken, let it go.]`
      : '';

    // #360: the previous utterance PLAYED but was cut off partway by a
    // barge-in — speak() had already reported it as spoken in full.
    const truncLine = formatSpeechTruncation(data.speechTruncated);

    if (entries.length === 0) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      // Chat-triggered wake: a new chat message arrived while the room was quiet
      // (the loop now pipelines chat like speech). Lead with that instead of a
      // misleading "no one spoke / timed out".
      if (data.chatWake) {
        return { content: [{ type: "text", text: `(New chat message — the room was quiet, so you were woken to handle it.)${chatLine || '\n[Call read_chat to see it, then respond aloud and/or in chat.]'}${statusLine}${errorLines}` }] };
      }
      // Deaf-bot hint: if Meet captions are off, the bot can't hear anything.
      // Distinguish that from "the room is silent" so the agent can ask humans
      // to re-enable captions instead of looping silent timeouts.
      const deafLine = status.captionsOn === false
        ? '\n[Captions are OFF in Meet — the bot hears via captions, so it is DEAF until they are re-enabled. The app is retrying automatically; if this persists, say or chat: "Could someone turn captions back on? (CC button in Meet\'s toolbar)"]'
        : '';
      return { content: [{ type: "text", text: `(No one spoke. Timed out after ${elapsed} seconds.)${statusLine}${errorLines}${chatLine}${ackLine}${replayLine}${discardLine}${truncLine}${deafLine}` }] };
    }

    // Each entry is now one logical speaker turn (#178 snapshot model); no
    // dedup needed. The old dedup-by-keep-longest was a workaround for the
    // accumulating-text bug and would now drop legitimate consecutive turns
    // from the same speaker.
    const deduped = entries;

    const transcriptText = deduped
      .map((e) => `[${e.participantName}]: ${e.text}`)
      .join("\n");

    const elapsed = data.elapsed || Math.round((Date.now() - startTime) / 1000);

    // Active-listening background tick (#245): the floor is STILL BUSY — others
    // are talking and you are NOT being addressed. You were surfaced early only
    // so you can keep your understanding current and (optionally) bank a brief
    // active-listening probe for later. Do NOT speak now; update and loop.
    if (data.backgroundTick) {
      return {
        content: [{
          type: "text",
          text: `[BACKGROUND TICK] The conversation is ongoing and you are not being directly addressed. This is mainly your chance to THINK, not to talk.\n\nLatest (${deduped.length} turn(s), ${elapsed}s):\n${transcriptText}\n\nUsually you should just silently update your sense of the discussion (optionally call post_understanding), keep any short interjection you can imagine in mind, then call wait_for_speech again WITHOUT speaking — most ticks should end in silence.\n\nBUT: if something just said genuinely compels you — a point you are uniquely able to add, a question squarely in your wheelhouse, a moment you'd regret staying silent on — you MAY speak ONE short interjection now. Use this sparingly and only when you truly feel you must; if in doubt, stay silent and keep listening.${chatLine}`,
        }],
      };
    }

    return {
      content: [{
        type: "text",
        text: `Speech detected (${deduped.length} speaker turn(s), ${elapsed}s elapsed):\n\n${transcriptText}${chatLine}${continuationLine}${ackLine}${replayLine}${discardLine}${truncLine}`,
      }],
    };
  }
);

// --- speak ---
server.tool(
  "speak",
  "Say something in the Google Meet call. Your text will be spoken aloud via text-to-speech. Keep messages concise since they are spoken aloud. Optionally pass an emoji to set the avatar face for this response — match the tone (e.g. 😂 for a joke, 😟 for a concern, 😎 for confidence, 🤓 for a technical answer). Default is 😄.",
  {
    text: z.string().describe("What to say in the call. Will be spoken via TTS."),
    voice: z.string().optional().describe("Override TTS voice for this message (e.g. 'Daniel', 'Karen'). Uses default voice if not specified."),
    emoji: z.string().optional().describe("Single emoji to display on the avatar while speaking this response. Match the tone of what you're saying — e.g. 😂 for funny, 😟 for sympathetic, 😎 confident, 🤓 technical. Falls back to 😄 if not specified."),
    urgency: z.number().min(0).max(1).optional().describe("How much the room needs to hear THIS, RIGHT NOW, over the top of someone else — 0.0 to 1.0. Anchors: 0.0 = filler, only worth saying into dead silence; 0.2 = mildly useful aside; 0.4 = A NORMAL ANSWER TO A NORMAL QUESTION, where most turns belong; 0.6 = the room is blocked on this or it goes stale in seconds; 0.9 = something is wrong right now and waiting makes it worse; 1.0 = genuine danger. GATES INTERRUPTION: 0.5 is the line where you may cut someone off — below it your reply waits for a gap, at or above it plays over them. The question is not 'is this good?' but 'is this worth interrupting a person for?', and for a normal answer that is no. (0.9 previously meant 'a direct answer to a question', so bots scored 0.9 on nearly everything and interrupted constantly.) Omit if you truly can't judge."),
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ text, voice, emoji, urgency, room_id }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) {
      return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    }

    const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botSyncPayload(BOT_NAME, {
        transcript: [{ text, ...(voice ? { voice } : {}), ...(emoji ? { emoji } : {}), ...(urgency != null ? { urgency } : {}) }],
      })),
    });

    const data = await resp.json();
    const tx = data.results?.transcript;
    if (tx?.reason === 'mode-silent') {
      return { content: [{ type: "text", text: "Speech suppressed (silent mode)." }] };
    }
    if (tx?.reason === 'user-speaking-stashed') {
      return { content: [{ type: "text", text: "Speech held (not dropped) — the user started talking before your reply could play, so it's been STASHED to auto-replay the moment the floor goes quiet. Do NOT recompose or repeat it now. Call wait_for_speech again and keep listening; it will tell you which way this went. Either it played, and you'll get an 'Auto-replayed your previously-yielded speech' note — build on it, don't repeat it. Or the conversation moved on and it was dropped, and you'll get a 'NOT SPOKEN — your held reply was dropped' note — the room never heard it, so say it again if it still matters. You do not have to infer either outcome from silence." }] };
    }
    if (tx?.reason === 'user-speaking') {
      return { content: [{ type: "text", text: "Speech dropped — the user started speaking before your response could play. Call wait_for_speech to hear what they said and respond to their new message instead of repeating this one." }] };
    }
    // #253: the PREVIOUS speech never reached anyone. Playback happens after the
    // speak call has already answered, so this is the first honest moment to say
    // so — and it matters most right here, where the agent is about to build on
    // a reply the room never heard.
    const failed = tx?.previousPlaybackFailed;
    let priorWarning = failed
      ? `⚠️ Your PREVIOUS speech was NOT heard — audio playback failed (${failed.reason}). `
        + `Nobody in the room got it. If it still matters, say it again.\n\n`
      : '';
    // #360: the previous speech played but was cut off partway — the agent is
    // about to speak again, believing its full point landed.
    const trunc = tx?.previousSpeechTruncated;
    if (trunc) priorWarning += `⚠️${formatSpeechTruncation(trunc).slice(1)}\n\n`;

    // #199: accepted but NOT yet audible. The app queues speech until the bot is
    // actually in the call, because the virtual mic isn't connected to the other
    // participants before then — speaking earlier plays into the void. Saying
    // "Spoken" here is what sent a stranger-drill debug down a TTS rabbit hole
    // for ~8 minutes while the app sat wedged at 'navigating'.
    if (data.success && tx?.queuedUntilInCall) {
      return { content: [{ type: "text", text: priorWarning +
        `QUEUED, not spoken — the bot is not in the call yet (status: ${tx.callStatus || 'unknown'}), `
        + `so nobody has heard this. It will play automatically once the bot is in-call; do NOT repeat it. `
        + `If the status does not reach 'in-call' shortly, the join is stuck — check get_room_info rather `
        + `than assuming a voice or TTS problem.` }] };
    }
    if (data.success && tx?.ok !== false) {
      // #360: "Speaking", not "Spoken" — this answer arrives at dispatch time,
      // before playback finishes (or even starts). If a barge-in cuts the
      // utterance short, the next wait_for_speech/speak result carries the
      // CUT OFF note; this line must not claim delivery it can't know about.
      return { content: [{ type: "text", text: priorWarning + `Speaking: "${text}"` }] };
    } else {
      return { content: [{ type: "text", text: `Error: ${data.error || tx?.reason || "Failed to post"}` }] };
    }
  }
);

// --- Preferences: read and write through the APP, not the config file ---
//
// Settings belong to the running bot, and only the app knows which bot that is.
// Its /api/preferences routes each key to the right store (app-level secrets vs
// the per-profile config for whichever profile is running), applies the change
// live, and works on every platform.
//
// This used to write the config file directly, at a hardcoded macOS path that
// pointed at the APP-LEVEL config — so a voice change during a call landed in a
// file the app reads no voice keys from. It looked saved, reported "applies on
// next restart", and was silently ignored forever. Don't reintroduce a file
// write here; add the key to preferences-schema.js instead.

async function getPrefs() {
  try {
    const resp = await vfetch(`${BASE_URL}/api/preferences`);
    const data = await resp.json();
    if (!data?.success) return {};
    return Object.fromEntries((data.preferences || []).map((p) => [p.key, p.value]));
  } catch { return {}; }
}

// One request for the whole set: the app validates every update before writing
// any, so a rejected key can't leave a half-changed voice behind.
async function setPrefs(updates) {
  const resp = await vfetch(`${BASE_URL}/api/preferences`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates }),
  });
  const data = await resp.json();
  if (!data?.success) throw new Error(data?.error || 'Failed to save preferences');
  return data;
}

// The handoff into after-call work (#139). Three different endings lead here —
// the agent leaving, everyone else leaving, the meeting ending — and they must
// all say the same thing, or an agent will learn one ending and be surprised by
// the next.
//
// Says "you are still running" as plainly as possible: the previous behaviour was
// an unambiguous STOP, so anything less than explicit will be read as one.
function afterCallWorkNote(plan) {
  if (!plan || !plan.enabled) {
    return ' Your work here is done — exit the conversation loop.';
  }
  // The bot's after-call duties live in the workdir CLAUDE.md, which only
  // app-spawned agents auto-load (they cd into the workdir; a terminal-driven
  // session runs wherever it was launched). The local-server therefore ships
  // the actual "## After the call" section in the plan, and it is inlined
  // here so EVERY transport sees the same checklist. On the 2026-08-10 Seth
  // call the old "its CLAUDE.md says what that is" phrasing left a
  // terminal-driven agent with nothing in context — it ended the session in
  // 0.6s and the summary + log copy were silently skipped.
  const duties = plan.duties
    ? `Your after-call duties, from the bot's CLAUDE.md${plan.workdir ? ` (workdir: ${plan.workdir} — file paths below are relative to it)` : ''}:\n\n${plan.duties}\n\n`
    : `Use them for whatever wrap-up this bot is meant to do — its CLAUDE.md says what that is (a summary, a receipt, notes filed somewhere)${plan.workdir ? `; if you don't have that file in context, read it at ${plan.workdir}/CLAUDE.md` : ''}.\n\n`;
  return ` You are now in AFTER-CALL WORK. You have up to ${plan.seconds} seconds, and you are still running.\n\n`
    + 'The call is over but its state is NOT gone: read_transcripts, read_whiteboard and get_room_info all still '
    + 'work, and still describe the call that just ended. '
    + duties
    + 'Do NOT call speak or send_chat: you have left the meeting, so nobody will hear or see it.\n\n'
    + 'Call end_session as soon as you are finished. That releases the app immediately instead of making it wait out '
    + 'the whole window. If there is nothing to do, call it now.';
}

// --- Helper: the app-level config file ---
//
// Still a direct file read, and correctly so: the ElevenLabs key is app-level
// (one secret per machine, see electron-app/config-scope.js) and preferences
// deliberately don't expose secrets, so there is no API to ask for it. This is
// the ONLY thing that should be read this way.
function getConfigPath() {
  // Where Electron puts userData per platform. The old macOS-only path meant
  // readConfig() returned {} on Windows and Linux, so the bot there believed no
  // ElevenLabs key was configured and quietly fell back to the OS voice.
  const home = homedir();
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Vibeconferencing', 'config.json');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Vibeconferencing', 'config.json');
  }
  return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'Vibeconferencing', 'config.json');
}

function readConfig() {
  try { return JSON.parse(readFileSync(getConfigPath(), 'utf-8')); } catch { return {}; }
}

function isElevenLabsActive() {
  return !!readConfig().ttsApiKey;
}

// The OS's built-in voices as [{ name, locale, sample, tier }], quality first
// (Premium > Enhanced > plain), English first, then name.
//
// macOS reads `say -v '?'`; Windows has no `say`, so it asks SAPI through
// PowerShell (#18) — the same two commands the app itself renders with.
//
// DUPLICATED from electron-app/system-voices.js on purpose: this file is copied
// into the packaged app standalone (extraResources) and cannot require() into
// electron-app/. Keep the two in sync, same as elevenLabsErrorText below.
function listSystemVoices() {
  if (process.platform === 'win32') return listSapiVoices();
  if (process.platform !== 'darwin') return [];
  return listMacosVoices();
}

// PowerShell that prints "Name|Culture|Gender" per installed SAPI voice, passed
// via -EncodedCommand (base64 UTF-16LE) so execution policy never applies.
function listSapiVoices() {
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `[Console]::OutputEncoding = [Text.Encoding]::UTF8`,
    `Add-Type -AssemblyName System.Speech`,
    `$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer`,
    `foreach ($v in $synth.GetInstalledVoices()) {`,
    `  if (-not $v.Enabled) { continue }`,
    `  $i = $v.VoiceInfo`,
    `  Write-Output ("{0}|{1}|{2}" -f $i.Name, $i.Culture.Name, $i.Gender)`,
    `}`,
    `$synth.Dispose()`,
  ].join('\n');
  let output;
  try {
    // PowerShell's cold start needs more headroom than `say`'s 5s.
    output = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf-8', timeout: 15000 });
  } catch { return []; }
  const voices = [];
  for (const line of String(output).split('\n')) {
    const parts = line.trim().split('|');
    if (parts.length < 2) continue;
    const name = parts[0].trim();
    if (!name) continue;
    const gender = (parts[2] || '').trim();
    // tier 1, not 2: David/Zira are all most Windows machines have, so demoting
    // them to "lower quality" would leave the recommended group empty.
    voices.push({
      name,
      locale: parts[1].trim().replace('-', '_') || 'en_US',
      sample: gender && gender !== 'NotSet' ? gender : '',
      tier: 1,
    });
  }
  const seen = new Set();
  return voices.filter(v => (seen.has(v.name) ? false : seen.add(v.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Parse `say -v '?'` into [{ name, locale, sample, tier }]. Robust to the
// parenthetical multi-locale voices ("Eddy (English (US)) en_US") and numeric
// locales ("Majed ar_001") that the simple column regex drops.
function listMacosVoices() {
  let output;
  try { output = execSync('say -v "?"', { encoding: 'utf-8', timeout: 5000 }); }
  catch { return []; }
  const voices = [];
  for (const line of output.split('\n')) {
    const hash = line.indexOf('#');
    if (hash < 0) continue;
    const left = line.slice(0, hash).trim();
    const sample = line.slice(hash + 1).trim();
    const m = /^(.*\S)\s+([A-Za-z]{2,3}(?:_[A-Za-z0-9]+)?)$/.exec(left);
    if (!m) continue;
    const name = m[1].trim();
    const tier = /\(Premium\)/i.test(name) ? 0 : /\(Enhanced\)/i.test(name) ? 1 : 2;
    voices.push({ name, locale: m[2], sample, tier });
  }
  const seen = new Set();
  const deduped = voices.filter(v => (seen.has(v.name) ? false : seen.add(v.name)));
  deduped.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const ae = a.locale.startsWith('en'), be = b.locale.startsWith('en');
    if (ae !== be) return ae ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return deduped;
}

// #340: standard macOS voices are mostly robotic — keep only a couple tolerable
// ones up-top; the rest are demoted to "Other". MUST match the panel's
// WHITELISTED_MACOS_STANDARD (electron-app/renderer/panel.js) so the agent's
// list and the settings picker agree.
// TODO(#342): single-source this + the merge logic behind one /api/voices endpoint
// so panel.js and this file stop duplicating the list.
const WHITELISTED_MACOS_STANDARD = ['Daniel', 'Samantha', 'Karen'];
const isWhitelistedStandard = (name) => WHITELISTED_MACOS_STANDARD.some((w) => name === w || name.startsWith(w + ' '));

// Turn a failed ElevenLabs response into a reason the agent can relay.
// ElevenLabs keys are SCOPED: a key that speaks fine can still lack
// `voices_read`, which 401s the list call. A bare "API error 401" sends the
// agent (and the user) hunting for a bad key that isn't bad. The body carries
// detail.status ('missing_permissions' | 'invalid_api_key' | …) and a message
// naming the permission.
//
// Deliberately duplicated from electron-app/elevenlabs-errors.js rather than
// imported: this file is copied into the packaged app standalone
// (extraResources) and cannot reach into electron-app/. Keep the two in sync.
async function elevenLabsErrorText(resp) {
  let detail = {};
  try {
    const body = await resp.json();
    detail = typeof body?.detail === 'string' ? { message: body.detail } : (body?.detail || {});
  } catch { /* empty or non-JSON body — fall through to the status alone */ }
  const status = String(detail.status || '');
  const message = String(detail.message || '');

  if (status === 'missing_permissions' || /missing the permission/i.test(message)) {
    const named = /permission\s+([a-z_]+)/i.exec(message);
    const perm = named ? named[1] : 'voices_read';
    return `the API key lacks the "${perm}" permission (HTTP ${resp.status}). ` +
      `Speaking may still work. Fix it at elevenlabs.io -> Profile -> API Keys by enabling "${perm}".`;
  }
  if (status === 'invalid_api_key' || /invalid api key/i.test(message)) {
    return `the API key was rejected as invalid (HTTP ${resp.status}).`;
  }
  if (status === 'quota_exceeded' || /quota/i.test(message)) {
    return `the ElevenLabs account is out of quota (HTTP ${resp.status}).`;
  }
  return `API error ${resp.status}${message ? ` — ${message}` : ''}`;
}

// Voicebox local-TTS profiles (#340) — mirror the app's list-voicebox-profiles so
// the agent sees the same voices the settings picker does. Best-effort: returns
// [] if Voicebox isn't running.
async function listVoiceboxProfiles() {
  const config = readConfig();
  const url = `${config.voiceboxUrl || 'http://127.0.0.1:17493'}/profiles`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const resp = await vfetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) return [];
    const profiles = await resp.json();
    return Array.isArray(profiles) ? profiles : [];
  } catch { return []; }
}

// --- suggest_bot_names ---
server.tool(
  "suggest_bot_names",
  "A list of candidate names for this bot, from the app's own curated pool — the same one the panel's name spinner draws from. Use it in the guided setup call so the user PICKS from real options instead of being asked to invent one cold. Names already used by other bots on this machine are excluded. Prefer these over names you make up: the pool is curated for names the bot reliably hears itself called, which is not obvious from a name alone.",
  {
    count: z.number().optional().describe("How many to return (default 12, max 24)."),
  },
  async ({ count }) => {
    try {
      const resp = await vfetch(`${BASE_URL}/api/name-suggestions?count=${count || 12}`);
      const data = await resp.json();
      if (!data.success) {
        return { content: [{ type: "text", text: `Error: ${data.error || "could not get name suggestions"}` }] };
      }
      return { content: [{ type: "text", text: (data.names || []).join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error contacting local server: ${err.message}` }] };
    }
  },
);

// "Screen sharing:" line for get_room_info.
//
// Reads the people pane, which lists every share as its own entry, rather than
// the toolbar's single "<name> is presenting" slot. Measured live with three
// shares up at once: the toolbar named only the most recent, and named nobody
// while the bot was presenting.
function formatScreenShares(status, data) {
  const shares = Array.isArray(data?.screenShares) ? data.screenShares : [];
  if (!shares.length) {
    // Fall back to the toolbar signal rather than asserting "no": on a Meet
    // build where the people-pane markup has moved, silence is better than a
    // confident wrong answer.
    if (status.sharing) return 'Screen sharing: yes (by you)';
    if (status.presenterName) return `Screen sharing: yes, by ${status.presenterName}`;
    return 'Screen sharing: nobody';
  }
  const names = shares.map((s) => s.name).filter(Boolean);
  return `Screen sharing: ${names.length} — ${names.join(', ')}`
    + (status.sharing ? ' (one of them is you)' : '');
}

// --- list_visual_assets ---
server.tool(
  "list_visual_assets",
  "Absolute paths to the sample art bundled with the app: one smiling face per emoji set, and every background preset. Use these with update_whiteboard to SHOW the options rather than list their names — write them as ordinary markdown image links, e.g. ![city](/abs/path/city.svg), and lay several out in a table for a grid. Mainly for the guided setup call, where 'pick an emoji set' and 'pick a background' are questions a picture answers instantly. Note the 'native' set is the OS font and has no file — put the character itself (e.g. 🙂) in that cell and let the machine draw it, which IS what picking native means. Sizes differ wildly between sets (the fluent3d PNG is hundreds of pixels, the noto SVG tiny), and markdown cannot size an image, so normalise with set_whiteboard_style, e.g. `table img { height: 84px; width: auto }`.",
  {},
  async () => {
    try {
      const resp = await vfetch(`${BASE_URL}/api/visual-assets`);
      const data = await resp.json();
      if (!data.success) {
        return { content: [{ type: "text", text: `Error: ${data.error || "could not read bundled assets"}` }] };
      }
      const lines = [];
      lines.push("=== Emoji sets (🙂 sample from each) ===");
      for (const e of data.emojiSets || []) lines.push(`${e.set}: ${e.path}`);
      lines.push("native: (no file — the operating system's own emoji font)");
      lines.push("");
      lines.push("=== Background presets ===");
      for (const b of data.backgrounds || []) lines.push(`${b.name}: ${b.path}`);
      lines.push("");
      lines.push("Embed with update_whiteboard: ![name](/that/path). Several in a markdown table gives you a grid.");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error contacting local server: ${err.message}` }] };
    }
  },
);

// --- list_fonts ---
server.tool(
  "list_fonts",
  "Font families installed on the machine running the app. Use with set_preference(\"emojiSet\", \"font:<Family>\") to draw the bot's face with a real font instead of the bundled picture sets — e.g. \"font:UnifontExMono\". Call this rather than guessing a name: a family that is not installed falls back to the system emoji font silently, so a typo looks exactly like the feature not working. Names are returned exactly as the system reports them, which is what the preference needs. Not every font has emoji coverage; the interesting ones are those that do.",
  {},
  async () => {
    try {
      const resp = await vfetch(`${BASE_URL}/api/fonts`);
      const data = await resp.json();
      if (!data.success) {
        return { content: [{ type: "text", text: `Error: ${data.error || "could not list fonts"}` }] };
      }
      const fams = data.families || [];
      if (!fams.length) {
        return { content: [{ type: "text", text: "No fonts reported. The app may not have a window open to ask." }] };
      }
      return {
        content: [{
          type: "text",
          text: `${fams.length} font families installed:\n\n${fams.join("\n")}\n\n`
            + `Use one with set_preference("emojiSet", "font:<Family>") — exact name, as listed above.`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error contacting local server: ${err.message}` }] };
    }
  },
);

// --- list_voices ---
server.tool(
  "list_voices",
  "List available text-to-speech voices across all providers — Voicebox (if its local server is running), ElevenLabs (if an API key is configured), and the operating system's built-in voices (macOS `say` voices, or Windows SAPI voices such as 'Microsoft Zira Desktop') — matching what the settings picker shows. To use one, call set_voice with its EXACT name (e.g. 'Ava (Premium)') or id. Prefer Voicebox/ElevenLabs or the Premium/Enhanced macOS voices; the plain 'Other' macOS ones sound robotic.",
  {},
  async () => {
    // The RUNNING bot's voice, from the app — not the config file. Read from
    // the file, this reported whatever was last written there by the old
    // set_voice, which is a different profile's setting at best and a value the
    // app never used at worst.
    const prefs = await getPrefs();
    const sections = [];

    // Current voice, derived from the active provider.
    const usingVb = prefs.ttsProvider === 'voicebox' && prefs.voiceboxProfileId;
    const osLabel = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'system';
    const usingSys = !usingVb && (prefs.ttsProvider === 'macos-say' || !isElevenLabsActive());
    const sysVoiceName = prefs.macosVoice || (process.platform === 'win32' ? 'the system default' : 'Daniel');
    sections.push(`Current voice: ${usingVb ? `Voicebox profile ${prefs.voiceboxProfileId}` : usingSys ? `${sysVoiceName} (built-in ${osLabel})` : 'ElevenLabs (see below)'}`);

    // Voicebox (local TTS) — listed first when the server is up (#340), matching
    // the settings picker's ordering.
    try {
      const vb = await listVoiceboxProfiles();
      if (vb.length) {
        const lines = vb.map((p) => `${p.name} [id: ${p.id}]${(p.preset_engine || p.default_engine) ? ` (${p.preset_engine || p.default_engine})` : ''}`);
        sections.push(`=== Voicebox voices (local) ===\n${lines.join('\n')}\nTo use one, call set_voice with its name or id.`);
      }
    } catch { /* voicebox not running — skip */ }

    if (isElevenLabsActive()) {
      try {
        const resp = await vfetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': readConfig().ttsApiKey } });
        if (!resp.ok) throw new Error(await elevenLabsErrorText(resp));
        const data = await resp.json();
        const voices = data.voices.map(v =>
          `${v.name} — ${`${v.labels?.accent || ''} ${v.labels?.gender || ''} ${v.labels?.age || ''}`.trim()} [id: ${v.voice_id}]`
        );
        sections.push(`=== ElevenLabs voices ===\n${voices.join('\n')}`);
      } catch (err) {
        sections.push(`=== ElevenLabs voices ===\n(error fetching: ${err.message})`);
      }
    }

    // The OS's built-in voices — always shown so the bot can pick a decent
    // built-in voice even when an ElevenLabs key is set (e.g. to save EL quota).
    const sys = listSystemVoices();
    if (sys.length) {
      const fmt = (v) => `${v.name} (${v.locale})`;
      const lines = [`=== Built-in ${osLabel} voices ===`];
      if (process.platform === 'win32') {
        // SAPI has no Premium/Enhanced tiering — it's one flat list, and every
        // entry is a voice the machine can actually speak in.
        lines.push(sys.map(fmt).join(', '));
        lines.push('These are the machine\'s installed SAPI voices; more can be added in Settings → Time & Language → Speech.');
        lines.push('To use one, call set_voice with the EXACT name (e.g. "Microsoft Zira Desktop").');
      } else {
        const premium = sys.filter(v => v.tier === 0).map(fmt);
        const enhanced = sys.filter(v => v.tier === 1).map(fmt);
        const stdEn = sys.filter(v => v.tier === 2 && v.locale.startsWith('en'));
        const stdWhitelisted = stdEn.filter(v => isWhitelistedStandard(v.name)).map(v => v.name);
        const stdOther = stdEn.filter(v => !isWhitelistedStandard(v.name)).map(v => v.name);
        lines.push('★ HIGH QUALITY (recommended) — Premium: ' + (premium.length ? premium.join(', ') : '(none installed)'));
        lines.push('★ HIGH QUALITY — Enhanced: ' + (enhanced.length ? enhanced.join(', ') : '(none installed)'));
        if (stdWhitelisted.length) lines.push(`Decent standard: ${stdWhitelisted.join(', ')}`);
        if (stdOther.length) lines.push(`Other (lower quality): ${stdOther.join(', ')}`);
        lines.push('To use one, call set_voice with the EXACT name including any "(Premium)"/"(Enhanced)" suffix.');
      }
      sections.push(lines.join('\n'));
    }

    return { content: [{ type: "text", text: sections.join('\n\n') }] };
  }
);

// --- set_voice ---
server.tool(
  "set_voice",
  "Change the bot's text-to-speech voice. Use list_voices to see options. Pass the EXACT voice name — a built-in OS voice (e.g. 'Ava (Premium)' on macOS, 'Microsoft Zira Desktop' on Windows), an ElevenLabs voice name/ID, or a Voicebox profile name/id. Matched in that order; the chosen voice becomes primary (its provider is forced, so e.g. a built-in voice wins even with an ElevenLabs key set). Takes effect immediately and is saved to this bot's profile, so it persists after the call and across restarts.",
  {
    voice: z.string().describe("Exact voice name. Built-in OS voice (macOS 'Ava (Premium)' / 'Samantha', Windows 'Microsoft Zira Desktop') or ElevenLabs voice name/ID."),
  },
  async ({ voice }) => {
    try {
      // Each branch writes the provider AND that provider's identifier in one
      // batched request. They are only meaningful together: a provider without
      // its matching id is a bot that can't speak.
      //
      // Match a built-in OS voice first (case-insensitive, exact) — lets the
      // bot pick a built-in voice regardless of the EL key. The stored keys are
      // still named macosVoice/'macos-say' for config compatibility; on Windows
      // they hold a SAPI voice name (#18).
      const osLabel = process.platform === 'win32' ? 'Windows' : 'macOS';
      const sys = listSystemVoices();
      const sysMatch = sys.find(v => v.name.toLowerCase() === voice.toLowerCase());
      if (sysMatch) {
        await setPrefs([
          { key: 'macosVoice', value: sysMatch.name },
          { key: 'ttsProvider', value: 'macos-say' }, // force the built-in voice as primary
        ]);
        return { content: [{ type: "text", text: `Voice changed to the built-in ${osLabel} voice "${sysMatch.name}". It's now your primary voice (ElevenLabs disabled until you switch back), effective immediately and saved to this bot's profile.` }] };
      }

      // Then a Voicebox profile (by name or id) — local TTS, forces provider (#340).
      const vb = await listVoiceboxProfiles();
      const vbMatch = vb.find(p => (p.name || '').toLowerCase() === voice.toLowerCase() || p.id === voice);
      if (vbMatch) {
        await setPrefs([
          { key: 'voiceboxProfileId', value: vbMatch.id },
          { key: 'voiceboxEngine', value: vbMatch.preset_engine || vbMatch.default_engine || 'kokoro' },
          { key: 'ttsProvider', value: 'voicebox' },
        ]);
        return { content: [{ type: "text", text: `Voice changed to Voicebox profile "${vbMatch.name}". It's now your primary voice, effective immediately and saved to this bot's profile.` }] };
      }

      // Else try ElevenLabs by name or ID. The key is app-level, so it comes
      // from the config file rather than the preferences API (which never
      // exposes secrets).
      if (isElevenLabsActive()) {
        const resp = await vfetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': readConfig().ttsApiKey } });
        if (!resp.ok) throw new Error(await elevenLabsErrorText(resp));
        const data = await resp.json();
        const match = data.voices.find(v => v.name.toLowerCase() === voice.toLowerCase() || v.voice_id === voice);
        if (match) {
          await setPrefs([
            { key: 'ttsVoiceId', value: match.voice_id },
            { key: 'ttsProvider', value: 'elevenlabs' },
          ]);
          return { content: [{ type: "text", text: `Voice changed to ElevenLabs "${match.name}", effective immediately and saved to this bot's profile.` }] };
        }
      }

      return { content: [{ type: "text", text: `Voice "${voice}" not found. Call list_voices to see exact available names (built-in voices need the full name, including any "(Premium)"/"(Enhanced)" suffix).` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error setting voice: ${err.message}` }] };
    }
  }
);

// --- set_whiteboard_style ---
server.tool(
  "set_whiteboard_style",
  "Restyle the shared whiteboard with custom CSS — colors, fonts, spacing, backgrounds. Use it when someone asks the board to look a certain way (e.g. \"make the whiteboard black-on-white with a curvy font and pastel colors\"): translate the request into CSS and set it here. The CSS is applied SCOPED to the whiteboard automatically, so write bare declarations for the board itself (e.g. `background:#fafaf5; color:#222; font-family:Georgia,serif`) and nested selectors for content (`h1 { font-family:'Comic Sans MS',cursive; color:#c9a }`, `code { background:#ffe0f0 }`, `a { color:#7a5 }`). It persists for the room and only affects the board (not the call UI). Pass an empty string to reset to the default style. Separate from update_whiteboard, which sets the CONTENT.",
  {
    css: z.string().describe("CSS for the whiteboard. Bare declarations style the board container; nested selectors (h1{}, p{}, code{}, ul{}, a{}) style the markdown content. No @import or external url() (blocked). Empty string resets to default."),
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ css, room_id }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) {
      return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    }
    try {
      const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(botSyncPayload(BOT_NAME, { whiteboardStyle: String(css || "") })),
      });
      const d = await resp.json();
      if (d.success || d.results?.whiteboardStyle?.ok) {
        return { content: [{ type: "text", text: css ? "Whiteboard restyled. It updates live on the shared board." : "Whiteboard style reset to default." }] };
      }
      return { content: [{ type: "text", text: `Couldn't set whiteboard style: ${d.error || d.results?.whiteboardStyle?.error || "unknown error"}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error contacting local server to set whiteboard style: ${err.message}` }] };
    }
  }
);

// --- reload_share ---
// Not whiteboard-specific: re-fetches whatever is currently loaded in the
// share window, markdown board or a URL loaded via load_url alike. Named to
// match the scroll_share/click_share/type_share/stop_sharing convention.
server.tool(
  "reload_share",
  "Force the share window to refresh WITHOUT changing its content — re-fetches whatever is currently shared (the whiteboard, or a page loaded via load_url) and re-renders it. Reach for it if the share looks stale or out of sync. No-op if nothing is currently being shared. Note: set_whiteboard_style already reloads automatically, so this is mainly a manual escape hatch.",
  {
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ room_id }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) {
      return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    }
    try {
      const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(botSyncPayload(BOT_NAME, { reloadWhiteboard: true })),
      });
      const d = await resp.json();
      const r = d.results?.reloadWhiteboard;
      if (r?.ok) {
        return { content: [{ type: "text", text: "Share reloaded." }] };
      }
      return { content: [{ type: "text", text: r?.error || "Nothing is being shared to reload." }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error contacting local server to reload share: ${err.message}` }] };
    }
  }
);

// --- load_url ---
// Split out of update_whiteboard (which used to double as "load any URL into
// the share window"). An agent showing an unrelated site shouldn't have to
// call a tool literally named "whiteboard" to do it.
server.tool(
  "load_url",
  "Load an arbitrary web page into the bot's share window in the Google Meet call — a website, localhost app, or dashboard, live (not a markdown board). Present it first with start_share if you're not already sharing; calling this while presenting swaps the live content to this URL. For markdown/Mermaid content, use update_whiteboard instead.",
  {
    url: z.string().describe("The URL to load into the share window."),
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ url, room_id }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) {
      return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    }
    const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botSyncPayload(BOT_NAME, {
        meta: { action: "load-url", url },
      })),
    });
    const data = await resp.json();
    if (data.success) {
      return { content: [{ type: "text", text: `Share window now showing: ${url}` }] };
    } else {
      return { content: [{ type: "text", text: `Error: ${data.error || "Failed to load URL"}` }] };
    }
  }
);

// --- update_whiteboard ---
server.tool(
  "update_whiteboard",
  "Update the shared whiteboard content in the Google Meet call. Supports markdown and Mermaid diagrams. To show a local image (e.g. a generated image), pass image_path (absolute local file path) — it gets registered with the app's local server and embedded as markdown. Do NOT put a raw file:// URL in a markdown image tag inside 'content' and do NOT hand-build a base64 data URI — the whiteboard renders in a sandboxed browser that can't load file:// URLs (broken image), and inlining base64 wastes huge amounts of context. image_path is the only correct way to show a local image. To load an arbitrary website/URL instead of markdown, use load_url.",
  {
    content: z.string().optional().describe("Markdown content for the whiteboard. Supports headings, lists, code blocks, Mermaid diagrams, and images. For SEVERAL images (a grid of options, a comparison), write ordinary markdown image links to absolute local paths — ![city](/abs/path/city.svg) — and they are registered and rewritten for you, so you control the layout. Base64 data URIs are still not supported. For a single image appended after the text, image_path is simpler."),
    image_path: z.string().optional().describe("Absolute local file path to an image (png/jpg/gif/webp/svg/bmp/pdf). The local server registers it and embeds it in the markdown. This is the correct way to show a local/generated image — do not build your own file:// link or base64 data URI. If 'content' is also provided, the image is appended after it."),
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ content, image_path, room_id }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) {
      return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    }

    if (!content && !image_path) {
      return { content: [{ type: "text", text: "Error: One of 'content' or 'image_path' must be provided." }] };
    }

    // image_path: register with the local server and fold the resulting URL
    // into the markdown content (#157). url mode is unaffected — image_path
    // composes with content, not with url.
    // Local image paths written straight into the markdown, e.g.
    // ![city](/abs/path/city.svg) — registered and rewritten here.
    //
    // image_path below handles ONE image, appended after the text. That is
    // useless for a grid: showing eight backgrounds, or one smiley per emoji
    // set, needs several images laid out in a table. Rewriting in place lets
    // the agent control the layout and use as many as it likes.
    if (content) {
      const localImg = /!\[([^\]]*)\]\((?:file:\/\/)?(\/[^)\s]+)\)/g;
      const seen = new Map();
      const paths = [...content.matchAll(localImg)].map((m) => m[2]);
      for (const p of paths) {
        if (seen.has(p)) continue;
        try {
          const r = await vfetch(`${BASE_URL}/api/whiteboard-asset`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: p }),
          });
          const d = await r.json();
          // A path that will not register is left ALONE rather than dropped:
          // the board then shows a broken image at that spot, which is a
          // visible, findable fault. Silently deleting it looks like the agent
          // simply chose not to show anything.
          if (d.success && d.url) seen.set(p, d.url);
        } catch { /* leave it as written */ }
      }
      if (seen.size) {
        content = content.replace(localImg, (whole, alt, p) =>
          (seen.has(p) ? `![${alt}](${seen.get(p)})` : whole));
      }
    }

    if (image_path) {
      try {
        const regResp = await vfetch(`${BASE_URL}/api/whiteboard-asset`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: image_path }),
        });
        const regData = await regResp.json();
        if (!regData.success) {
          return { content: [{ type: "text", text: `Error registering image_path: ${regData.error || "unknown"}` }] };
        }
        const imgMd = `![image](${regData.url})`;
        content = content ? `${content}\n\n${imgMd}` : imgMd;
      } catch (err) {
        return { content: [{ type: "text", text: `Error contacting local server to register image: ${err.message}` }] };
      }
    }

    // Markdown content mode
    const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botSyncPayload(BOT_NAME, {
        whiteboard: { content },
      })),
    });

    const data = await resp.json();
    if (data.success) {
      const wb = data.results?.whiteboard || {};
      // #221: a 200 from the app used to mean "I updated my own copy", which is
      // not what anyone is asking. The board is REMOTE — if the write did not
      // reach it, nobody in the room sees this, and the bot needs to know that
      // while it can still say something useful out loud.
      // Stored, but unreadable — the write worked and the room still sees
      // nothing. Distinct from a failed write, and the bot should say something
      // different about it.
      if (wb.readable === false) {
        return { content: [{ type: "text", text:
          `Saved, but the board CANNOT BE DISPLAYED right now — the sync server is failing to serve `
          + `room state, so the whiteboard is blank for everyone in the call. Do not describe this as `
          + `if it were on screen: say the board is down and send the content with send_chat.` }] };
      }
      if (wb.delivered === false) {
        return { content: [{ type: "text", text:
          `The whiteboard did NOT update — ${wb.error || "the shared board could not be reached"}. `
          + `Nobody in the room can see this content. Do not describe it as if it were on screen: `
          + `say the board is unavailable and send the content with send_chat instead.` }] };
      }

      // #366: the write reaching the board says nothing about whether anyone in
      // the room is actually LOOKING at it. Writing and presenting are two
      // different calls, and a bot that only did the first has no way to know
      // it — caught live on the 2026-08-13 call, then named as the general
      // failure by a bot that hit it from the other side an hour earlier.
      // `status.sharing` / `status.presenterName` are the same room-wide
      // presenting signal `get_room_info` already surfaces (formatScreenShares),
      // read fresh here rather than trusting stale local state.
      let presenceNote = "";
      try {
        const status = await getRoomStatus(roomId);
        if (!status.sharing && !status.presenterName) {
          presenceNote = ` Nobody is presenting anything right now — the room CANNOT see this. `
            + `Use start_share to present the whiteboard, or send_chat instead.`;
        } else if (status.sharing) {
          const shareUrl = status.screenShareUrl || status.whiteboardLoadedUrl || "";
          const onBoard = !shareUrl || shareUrl === status.whiteboardUrl || shareUrl === status.roomUrl;
          if (!onBoard) {
            presenceNote = ` But you're currently presenting something else (${shareUrl}), not this board — `
              + `the room can't see this update until your share points back at the whiteboard.`;
          }
        } else if (status.presenterName) {
          presenceNote = ` Note: ${status.presenterName} is presenting right now, not you — if that's not `
            + `this whiteboard, the room can't see this update.`;
        }
      } catch { /* best-effort — a failed status check shouldn't block the write confirmation */ }

      return { content: [{ type: "text", text: `Whiteboard updated (version ${wb.version}).${presenceNote}` }] };
    } else {
      return { content: [{ type: "text", text: `Error: ${data.error || "Failed to update"}` }] };
    }
  }
);

// --- read_whiteboard ---
server.tool(
  "play_audio",
  "Play an audio file INTO the Google Meet call through the bot's virtual mic — everyone hears it. BEST FOR SPEECH/VOICE audio (e.g. a recorded human utterance, a TTS clip): Meet's mic pipeline (noise cancellation + voice-activity detection) aggressively SUPPRESSES non-voice audio, so sound effects and music are filtered out / come through choppy and are NOT reliable through this path — use the whiteboard/screen-share for those instead. Provide exactly ONE source: url (remote audio file), path (absolute local file path — e.g. a clip a local tool just generated), or data (base64-encoded audio bytes). mp3/wav/ogg supported. Sequenced after any spoken ack and treated as speaking (won't talk over itself).",
  {
    url: z.string().optional().describe("Remote audio file URL, e.g. https://example.com/airhorn.mp3"),
    path: z.string().optional().describe("Absolute local file path to an audio file (mp3/wav/ogg). The app reads and plays it — no upload needed."),
    data: z.string().optional().describe("Base64-encoded audio bytes, for audio generated in-memory by a tool."),
    emoji: z.string().optional().describe("Optional emoji to show on the bot's avatar while the audio plays, e.g. 🔊"),
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ url, path, data, emoji, room_id }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    if (!url && !path && !data) return { content: [{ type: "text", text: "Error: provide one of url, path, or data." }] };
    try {
      const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(botSyncPayload(BOT_NAME, { meta: { action: "play-audio", url, path, audioData: data, emoji } })),
      });
      const d = await resp.json().catch(() => ({}));
      if (d.success || d.results?.playAudio?.ok) {
        return { content: [{ type: "text", text: `Playing audio (${url ? "url" : path ? "local file" : "inline data"}) into the call.` }] };
      }
      return { content: [{ type: "text", text: `Failed to play audio: ${d.error || "unknown"}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error contacting local server: ${err.message}` }] };
    }
  }
);

// --- play_sound ---
// Built-in sound-effect library (#sfx). The catalog is generated by
// scripts/build-sounds-manifest.mjs into sounds-catalog.json (committed); the
// actual mp3s ship with the Electron app, which resolves the id → file.
const SOUND_CATALOG = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./sounds-catalog.json', import.meta.url), 'utf-8'));
  } catch { return { ids: [], byCategory: {} }; }
})();

const SOUND_TOOL_DESC = (() => {
  const groups = Object.entries(SOUND_CATALOG.byCategory || {})
    .map(([cat, ids]) => `  ${cat}: ${ids.map((id) => id.split('/')[1]).join(', ')}`)
    .join('\n');
  return [
    "Play a built-in sound effect INTO the call (coin, level-up, success/error chimes, button clicks, portal whoosh, etc.) — a fun way to react. This is a UI/game-feedback library, NOT comedy SFX (no airhorn/rimshot/applause). Pass the sound `name` as \"<category>/<sound>\" (e.g. \"game/coin\", \"notification/success\", \"ui/submit\").",
    "NOTE: sound effects play cleanly only with the Meet 'studio sound' filter OFF — if they come through choppy, set the studioSound preference to false first (set_preference). They go through the bot's virtual mic and are treated as speaking (won't talk over your own speech).",
    "",
    `Available sounds (${SOUND_CATALOG.count || (SOUND_CATALOG.ids || []).length} total), as <category>/<name>:`,
    groups,
  ].join('\n');
})();

server.tool(
  "play_sound",
  SOUND_TOOL_DESC,
  {
    name: z.string().describe('Sound id as "<category>/<name>", e.g. "game/coin", "notification/success", "ui/submit". See the tool description for the full list.'),
    emoji: z.string().optional().describe("Optional emoji to show on the bot's avatar while the sound plays, e.g. 🔊 📣 🎉"),
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ name, emoji, room_id }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    // Validate against the catalog up front so a typo gets a helpful error
    // instead of silently doing nothing.
    if (!name || !(SOUND_CATALOG.ids || []).includes(name)) {
      const near = (SOUND_CATALOG.ids || []).filter((id) => id.includes((name || '').split('/').pop() || '\0')).slice(0, 8);
      return { content: [{ type: "text", text: `Unknown sound "${name}". ${near.length ? `Did you mean: ${near.join(', ')}? ` : ''}See play_sound's description for the full list.` }] };
    }
    try {
      const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(botSyncPayload(BOT_NAME, { meta: { action: "play-sound", name, emoji } })),
      });
      const d = await resp.json().catch(() => ({}));
      if (d.success && d.results?.playSound?.ok !== false) {
        return { content: [{ type: "text", text: `Played sound "${name}" into the call.` }] };
      }
      return { content: [{ type: "text", text: `Failed to play sound: ${d.results?.playSound?.reason || d.error || "unknown"}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error contacting local server: ${err.message}` }] };
    }
  }
);

server.tool(
  "read_whiteboard",
  "Read the current contents of the shared whiteboard — the markdown/Mermaid source text, not a screenshot. Use this before update_whiteboard to build on what's already there (your own earlier writes or another bot's), or to recall what you put up. Returns the source and the current version number. (get_room_info also includes the board, but this is the clean, dedicated read.)",
  {
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ room_id }) => {
    let roomId = room_id || ROOM_ID;
    // Prefer the app's active room when it's in a call — authoritative over a
    // stale env/arg, mirroring get_room_info.
    try {
      const probe = await vfetch(`${BASE_URL}/api/sync/no-room`);
      const probeData = await probe.json();
      const activeStatuses = ["in-call", "joining", "navigating", "waiting-to-be-admitted"];
      if (probeData.roomId && activeStatuses.includes(probeData.status?.callStatus)) {
        roomId = probeData.roomId;
        ROOM_ID = probeData.roomId;
      }
    } catch {
      // Local server unreachable — fall through with whatever roomId we have.
    }
    if (!roomId) {
      return { content: [{ type: "text", text: "Not in a call and no room_id provided — nothing to read." }] };
    }

    const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}`);
    const data = await resp.json();
    if (!data.success) {
      return { content: [{ type: "text", text: `Error: ${data.error || "Unknown error"}` }] };
    }
    const wb = data.whiteboard || {};
    const content = (wb.content || "").trim();
    if (!content) {
      return { content: [{ type: "text", text: "The whiteboard is currently empty." }] };
    }
    const version = wb.version != null ? ` (version ${wb.version})` : "";
    return { content: [{ type: "text", text: `Current whiteboard contents${version}:\n\n${content}` }] };
  }
);

// --- start_call ---
server.tool(
  "start_call",
  "Start a BRAND-NEW call: creates a fresh Google Meet that anyone with the link can join, sends the bot into it, and opens the user's own browser to it. This is the /call command, and it mirrors the app's \"Call <bot> now\" button. Use it when there is no existing call — to put the bot into a call that ALREADY exists, use join_call instead. If the user is NOT at the machine running the app — driving you from a phone, or from a remote session — pass open_browser: false, and you will get the meeting link back to hand them.",
  {
    bot_name: z.string().optional().describe("Which PROFILE to drive, when several app instances are running. Same routing as join_call. Omit to use the sole running instance, or the one this session is pinned to."),
    open_browser: z.boolean().optional().describe("Whether to open a browser to the meeting ON THE MACHINE RUNNING THE APP. Default true, which is right when the user is sitting at it. Pass false when they are remote (on their phone, in a remote session): no stray tab opens on the unattended desktop, and the response includes the join link so you can give it to them."),
  },
  async ({ bot_name, open_browser }) => {
    try {
      // Same multi-profile routing as join_call: the name selects which running
      // app instance starts the call, so `/call Alice` uses Alice's app.
      const routed = await routeToInstance(bot_name);
      if (routed.error) return { content: [{ type: "text", text: routed.error }] };
      const where = routed.instance
        ? ` (profile "${routed.instance.profile}" on port ${routed.instance.port})`
        : "";

      const remote = open_browser === false;
      const resp = await vfetch(`${BASE_URL}/api/call/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openBrowser: !remote }),
      });
      const data = await resp.json().catch(() => ({}));

      if (data.success) {
        const room = data.roomId ? ` Room: ${data.roomId}.` : "";
        // The link is always reported: whoever called this is the user's own
        // agent, and without it a remote user can't reach the room they made.
        const link = data.url || (data.roomId ? `https://meet.google.com/${data.roomId}` : null);
        const lead = remote
          ? "No browser was opened on the app's machine — give the user this link so they can join from wherever they are"
          : "The bot is joining and your browser is opening to it. The link, in case you want to pass it on";
        return { content: [{ type: "text", text: link
          ? `Started a new call${where}.${room} ${lead}:\n\n${link}`
          : `Started a new call${where}.${room} The app did not return a join link — check the app's panel for the room.` }] };
      }

      const REASONS = {
        "signed-out": "Not signed in to vibeconferencing.com. Sign in from the app's panel, then try again.",
        "rate-limited": "Too many calls started recently — try again in a few minutes.",
        upstream: "Google couldn't create the room. Try again.",
        "bad-request": "The app sent a malformed request — this is a bug worth reporting.",
        offline: "Couldn't reach vibeconferencing.com. Check the network.",
      };
      const why = REASONS[data.code] || `Couldn't start a call (${data.code || "unknown"}).`;
      return { content: [{ type: "text", text: why }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error starting a call: ${err.message}. Is the Vibeconferencing app running?` }] };
    }
  }
);

// --- start_recording (#209) ---
server.tool(
  "start_recording",
  "Record the current call to disk — one audio file per track (the bot's own voice plus each remote participant's audio, which Meet sends separately) PLUS a video track of the bot's own Meet view, with a manifest that names tracks and time-aligns them. Once recording stops, audio and video are automatically muxed into one playable call-recording.mp4. A small visible status window (elapsed time + Stop button) appears while recording is active — that's expected. Requires an active call. Recording can be started (and stopped, via stop_recording) at ANY point during a live call, not just at launch. Auto-runs on every call when the recordCallAudio pref / VIBECONF_RECORD_CALL is set; this tool starts it on demand otherwise.",
  {
    bot_name: z.string().optional().describe("Which PROFILE to drive, when several app instances are running. Same routing as join_call. Omit to use the sole running instance, or the one this session is pinned to."),
  },
  async ({ bot_name }) => {
    try {
      const routed = await routeToInstance(bot_name);
      if (routed.error) return { content: [{ type: "text", text: routed.error }] };
      const resp = await vfetch(`${BASE_URL}/api/call/record`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ on: true }),
      });
      const data = await resp.json().catch(() => ({}));
      if (data.ok) {
        if (data.already) return { content: [{ type: "text", text: `Already recording — files in:\n${data.dir}` }] };
        const notice = data.announced
          ? " I spoke a notice so the room knows it's being recorded — no need to announce it again."
          : "";
        return { content: [{ type: "text", text: `Recording the call (audio, one file per track, + video of the bot's own view).${notice} Saving to:\n${data.dir}` }] };
      }
      const why = data.code === 'not-in-call'
        ? "Not in a call — join or start one first, then record."
        : `Couldn't start recording (${data.code || 'unknown'}${data.detail ? ': ' + data.detail : ''}).`;
      return { content: [{ type: "text", text: why }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error starting recording: ${err.message}. Is the Vibeconferencing app running?` }] };
    }
  }
);

// --- stop_recording (#209) ---
server.tool(
  "stop_recording",
  "Stop the call recording started by start_recording (or by the recordCallAudio pref) — finalizes the per-track audio + video files and manifest, then automatically muxes them into one playable call-recording.mp4. Returns where they were saved. Can be called at any point mid-call (not just at the end). Recording also stops automatically when the bot leaves the call.",
  {
    bot_name: z.string().optional().describe("Which PROFILE to drive, when several app instances are running. Same routing as join_call. Omit to use the sole running instance, or the one this session is pinned to."),
  },
  async ({ bot_name }) => {
    try {
      const routed = await routeToInstance(bot_name);
      if (routed.error) return { content: [{ type: "text", text: routed.error }] };
      const resp = await vfetch(`${BASE_URL}/api/call/record`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ on: false }),
      });
      const data = await resp.json().catch(() => ({}));
      if (data.already || !data.dir) return { content: [{ type: "text", text: "No recording was in progress." }] };
      return { content: [{ type: "text", text: `Recording stopped — ${data.tracks ?? 0} track(s) saved to:\n${data.dir}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error stopping recording: ${err.message}.` }] };
    }
  }
);

// --- leave_call ---
server.tool(
  "leave_call",
  "Leave the Google Meet call. Signals the Electron app to hang up and closes the bot's session.",
  {
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ room_id }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) {
      return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    }

    const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botSyncPayload(BOT_NAME, {
        meta: { action: "leave" },
      })),
    });

    const data = await resp.json();
    if (data.success) {
      botNameLocked = false;
      return { content: [{ type: "text", text: "Left the call successfully."
        + afterCallWorkNote(data.results?.leave?.afterCallWork) }] };
    } else {
      return { content: [{ type: "text", text: `Error: ${data.error || "Failed to leave"}` }] };
    }
  }
);

// --- start_share (alias: share_whiteboard) ---
// "Screen share" is the Meet feature for presenting visual content; the
// whiteboard window is the (only) content source — it can load any URL, not
// just the built-in board. Shared schema + handler so the legacy
// share_whiteboard name keeps working for skills in the wild (#177).
const startShareSchema = {
  room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  width: z.number().optional().describe("Width of the shared board in pixels. Leave unset for the recommended 800 — the whiteboard renderer is TUNED for 800 wide, so markdown/Mermaid boards should keep it. Only change this when sharing a URL whose content wants a different shape."),
  height: z.number().optional().describe("Height of the shared board in pixels. Leave unset for the recommended 800. Square is deliberate: Meet stacks participant tiles down the RIGHT of a shared screen, so a wide board loses its edge behind them."),
  title_bar: z.boolean().optional().describe("Whether the shared window keeps its title bar. Default true — it labels what people are looking at. Pass false for an edge-to-edge capture when the chrome would read as an accident (a screenshot, a design mock, a full-bleed image)."),
};
async function startShareHandler({ room_id, width, height, title_bar }) {
    const roomId = room_id || ROOM_ID;
    if (!roomId) {
      return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    }

    // Stamp the attempt start so we can filter out stale errors from earlier
    // shares in the same call (e.g. an "ended unexpectedly" from a prior
    // drop must not get mis-reported as the cause of THIS attempt failing).
    const attemptStartedAt = new Date().toISOString();

    // Title bar before the window is built — `frame` is fixed at construction,
    // so asking after the share has started would only affect the NEXT one.
    if (title_bar !== undefined) {
      await vfetch(`${BASE_URL}/api/sync/${roomId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(botSyncPayload(BOT_NAME, {
          meta: { action: "set-share-title-bar", visible: title_bar },
        })),
      }).catch(() => { /* non-fatal — the share still happens */ });
    }

    // Size first, so the window opens at the requested shape rather than
    // opening square and visibly resizing in front of the room.
    if (width !== undefined || height !== undefined) {
      await vfetch(`${BASE_URL}/api/sync/${roomId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(botSyncPayload(BOT_NAME, {
          meta: { action: "set-share-size", width, height },
        })),
      }).catch(() => { /* non-fatal — the share still happens at the current size */ });
    }

    const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botSyncPayload(BOT_NAME, {
        meta: { action: "share-whiteboard" },
      })),
    });

    const data = await resp.json();
    if (data.success) {
      // Wait for screen share to complete (or fail) before responding. Polling
      // lets successful shares return quickly and avoids hard-coding a UI delay.
      const statusData = await waitForSharingState(roomId, true, { timeoutMs: 9000, intervalMs: 300, stablePolls: 2 });

      // Check for errors that occurred during THIS share attempt (filter by
      // timestamp — earlier-call errors like "ended unexpectedly" must not
      // bleed into this attempt's diagnostic).
      // Ground truth wins: status.sharing reflects Meet's own "You are
      // presenting" label. If we ARE presenting, it succeeded — even if a
      // transient "Can't share your screen" fired on a first attempt that then
      // recovered. Don't report failure over stale/transient errors when the
      // share is actually live.
      if (statusData.status?.sharing === true) {
        return { content: [{ type: "text", text: "The whiteboard window is now being shared in the call. Use update_whiteboard to change what it shows." }] };
      }

      // Not presenting — explain why, using errors from THIS attempt.
      const errors = statusData.status?.errors || [];
      const shareErrors = errors.filter(
        e => e.message.includes('Screen share') && e.timestamp >= attemptStartedAt
      );
      if (shareErrors.length > 0) {
        const latestError = shareErrors[shareErrors.length - 1];
        return { content: [{ type: "text", text: `Screen sharing failed: ${latestError.message}. The Meet UI may not be in a presentable state. Tell the user the share dropped and offer to retry.` }] };
      }

      return { content: [{ type: "text", text: "Share request was sent but the app reports it isn't presenting yet. The Meet UI may need to be refreshed or focused. Tell the user." }] };
    } else {
      return { content: [{ type: "text", text: `Error: ${data.error || "Failed to share"}` }] };
    }
}
server.tool(
  "start_share",
  "Start sharing the bot's whiteboard window into the Google Meet call so participants can see it. Set its content with update_whiteboard (markdown/Mermaid), or load_url to show an arbitrary web page instead.",
  startShareSchema,
  startShareHandler
);
server.tool(
  "share_whiteboard",
  "Alias for start_share (kept for back-compat). Starts screen-sharing into the call; defaults to the bot's whiteboard window.",
  startShareSchema,
  startShareHandler
);

// --- share_tab (POC: share the tab you're browsing) ---
// The SAME agent drives a Chrome tab (via the claude-in-chrome extension) and
// this bot, so it already knows the tab's URL — pass it here. The app activates
// that tab and screen-shares its window into the call, live. Reuses the
// screen-share pipeline; the URL is the join key. See share-external-tab.js.
async function shareTabHandler({ room_id, url, app_name }) {
  // Platform guard: the whole locate/isolate/present flow is AppleScript, so this
  // is macOS-only for now. On Windows/Linux, fail LOUD and CLEAR (not with a
  // cryptic "osascript not found") and point at the portable alternatives.
  if (process.platform !== "darwin") {
    return { content: [{ type: "text", text: "Sharing a specific browser tab (share_tab) is macOS-only right now — it uses AppleScript to find and isolate the tab, which Windows/Linux don't support yet. On this platform, tell the user and use start_share to share the whiteboard instead." }] };
  }
  const roomId = room_id || ROOM_ID;
  if (!roomId) return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
  if (!url) return { content: [{ type: "text", text: "Error: url is required — the URL of the tab to share (the one you're browsing in Chrome)." }] };

  const attemptStartedAt = new Date().toISOString();
  const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(botSyncPayload(BOT_NAME, { meta: { action: "share-tab", url, appName: app_name } })),
  });
  const data = await resp.json();
  if (!data.success) return { content: [{ type: "text", text: `Error: ${data.error || "Failed to share tab"}` }] };

  const statusData = await waitForSharingState(roomId, true, { timeoutMs: 9000, intervalMs: 300, stablePolls: 2 });
  if (statusData.status?.sharing === true) {
    return { content: [{ type: "text", text: `Now sharing the browser tab (${url}) into the call. It updates live as you browse — narrate or drive it as you like.` }] };
  }
  const errors = (statusData.status?.errors || []).filter(e => e.message.includes('Screen share') && e.timestamp >= attemptStartedAt);
  if (errors.length) {
    return { content: [{ type: "text", text: `Couldn't share the tab: ${errors[errors.length - 1].message}. Common causes: the tab/URL isn't open in Chrome, or screen-recording permission is off.` }] };
  }
  return { content: [{ type: "text", text: "Share request sent but the app isn't presenting yet — the tab may not be open in Chrome, or the Meet UI needs focus. Tell the user." }] };
}
server.tool(
  "share_tab",
  "Share a SPECIFIC browser tab into the Google Meet by its URL — ideal for showing the room the exact page you're browsing with the Chrome tools. Pass the tab's `url`; the app finds that tab in Chrome, makes it active, and screen-shares its window live (participants see it update as you navigate). Prefer this over start_share when you want to present a live external page rather than the bot's own whiteboard. macOS only for now (uses AppleScript to locate the tab); Windows support tracked separately.",
  {
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
    url: z.string().describe("The URL of the tab to share — the page you're browsing (e.g. from the claude-in-chrome tab you navigated). Matched by substring against open Chrome tabs, so a distinctive URL works best."),
    app_name: z.string().optional().describe("Browser app to search, default 'Google Chrome'. Use 'Brave Browser' if the tab is in Brave."),
  },
  shareTabHandler
);

// --- stop_sharing ---
server.tool(
  "stop_sharing",
  "Stop the bot's screen share in the Google Meet call.",
  {
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ room_id }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) {
      return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    }

    const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botSyncPayload(BOT_NAME, {
        meta: { action: "stop-sharing" },
      })),
    });

    const data = await resp.json();
    if (data.success) {
      // stablePolls 5 x 300ms = 1.5s, deliberately longer than the app's 1s
      // Meet-DOM reconcile tick (#68). Two polls (600ms) could sample the window
      // between our capture stream ending — which sets sharing=false
      // optimistically — and the first reconcile discovering Meet never actually
      // stopped presenting. That would confirm "stopped" from the very
      // optimistic flag this check exists to catch, which is how a bot came to
      // announce it had stopped while its screen was still up in front of the
      // room.
      const statusData = await waitForSharingState(roomId, false, { timeoutMs: 7000, intervalMs: 300, stablePolls: 5 });
      if (statusData.status?.sharing === false) {
        return { content: [{ type: "text", text: "Stopped sharing the whiteboard." }] };
      }
      return { content: [{ type: "text", text: "Stop sharing request was sent, but the app still reports it is presenting. Tell the user it may need a manual Stop presenting click." }] };
    } else {
      return { content: [{ type: "text", text: `Error: ${data.error || "Failed to stop sharing"}` }] };
    }
  }
);

// --- scroll_share ---
server.tool(
  "scroll_share",
  "Scroll the content currently being screen-shared into the call — useful when you've loaded a long website (via load_url) or posted markdown longer than the viewport and want to move down. Scrolls smoothly. Direction: 'down'/'up' move ~one screenful, 'top'/'bottom' jump to the ends. Works on whatever is in the share, URL or markdown alike.",
  {
    direction: z.enum(["down", "up", "top", "bottom"]).optional().describe("Scroll direction. Default: down."),
    amount: z.number().optional().describe("Pixels to scroll for up/down (default: ~85% of the viewport). Ignored for top/bottom."),
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ direction, amount, room_id }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) {
      return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    }
    const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botSyncPayload(BOT_NAME, {
        meta: { action: "scroll-share", direction, amount },
      })),
    });
    const data = await resp.json();
    const r = data.results?.scrollShare;
    if (r?.ok) {
      return { content: [{ type: "text", text: `Scrolled ${direction || 'down'}.` }] };
    }
    return { content: [{ type: "text", text: `Error: ${r?.error || data.error || "Failed to scroll"}` }] };
  }
);

// --- set_share_size ---
server.tool(
  "set_share_size",
  "Resize the shared board. Works whether or not you are already presenting: with a live share the window resizes and participants see it immediately; otherwise the size is remembered and the next start_share opens at it. RECOMMENDED: 800x800, the default. The whiteboard renderer is tuned for 800 wide, so leave it alone for markdown/Mermaid boards — resizing those makes text and diagrams render at the wrong scale. Change it when the board is showing a URL with its own natural shape: a phone-sized mock (390x844), a wide dashboard (1440x900), a tall document. Square is the default for a reason — Meet stacks the participant tiles down the RIGHT of a shared screen, so a wide board loses its right edge behind them. Clamped to 240-4096px.",
  {
    width: z.number().optional().describe("Width in pixels. Omit to keep the current width."),
    height: z.number().optional().describe("Height in pixels. Omit to keep the current height."),
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ width, height, room_id }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    if (width === undefined && height === undefined) {
      return { content: [{ type: "text", text: "Error: provide width, height, or both." }] };
    }
    const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botSyncPayload(BOT_NAME, { meta: { action: "set-share-size", width, height } })),
    });
    const data = await resp.json();
    const r = data.results?.setShareSize;
    if (r?.ok) {
      const notes = r.notes?.length ? " (" + r.notes.join("; ") + ")" : "";
      return { content: [{ type: "text", text: `Shared board is now ${r.width}x${r.height}${notes}. ${r.applied ? "Applied to the live share." : "Saved — the next share opens at this size."}` }] };
    }
    return { content: [{ type: "text", text: `Error: ${r?.error || data.error || "Failed to resize"}` }] };
  }
);

// --- set_share_title_bar ---
server.tool(
  "set_share_title_bar",
  "Show or hide the title bar on the window you are screen-sharing. It is SHOWN by default and that is usually right — it labels what people are looking at, and it is the only handle for moving that window by hand. Hide it when the chrome would read as an accident rather than a label: a full-bleed image, a design mock, a screenshot you want edge to edge. Note this cannot change during a live share (the window has to be rebuilt): while presenting, the setting is saved and applies to your next start_share, so set it BEFORE you share, or pass title_bar to start_share directly.",
  {
    visible: z.boolean().describe("true = keep the title bar (default). false = hide it for a clean edge-to-edge capture."),
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ visible, room_id }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botSyncPayload(BOT_NAME, { meta: { action: "set-share-title-bar", visible } })),
    });
    const data = await resp.json();
    const r = data.results?.setShareTitleBar;
    if (r?.ok) {
      const state = r.visible ? "shown" : "hidden";
      if (r.unchanged) return { content: [{ type: "text", text: `Title bar was already ${state}.` }] };
      return { content: [{ type: "text", text: r.applied
        ? `Title bar ${state}.`
        : `Title bar will be ${state} on your next share — it can't change while you're presenting.` }] };
    }
    return { content: [{ type: "text", text: `Error: ${r?.error || data.error || "Failed to set the title bar"}` }] };
  }
);

// --- click_share ---
server.tool(
  "click_share",
  "Click inside whatever the bot is screen-sharing — a real mouse event, so the page reacts exactly as it would to a person. Use it to drive an app on the board: press a button, open a menu, follow a link, tick a checkbox. PREFER selector over x/y: pass a CSS selector and the click lands on that element's centre, which you can find with inspect_dom. Raw x/y is for content with no addressable elements (a canvas, a map, an embedded viewer) — and note those coordinates are CSS pixels IN THE PAGE, which are NOT screenshot pixels: get_shared_screenshot is 2x on a Retina host, so halve what you measure there. Whatever you click, the room sees it happen.",
  {
    selector: z.string().optional().describe("CSS selector to click, e.g. 'button.submit', '#next', 'a[href=\"/docs\"]'. Clicks the element's centre and scrolls it into view first. Preferred over x/y."),
    x: z.number().optional().describe("X in CSS pixels within the shared page. Only when no selector fits."),
    y: z.number().optional().describe("Y in CSS pixels within the shared page."),
    button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button. Default left."),
    double: z.boolean().optional().describe("Send a double-click instead of a single click."),
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ selector, x, y, button, double, room_id }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    if (!selector && (x === undefined || y === undefined)) {
      return { content: [{ type: "text", text: "Error: provide a selector, or both x and y." }] };
    }
    const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botSyncPayload(BOT_NAME, {
        meta: { action: "share-click", selector, x, y, button, clickCount: double ? 2 : 1 },
      })),
    });
    const data = await resp.json();
    const r = data.results?.shareClick;
    if (r?.ok) {
      return { content: [{ type: "text", text: `Clicked ${r.selector ? r.selector + " " : ""}at (${r.x}, ${r.y}). Check the result with get_shared_screenshot or inspect_dom.` }] };
    }
    return { content: [{ type: "text", text: `Error: ${r?.error || data.error || "Failed to click"}` }] };
  }
);

// --- type_share ---
server.tool(
  "type_share",
  "Type into whatever the bot is screen-sharing — real key events, so autocomplete, validation and keyboard shortcuts all behave normally. Pass text to type it, or key to press a single named key (Enter, Tab, Escape, Backspace, ArrowDown, Home...). Add modifiers for a shortcut (['cmd'] + text 'a' selects all). Pass selector to focus a field first — without it keys go to whatever the page already has focused, which for a freshly loaded page is nothing, and the text vanishes. A newline inside text presses Enter, so you can fill a field and submit in one call. The room sees every keystroke land.",
  {
    text: z.string().optional().describe("Text to type, character by character. A \n presses Enter."),
    key: z.string().optional().describe("A single named key instead of text: 'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp'/'ArrowDown'/'ArrowLeft'/'ArrowRight', 'Home', 'End', 'PageDown'."),
    modifiers: z.array(z.string()).optional().describe("Held modifiers: 'cmd'/'meta', 'ctrl', 'alt'/'option', 'shift'. With text, this becomes a shortcut on the first character rather than literal typing."),
    selector: z.string().optional().describe("CSS selector of the field to focus first, e.g. 'input[name=q]', 'textarea'. Strongly recommended when typing into a form."),
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ text, key, modifiers, selector, room_id }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    if (!text && !key) return { content: [{ type: "text", text: "Error: provide text to type, or a key to press." }] };
    const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botSyncPayload(BOT_NAME, {
        meta: { action: "share-type", text, key, modifiers, selector },
      })),
    });
    const data = await resp.json();
    const r = data.results?.shareType;
    if (r?.ok) {
      const what = r.key ? `Pressed ${r.key}` : `Typed ${JSON.stringify(r.typed)}`;
      return { content: [{ type: "text", text: `${what}${r.selector ? " into " + r.selector : ""}. Check the result with get_shared_screenshot or inspect_dom.` }] };
    }
    return { content: [{ type: "text", text: `Error: ${r?.error || data.error || "Failed to type"}` }] };
  }
);

// --- set_share_audio ---
server.tool(
  "set_share_audio",
  "Mute or unmute the sound coming from what you're screen-sharing, without stopping the share. By default a shared board's audio is live — a video or sound effect playing on it is heard by everyone in the call. Mute it when the room should talk OVER the content rather than listen to it (e.g. you've put a video up for discussion, or you're leaving a page open that plays sound you don't want as a backdrop), then unmute when it's time to actually watch. Takes effect instantly and the share keeps running; the video keeps playing either way, so you can still see it. The setting sticks across shares until you change it.",
  {
    muted: z.boolean().describe("true = the call hears nothing from the shared surface. false = restore its sound."),
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ muted, room_id }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) {
      return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    }
    const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botSyncPayload(BOT_NAME, {
        meta: { action: "set-share-audio", muted },
      })),
    });
    const data = await resp.json();
    const r = data.results?.setShareAudio;
    if (r?.ok) {
      return { content: [{ type: "text", text: muted
        ? "Share audio muted — the call hears nothing from the shared surface."
        : "Share audio unmuted — the call hears the shared surface again." }] };
    }
    return { content: [{ type: "text", text: `Error: ${r?.error || data.error || "Failed to set share audio"}` }] };
  }
);

// --- inspect_dom ---
server.tool(
  "inspect_dom",
  "Inspect the live DOM of the bot's Google Meet call, or of whatever it's currently screen-sharing into the call — returns the matched elements' outerHTML. Read-only. Use it to debug what's actually on screen: locate a modal and its dismiss button, find why a share rendered blank, or check Meet's UI state. Pair with get_call_screenshot (pixels) for a fuller picture.",
  {
    selector: z.string().describe("CSS selector to query, e.g. '[role=dialog]', 'button', '.some-class'. Defaults to 'body'."),
    target: z.enum(["meet", "share"]).optional().describe("Which DOM to read. 'meet' (default) = the bot's Google Meet call page. 'share' = the window currently being screen-shared into the call — that's the whiteboard if you're sharing the whiteboard, or any URL you loaded into it via load_url."),
    max_elements: z.number().optional().describe("Max matched elements to return (default 5, max 20)."),
    max_chars: z.number().optional().describe("Max characters of outerHTML per element (default 4000, max 20000); longer elements are truncated."),
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ selector, target, max_elements, max_chars, room_id }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) {
      return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    }
    const tgt = target || "meet";
    const sel = selector || "body";
    const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botSyncPayload(BOT_NAME, {
        meta: { action: "inspect-dom", target: tgt, selector: sel, maxElements: max_elements, maxChars: max_chars },
      })),
    });
    const data = await resp.json();
    const r = data.results?.inspectDom;
    if (!r) {
      return { content: [{ type: "text", text: `Error: ${data.error || "No response from app"}` }] };
    }
    if (!r.ok) {
      return { content: [{ type: "text", text: `Error: ${r.error || "inspect failed"}` }] };
    }
    if (!r.returned) {
      return { content: [{ type: "text", text: `No elements matched '${sel}' in the ${tgt} DOM.` }] };
    }
    const header = `Matched ${r.total} element(s) for '${sel}' in the ${tgt} DOM; showing ${r.returned}:`;
    const body = r.html.map((h, i) => `--- [${i + 1}] ---\n${h}`).join("\n\n");
    return { content: [{ type: "text", text: `${header}\n\n${body}` }] };
  }
);

// --- set_mode ---
// --- set_caption_language ---
server.tool(
  "set_caption_language",
  "Set the language the bot LISTENS in, by changing Meet's \"Language of the meeting\" caption setting. This is not cosmetic: the bot hears the room by reading Meet's captions, so if the meeting is in Spanish while this is English, Meet produces nonsense from correct speech and the bot answers the nonsense — it does not fall silent, it becomes confidently wrong. Call this as soon as you notice the room is speaking a language other than the current caption language, or when asked to work in another language. Meet has no host-level control for this (each participant sets their own), so the bot must set its own. Takes a few seconds: it walks Meet's Settings dialog.",
  {
    language: z.string().describe("BCP-47 tag as Meet spells it: 'es-ES', 'es-MX', 'en-GB', 'fr-FR', 'de-DE', 'ja-JP', 'pt-BR', 'cmn-Hans-CN'. A bare language ('es') resolves to the first regional variant Meet offers. Many are marked BETA in Meet's own list."),
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ language, room_id }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) {
      return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    }

    const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botSyncPayload(BOT_NAME, {
        meta: { action: "set-caption-language", language },
      })),
    });

    const data = await resp.json();
    const result = data.results?.setCaptionLanguage;
    if (result?.ok) {
      const was = result.previous ? ` (was ${result.previous})` : "";
      // Save it to the bot's profile so it sticks past this call. Store the tag
      // MEET resolved to, not the one asked for — "es" becomes "es-ES", and the
      // resolved form is what should be reapplied on the next join.
      //
      // The app skips re-driving Meet for a language it just applied, so this
      // costs nothing beyond the write. Best-effort: the language IS already
      // set, so failing to persist it is worth a note, not an error.
      let saved = " Saved as this bot's language for future calls.";
      try {
        await setPrefs([{ key: 'captionLanguage', value: result.language }]);
      } catch (err) {
        saved = ` (Note: it's set for this call, but saving it as the bot's default failed: ${err.message})`;
      }
      return { content: [{ type: "text", text: `Caption language set to ${result.language}${was}. The bot now hears the room in that language; earlier transcripts were captioned in the previous one.${saved}` }] };
    }
    return { content: [{ type: "text", text: `Error: ${result?.error || data.error || "failed to set the caption language"}` }] };
  }
);

server.tool(
  "set_mode",
  "Set the bot's persistent behavior mode. 'active' = responds freely on every pause (default). 'passive' = silent until its name is mentioned — use when the user wants the bot to stay out of the way. 'silent' = listens and can act (update whiteboard, run tools) but never speaks. Call this when the user explicitly asks you to switch modes (e.g. 'be quiet', 'speak when spoken to', 'go silent', 'be active again').",
  {
    mode: z.enum(["active", "passive", "silent"]).describe("Behavior mode: active, passive, or silent"),
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ mode, room_id }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) {
      return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    }

    const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botSyncPayload(BOT_NAME, {
        meta: { action: "set-mode", mode },
      })),
    });

    const data = await resp.json();
    const result = data.results?.setMode;
    if (result?.ok) {
      return { content: [{ type: "text", text: `Mode set to '${result.mode}'.` }] };
    }
    return { content: [{ type: "text", text: `Error: ${result?.error || data.error || "Failed to set mode"}` }] };
  }
);

// --- set_camera ---
server.tool(
  "set_camera",
  "Turn the bot's camera on or off in the Meet call. Use 'off' when the user wants you to listen passively without showing the avatar video (saves bandwidth and reduces visual noise). Use 'on' to bring the avatar back. The avatar overlay state (emoji, animation) is independent of this — turning the camera off just hides the video feed from other participants.",
  {
    on: z.boolean().describe("true to turn the camera on, false to turn it off"),
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ on, room_id }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) {
      return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    }

    const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botSyncPayload(BOT_NAME, {
        meta: { action: "set-camera", on },
      })),
    });

    const data = await resp.json();
    const result = data.results?.setCamera;
    if (result?.ok) {
      return { content: [{ type: "text", text: `Camera ${result.on ? 'on' : 'off'}.` }] };
    }
    return { content: [{ type: "text", text: `Error: ${data.error || "Failed to set camera"}` }] };
  }
);

// --- get_call_screenshot ---
server.tool(
  "get_call_screenshot",
  "Capture a screenshot of the current Meet view as the bot sees it — participant tiles, names, mic icons, who's speaking, captions, ANOTHER participant's shared screen, and the surrounding Google Meet chrome — saved to a temporary file. Returns the absolute path to the PNG. Use this for visual context about what's happening in the call. IMPORTANT: this is the Meet view, so it does NOT show the bot's OWN screen share — Meet never shows you your own presentation. To see what YOU are presenting (your shared whiteboard), use get_shared_screenshot instead. After getting the path, read the file with your normal image-reading tool to look at it.",
  {
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async () => {
    const resp = await vfetch(`${BASE_URL}/api/call-screenshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await resp.json();
    if (data?.success && data.path) {
      return { content: [{ type: "text", text: `Saved screenshot to ${data.path}` }] };
    }
    return { content: [{ type: "text", text: `Error capturing screenshot: ${data?.error || "unknown"}` }] };
  }
);

// --- get_shared_screenshot ---
server.tool(
  "get_shared_screenshot",
  "Capture a screenshot of the bot's OWN shared screen — the whiteboard it's currently presenting into the call — and save it to a temporary file. Returns the absolute path to the PNG. Use this to see what participants are actually seeing on your shared screen (get_call_screenshot only shows the Meet view, which can't show you your own share). Fails if you're not currently sharing. After getting the path, read the file with your normal image-reading tool to look at it.",
  {
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async () => {
    const resp = await vfetch(`${BASE_URL}/api/shared-screenshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await resp.json();
    if (data?.success && data.path) {
      return { content: [{ type: "text", text: `Saved shared-screen screenshot to ${data.path}` }] };
    }
    return { content: [{ type: "text", text: `Error capturing shared screen: ${data?.error || "unknown"}` }] };
  }
);

// --- read_chat ---
server.tool(
  "read_chat",
  "Read the messages in the Google Meet text chat. Returns sender (best-effort) and text for each visible message. Use this when get_room_info reports unread chat, or when someone says they posted something in the chat. Note: reading chat briefly opens the chat pane (which closes the people pane), so speaker detection pauses for ~1 second while it reads, then resumes automatically.",
  {
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async () => {
    const resp = await vfetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "read" }),
    });
    const data = await resp.json();
    if (data?.reason === 'chat-space-unreachable') {
      return { content: [{ type: "text", text: `⚠️ Can't read chat: this meeting's chat is a Google Chat space the bot can't access. ANNOUNCE THIS ALOUD to the participants — e.g. "Heads up: I can't see the chat in this meeting, so please say anything important out loud instead." (To fix for future calls, have the organizer create the meeting from a personal @gmail account.)` }] };
    }
    if (!data?.success) {
      return { content: [{ type: "text", text: `Error reading chat: ${data?.error || "unknown"}` }] };
    }
    const messages = data.messages || [];
    if (messages.length === 0) {
      return { content: [{ type: "text", text: "Chat is empty." }] };
    }
    const text = messages.map(m => `${m.sender ? m.sender + ': ' : ''}${m.text}`).join('\n');
    return { content: [{ type: "text", text }] };
  }
);

// --- send_chat ---
server.tool(
  "send_chat",
  "Post a message into the Google Meet text chat. Use this for things that are awkward to say aloud — links, code snippets, the room URL — or to respond in text when in silent mode. Note: sending briefly opens the chat pane (which closes the people pane), so speaker detection pauses for ~1 second, then resumes automatically.",
  {
    text: z.string().describe("The message to post in the Meet chat."),
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ text }) => {
    const resp = await vfetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "send", text }),
    });
    const data = await resp.json();
    if (data?.success) {
      return { content: [{ type: "text", text: `Posted to chat: "${text}"` }] };
    }
    if (data?.reason === 'chat-space-unreachable') {
      return { content: [{ type: "text", text: `⚠️ Couldn't post to chat: this meeting's chat is a Google Chat space the bot can't access. SAY IT ALOUD instead (the participants can't get it from you in text here). If it was a link/snippet, read or describe it verbally. (To fix for future calls, have the organizer create the meeting from a personal @gmail account.)` }] };
    }
    return { content: [{ type: "text", text: `Error sending chat: ${data?.error || "unknown"}` }] };
  }
);

// --- set_avatar_emoji ---
server.tool(
  "set_avatar_emoji",
  "Override the avatar's resting/yielding emojis to match the conversation's tone. 'idle' shows between turns; 'listening' shows while actively listening (in active mode); 'yielding' shows when the bot wants to speak but is deferring because someone else is talking. Pass any combination. Pass an empty string for a field to revert to the default for that state. Persists for the rest of the call.",
  {
    idle: z.string().optional().describe("Emoji to show between turns (replaces default 😔). Pass '' to reset."),
    listening: z.string().optional().describe("Emoji to show while listening in active mode (replaces default 🙂). Pass '' to reset."),
    yielding: z.string().optional().describe("Emoji to show when the bot wants to speak but is yielding (replaces default 🙋). Pass '' to reset."),
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ idle, listening, yielding, room_id }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) {
      return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    }
    const payload = {};
    if (idle !== undefined) payload.idle = idle;
    if (listening !== undefined) payload.listening = listening;
    if (yielding !== undefined) payload.yielding = yielding;
    if (Object.keys(payload).length === 0) {
      return { content: [{ type: "text", text: "No emoji values provided. Pass 'idle', 'listening', and/or 'yielding'." }] };
    }
    const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botSyncPayload(BOT_NAME, {
        meta: { action: "set-avatar-emoji", ...payload },
      })),
    });
    const data = await resp.json();
    const result = data.results?.setAvatarEmoji;
    if (result?.ok) {
      const parts = [];
      if (idle !== undefined) parts.push(`idle=${idle ? `'${idle}'` : 'default'}`);
      if (listening !== undefined) parts.push(`listening=${listening ? `'${listening}'` : 'default'}`);
      if (yielding !== undefined) parts.push(`yielding=${yielding ? `'${yielding}'` : 'default'}`);
      return { content: [{ type: "text", text: `Avatar emoji set: ${parts.join(', ')}.` }] };
    }
    return { content: [{ type: "text", text: `Error: ${result?.error || data.error || "Failed to set avatar emoji"}` }] };
  }
);

// --- list_preferences ---
server.tool(
  "list_preferences",
  "List the bot's user-modifiable preferences (ack thresholds, ack phrase pools, voice, etc.) with their current values, defaults, types, and descriptions. Call this when the user asks to change a setting and you want to see what's available, or when answering 'what can I tweak about how you behave?'. Note: secrets (API keys, auth) are not exposed.",
  {},
  async () => {
    try {
      const resp = await vfetch(`${BASE_URL}/api/preferences`);
      const data = await resp.json();
      if (!data?.success) {
        return { content: [{ type: "text", text: `Error: ${data?.error || 'Could not fetch preferences'}` }] };
      }
      const lines = data.preferences.map(p => {
        const valueStr = JSON.stringify(p.value);
        const defaultStr = p.isDefault ? ' (default)' : ` (default: ${JSON.stringify(p.default)})`;
        const constraints = [];
        if (p.min != null) constraints.push(`min ${p.min}`);
        if (p.max != null) constraints.push(`max ${p.max}`);
        if (p.minItems != null) constraints.push(`minItems ${p.minItems}`);
        if (p.requiresRestart) constraints.push('requires restart');
        const constraintStr = constraints.length ? ` [${constraints.join(', ')}]` : '';
        return `- ${p.key} (${p.type}${constraintStr}): ${valueStr}${defaultStr}\n  ${p.description}`;
      });
      return { content: [{ type: "text", text: `Preferences:\n\n${lines.join('\n\n')}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);

// --- set_preference ---
server.tool(
  "set_preference",
  "Modify a user preference. The 'value' must match the preference's type (number, string, boolean, or array of strings). Call list_preferences first if you need to see available keys, types, and constraints. Common use cases: tune ack thresholds (ackShortMin / ackLongMin), customize what the bot says when thinking (ackShortPhrases / ackLongPhrases), change bot name. The agent should confirm with the user before changing irreversible-feeling settings; obvious requests ('add \"sure thing\" to your short acks') don't need confirmation.",
  {
    key: z.string().describe("Preference key. Use list_preferences to see what's available."),
    value: z.any().describe("New value. Must match the preference's type. For string arrays, pass a JSON array."),
  },
  async ({ key, value }) => {
    try {
      const resp = await vfetch(`${BASE_URL}/api/preferences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      const data = await resp.json();
      if (!data?.success) {
        return { content: [{ type: "text", text: `Error: ${data?.error || 'Failed to set preference'}` }] };
      }
      const restartNote = data.requiresRestart ? ' Takes effect on next app restart.' : ' Applied immediately.';
      return { content: [{ type: "text", text: `Set '${data.key}' to ${JSON.stringify(data.value)}.${restartNote}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);

// --- end_session ---
server.tool(
  "end_session",
  "Finish your after-call work and release the app. Call this once you have done whatever wrap-up the bot is meant to do after leaving a call (summary, receipt, notes) — or immediately if there is nothing to do. The app is holding the call's room, transcript and your terminal open until you do, so calling it promptly matters; it will otherwise wait out the full window. Only meaningful during after-call work: harmless at any other time.",
  {
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ room_id }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) {
      return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    }
    const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botSyncPayload(BOT_NAME, {
        meta: { action: "end-session" },
      })),
    });
    const data = await resp.json();
    const r = data.results?.endSession;
    if (r?.ok && r.wasActive) {
      return { content: [{ type: "text", text: "After-call work finished — the app is tearing the call down now. Nothing further to do; exit the conversation loop." }] };
    }
    if (r?.ok) {
      return { content: [{ type: "text", text: "No after-call work was running, so there was nothing to end. Exit the conversation loop." }] };
    }
    return { content: [{ type: "text", text: `Error: ${data.error || "could not end the session"}` }] };
  }
);

// --- get_working_memory ---
// Two-tier architecture (docs/two-tier-design.md). The bot's private internal
// read of the conversation — distinct from the shared whiteboard. Read it to
// see the current running understanding + stance; the fast model phrases from
// this so it can speak instantly when called on.
server.tool(
  "get_working_memory",
  "Read the bot's private working memory for this call: 'understanding' (the running read of what's being discussed) and 'stance' (the point the bot would make if the floor opened now). This is the bot's internal mental state, NOT the shared whiteboard participants see. Use it to check what the slow model currently believes before phrasing a response, or to decide whether the understanding needs refreshing.",
  {},
  async () => {
    try {
      const resp = await vfetch(`${BASE_URL}/api/working-memory`);
      const data = await resp.json();
      if (!data?.success) {
        return { content: [{ type: "text", text: `Error: ${data?.error || 'Could not fetch working memory'}` }] };
      }
      const wm = data.workingMemory || {};
      const age = wm.updatedAt ? `${Math.round((Date.now() - wm.updatedAt) / 1000)}s ago` : 'never';
      return { content: [{ type: "text", text:
        `Working memory (updated ${age}${wm.updatedBy ? ` by ${wm.updatedBy}` : ''}):\n\n` +
        `UNDERSTANDING:\n${wm.understanding || '(empty)'}\n\n` +
        `STANCE:\n${wm.stance || '(empty)'}\n\n` +
        `PEOPLE:\n${wm.people || '(empty)'}\n\n` +
        `ENGAGEMENT (who the bot is actively talking with — feeds the fast addressing judge):\n${wm.engagement || '(empty)'}`
      }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);

// --- post_understanding ---
// The slow model's background-comprehension write path. Maintains the bot's
// working memory while it's silent on the sidelines, so the call-on moment is
// cheap (the fast model only has to phrase, not catch up on minutes of talk).
server.tool(
  "post_understanding",
  "Update the bot's private working memory for this call. Pass any of 'understanding' (your running read of what's being discussed), 'stance' (the point you'd make if the floor opened right now), or 'people' (accumulating notes about who's in the call — roles, expertise, who's been quiet). Unset fields are left as-is, so you can refresh the topic read without disturbing the people notes. Call this in the background as the conversation evolves, even when you're NOT speaking, so the bot can respond instantly when called on. This is internal state, not the shared whiteboard.",
  {
    understanding: z.string().optional().describe("Running read of what's being discussed. Keep it concise and current. Churns as the topic moves."),
    stance: z.string().optional().describe("The point the bot would make if the floor opened now. A bullet or two, ready to be phrased into speech."),
    people: z.string().optional().describe("Accumulating notes about participants: roles, expertise, relationships, who's been quiet. Persists across topic shifts — update it as you learn things, don't rewrite it from scratch each turn."),
    engagement: z.string().optional().describe("Who the bot is actively in a back-and-forth with right now, by name, vs sidelined (e.g. 'actively talking with Stan' or 'sidelined; Stan and Samantha are talking to each other'). This feeds the fast addressing judge so a bare 'you'/unnamed follow-up resolves to the right person. A background pass keeps it fresh; override it here when you know better."),
  },
  async ({ understanding, stance, people, engagement }) => {
    if (understanding == null && stance == null && people == null && engagement == null) {
      return { content: [{ type: "text", text: "Provide understanding, stance, people, and/or engagement." }] };
    }
    try {
      const resp = await vfetch(`${BASE_URL}/api/working-memory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ understanding, stance, people, engagement, updatedBy: BOT_NAME }),
      });
      const data = await resp.json();
      if (!data?.success) {
        return { content: [{ type: "text", text: `Error: ${data?.error || 'Failed to update working memory'}` }] };
      }
      const wm = data.workingMemory || {};
      const u = (wm.understanding || '').length;
      const s = (wm.stance || '').length;
      const p = (wm.people || '').length;
      const e = (wm.engagement || '').length;
      return { content: [{ type: "text", text: `Working memory updated (understanding ${u} chars, stance ${s} chars, people ${p} chars, engagement ${e} chars).` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);

// --- bank_probe ---
// Active-listening (#245). On a background tick — when you're NOT being addressed
// but the conversation is moving — you can deposit a SHORT interjection here. The
// app's fast-model firing gate may speak it at the next natural opening to show
// you're listening and to buy you time, without you having to fully respond.
server.tool(
  "bank_probe",
  "Active listening: stash a SHORT (2–6 word) interjection the bot may say at the next natural opening in the conversation — e.g. 'Good point about latency.', 'What about cost?', 'Interesting.'. Use this on a [BACKGROUND TICK] when you're following along but not being directly addressed: it lets the bot react in real time (a brief acknowledgment or nudge) while you keep thinking. Keep it short and low-stakes — it's a probe, not your full point. Only the freshest banked probe is used, and it's discarded if the conversation moves on, so re-bank as the topic evolves. Does nothing user-visible unless the active-listening firing gate (probeFiring) is enabled.",
  {
    text: z.string().describe("The short interjection to bank (2–6 words). One natural spoken phrase."),
  },
  async ({ text }) => {
    if (!text || !text.trim()) {
      return { content: [{ type: "text", text: "Provide a non-empty interjection." }] };
    }
    try {
      const resp = await vfetch(`${BASE_URL}/api/bank-probe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await resp.json();
      if (!data?.success) {
        return { content: [{ type: "text", text: `Error: ${data?.error || 'Failed to bank probe'}` }] };
      }
      return { content: [{ type: "text", text: `Probe banked (${data.bankSize} in bank). It may fire at the next opening; re-bank if the topic shifts.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);

// --- get_room_info ---
server.tool(
  "get_room_info",
  "Get the current state of the Google Meet call: participants, who is speaking, screen sharing status, detected Meet URLs, errors. When not in a call, shows detected Meet URLs from browser tabs. This is your primary tool for understanding what's happening in the call.",
  {
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ room_id }) => {
    // Always consult the local server first. Its active roomId is authoritative:
    // if the app is in a call, use that room regardless of what ROOM_ID env or
    // the caller's room_id arg says — those can be stale from a previous session.
    let roomId = room_id || ROOM_ID;
    let noteMismatch = null;
    try {
      const resp = await vfetch(`${BASE_URL}/api/sync/no-room`);
      const data = await resp.json();
      const activeStatuses = ['in-call', 'joining', 'navigating', 'waiting-to-be-admitted'];
      if (data.roomId && activeStatuses.includes(data.status?.callStatus)) {
        // App is in a call — that's authoritative
        if (roomId && roomId !== data.roomId) {
          noteMismatch = `Note: ignoring stale room_id '${roomId}' — app is actually in '${data.roomId}'.`;
        }
        roomId = data.roomId;
        ROOM_ID = data.roomId;
      } else if (!roomId) {
        // Not in a call and no room_id given — return detected URLs or nothing
        const urls = data.detectedMeetUrls || [];
        const localServerHint = data.status?.localServerUrl
          ? `\n\nLocal server: ${data.status.localServerUrl} (MCP base URL for this app instance)${data.status.localProfile ? `\nProfile: ${data.status.localProfile}` : ''}`
          : '';
        if (urls.length > 0) {
          return { content: [{ type: "text", text: `Not in a call. Detected Google Meet URLs:\n${urls.map(u => `  - ${u}`).join('\n')}\n\nUse the meet code from one of these URLs as room_id to join.${localServerHint}` }] };
        }
        return { content: [{ type: "text", text: `Not in a call. No Google Meet URLs detected in browser tabs.${localServerHint}` }] };
      }
    } catch {
      // Local server unreachable — fall through with whatever roomId we have
    }

    if (!roomId) {
      return { content: [{ type: "text", text: "Not in a call. No Google Meet URLs detected in browser tabs." }] };
    }

    const resp = await vfetch(`${BASE_URL}/api/sync/${roomId}`);
    const data = await resp.json();

    if (!data.success) {
      return { content: [{ type: "text", text: `Error: ${data.error || "Unknown error"}` }] };
    }

    const status = data.status || {};
    const participants = data.participants || [];
    const detectedUrls = data.detectedMeetUrls || [];

    // #366-followup: peers' sharing state lives on the REMOTE presence hash
    // (announced by announceSharing() in main.js on start/stop), not in the
    // local server's own status/members above — that only knows about this
    // bot's own view. Best-effort: a failed or slow remote fetch must not
    // block the rest of get_room_info, which is otherwise entirely local.
    let peerSharing = [];
    try {
      const remoteResp = await vfetch(`${WEBSITE_URL}/api/sync/${roomId}`);
      const remoteData = await remoteResp.json();
      if (remoteData.success) {
        peerSharing = (remoteData.members || []).filter((m) =>
          m.sharing && m.name && m.name.toLowerCase() !== (BOT_NAME || '').toLowerCase()
        );
      }
    } catch { /* best-effort — see comment above */ }

    // Members from sync API (includes bots). Build a set of registered bot
    // names (case-insensitive) so we can annotate the Meet participant list
    // with (bot) for cross-instance bots like Coltrane (#162).
    const allMembers = data.members || [];
    const botNames = new Set(
      allMembers
        .filter((m) => m.role === 'bot' && m.name)
        .map((m) => m.name.toLowerCase())
    );

    // Build participant list with speaking + bot indicators
    const participantLines = participants.length > 0
      ? participants.map(p => {
          const tags = [];
          if (botNames.has((p.name || '').toLowerCase())) tags.push('bot');
          if (p.speaking) tags.push('speaking');
          const suffix = tags.length ? ` (${tags.join(', ')})` : '';
          return `  - ${p.name}${suffix}`;
        }).join('\n')
      : '  (none detected)';

    const formatVersions = (versions = {}) => {
      const parts = [];
      if (versions.app) parts.push(`app ${versions.app}`);
      if (versions.mcp) parts.push(`mcp ${versions.mcp}`);
      if (versions.node) parts.push(`node ${versions.node}`);
      return parts.length ? ` — ${parts.join(', ')}` : '';
    };

    // Registered bot members (full list, includes bots not currently visible
    // in the Meet participant tiles — e.g. still joining)
    const members = allMembers
      .map((m) => `  - ${m.name} (${m.role})${formatVersions(m.versions)}`)
      .join("\n");

    const botAppVersions = new Map();
    for (const m of allMembers) {
      if (m.role === 'bot' && m.versions?.app) botAppVersions.set(m.name, m.versions.app);
    }
    const uniqueAppVersions = new Set(botAppVersions.values());

    const wb = data.whiteboard?.content || "(empty)";
    const errors = (status.errors || []).map(e => `  - ${e.message} (${e.timestamp})`).join("\n");

    const sections = [];
    if (noteMismatch) sections.push(noteMismatch, '');
    sections.push(...[
      `Room: ${roomId}`,
      // The call id is what names this call's artifact folder (calls/<call-id>/),
      // so the bot's CLAUDE.md can tell it where to save transcripts, summaries
      // and recordings. It was in the payload but never printed, which made every
      // "get_room_info for the call id" instruction quietly unfollowable.
      // Absent between calls — the id is minted on join and cleared on leave.
      data.callId ? `Call id: ${data.callId} (artifacts for this call belong in calls/${data.callId}/)` : null,
      `Call status: ${status.callStatus || 'unknown'}`,
      `Mode: ${status.mode || 'active'} (active=responds freely, passive=only when named, silent=listens but never speaks)`,
      status.localServerUrl ? `Local server: ${status.localServerUrl} (MCP base URL for this app instance)` : null,
      status.localProfile ? `Profile: ${status.localProfile}` : null,
      // Everyone sharing, not just the bot. This used to read "Screen sharing:
      // no" while somebody was mid-presentation, which is not a gap but a wrong
      // answer. The people-pane list can hold several at once; the toolbar
      // (presenterName) names one, latest-wins, and says nothing at all while
      // the bot itself is presenting.
      formatScreenShares(status, data),
    ].filter(Boolean));

    // Calendar auto-join (#299): only present when this join was matched from
    // a Google Calendar event — gives the agent the meeting's actual title/
    // description/start time up front, instead of walking into the call cold
    // and having to ask what it's for.
    const cal = status.calendarEventContext;
    if (cal && (cal.summary || cal.description)) {
      const calLines = [`Calendar context: this call was auto-joined from a calendar invite.`];
      if (cal.summary) calLines.push(`  Title: ${cal.summary}`);
      if (cal.start) calLines.push(`  Start: ${cal.start}`);
      if (cal.description) calLines.push(`  Description: ${cal.description}`);
      sections.push(calLines.join('\n'));
    }

    if (status.whiteboardUrl) {
      sections.push(`Whiteboard URL (just the board, no room UI): ${status.whiteboardUrl} (share this in chat so participants can view the whiteboard)`);
    }
    if (status.roomUrl) {
      sections.push(`Full room URL (whole room UI): ${status.roomUrl}`);
    }
    const shareUrl = status.screenShareUrl || status.whiteboardLoadedUrl; // #177 rename; tolerate old field
    if (shareUrl) {
      sections.push(`Currently sharing: ${shareUrl} (what's rendering in the screen share now, post-update_whiteboard / scroll_share)`);
    }
    if (peerSharing.length > 0) {
      // WHO is presenting is already visible via Meet's own UI (presenterName,
      // above) — this is WHAT: content another bot announced it's sharing,
      // which Meet's UI has no way to tell you.
      sections.push(
        `Peer bots sharing:\n` +
        peerSharing.map((m) => `  - ${m.name}: ${m.screenShareUrl || '(url not announced)'}`).join('\n')
      );
    }

    // #244: surface the current avatar background so the bot can recall it
    // ("what's my background?") across context resets, without parsing raw SVG.
    if (status.avatarBackground?.set) {
      const ab = status.avatarBackground;
      const bits = [];
      if (ab.caption) bits.push(`"${ab.caption}"`);
      if (ab.imageRef) bits.push(`image: ${ab.imageRef}`);
      bits.push(`${ab.length} chars of SVG`);
      sections.push(
        `Avatar background: custom (${bits.join(', ')})` +
        (ab.caption ? '' : ' — set avatarBackgroundCaption to label it for later recall')
      );
    }

    if (status.someoneElsePresenting) {
      sections.push(`Someone else presenting: ${status.presenterName || 'yes'}`);
    }

    if (status.chatUnread) {
      sections.push('Chat: unread message(s) — use read_chat to see them');
    }

    if (status.sessionLogPath) {
      sections.push(`Session log: ${status.sessionLogPath} (call get_session_log to read recent lines for post-mortem debugging)`);
    }

    sections.push('');
    sections.push('## Participants (in call)');
    sections.push(participantLines);

    if (members) {
      sections.push('');
      sections.push('## Bot Members');
      sections.push(members || '  (none)');
      if (uniqueAppVersions.size > 1) {
        sections.push('');
        sections.push(`Version mismatch: ${[...botAppVersions.entries()].map(([name, version]) => `${name} app ${version}`).join(', ')}`);
      }
    }

    sections.push('');
    sections.push('## Whiteboard');
    sections.push(wb.slice(0, 500));

    if (detectedUrls.length > 0 && status.callStatus === 'idle') {
      sections.push('');
      sections.push('## Detected Meet URLs');
      sections.push(detectedUrls.map(u => `  - ${u}`).join('\n'));
    }

    if (errors) {
      sections.push('');
      sections.push('## Recent Errors');
      sections.push(errors);
    }

    return { content: [{ type: "text", text: sections.join('\n') }] };
  }
);

// --- list_call_instances ---
server.tool(
  "list_call_instances",
  "List the Vibeconferencing app instances (profiles) currently running on this machine — each is a separate bot on its own local-server port. Returns profile name, port, bot name, and call status. join_call's bot_name selects the instance by PROFILE name (so `/join-call <code> alice2` drives the 'alice2' profile's app, joining under that profile's own display name). Use this to see what you can target, or when join_call reports the name is ambiguous/not found.",
  {},
  async () => {
    const instances = await discoverInstances();
    if (!instances.length) {
      return { content: [{ type: "text", text: "No running Vibeconferencing app instances found (probed the local port range). Launch the app for the profile you want to drive." }] };
    }
    const lines = instances.map((i) =>
      `• ${i.profile} — port ${i.port}${i.botName ? `, bot "${i.botName}"` : ""}${i.callStatus ? `, ${i.callStatus}` : ""}${i.roomId ? `, room ${i.roomId}` : ""}${i.baseUrl === BASE_URL ? "  ← current target" : ""}`);
    return { content: [{ type: "text", text: `Running instances (${instances.length}):\n${lines.join("\n")}\n\njoin_call(bot_name) selects one by profile name.` }] };
  }
);

// --- join_call ---
server.tool(
  "join_call",
  "Tell the Vibeconferencing app to join a call — a Google Meet OR a Slack huddle. Use this when the app is running but idle. For Meet, pass the meet code OR the full Meet URL (either is accepted); the app navigates and joins. For Slack, pass the huddle URL (app.slack.com/client/<team>/<channel>); the app switches to the Slack provider and auto-joins the huddle.",
  {
    room_id: z.string().describe("Meet code (e.g. abc-defg-hij), a full Meet URL (https://meet.google.com/abc-defg-hij, query string and all), OR a Slack huddle URL (https://app.slack.com/client/<team>/<channel>)."),
    bot_name: z.string().optional().describe("Which PROFILE to drive, when several app instances are running (see list_call_instances) — the profile keeps its own display name, so `/join-call <code> alice2` joins as whatever alice2 is named. If the name matches no profile and only one instance is running, it is used as a one-off Meet display name instead. Omit to use the sole running instance, or the one this session is pinned to, under its configured name — don't pass a literal default like 'Unnamed bot', that overrides the user's preference."),
    force: z.boolean().optional().describe("Rebuild the session even if the bot is already in this call. Default false, which makes a repeat join a harmless no-op. Only pass true when the live session is genuinely wedged and you mean to drop and rejoin — it tears down the working call. It also skips the same-name collision check."),
  },
  async ({ room_id, bot_name, force }) => {
    try {
      // Multi-profile routing (#301): the name selects which running app instance
      // to drive. Re-bind this session's BASE_URL to it BEFORE resolving the bot
      // name (so resolveBotName queries the right instance) and the join.
      const routed = await routeToInstance(bot_name);
      if (routed.error) return { content: [{ type: "text", text: routed.error }] };
      const routedNote = routed.instance
        ? ` (profile "${routed.instance.profile}" on port ${routed.instance.port})`
        : "";
      const joinedBotName = await displayNameForJoin(bot_name, routed);
      // If the lock is set but the bot name changed, check whether the
      // previous call is actually still in progress. The local-server is
      // the source of truth — handles every call-end path (explicit
      // leave_call, host-ended, network drop, app restart) without
      // requiring a push channel.
      if (botNameLocked && joinedBotName !== BOT_NAME) {
        try {
          const statusResp = await vfetch(`${BASE_URL}/api/sync/${ROOM_ID || 'no-room'}`);
          const statusData = await statusResp.json();
          const cs = statusData?.status?.callStatus;
          if (cs && cs !== 'in-call') botNameLocked = false;
        } catch { /* if we can't reach the local-server, fall through to lock-enforcement */ }
      }
      if (botNameLocked && joinedBotName !== BOT_NAME) {
        return {
          content: [{
            type: "text",
            text: `Bot identity is locked to "${BOT_NAME}" while the current call is active. Leave the call first (the lock clears automatically once the call ends) or restart the agent.`,
          }],
        };
      }

      // Slack huddle? room_id is an app.slack.com/client/<team>/<channel> URL —
      // route to the Slack provider path instead of Meet navigation (#302). The
      // app's room id becomes slack-<team>-<channel> (lowercased), which we mirror
      // so subsequent tool calls (wait_for_speech etc.) target the right room.
      const slackMatch = String(room_id).match(/app\.slack\.com\/client\/([^/]+)\/([^/?#]+)/i);
      if (slackMatch) {
        const slackRoomId = `slack-${slackMatch[1].toLowerCase()}-${slackMatch[2].toLowerCase()}`;
        const sresp = await vfetch(`${BASE_URL}/api/sync/${slackRoomId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(botSyncPayload(joinedBotName, { meta: { action: "join-slack", url: room_id } })),
        });
        const sdata = await sresp.json();
        if (sdata.results?.join?.ok) {
          ROOM_ID = slackRoomId;
          BOT_NAME = joinedBotName;
          botNameLocked = true;
          lastPollTime = null;
          return {
            content: [{
              type: "text",
              text: [
                `Joining the Slack huddle as "${joinedBotName}"${routedNote}. The app is switching to the Slack provider and auto-joining the huddle.`,
                ``,
                `**Joining is not complete until you have started the conversation loop.** Use \`${slackRoomId}\` as room_id for all tool calls.`,
                ``,
                `1. Once in the huddle, \`speak\` a brief one-sentence greeting so participants hear you're on the line.`,
                `2. Then loop: \`wait_for_speech\` → optionally \`speak\` / \`send_chat\` → \`wait_for_speech\` — repeat until asked to leave or the call ends.`,
                `**Do not send a final response to the user while the call is active** — if you stop, the bot sits silent; the local server only responds to your calls.`,
                ``,
                `When the call ends or the user asks you to leave, call \`leave_call\`.`,
              ].join('\n'),
            }],
          };
        }
        return { content: [{ type: "text", text: `Couldn't join the Slack huddle: ${sdata.results?.join?.error || sdata.error || 'unknown error'}.` }] };
      }

      // Meet: accept a pasted URL, not just the bare code (#314).
      //
      // The URL→code extraction has always existed, but only in the /join-call
      // skill — so it covered Claude Code and nothing else. The raw tool is the
      // front door for every other integrator (Codex, Cursor, hand-rolled
      // clients), and a URL is what people actually have in their clipboard.
      // Reassigning room_id here keeps the whole rest of the join (and the room
      // id echoed back to the agent) on the canonical code.
      const parsedRoom = parseMeetRoomId(room_id);
      if (!parsedRoom.ok) return { content: [{ type: "text", text: parsedRoom.error }] };
      room_id = parsedRoom.roomId;

      const resp = await vfetch(`${BASE_URL}/api/sync/${room_id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(botSyncPayload(joinedBotName, {
          meta: { action: "join", meetCode: room_id, botName: joinedBotName, ...(force ? { force: true } : {}) },
        })),
      });
      const data = await resp.json();
      if (data.results?.join?.ok) {
        ROOM_ID = room_id;
        BOT_NAME = data.results.join.botName || joinedBotName;
        botNameLocked = true;
        lastPollTime = null;

        // Already there: the app deliberately did nothing rather than tear the
        // live session down (#26). Say so plainly — an agent that reads this as
        // a fresh join would greet the room a second time.
        if (data.results.join.alreadyInCall) {
          const st = (data.results.join.status === 'joining' || data.results.join.status === 'navigating')
            ? 'still joining' : 'already in';
          return { content: [{ type: "text", text: [
            `The bot is ${st} call ${room_id} as "${BOT_NAME}"${routedNote} — nothing to do, and nothing was disturbed.`,
            ``,
            `Do NOT greet again if you already have. Go straight back to the loop: \`wait_for_speech\` → optionally \`speak\` / \`update_whiteboard\` / \`read_chat\` → \`wait_for_speech\`.`,
            ``,
            `If you genuinely believe the session is wedged, pass force:true to rebuild it — that WILL drop and rejoin the call.`,
          ].join('\n') }] };
        }

        return {
          content: [{
            type: "text",
            text: [
              `Joining Meet call ${room_id} as "${joinedBotName}"${routedNote}. The app is navigating to the call and will admit itself shortly.`,
              ``,
              `**Joining is not complete until you have started the conversation loop.**`,
              ``,
              `1. Once admitted (the bot can speak), call \`speak\` with a brief greeting so participants hear that you're on the line — e.g. "Hi, I'm ${joinedBotName}. I've joined the call and I'm listening." Keep it to one sentence.`,
              `2. Then start the loop: \`wait_for_speech\` → optionally \`speak\` / \`update_whiteboard\` / \`read_chat\` / \`send_chat\` → \`wait_for_speech\` — repeat until the user asks you to leave or the tool reports the call has ended.`,
              `3. If speech starts before the greeting plays, yield to the speaker — respond to the new turn instead of repeating the greeting.`,
              ``,
              `**Do not send a final response to the user while the call is active.** If you stop here, the bot sits silently in the call — the local server only responds to your calls, it cannot drive you. The troubleshooting panel surfaces "time since last wait_for_speech" so the user can see whether the loop is active.`,
              ``,
              `When the call ends (\`wait_for_speech\` returns the auto-left message, or the user asks you to leave), call \`leave_call\` to disconnect cleanly. Bot name "${joinedBotName}" is locked for this call.`,
            ].join('\n'),
          }],
        };
      }
      return { content: [{ type: "text", text: `Error: ${data.error || "Failed to join"}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);

// Exit when the parent (Claude Code) goes away — otherwise these node
// processes pile up as orphans across sessions. The host talks to us over
// stdio, so a closed/ended stdin pipe (parent exited) is our signal to quit.
// Also handle the transport closing and the usual termination signals.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exit(0);
}
transport.onclose = shutdown;
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGHUP', shutdown);
