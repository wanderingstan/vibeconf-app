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

## Make it yours
Add anything that should shape this bot: topics it cares about, tone, domain
knowledge, the people it works with, things it should never do.
`;
}

module.exports = {
  agentDirFor, defaultBotSettings, withTrustedProject, isProjectTrusted, perProfileSubset,
  defaultClaudeMd,
};
