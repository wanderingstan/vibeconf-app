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
 *   VIBECONF_BOT_NAME  - Bot's display name (default: "AI Assistant")
 *   VIBECONF_BASE_URL  - API base URL (default: https://vibeconferencing.com)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const ROOM_ID = process.env.VIBECONF_ROOM_ID || "";
const BOT_NAME = process.env.VIBECONF_BOT_NAME || "AI Assistant";
const BASE_URL = process.env.VIBECONF_BASE_URL || "https://vibeconferencing.com";

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

    const entries = (data.transcript?.entries || []).filter(
      (e) => e.participantName !== BOT_NAME
    );

    if (entries.length === 0) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      return { content: [{ type: "text", text: `(No one spoke. Timed out after ${elapsed} seconds.)` }] };
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
        text: `Speech detected (${deduped.length} speaker turn(s), ${elapsed}s elapsed):\n\n${transcriptText}`,
      }],
    };
  }
);

// --- speak ---
server.tool(
  "speak",
  "Say something in the Google Meet call. Your text will be spoken aloud via text-to-speech. Keep messages concise since they are spoken aloud.",
  {
    text: z.string().describe("What to say in the call. Will be spoken via TTS."),
    voice: z.string().optional().describe("Override TTS voice for this message (e.g. 'Daniel', 'Karen'). Uses default voice if not specified."),
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ text, voice, room_id }) => {
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
        transcript: [{ text, ...(voice ? { voice } : {}) }],
      }),
    });

    const data = await resp.json();
    if (data.success) {
      return { content: [{ type: "text", text: `Spoken: "${text}"` }] };
    } else {
      return { content: [{ type: "text", text: `Error: ${data.error || "Failed to post"}` }] };
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
  "Update the shared whiteboard/screen in the Google Meet call. Supports markdown and Mermaid diagrams. The whiteboard is visible to all participants via screen share.",
  {
    content: z.string().describe("Markdown content for the whiteboard. Supports headings, lists, code blocks, and Mermaid diagrams."),
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ content, room_id }) => {
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
  "Start screen sharing the whiteboard in the Google Meet call. Opens the whiteboard window and presents it to all participants. Use update_whiteboard to set content before or after sharing.",
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
        meta: { action: "share-whiteboard" },
      }),
    });

    const data = await resp.json();
    if (data.success) {
      return { content: [{ type: "text", text: "Whiteboard is now being shared in the call. Use update_whiteboard to change its content." }] };
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

// --- get_room_info ---
server.tool(
  "get_room_info",
  "Get the current state of the room: whiteboard content, members, and metadata.",
  {
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ room_id }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) {
      return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    }

    const resp = await fetch(`${BASE_URL}/api/sync/${roomId}`);
    const data = await resp.json();

    if (!data.success) {
      return { content: [{ type: "text", text: `Error: ${data.error || "Unknown error"}` }] };
    }

    const members = (data.members || []).map((m) => `  - ${m.name} (${m.role})`).join("\n");
    const wb = data.whiteboard?.content || "(empty)";

    const result = [
      `Room: ${roomId}`,
      ``,
      `## Members`,
      members || "  (none)",
      ``,
      `## Whiteboard`,
      wb.slice(0, 500),
    ].join("\n");

    return { content: [{ type: "text", text: result }] };
  }
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
