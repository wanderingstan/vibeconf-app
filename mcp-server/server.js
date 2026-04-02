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
    silence_seconds: z.number().optional().describe("How many seconds of silence to wait before considering speech 'done'. Default: 5"),
    timeout_seconds: z.number().optional().describe("Maximum seconds to wait before returning even if nobody speaks. Default: 55"),
  },
  async ({ room_id, silence_seconds, timeout_seconds }) => {
    const roomId = room_id || ROOM_ID;
    if (!roomId) {
      return { content: [{ type: "text", text: "Error: No room_id provided and VIBECONF_ROOM_ID not set." }] };
    }

    const silenceSec = silence_seconds || 5;
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
    room_id: z.string().optional().describe("Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided."),
  },
  async ({ text, room_id }) => {
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
        transcript: [{ text }],
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
