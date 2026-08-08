// agent-workdir.js — the per-profile working directory a launched Claude session
// starts in (#305). Pure helpers; the filesystem + ~/.claude.json writes live in
// main.js's ensureAgentWorkdir().
//
// The bug this fixes: Join Call launches `claude` in /tmp, which Claude Code does
// NOT treat as a trusted workspace — so it drops the bot's permissions.allow
// allowlist ("Ignoring N permissions.allow entries: this workspace has not been
// trusted") and can prompt mid-call, even with --dangerously-skip-permissions.
//
// The fix: give each profile its own dir, mark it trusted in ~/.claude.json (the
// same file the app already edits to install the MCP server), and cd there. That
// dir also becomes the bot's canonical HOME — where its CLAUDE.md personality
// (#291) will live and, later, what the hosted model (#347) serves per profile.

const path = require('path');

// The agent working dir for a profile, given that profile's Electron userData dir.
// For the default profile userData IS the base app dir; for a named profile it's
// …/profiles/<name>. So each bot gets its own …/<userData>/agent.
function agentDirFor(userDataDir) {
  return path.join(String(userDataDir || ''), 'agent');
}

// The bot's pre-approved tool allowlist, written to <agentDir>/.claude/settings.local.json.
// Honored only because the dir is marked trusted (below). The MCP wildcard covers
// the whole vibeconferencing server; if a Claude Code version doesn't expand the
// wildcard it's simply ignored (no worse than today), and dangerousMode bypasses
// prompts regardless. Kept minimal on purpose — this is the trust/plumbing fix,
// not a policy statement.
function defaultBotSettings() {
  return {
    permissions: {
      allow: [
        'mcp__vibeconferencing__*',
        // After-call work writes into this directory — call notes, summaries,
        // receipts. By then the call is over and nobody is watching the
        // terminal, so a permission prompt would hang the wrap-up silently
        // rather than ask anyone. Bounded by the workspace: this dir IS the
        // session's cwd, and writes outside it still prompt.
        'Write',
        'Edit',
        'Read',
      ],
    },
  };
}

// Return a COPY of claudeJson with `projects[dir].hasTrustDialogAccepted = true`,
// preserving every other project entry and top-level key. Non-destructive: if the
// project already has other fields (history, etc.) they're kept; only the trust
// flag is set. This is exactly how a manually-accepted trust dialog records
// itself, so Claude Code honors the workspace without a prompt.
function withTrustedProject(claudeJson, dir) {
  const base = (claudeJson && typeof claudeJson === 'object') ? claudeJson : {};
  const projects = { ...(base.projects || {}) };
  projects[dir] = { ...(projects[dir] || {}), hasTrustDialogAccepted: true };
  return { ...base, projects };
}

// True iff the given dir is already recorded as a trusted project — lets the
// caller skip a redundant write to ~/.claude.json.
function isProjectTrusted(claudeJson, dir) {
  return !!(claudeJson && claudeJson.projects && claudeJson.projects[dir]
    && claudeJson.projects[dir].hasTrustDialogAccepted);
}

// The per-profile view of a config object: everything EXCEPT the app-level keys
// (which live authoritatively in the shared base config.json — see
// config-scope.js). Used when migrating a bot's config into <agentDir>/config.json
// so that file is a CLEAN "this is the bot" definition — voice, name, avatar,
// model, ack phrases — with no machine-wide auth/plumbing keys mixed in. Pure;
// does not mutate the input.
function perProfileSubset(config, appLevelKeys) {
  const src = (config && typeof config === 'object') ? config : {};
  const skip = appLevelKeys instanceof Set ? appLevelKeys : new Set(appLevelKeys || []);
  const out = {};
  for (const k of Object.keys(src)) if (!skip.has(k)) out[k] = src[k];
  return out;
}

// The starter CLAUDE.md seeded into the bot's agent dir (#305/#291). Because the
// launched session cd's into that dir, Claude Code auto-loads this file as the
// bot's standing instructions at the start of EVERY call — so it's the bot's
// personality/directives home. Seeded only if absent (never clobbers user edits);
// fully user-editable afterward.
//
// Deliberately NAME-NEUTRAL: the bot's name is dynamic (the Bot Name setting, and
// whatever name the call itself shows), so baking a name in here would be a second
// source of truth that drifts the moment the name changes. This file is about HOW
// the bot behaves, not WHO it is by name.
function defaultClaudeMd() {
  return `# Bot personality

You are an AI participant in live voice/video calls (Vibe Conferencing). This file
is your personality and standing instructions — everything here loads at the start
of every call you join. Edit it to change how you show up in the room.

(Your name isn't set here: it comes from the app's Bot Name setting and the call
itself, so renaming the bot never means editing this file.)

## Who you are
- Warm, concise, and genuinely helpful — a peer in the room, not a servant.
- Keep spoken replies short; offer to go deeper rather than monologue.

## How you participate
- Answer the question that was actually asked; don't pad.
- Use the whiteboard for anything visual — diagrams, code, structured notes.
- When you're unsure, say so briefly rather than guessing confidently.

## After the call
When a call ends you may get an AFTER-CALL WORK phase: you are still running, and
the call's transcript, whiteboard and room info are all still readable even
though you have left the meeting. This section is what you do with that time.

### Where call artifacts go

**One folder per call: \`calls/<call-id>/\`, relative to this directory.**

\`get_room_info\` prints the call id — use it verbatim. It is the room code plus
the call's start time (e.g. \`abc-defg-hij-20260801T143000Z\`), NOT the bare room
code: the same room hosts many calls, so the room code alone would make every
call overwrite the last one.

This is the standard place for everything a call produces — the summary below
today, and transcripts and recordings as those arrive. When call recording is
on, this is where \`call-recording-tracks/\` (one audio file per
participant, plus the bot's own \`video.webm\` and, if a whiteboard share
happened, \`share.webm\`) and the merged \`call-recording.mp4\` / \`call-recording-share.mp4\` land.
One folder per call keeps a call's artifacts together and makes it obvious
what to delete.

By default: **write a short summary of the call.**

1. \`get_room_info\` for the call id, then \`read_transcripts\` for what was said.
2. Write \`calls/<call-id>/summary.md\` — a few lines of what the call was about,
   any decisions, and anything someone asked you to remember or follow up. Skip
   the blow-by-blow; write what you would want to read in a month.
3. Call \`end_session\`. Do it as soon as you are done — the app holds the room
   and your terminal open until you do.

If the call produced nothing worth keeping (a test, a two-line hello), write
nothing and call \`end_session\` straight away. An empty note is worse than none.

Never \`speak\` or \`send_chat\` in this phase — you have left the meeting, so
nobody would hear or see it.

Change any of this. Summaries into a different shape, a receipt posted somewhere,
tickets filed, nothing at all — this is the bot's own file, and after-call work is
whatever you write here.

## Make it yours
Add anything that should shape this bot: topics it cares about, tone, domain
knowledge, the people it works with, things it should never do.
`;
}

module.exports = {
  agentDirFor, defaultBotSettings, withTrustedProject, isProjectTrusted, perProfileSubset,
  defaultClaudeMd,
};
