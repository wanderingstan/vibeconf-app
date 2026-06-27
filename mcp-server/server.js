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
 *   VIBECONF_BOT_NAME  - Bot's display name (default: "Jimmy")
 *   VIBECONF_BASE_URL  - API base URL (default: http://127.0.0.1:7865 — the Electron app's local server)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

let ROOM_ID = process.env.VIBECONF_ROOM_ID || "";
let BOT_NAME = process.env.VIBECONF_BOT_NAME || "Jimmy";
const BASE_URL = process.env.VIBECONF_BASE_URL || "http://127.0.0.1:7865";
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

function botSyncPayload(name = BOT_NAME, payload = {}) {
  return {
    sender: name,
    role: "bot",
    ownerName: name,
    versions: MCP_VERSIONS,
    ...payload,
  };
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
    const resp = await fetch(`${BASE_URL}/api/sync/no-room`);
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

const server = new McpServer({
  name: "vibeconferencing",
  version: "0.1.0",
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function getRoomStatus(roomId) {
  const resp = await fetch(`${BASE_URL}/api/sync/${roomId}`);
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
  "Read recent lines from the Electron app's session log. Use this to post-mortem mid-call weirdness — failed shares, blank whiteboards, unexpected state. Each session writes to its own file under userData/logs/; the file path is also returned in get_room_info as status.sessionLogPath so you can cite it if comparing two bots' logs. Optional 'grep' filters by case-insensitive regex (e.g. 'screen|share|present' to focus on screen-share lines).",
  {
    lines: z.number().optional().describe("How many recent log lines to return. Default 200. Max 5000."),
    grep: z.string().optional().describe("Case-insensitive regex filter applied before truncation. E.g. 'screen|share' to focus on screen-share activity."),
  },
  async ({ lines, grep }) => {
    const params = new URLSearchParams();
    if (lines) params.set('lines', String(lines));
    if (grep) params.set('grep', grep);
    const url = `${BASE_URL}/api/session-log${params.toString() ? '?' + params.toString() : ''}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!data.success) {
      return { content: [{ type: "text", text: `Error: ${data.error || "Unknown error"}` }] };
    }
    if (data.error) {
      return { content: [{ type: "text", text: `Error: ${data.error}` }] };
    }
    const header = data.filePath ? `Session log: ${data.filePath} (${data.returnedLines}/${data.totalLines} lines${data.truncated ? ', truncated' : ''})\n---\n` : '';
    return { content: [{ type: "text", text: header + (data.content || '(empty)') }] };
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
    const resp = await fetch(`${BASE_URL}/api/sync/${roomId}${sinceParam}`);
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
      const baseline = await fetch(`${BASE_URL}/api/sync/${roomId}`);
      const baseData = await baseline.json();
      lastPollTime = baseData.asOf;
    }

    // Single server-side long-poll request
    const url = `${BASE_URL}/api/sync/${roomId}?since=${lastPollTime}&wait=${waitSec}${silenceParam}&bot=${encodeURIComponent(BOT_NAME)}`;
    const startTime = Date.now();
    const resp = await fetch(url);
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
          text: "Auto-left the call: everyone else left and the bot was alone. The app has already hung up. Exiting the conversation loop. Do not retry wait_for_speech and do not call leave_call.",
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
      return { content: [{ type: "text", text: `(No one spoke. Timed out after ${elapsed} seconds.)${statusLine}${errorLines}${chatLine}${ackLine}${replayLine}${deafLine}` }] };
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
        text: `Speech detected (${deduped.length} speaker turn(s), ${elapsed}s elapsed):\n\n${transcriptText}${chatLine}${continuationLine}${ackLine}${replayLine}`,
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
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ text, voice, emoji, room_id }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) {
      return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    }

    const resp = await fetch(`${BASE_URL}/api/sync/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botSyncPayload(BOT_NAME, {
        transcript: [{ text, ...(voice ? { voice } : {}), ...(emoji ? { emoji } : {}) }],
      })),
    });

    const data = await resp.json();
    const tx = data.results?.transcript;
    if (tx?.reason === 'mode-silent') {
      return { content: [{ type: "text", text: "Speech suppressed (silent mode)." }] };
    }
    if (tx?.reason === 'user-speaking') {
      return { content: [{ type: "text", text: "Speech dropped — the user started speaking before your response could play. Call wait_for_speech to hear what they said and respond to their new message instead of repeating this one." }] };
    }
    if (data.success && tx?.ok !== false) {
      return { content: [{ type: "text", text: `Spoken: "${text}"` }] };
    } else {
      return { content: [{ type: "text", text: `Error: ${data.error || tx?.reason || "Failed to post"}` }] };
    }
  }
);

// --- Helper: read app config ---
function getConfigPath() {
  return join(homedir(), 'Library', 'Application Support', 'Vibeconferencing', 'config.json');
}

function readConfig() {
  try { return JSON.parse(readFileSync(getConfigPath(), 'utf-8')); } catch { return {}; }
}

function writeConfig(config) {
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

function isElevenLabsActive() {
  const config = readConfig();
  return !!config.ttsApiKey;
}

// Parse `say -v '?'` into [{ name, locale, sample, tier }], quality first
// (Premium > Enhanced > plain), English first, then name. Robust to the
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

// --- list_voices ---
server.tool(
  "list_voices",
  "List available text-to-speech voices — both ElevenLabs (if an API key is configured) and the built-in macOS voices. To use a built-in voice call set_voice with its EXACT name (e.g. 'Ava (Premium)'). The Premium/Enhanced macOS voices are far higher quality than the plain ones — prefer those.",
  {},
  async () => {
    const config = readConfig();
    const sections = [];

    // Current voice, derived from the active provider.
    const usingMac = config.ttsProvider === 'macos-say' || !isElevenLabsActive();
    sections.push(`Current voice: ${usingMac ? `${config.macosVoice || 'Samantha'} (built-in macOS)` : 'ElevenLabs (see below)'}`);

    if (isElevenLabsActive()) {
      try {
        const resp = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': config.ttsApiKey } });
        if (!resp.ok) throw new Error(`API error ${resp.status}`);
        const data = await resp.json();
        const voices = data.voices.map(v =>
          `${v.name} — ${`${v.labels?.accent || ''} ${v.labels?.gender || ''} ${v.labels?.age || ''}`.trim()} [id: ${v.voice_id}]`
        );
        sections.push(`=== ElevenLabs voices ===\n${voices.join('\n')}`);
      } catch (err) {
        sections.push(`=== ElevenLabs voices ===\n(error fetching: ${err.message})`);
      }
    }

    // Built-in macOS voices — always shown so the bot can pick a high-quality
    // built-in voice even when an ElevenLabs key is set (e.g. to save EL quota).
    const mac = listMacosVoices();
    if (mac.length) {
      const fmt = (v) => `${v.name} (${v.locale})`;
      const premium = mac.filter(v => v.tier === 0).map(fmt);
      const enhanced = mac.filter(v => v.tier === 1).map(fmt);
      const stdEn = mac.filter(v => v.tier === 2 && v.locale.startsWith('en')).map(v => v.name);
      const lines = ['=== Built-in macOS voices ==='];
      lines.push('★ HIGH QUALITY (recommended) — Premium: ' + (premium.length ? premium.join(', ') : '(none installed)'));
      lines.push('★ HIGH QUALITY — Enhanced: ' + (enhanced.length ? enhanced.join(', ') : '(none installed)'));
      lines.push(`Standard English (lower quality): ${stdEn.join(', ')}`);
      lines.push('To use one, call set_voice with the EXACT name including any "(Premium)"/"(Enhanced)" suffix.');
      sections.push(lines.join('\n'));
    }

    return { content: [{ type: "text", text: sections.join('\n\n') }] };
  }
);

// --- set_voice ---
server.tool(
  "set_voice",
  "Change the bot's text-to-speech voice. Use list_voices to see options. Pass the EXACT voice name — a built-in macOS voice (e.g. 'Ava (Premium)') OR an ElevenLabs voice name/ID. A built-in voice is matched first and, when chosen, becomes the active voice even if an ElevenLabs key is set. Saved across sessions; use the speak `voice` parameter for immediate effect this turn.",
  {
    voice: z.string().describe("Exact voice name. Built-in macOS (e.g. 'Ava (Premium)', 'Samantha') or ElevenLabs voice name/ID."),
  },
  async ({ voice }) => {
    try {
      const config = readConfig();

      // Match a built-in macOS voice first (case-insensitive, exact) — lets the
      // bot pick a high-quality built-in voice regardless of the EL key.
      const mac = listMacosVoices();
      const macMatch = mac.find(v => v.name.toLowerCase() === voice.toLowerCase());
      if (macMatch) {
        config.macosVoice = macMatch.name;
        config.ttsProvider = 'macos-say'; // force the built-in voice as primary
        writeConfig(config);
        return { content: [{ type: "text", text: `Voice changed to the built-in macOS voice "${macMatch.name}". It's now your primary voice (ElevenLabs disabled until you switch back). Pass voice:"${macMatch.name}" to speak for immediate effect; the saved default applies on app restart.` }] };
      }

      // Else try ElevenLabs by name or ID.
      if (isElevenLabsActive()) {
        const resp = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': config.ttsApiKey } });
        if (!resp.ok) throw new Error(`API error ${resp.status}`);
        const data = await resp.json();
        const match = data.voices.find(v => v.name.toLowerCase() === voice.toLowerCase() || v.voice_id === voice);
        if (match) {
          config.ttsVoiceId = match.voice_id;
          config.ttsProvider = 'elevenlabs';
          writeConfig(config);
          return { content: [{ type: "text", text: `Voice changed to ElevenLabs "${match.name}". Pass voice:"${match.voice_id}" to speak for immediate effect; the saved default applies on app restart.` }] };
        }
      }

      return { content: [{ type: "text", text: `Voice "${voice}" not found. Call list_voices to see exact available names (built-in voices need the full name, including any "(Premium)"/"(Enhanced)" suffix).` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error setting voice: ${err.message}` }] };
    }
  }
);

// --- update_whiteboard ---
server.tool(
  "update_whiteboard",
  "Update the shared whiteboard/screen in the Google Meet call. Supports markdown and Mermaid diagrams. Can also load an arbitrary URL (e.g. a website, localhost app, dashboard) instead of markdown content. Pass image_path (absolute local file path) to show a local image — it gets registered with the app's local server and embedded as markdown.",
  {
    content: z.string().optional().describe("Markdown content for the whiteboard. Supports headings, lists, code blocks, and Mermaid diagrams."),
    url: z.string().optional().describe("Load an arbitrary URL in the whiteboard window instead of markdown content. Useful for showing websites, localhost apps, or dashboards."),
    image_path: z.string().optional().describe("Absolute local file path to an image (png/jpg/gif/webp/svg/bmp/pdf). The local server registers it and embeds it in the markdown. If 'content' is also provided, the image is appended after it."),
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ content, url, image_path, room_id }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) {
      return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    }

    if (!content && !url && !image_path) {
      return { content: [{ type: "text", text: "Error: One of 'content', 'url', or 'image_path' must be provided." }] };
    }

    // image_path: register with the local server and fold the resulting URL
    // into the markdown content (#157). url mode is unaffected — image_path
    // composes with content, not with url.
    if (image_path) {
      try {
        const regResp = await fetch(`${BASE_URL}/api/whiteboard-asset`, {
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

    // Load arbitrary URL mode
    if (url) {
      const resp = await fetch(`${BASE_URL}/api/sync/${roomId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(botSyncPayload(BOT_NAME, {
          meta: { action: "load-url", url },
        })),
      });
      const data = await resp.json();
      if (data.success) {
        return { content: [{ type: "text", text: `Whiteboard window now showing: ${url}` }] };
      } else {
        return { content: [{ type: "text", text: `Error: ${data.error || "Failed to load URL"}` }] };
      }
    }

    // Markdown content mode
    const resp = await fetch(`${BASE_URL}/api/sync/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botSyncPayload(BOT_NAME, {
        whiteboard: { content },
      })),
    });

    const data = await resp.json();
    if (data.success) {
      const version = data.results?.whiteboard?.version;
      return { content: [{ type: "text", text: `Whiteboard updated (version ${version}).` }] };
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
      const resp = await fetch(`${BASE_URL}/api/sync/${roomId}`, {
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
    "Play a built-in sound effect INTO the call (airhorn, applause, rimshot, coin, etc.) — a fun way to react. Pass the sound `name` as \"<category>/<sound>\" (e.g. \"game/coin\", \"notification/success\", \"ui/error\").",
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
      const resp = await fetch(`${BASE_URL}/api/sync/${roomId}`, {
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
      const probe = await fetch(`${BASE_URL}/api/sync/no-room`);
      const probeData = await probe.json();
      const activeStatuses = ["in-call", "joining", "waiting-to-be-admitted"];
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

    const resp = await fetch(`${BASE_URL}/api/sync/${roomId}`);
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

    const resp = await fetch(`${BASE_URL}/api/sync/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botSyncPayload(BOT_NAME, {
        meta: { action: "leave" },
      })),
    });

    const data = await resp.json();
    if (data.success) {
      botNameLocked = false;
      return { content: [{ type: "text", text: "Left the call successfully." }] };
    } else {
      return { content: [{ type: "text", text: `Error: ${data.error || "Failed to leave"}` }] };
    }
  }
);

// --- start_share (alias: share_whiteboard) ---
// "Screen share" is the Meet feature for presenting visual content; the
// whiteboard window is just the default content source (it can also load any
// URL, or you can share the whole screen). Shared schema + handler so the
// legacy share_whiteboard name keeps working for skills in the wild (#177).
const startShareSchema = {
  room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  share_type: z.enum(["whiteboard", "screen"]).optional().describe("What to share. 'whiteboard' (default) shares the bot's whiteboard window — set its content with update_whiteboard (markdown/Mermaid, an image, or any URL). 'screen' shares the entire screen."),
};
async function startShareHandler({ room_id, share_type }) {
    const roomId = room_id || ROOM_ID;
    if (!roomId) {
      return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    }

    const shareType = share_type || "whiteboard";

    // Pre-flight: confirm screen recording permission before attempting the
    // share. Without it, getDisplayMedia silently fails and the user hears
    // the bot claim it shared something that isn't actually visible.
    try {
      const preflight = await fetch(`${BASE_URL}/api/sync/${roomId}`);
      const preflightData = await preflight.json();
      const screenPerm = preflightData.status?.permissions?.screenRecording;
      if (screenPerm && screenPerm !== 'granted' && screenPerm !== 'unknown') {
        return { content: [{ type: "text", text: `Cannot share: screen recording permission is '${screenPerm}'. The user needs to grant Vibeconferencing access in System Settings > Privacy & Security > Screen Recording. Tell them this in the call (in 1 sentence) so they can fix it.` }] };
      }
    } catch (err) {
      // Non-fatal — fall through to the share attempt; the existing 7s
      // error-detection path will catch real failures.
    }

    // Stamp the attempt start so we can filter out stale errors from earlier
    // shares in the same call (e.g. an "ended unexpectedly" from a prior
    // drop must not get mis-reported as the cause of THIS attempt failing).
    const attemptStartedAt = new Date().toISOString();

    const resp = await fetch(`${BASE_URL}/api/sync/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botSyncPayload(BOT_NAME, {
        meta: { action: "share-whiteboard", shareType },
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
        const msg = shareType === 'screen'
          ? "Your screen is now being shared in the call."
          : "The whiteboard window is now being shared in the call. Use update_whiteboard to change what it shows.";
        return { content: [{ type: "text", text: msg }] };
      }

      // Not presenting — explain why, using errors from THIS attempt.
      const errors = statusData.status?.errors || [];
      const shareErrors = errors.filter(
        e => e.message.includes('Screen share') && e.timestamp >= attemptStartedAt
      );
      if (shareErrors.length > 0) {
        const latestError = shareErrors[shareErrors.length - 1];
        const screenPerm = statusData.status?.permissions?.screenRecording;
        const permActuallyDenied = screenPerm && screenPerm !== 'granted' && screenPerm !== 'unknown';
        const suffix = permActuallyDenied
          ? ` Screen recording permission is '${screenPerm}' — fix in System Settings > Privacy & Security > Screen Recording.`
          : ` Permission is OK — the Meet UI may not be in a presentable state. Tell the user the share dropped and offer to retry.`;
        return { content: [{ type: "text", text: `Screen sharing failed: ${latestError.message}.${suffix}` }] };
      }

      return { content: [{ type: "text", text: "Share request was sent but the app reports it isn't presenting yet. The Meet UI may need to be refreshed or focused. Tell the user." }] };
    } else {
      return { content: [{ type: "text", text: `Error: ${data.error || "Failed to share"}` }] };
    }
}
server.tool(
  "start_share",
  "Start screen-sharing into the Google Meet call so participants can see it. By default shares the bot's whiteboard window (set its content with update_whiteboard — markdown/Mermaid or any URL); pass share_type 'screen' to share the whole screen instead.",
  startShareSchema,
  startShareHandler
);
server.tool(
  "share_whiteboard",
  "Alias for start_share (kept for back-compat). Starts screen-sharing into the call; defaults to the bot's whiteboard window.",
  startShareSchema,
  startShareHandler
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

    const resp = await fetch(`${BASE_URL}/api/sync/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(botSyncPayload(BOT_NAME, {
        meta: { action: "stop-sharing" },
      })),
    });

    const data = await resp.json();
    if (data.success) {
      const statusData = await waitForSharingState(roomId, false, { timeoutMs: 7000, intervalMs: 300, stablePolls: 2 });
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
  "Scroll the content currently being screen-shared into the call — useful when you've loaded a long website (via update_whiteboard with a url) or posted markdown longer than the viewport and want to move down. Scrolls smoothly. Direction: 'down'/'up' move ~one screenful, 'top'/'bottom' jump to the ends. Works on whatever is in the share, URL or markdown alike.",
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
    const resp = await fetch(`${BASE_URL}/api/sync/${roomId}`, {
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

// --- inspect_dom ---
server.tool(
  "inspect_dom",
  "Inspect the live DOM of the bot's Google Meet call, or of whatever it's currently screen-sharing into the call — returns the matched elements' outerHTML. Read-only. Use it to debug what's actually on screen: locate a modal and its dismiss button, find why a share rendered blank, or check Meet's UI state. Pair with get_call_screenshot (pixels) for a fuller picture.",
  {
    selector: z.string().describe("CSS selector to query, e.g. '[role=dialog]', 'button', '.some-class'. Defaults to 'body'."),
    target: z.enum(["meet", "share"]).optional().describe("Which DOM to read. 'meet' (default) = the bot's Google Meet call page. 'share' = the window currently being screen-shared into the call — that's the whiteboard if you're sharing the whiteboard, or any URL you loaded into it via update_whiteboard."),
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
    const resp = await fetch(`${BASE_URL}/api/sync/${roomId}`, {
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

    const resp = await fetch(`${BASE_URL}/api/sync/${roomId}`, {
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

    const resp = await fetch(`${BASE_URL}/api/sync/${roomId}`, {
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
  "Capture a screenshot of the current Meet view as the bot sees it — participant tiles, names, mic icons, who's speaking, captions, shared screen content, the surrounding Google Meet chrome — and save it to a temporary file. Returns the absolute path to the PNG. Use this when you need visual context about what's happening in the call. After getting the path, read the file with your normal image-reading tool to actually look at the screenshot.",
  {
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async () => {
    const resp = await fetch(`${BASE_URL}/api/call-screenshot`, {
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

// --- read_chat ---
server.tool(
  "read_chat",
  "Read the messages in the Google Meet text chat. Returns sender (best-effort) and text for each visible message. Use this when get_room_info reports unread chat, or when someone says they posted something in the chat. Note: reading chat briefly opens the chat pane (which closes the people pane), so speaker detection pauses for ~1 second while it reads, then resumes automatically.",
  {
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async () => {
    const resp = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "read" }),
    });
    const data = await resp.json();
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
    const resp = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "send", text }),
    });
    const data = await resp.json();
    if (data?.success) {
      return { content: [{ type: "text", text: `Posted to chat: "${text}"` }] };
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
    const resp = await fetch(`${BASE_URL}/api/sync/${roomId}`, {
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
      const resp = await fetch(`${BASE_URL}/api/preferences`);
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
      const resp = await fetch(`${BASE_URL}/api/preferences`, {
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
      const resp = await fetch(`${BASE_URL}/api/working-memory`);
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
      const resp = await fetch(`${BASE_URL}/api/working-memory`, {
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
      const resp = await fetch(`${BASE_URL}/api/bank-probe`, {
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
      const resp = await fetch(`${BASE_URL}/api/sync/no-room`);
      const data = await resp.json();
      const activeStatuses = ['in-call', 'joining', 'waiting-to-be-admitted'];
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

    const resp = await fetch(`${BASE_URL}/api/sync/${roomId}`);
    const data = await resp.json();

    if (!data.success) {
      return { content: [{ type: "text", text: `Error: ${data.error || "Unknown error"}` }] };
    }

    const status = data.status || {};
    const participants = data.participants || [];
    const detectedUrls = data.detectedMeetUrls || [];

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
      `Call status: ${status.callStatus || 'unknown'}`,
      `Mode: ${status.mode || 'active'} (active=responds freely, passive=only when named, silent=listens but never speaks)`,
      status.localServerUrl ? `Local server: ${status.localServerUrl} (MCP base URL for this app instance)` : null,
      status.localProfile ? `Profile: ${status.localProfile}` : null,
      `Screen sharing: ${status.sharing ? 'yes (by bot)' : 'no'}`,
    ].filter(Boolean));

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

    const screenPerm = status.permissions?.screenRecording;
    if (screenPerm && screenPerm !== 'granted' && screenPerm !== 'unknown') {
      sections.push(`Screen recording permission: ${screenPerm} (whiteboard sharing will not work — tell user to grant access in System Settings > Privacy & Security > Screen Recording)`);
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

// --- join_call ---
server.tool(
  "join_call",
  "Tell the Vibeconferencing app to join a Google Meet call. Use this when the app is running but idle (not yet in a call). The app will navigate to the Meet URL and join.",
  {
    room_id: z.string().describe("Meet code (e.g. abc-defg-hij)"),
    bot_name: z.string().optional().describe("Bot display name in Meet. Omit to use the bot name configured for this MCP instance (set via the app's panel or VIBECONF_BOT_NAME env). Only pass this to explicitly override — don't pass a literal default like 'Jimmy', that overrides the user's preference."),
  },
  async ({ room_id, bot_name }) => {
    try {
      const joinedBotName = await resolveBotName(bot_name);
      // If the lock is set but the bot name changed, check whether the
      // previous call is actually still in progress. The local-server is
      // the source of truth — handles every call-end path (explicit
      // leave_call, host-ended, network drop, app restart) without
      // requiring a push channel.
      if (botNameLocked && joinedBotName !== BOT_NAME) {
        try {
          const statusResp = await fetch(`${BASE_URL}/api/sync/${ROOM_ID || 'no-room'}`);
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
      const resp = await fetch(`${BASE_URL}/api/sync/${room_id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(botSyncPayload(joinedBotName, {
          meta: { action: "join", meetCode: room_id, botName: joinedBotName },
        })),
      });
      const data = await resp.json();
      if (data.results?.join?.ok) {
        ROOM_ID = room_id;
        BOT_NAME = joinedBotName;
        botNameLocked = true;
        lastPollTime = null;
        return {
          content: [{
            type: "text",
            text: [
              `Joining Meet call ${room_id} as "${joinedBotName}". The app is navigating to the call and will admit itself shortly.`,
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
