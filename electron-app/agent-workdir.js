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

module.exports = { agentDirFor, defaultBotSettings, withTrustedProject, isProjectTrusted };
