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
const BOT_NAME = process.env.VIBECONF_BOT_NAME || "Jimmy";
const BASE_URL = process.env.VIBECONF_BASE_URL || "http://127.0.0.1:7865";

let lastPollTime = null;

const server = new McpServer({
  name: "vibeconferencing",
  version: "0.1.0",
});

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

    // Deduplicate: consecutive entries from same speaker → keep longest
    const deduped = [];
    for (const entry of entries) {
      const last = deduped[deduped.length - 1];
      if (last && last.participantName === entry.participantName) {
        if (entry.text.length >= last.text.length) {
          deduped[deduped.length - 1] = entry;
        }
      } else {
        deduped.push(entry);
      }
    }

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
    silence_seconds: z.number().optional().describe("How many seconds of silence to wait before considering speech 'done'. Default: 2"),
    timeout_seconds: z.number().optional().describe("Maximum seconds to wait before returning even if nobody speaks. Default: 55"),
  },
  async ({ room_id, silence_seconds, timeout_seconds }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) {
      return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    }

    const silenceSec = silence_seconds || 2;
    const waitSec = Math.min(55, timeout_seconds || 55);

    // Get baseline timestamp if we don't have one
    if (!lastPollTime) {
      const baseline = await fetch(`${BASE_URL}/api/sync/${roomId}`);
      const baseData = await baseline.json();
      lastPollTime = baseData.asOf;
    }

    // Single server-side long-poll request
    const url = `${BASE_URL}/api/sync/${roomId}?since=${lastPollTime}&wait=${waitSec}&silence=${silenceSec}&bot=${encodeURIComponent(BOT_NAME)}`;
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

    if (entries.length === 0) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      return { content: [{ type: "text", text: `(No one spoke. Timed out after ${elapsed} seconds.)${statusLine}${errorLines}${chatLine}` }] };
    }

    // Deduplicate: consecutive entries from same speaker → keep longest
    const deduped = [];
    for (const entry of entries) {
      const last = deduped[deduped.length - 1];
      if (last && last.participantName === entry.participantName) {
        if (entry.text.length >= last.text.length) {
          deduped[deduped.length - 1] = entry;
        }
      } else {
        deduped.push(entry);
      }
    }

    const transcriptText = deduped
      .map((e) => `[${e.participantName}]: ${e.text}`)
      .join("\n");

    const elapsed = data.elapsed || Math.round((Date.now() - startTime) / 1000);

    return {
      content: [{
        type: "text",
        text: `Speech detected (${deduped.length} speaker turn(s), ${elapsed}s elapsed):\n\n${transcriptText}${chatLine}${continuationLine}`,
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
      body: JSON.stringify({
        sender: BOT_NAME,
        role: "bot",
        ownerName: BOT_NAME,
        transcript: [{ text, ...(voice ? { voice } : {}), ...(emoji ? { emoji } : {}) }],
      }),
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

// --- list_voices ---
server.tool(
  "list_voices",
  "List available text-to-speech voices. If ElevenLabs API key is configured, shows ElevenLabs voices. Otherwise shows macOS system voices.",
  {},
  async () => {
    const config = readConfig();

    if (isElevenLabsActive()) {
      // Fetch ElevenLabs voices
      try {
        const resp = await fetch('https://api.elevenlabs.io/v1/voices', {
          headers: { 'xi-api-key': config.ttsApiKey },
        });
        if (!resp.ok) throw new Error(`API error ${resp.status}`);
        const data = await resp.json();

        const voices = data.voices.map(v =>
          `${v.name} — ${v.labels?.accent || ''} ${v.labels?.gender || ''} ${v.labels?.age || ''}`.trim() + ` [id: ${v.voice_id}]`
        );

        const currentVoice = config.ttsVoiceId || 'CwhRBWXzGAHq8TQ4Fs17';
        const currentName = data.voices.find(v => v.voice_id === currentVoice)?.name || currentVoice;

        return {
          content: [{
            type: "text",
            text: `Provider: ElevenLabs\nCurrent voice: ${currentName}\n\nAvailable voices:\n${voices.join('\n')}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error fetching ElevenLabs voices: ${err.message}` }] };
      }
    } else {
      // macOS say voices
      try {
        const output = execSync('say -v "?"', { encoding: 'utf-8', timeout: 5000 });
        const voices = output
          .split('\n')
          .filter(line => line.includes('en_'))
          .map(line => {
            const match = line.match(/^(.+?)\s{2,}(\w{2}_\w{2})/);
            if (match) return `${match[1].trim()} (${match[2]})`;
            return line.trim();
          })
          .filter(Boolean);

        const currentVoice = config.macosVoice || 'Samantha';

        return {
          content: [{
            type: "text",
            text: `Provider: macOS say\nCurrent voice: ${currentVoice}\n\nAvailable English voices:\n${voices.join('\n')}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error listing voices: ${err.message}` }] };
      }
    }
  }
);

// --- set_voice ---
server.tool(
  "set_voice",
  "Change the bot's text-to-speech voice. Use list_voices to see available options. The choice is saved and persists across sessions.",
  {
    voice: z.string().describe("Voice name (e.g. 'Samantha', 'Daniel') for macOS, or voice name/ID for ElevenLabs"),
  },
  async ({ voice }) => {
    try {
      const config = readConfig();

      if (isElevenLabsActive()) {
        // Look up ElevenLabs voice by name or ID
        const resp = await fetch('https://api.elevenlabs.io/v1/voices', {
          headers: { 'xi-api-key': config.ttsApiKey },
        });
        if (!resp.ok) throw new Error(`API error ${resp.status}`);
        const data = await resp.json();

        const match = data.voices.find(v =>
          v.name.toLowerCase() === voice.toLowerCase() || v.voice_id === voice
        );
        if (!match) {
          return { content: [{ type: "text", text: `Voice "${voice}" not found. Use list_voices to see available options.` }] };
        }

        config.ttsVoiceId = match.voice_id;
        writeConfig(config);
        return { content: [{ type: "text", text: `Voice changed to "${match.name}". Use the voice parameter in speak for immediate effect, or restart the app for the saved default to take effect.` }] };
      } else {
        // macOS say voice
        const output = execSync('say -v "?"', { encoding: 'utf-8', timeout: 5000 });
        const voiceExists = output.split('\n').some(line => line.trim().startsWith(voice));
        if (!voiceExists) {
          return { content: [{ type: "text", text: `Voice "${voice}" not found. Use list_voices to see available options.` }] };
        }

        config.macosVoice = voice;
        writeConfig(config);
        return { content: [{ type: "text", text: `Voice changed to "${voice}". Use the voice parameter in speak for immediate effect, or restart the app for the saved default to take effect.` }] };
      }
    } catch (err) {
      return { content: [{ type: "text", text: `Error setting voice: ${err.message}` }] };
    }
  }
);

// --- update_whiteboard ---
server.tool(
  "update_whiteboard",
  "Update the shared whiteboard/screen in the Google Meet call. Supports markdown and Mermaid diagrams. Can also load an arbitrary URL (e.g. a website, localhost app, dashboard) instead of markdown content.",
  {
    content: z.string().optional().describe("Markdown content for the whiteboard. Supports headings, lists, code blocks, and Mermaid diagrams."),
    url: z.string().optional().describe("Load an arbitrary URL in the whiteboard window instead of markdown content. Useful for showing websites, localhost apps, or dashboards."),
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ content, url, room_id }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) {
      return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    }

    if (!content && !url) {
      return { content: [{ type: "text", text: "Error: Either 'content' or 'url' must be provided." }] };
    }

    // Load arbitrary URL mode
    if (url) {
      const resp = await fetch(`${BASE_URL}/api/sync/${roomId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sender: BOT_NAME,
          role: "bot",
          ownerName: BOT_NAME,
          meta: { action: "load-url", url },
        }),
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
      body: JSON.stringify({
        sender: BOT_NAME,
        role: "bot",
        ownerName: BOT_NAME,
        whiteboard: { content },
      }),
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
      body: JSON.stringify({
        sender: BOT_NAME,
        role: "bot",
        ownerName: BOT_NAME,
        meta: { action: "leave" },
      }),
    });

    const data = await resp.json();
    if (data.success) {
      return { content: [{ type: "text", text: "Left the call successfully." }] };
    } else {
      return { content: [{ type: "text", text: `Error: ${data.error || "Failed to leave"}` }] };
    }
  }
);

// --- share_whiteboard ---
server.tool(
  "share_whiteboard",
  "Start screen sharing in the Google Meet call. By default shares the whiteboard window (use update_whiteboard to set content). Can also share the entire screen.",
  {
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
    share_type: z.enum(["whiteboard", "screen"]).optional().describe("What to share. 'whiteboard' (default) shares the whiteboard window. 'screen' shares the entire screen."),
  },
  async ({ room_id, share_type }) => {
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
      body: JSON.stringify({
        sender: BOT_NAME,
        role: "bot",
        ownerName: BOT_NAME,
        meta: { action: "share-whiteboard", shareType },
      }),
    });

    const data = await resp.json();
    if (data.success) {
      // Wait for screen share to complete (or fail) before responding
      // Timeline: 2s whiteboard load + 3s error detection + margin
      await new Promise(resolve => setTimeout(resolve, 7000));

      // Check for errors that occurred during THIS share attempt (filter by
      // timestamp — earlier-call errors like "ended unexpectedly" must not
      // bleed into this attempt's diagnostic).
      const statusResp = await fetch(`${BASE_URL}/api/sync/${roomId}`);
      const statusData = await statusResp.json();

      // Ground truth wins: status.sharing reflects Meet's own "You are
      // presenting" label. If we ARE presenting, it succeeded — even if a
      // transient "Can't share your screen" fired on a first attempt that then
      // recovered. Don't report failure over stale/transient errors when the
      // share is actually live.
      if (statusData.status?.sharing === true) {
        return { content: [{ type: "text", text: "Whiteboard is now being shared in the call. Use update_whiteboard to change its content." }] };
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
);

// --- stop_sharing ---
server.tool(
  "stop_sharing",
  "Stop screen sharing the whiteboard in the Google Meet call.",
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
      body: JSON.stringify({
        sender: BOT_NAME,
        role: "bot",
        ownerName: BOT_NAME,
        meta: { action: "stop-sharing" },
      }),
    });

    const data = await resp.json();
    if (data.success) {
      return { content: [{ type: "text", text: "Stopped sharing the whiteboard." }] };
    } else {
      return { content: [{ type: "text", text: `Error: ${data.error || "Failed to stop sharing"}` }] };
    }
  }
);

// --- scroll_share ---
server.tool(
  "scroll_share",
  "Scroll the content currently being shared in the whiteboard window — useful when you've loaded a website (via update_whiteboard with a url) and want to move down a long page. Scrolls smoothly. Direction: 'down'/'up' move ~one screenful, 'top'/'bottom' jump to the ends. Only affects a shared URL/website, not markdown whiteboard content.",
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
      body: JSON.stringify({
        sender: BOT_NAME,
        role: "bot",
        ownerName: BOT_NAME,
        meta: { action: "scroll-share", direction, amount },
      }),
    });
    const data = await resp.json();
    const r = data.results?.scrollShare;
    if (r?.ok) {
      return { content: [{ type: "text", text: `Scrolled ${direction || 'down'}.` }] };
    }
    return { content: [{ type: "text", text: `Error: ${r?.error || data.error || "Failed to scroll"}` }] };
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
      body: JSON.stringify({
        sender: BOT_NAME,
        role: "bot",
        ownerName: BOT_NAME,
        meta: { action: "set-mode", mode },
      }),
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
      body: JSON.stringify({
        sender: BOT_NAME,
        role: "bot",
        ownerName: BOT_NAME,
        meta: { action: "set-camera", on },
      }),
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
  "Override the avatar's resting emojis to match the conversation's tone. 'idle' shows between turns; 'listening' shows while actively listening (in active mode). Pass either or both. Pass an empty string for either to revert to the default for that state. The agent should adjust these as the conversation tone shifts — e.g. 😔 idle for a somber topic, 🤔 listening for technical discussion, 😄 listening for friendly chat. Persists for the rest of the call.",
  {
    idle: z.string().optional().describe("Emoji to show between turns (replaces default 😔). Pass '' to reset."),
    listening: z.string().optional().describe("Emoji to show while listening in active mode (replaces default 🙂). Pass '' to reset."),
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ idle, listening, room_id }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) {
      return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    }
    const payload = {};
    if (idle !== undefined) payload.idle = idle;
    if (listening !== undefined) payload.listening = listening;
    if (Object.keys(payload).length === 0) {
      return { content: [{ type: "text", text: "No emoji values provided. Pass 'idle' and/or 'listening'." }] };
    }
    const resp = await fetch(`${BASE_URL}/api/sync/${roomId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: BOT_NAME,
        role: "bot",
        ownerName: BOT_NAME,
        meta: { action: "set-avatar-emoji", ...payload },
      }),
    });
    const data = await resp.json();
    const result = data.results?.setAvatarEmoji;
    if (result?.ok) {
      const parts = [];
      if (idle !== undefined) parts.push(`idle=${idle ? `'${idle}'` : 'default'}`);
      if (listening !== undefined) parts.push(`listening=${listening ? `'${listening}'` : 'default'}`);
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
        if (urls.length > 0) {
          return { content: [{ type: "text", text: `Not in a call. Detected Google Meet URLs:\n${urls.map(u => `  - ${u}`).join('\n')}\n\nUse the meet code from one of these URLs as room_id to join.` }] };
        }
        return { content: [{ type: "text", text: "Not in a call. No Google Meet URLs detected in browser tabs." }] };
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

    // Build participant list with speaking indicators
    const participantLines = participants.length > 0
      ? participants.map(p => `  - ${p.name}${p.speaking ? ' (speaking)' : ''}`).join('\n')
      : '  (none detected)';

    // Members from sync API (includes bots)
    const members = (data.members || []).map((m) => `  - ${m.name} (${m.role})`).join("\n");

    const wb = data.whiteboard?.content || "(empty)";
    const errors = (status.errors || []).map(e => `  - ${e.message} (${e.timestamp})`).join("\n");

    const sections = [];
    if (noteMismatch) sections.push(noteMismatch, '');
    sections.push(
      `Room: ${roomId}`,
      `Call status: ${status.callStatus || 'unknown'}`,
      `Mode: ${status.mode || 'active'} (active=responds freely, passive=only when named, silent=listens but never speaks)`,
      `Screen sharing: ${status.sharing ? 'yes (by bot)' : 'no'}`,
    );

    if (status.whiteboardUrl) {
      sections.push(`Whiteboard URL (just the board, no room UI): ${status.whiteboardUrl} (share this in chat so participants can view the whiteboard)`);
    }
    if (status.roomUrl) {
      sections.push(`Full room URL (whole room UI): ${status.roomUrl}`);
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

    sections.push('');
    sections.push('## Participants (in call)');
    sections.push(participantLines);

    if (members) {
      sections.push('');
      sections.push('## Bot Members');
      sections.push(members || '  (none)');
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
    bot_name: z.string().optional().describe("Bot display name. Default: Jimmy"),
  },
  async ({ room_id, bot_name }) => {
    try {
      const resp = await fetch(`${BASE_URL}/api/sync/${room_id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sender: bot_name || BOT_NAME,
          role: "bot",
          meta: { action: "join", meetCode: room_id, botName: bot_name || BOT_NAME },
        }),
      });
      const data = await resp.json();
      if (data.results?.join?.ok) {
        ROOM_ID = room_id;
        return { content: [{ type: "text", text: `Joining Meet call: ${room_id}. The app will navigate to the call and join. Use wait_for_speech to start listening.` }] };
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
