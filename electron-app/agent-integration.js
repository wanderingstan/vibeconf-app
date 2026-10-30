// agent-integration.js: the machine-wide agent setup (#301).
//
// What every Claude Code session on this machine gets from Vibeconferencing:
// the user-scoped MCP registration in ~/.claude.json, the skills in
// ~/.claude/skills (/join-call, /call, /call-new-bot, /onboarding-call,
// /emoji-set) and the agent-activity hook. It is the app's, not any one bot's,
// so the app window writes it (supervisor-app.js) as the single writer; a bot
// writes it only when it runs in its own window as the default bot (classic
// mode, development), which was the election before the app window existed.
//
// Moved out of main.js unchanged except where it read the default bot's
// process: ensureClaudeIntegration now takes { defaultPort, botName }.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { DEFAULT_PORT_BASE, layoutFromEnv, portLayout, portBaseEnv } = require('./port-layout.js');

// How Claude Code should launch our stdio MCP server.
//
// It used to be the bare string 'node', which silently requires the user to
// have Node on PATH. macOS ships none, and Claude Code's own native installer
// (~/.local/share/claude/...) doesn't bring one — so a non-developer who does
// everything right gets `spawn node ENOENT` and a bot that never appears.
// This never showed up in our own testing because every machine we test on has
// Homebrew node, and that's machine-wide: a fresh macOS *account* still sees it.
//
// Electron already contains a Node runtime, so use ours. ELECTRON_RUN_AS_NODE
// makes the app binary behave exactly like `node <script>`. It costs nothing
// (already on disk), pins a known-good version, and adds no new fragility —
// args[0] already points inside the app bundle, so the config was always tied
// to the app's existence.
function mcpNodeLauncher() {
  return {
    command: process.execPath,
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

function bundledMcpServerRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'mcp-server')
    : path.join(__dirname, '..', 'mcp-server');
}

function bundledMcpServerPath() {
  return path.join(bundledMcpServerRoot(), 'server.js');
}

function mcpServerDepsPresent(mcpServerRoot = bundledMcpServerRoot()) {
  return app.isPackaged || (
    fs.existsSync(path.join(mcpServerRoot, 'node_modules', '@modelcontextprotocol', 'sdk')) &&
    fs.existsSync(path.join(mcpServerRoot, 'node_modules', 'zod')));
}

function runningFromGitWorktree() {
  if (app.isPackaged) return false;
  try { return fs.statSync(path.join(__dirname, '..', '.git')).isFile(); } catch { return false; }
}

// Agent-activity hook: a tiny PostToolUse hook, scoped to mcp__vibeconferencing__*
// tools, that reports the DRIVING session's transcript path to this app's local
// server. Scoping to our own MCP tools means only the session actually driving a
// bot reports (no cross-session noise), and it works for BOTH launch paths
// (app-spawned OR an existing session that ran /join-call). The app tails that
// transcript onto the debug overlay (gated by the debugOverlay toggle).
//
// It also warns in-terminal when a bot joins a call on Fable (#responsiveness
// audit: Fable averages ~17s stop→audio vs ~8s for Sonnet/Opus, almost entirely
// think time) — via the join_call tool call itself, so it fires exactly once
// per join, for whoever's actually watching that terminal.
//
// A SECOND hook — Notification, not tool-scoped — rides the same script and
// reports permission prompts / idle nudges to /api/agent-notification, so the
// brain panel can show "waiting on you" instead of the silence an unhandled
// prompt produces today (see agent-spawn.js's headlessBlockedReason comment
// on why that silence is "the single worst failure shape in this app").
const AGENT_HOOK_CONTENT = `#!/usr/bin/env node
// Auto-installed by Vibeconferencing — reports the Claude session's transcript
// path to the local bot server for the debug-overlay agent-activity tail,
// forwards Notification events (permission prompts, idle nudges), and warns
// (once per join_call) when the joining model is Fable.
// Never blocks or breaks the agent: swallows all errors, exits 0 fast.
const http = require('http');
const fs = require('fs');
// process.exit() can truncate a stdout write to a pipe that hasn't flushed yet
// — a real Node gotcha, not hypothetical. Every exit path funnels through
// done(), which waits on this if maybeWarnSlowModel started a write.
let pendingWrite = null;
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let d = {};
  try { d = JSON.parse(raw); } catch (e) {}
  maybeWarnSlowModel(d);
  const port = process.env.VIBECONF_LOCAL_PORT || '7865';
  // #201 made the control API require a bearer token, and this hook was not
  // updated — so every POST here 401'd from Aug 1 and the agent session was
  // never bound. Nothing surfaced it: the hook swallows all errors by design,
  // and a hook that silently stops working looks exactly like a hook that has
  // nothing to report. The visible symptom was the avatar never reaching
  // 🧑‍💻 working (#339), because that state is driven entirely by this feed.
  //
  // Same 0600 file the MCP server reads, keyed by port.
  let token = '';
  try {
    token = fs.readFileSync(
      require('path').join(require('os').homedir(), '.vibeconferencing', 'local-tokens', port + '.token'),
      'utf8').trim();
  } catch (e) { /* no token file — server may be running with auth off */ }

  if (d.hook_event_name === 'Notification') {
    const body = JSON.stringify({ sessionId: d.session_id, message: d.message });
    return postJson('/api/agent-notification', body, port, token);
  }
  const transcriptPath = d.transcript_path;
  if (!transcriptPath) return done();
  const body = JSON.stringify({ sessionId: d.session_id, transcriptPath });
  postJson('/api/agent-session', body, port, token);
});

function postJson(urlPath, body, port, token) {
  const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
  if (token) headers.authorization = 'Bearer ' + token;
  const req = http.request({
    host: '127.0.0.1', port, path: urlPath, method: 'POST',
    headers,
    timeout: 500,
  }, (res) => { res.resume(); res.on('end', done); });
  req.on('error', done);
  req.on('timeout', () => { req.destroy(); done(); });
  req.write(body); req.end();
}

// A PostToolUse hook's stdout JSON can carry a systemMessage shown to the user
// in-terminal (not fed to the model, and non-blocking — the tool already ran).
// Only checked on join_call itself, so this fires once per join, not once per
// tool call.
function maybeWarnSlowModel(d) {
  try {
    if (d.tool_name !== 'mcp__vibeconferencing__join_call') return;
    const model = lastRealModel(d.transcript_path);
    if (model && model.toLowerCase().includes('fable')) {
      pendingWrite = new Promise((resolve) => {
        process.stdout.write(JSON.stringify({
          systemMessage: '⚠️ Joining on ' + model + ' — response latency tends to run much higher than Sonnet/Opus (~17s vs ~8s avg in our audits), almost entirely model think time. Switch with /model if responsiveness matters here.',
        }), resolve);
      });
    }
  } catch (e) { /* never let a warning attempt block the join */ }
}

// The model on the most recent real (non-<synthetic>) assistant turn, read
// from the tail of the transcript. The turn that IS this join_call call is
// always the last one at this point, so a small tail read is enough.
function lastRealModel(transcriptPath) {
  if (!transcriptPath) return null;
  const size = fs.statSync(transcriptPath).size;
  const tailBytes = Math.min(size, 65536);
  const fd = fs.openSync(transcriptPath, 'r');
  const buf = Buffer.alloc(tailBytes);
  fs.readSync(fd, buf, 0, tailBytes, size - tailBytes);
  fs.closeSync(fd);
  const lines = buf.toString('utf-8').split('\\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let entry; try { entry = JSON.parse(lines[i]); } catch (e) { continue; }
    const model = entry && entry.type === 'assistant' && entry.message && entry.message.model;
    if (model && model !== '<synthetic>') return model;
  }
  return null;
}

function done() {
  if (pendingWrite) { pendingWrite.then(() => process.exit(0)); return; }
  process.exit(0);
}
setTimeout(done, 1500); // never hang the agent
`;

// The hook as installed for a given default bot port. The literal above names
// 7865, and with the port base unset this returns it unchanged (byte for byte,
// so an existing install is not rewritten). A second macOS user who moved the
// block (port-layout.js) gets their own default baked in instead: the hook file
// lives in THEIR ~/.claude, and a session that never set VIBECONF_LOCAL_PORT
// (a bare-terminal /join-call) must report to their bot, not the primary
// user's.
const HOOK_DEFAULT_PORT_LINE = "process.env.VIBECONF_LOCAL_PORT || '7865';";
function agentHookContent(defaultPort = portLayout().defaultBot) {
  if (String(defaultPort) === '7865') return AGENT_HOOK_CONTENT;
  return AGENT_HOOK_CONTENT.replace(HOOK_DEFAULT_PORT_LINE, `process.env.VIBECONF_LOCAL_PORT || '${Number(defaultPort)}';`);
}

// The skills' shell snippets name the supervisor (7864) and the default bot
// (7865) by number, for an agent to curl. Moved with the block for a user whose
// port base is not the default; untouched (returned as is) otherwise.
function localizeSkillPorts(content, layout = layoutFromEnv()) {
  if (layout.base === DEFAULT_PORT_BASE) return content;
  return content
    .replace(/\b7864\b/g, String(layout.supervisor))
    .replace(/\b7865\b/g, String(layout.defaultBot));
}

// What a skill's .version file records. Just SKILL_VERSION for the default
// block, so nothing reinstalls for anyone who never sets a base; with a moved
// block the base is part of it, so switching base reinstalls once (with the
// new ports) and then settles.
function skillVersionStamp(version, layout = layoutFromEnv()) {
  return layout.base === DEFAULT_PORT_BASE ? version : `${version}@${layout.base}`;
}

// The user-scoped ~/.claude.json entry for our MCP server. Pure, so the shape
// (and the needsUpdate comparison against it) can be tested without disk.
//
// VIBECONF_BASE_URL is the default bot's port for this user's block (7865
// unless moved), the stable fallback, deliberately NOT the writing instance's
// own port. VIBECONF_PORT_BASE is carried only when the block is moved, so a
// default install's entry is exactly what it always was, and the server's scan
// range and supervisor port follow the move.
function buildClaudeMcpEntry({ launcher, mcpServerPath, botName, defaultPort, portBase = DEFAULT_PORT_BASE }) {
  return {
    command: launcher.command,
    args: [mcpServerPath],
    env: {
      ...launcher.env,
      VIBECONF_ROOM_ID: '',
      VIBECONF_BOT_NAME: botName,
      VIBECONF_BASE_URL: `http://127.0.0.1:${defaultPort}`,
      ...portBaseEnv(portBase),
    },
  };
}

// Whether `current` (what ~/.claude.json holds) differs from `desired` in any
// way we own. Compares the same fields it always did, plus VIBECONF_PORT_BASE,
// where absent and absent are equal: a default install never flaps, and a
// switch of base (to, from, or between moved blocks) rewrites exactly once.
function claudeMcpEntryNeedsUpdate(current, desired) {
  return !current ||
    current.command !== desired.command ||
    current.env?.VIBECONF_BASE_URL !== desired.env.VIBECONF_BASE_URL ||
    current.env?.VIBECONF_BOT_NAME !== desired.env.VIBECONF_BOT_NAME ||
    (current.env?.VIBECONF_PORT_BASE || undefined) !== desired.env.VIBECONF_PORT_BASE ||
    current.args?.[0] !== desired.args[0];
}

function ensureAgentActivityHook({ defaultPort = layoutFromEnv().defaultBot } = {}) {
  const home = process.env.HOME || process.env.USERPROFILE;
  const claudeDir = path.join(home, '.claude');
  const hookPath = path.join(claudeDir, 'vibeconf-agent-hook.cjs');
  const settingsPath = path.join(claudeDir, 'settings.json');
  try {
    fs.mkdirSync(claudeDir, { recursive: true });
    // Write the hook file only when its content differs (avoid needless churn).
    let existing = '';
    try { existing = fs.readFileSync(hookPath, 'utf-8'); } catch { /* missing */ }
    const hookContent = agentHookContent(defaultPort);
    if (existing !== hookContent) fs.writeFileSync(hookPath, hookContent);

    // No port baked into the command: the hook reads VIBECONF_LOCAL_PORT from
    // its inherited env (app-spawned sessions set it to THEIR bot's port — see
    // launchClaudeTerminal) and falls back to 7865 (the primary app; or this
    // user's own default bot when the port base moved it) for an existing
    // session that ran /join-call. This is why the same global hook
    // works for every bot — the port comes from the session, not the command.
    const desiredCmd = `node "${hookPath}"`;
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { /* none yet */ }
    if (!settings.hooks) settings.hooks = {};
    // Is our entry already present with the right command? (idempotent)
    const isOurs = (e) => (e.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes('vibeconf-agent-hook'));

    // Checked independently (not one early-return after the first match) so an
    // existing install missing just the newer Notification hook still gets it
    // added on the next launch, instead of the PostToolUse match short-circuiting
    // before Notification is ever looked at.
    let changed = false;

    if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = [];
    const toolCurrent = settings.hooks.PostToolUse.find(isOurs);
    if (!toolCurrent || toolCurrent.matcher !== 'mcp__vibeconferencing__.*' || toolCurrent.hooks?.[0]?.command !== desiredCmd) {
      settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter((e) => !isOurs(e));
      settings.hooks.PostToolUse.push({
        matcher: 'mcp__vibeconferencing__.*',
        hooks: [{ type: 'command', command: desiredCmd }],
      });
      changed = true;
    }

    // Notification — permission prompts / idle nudges, so the brain panel can
    // show a session as waiting-on-you instead of just quiet. No matcher: this
    // fires per-notification, not per-tool, and every notification is worth
    // forwarding — the server (not this hook) decides what to do with it.
    if (!Array.isArray(settings.hooks.Notification)) settings.hooks.Notification = [];
    const notifCurrent = settings.hooks.Notification.find(isOurs);
    if (!notifCurrent || notifCurrent.hooks?.[0]?.command !== desiredCmd) {
      settings.hooks.Notification = settings.hooks.Notification.filter((e) => !isOurs(e));
      settings.hooks.Notification.push({
        hooks: [{ type: 'command', command: desiredCmd }],
      });
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      console.log(`[electron] Installed agent-activity PostToolUse + Notification hooks (port from session env, default ${defaultPort})`);
    }
  } catch (err) {
    console.warn('[electron] Failed to install agent-activity hook:', err.message);
  }
}

function ensureClaudeIntegration({ defaultPort, botName } = {}) {
  const home = process.env.HOME || process.env.USERPROFILE;
  const claudeDir = path.join(home, '.claude');
  const claudeJsonPath = path.join(home, '.claude.json');
  const skillDir = path.join(claudeDir, 'skills', 'join-call');
  const skillPath = path.join(skillDir, 'SKILL.md');

  // Determine paths based on whether we're packaged or in dev
  const isPackaged = app.isPackaged;
  const mcpServerRoot = bundledMcpServerRoot();
  const mcpServerPath = bundledMcpServerPath();
  const appLaunchCmd = isPackaged
    ? 'open -a Vibeconferencing'
    : `cd ${__dirname} && npx electron .`;

  // ~/.claude.json is durable config; only point it at a server that can
  // actually start. Packaged builds get prod deps via beforePack; a fresh
  // source checkout has none until someone installs them in mcp-server/.
  const serverEntryExists = fs.existsSync(mcpServerPath);
  // The server needs BOTH the MCP SDK and zod to boot — check both, not just the SDK.
  const serverDepsPresent = mcpServerDepsPresent(mcpServerRoot);

  // A linked git worktree (`.git` is a file, not a dir) is a removable
  // checkout — repointing durable config at one strands the entry when the
  // worktree goes away.
  const isTempWorktree = runningFromGitWorktree();

  let changed = false;

  // --- Ensure global MCP config in ~/.claude.json ---
  // Read defensively: a missing file is fine (we create it), but a present-but-
  // unreadable/malformed file must NOT be rewritten from {} — that would erase
  // every other MCP server the user has. See claude-config.js.
  const { readClaudeConfigSafe, atomicWriteJson } = require('./claude-config.js');
  const { config: claudeJson, readable: configReadable, mtimeMs: claudeMtimeMs } = readClaudeConfigSafe(claudeJsonPath);
  if (!configReadable) {
    console.warn('[electron] ~/.claude.json exists but is unreadable/malformed —',
      'leaving MCP config untouched to avoid clobbering other servers');
  }

  if (!claudeJson.mcpServers) claudeJson.mcpServers = {};

  // Always pin the global config at the stable fallback port, NOT the writing
  // instance's own port — this entry is app-level and must point bare-terminal
  // `claude` at a fixed target regardless of who installs it. (On join_call the
  // MCP server re-binds by profile name anyway; this is just the default target.)
  // `defaultPort` is already this user's block's default bot (port-layout.js).
  const localBaseUrl = `http://127.0.0.1:${defaultPort}`;
  const configuredBotName = botName;
  const currentMcp = claudeJson.mcpServers.vibeconferencing;
  const nodeLauncher = mcpNodeLauncher();
  const desiredMcp = buildClaudeMcpEntry({
    launcher: nodeLauncher, mcpServerPath, botName: configuredBotName, defaultPort, portBase: layoutFromEnv().base,
  });
  // `command` is compared too, so installs written by an older build (which
  // hardcoded 'node') get repaired on next launch instead of staying broken for
  // exactly the users who can't diagnose it.
  const needsUpdate = claudeMcpEntryNeedsUpdate(currentMcp, desiredMcp);
  const existingServerOk = !!currentMcp?.args?.[0] && fs.existsSync(currentMcp.args[0]);

  if (!configReadable) {
    /* warned above — never rewrite an unreadable/malformed config from {} */
  } else if (!serverEntryExists) {
    console.warn('[electron] MCP server entrypoint missing at', mcpServerPath,
      '— leaving MCP config untouched');
  } else if (!serverDepsPresent) {
    console.warn('[electron] mcp-server deps not installed (no node_modules/@modelcontextprotocol/sdk).',
      'Run `npm install` (or pnpm) in', mcpServerRoot, '— leaving MCP config untouched');
  } else if (isTempWorktree && existingServerOk && currentMcp.args[0] !== mcpServerPath) {
    console.warn('[electron] running from a git worktree — keeping existing MCP server path',
      currentMcp.args[0], 'instead of repointing durable config at', mcpServerPath);
  } else if (needsUpdate) {
    claudeJson.mcpServers.vibeconferencing = desiredMcp;
    atomicWriteJson(claudeJsonPath, claudeJson, { expectedMtimeMs: claudeMtimeMs });
    console.log('[electron] Updated MCP config → local server at', localBaseUrl, 'botName:', configuredBotName);
    changed = true;
  } else {
    console.log('[electron] MCP config already pointing to local server');
  }

  // --- Ensure global skill in ~/.claude/skills/join-call/ ---
  // Version-tracked: updates when app version changes
  const SKILL_VERSION = '72';  // Bump this when updating the skill content below
  // What each .version file holds: SKILL_VERSION, plus the port base when the
  // block is moved (skillVersionStamp), because the installed text carries the
  // ports (localizeSkillPorts).
  const skillStamp = skillVersionStamp(SKILL_VERSION);
  const versionFile = path.join(skillDir, '.version');
  let installedVersion = '';
  try { installedVersion = fs.readFileSync(versionFile, 'utf-8').trim(); } catch {}

  const skillSourcePath = path.join(mcpServerRoot, 'join-call-skill.md');
  if (installedVersion !== skillStamp && !fs.existsSync(skillSourcePath)) {
    console.warn('[electron] join-call skill source missing at', skillSourcePath, '— skipping skill install');
  } else if (installedVersion !== skillStamp) {
    fs.mkdirSync(skillDir, { recursive: true });
    const skillContent = localizeSkillPorts(fs.readFileSync(skillSourcePath, 'utf-8'));
    fs.writeFileSync(skillPath, skillContent);
    fs.writeFileSync(versionFile, skillStamp);
    console.log(`[electron] Installed/updated skill v${SKILL_VERSION} at ${skillPath}`);
    changed = true;
  } else {
    console.log('[electron] Skill v%s already installed', SKILL_VERSION);
  }

  // --- Ensure global skill in ~/.claude/skills/call/ ---
  // /call starts a BRAND-NEW call (the command form of the panel's "Call <bot>
  // now"); /join-call puts the bot into one that already exists. Same version
  // gate, its own directory — Claude Code takes one skill per directory.
  try {
    const callSkillDir = path.join(claudeDir, 'skills', 'call');
    const callVersionFile = path.join(callSkillDir, '.version');
    let callInstalled = '';
    try { callInstalled = fs.readFileSync(callVersionFile, 'utf-8').trim(); } catch { /* not yet */ }
    if (callInstalled !== skillStamp) {
      fs.mkdirSync(callSkillDir, { recursive: true });
      fs.writeFileSync(path.join(callSkillDir, 'SKILL.md'), localizeSkillPorts(fs.readFileSync(
        isPackaged
          ? path.join(process.resourcesPath, 'mcp-server', 'call-skill.md')
          : path.join(__dirname, '..', 'mcp-server', 'call-skill.md'),
        'utf-8',
      )));
      fs.writeFileSync(callVersionFile, skillStamp);
      console.log(`[electron] Installed/updated /call skill v${SKILL_VERSION}`);
      changed = true;
    }
  } catch (err) {
    console.warn('[electron] /call skill install failed:', err.message);
  }

  // --- Remove the old ~/.claude/skills/realtime-call/ ---
  // /realtime-call was a stopgap: a separate command for a bot whose voice
  // belongs to the realtime model. The mode is a property of the BOT, not of
  // how you start it, so /join-call now branches on its realtimeVoice
  // preference and answers with a completely different operating prompt.
  //
  // Deleted rather than left behind. A slash command that still appears in the
  // list, still installs, and quietly does the wrong thing is worse than one
  // that is gone: it would join with the realtime prompt whatever the bot is
  // actually set to.
  try {
    const staleRtSkill = path.join(claudeDir, 'skills', 'realtime-call');
    if (fs.existsSync(staleRtSkill)) {
      fs.rmSync(staleRtSkill, { recursive: true, force: true });
      console.log('[electron] Removed the old /realtime-call skill (superseded by /join-call)');
      changed = true;
    }
  } catch (err) {
    console.warn('[electron] could not remove the old /realtime-call skill:', err.message);
  }

  // --- Ensure global skill in ~/.claude/skills/call-new-bot/ ---
  // /call-new-bot turns the CALLER's own Claude session into a bot: it creates a
  // profile seeded with that session's workdir + name, so the new bot resumes it
  // rather than starting fresh. The inverse of every other path here — normally a
  // bot gets a session; this gives a session a bot. Same version gate, own
  // directory (Claude Code takes one skill per directory).
  try {
    const newBotSkillDir = path.join(claudeDir, 'skills', 'call-new-bot');
    const newBotVersionFile = path.join(newBotSkillDir, '.version');
    let newBotInstalled = '';
    try { newBotInstalled = fs.readFileSync(newBotVersionFile, 'utf-8').trim(); } catch { /* not yet */ }
    if (newBotInstalled !== skillStamp) {
      fs.mkdirSync(newBotSkillDir, { recursive: true });
      fs.writeFileSync(path.join(newBotSkillDir, 'SKILL.md'), localizeSkillPorts(fs.readFileSync(
        isPackaged
          ? path.join(process.resourcesPath, 'mcp-server', 'call-new-bot-skill.md')
          : path.join(__dirname, '..', 'mcp-server', 'call-new-bot-skill.md'),
        'utf-8',
      )));
      fs.writeFileSync(newBotVersionFile, skillStamp);
      console.log(`[electron] Installed/updated /call-new-bot skill v${SKILL_VERSION}`);
      changed = true;
    }
  } catch (err) {
    console.warn('[electron] /call-new-bot skill install failed:', err.message);
  }

  // --- Ensure global skill in ~/.claude/skills/onboarding-call/ ---
  // /onboarding-call is /call's guided-setup sibling: same "start a brand-new
  // call" mechanics, but the agent runs a scripted walkthrough (name, voice,
  // emoji, whiteboard style, skills, after-call routine) instead of a normal
  // conversation. Triggered by the panel's "Setup" button (setupCallBtn),
  // which passes onboardingCall through createAndJoinMeet → launchClaudeTerminal
  // / launchClaudeHeadless → buildAgentArgs, picking this slash command over
  // /join-call. Same version gate as the other two, own directory.
  try {
    const onboardingSkillDir = path.join(claudeDir, 'skills', 'onboarding-call');
    const onboardingVersionFile = path.join(onboardingSkillDir, '.version');
    let onboardingInstalled = '';
    try { onboardingInstalled = fs.readFileSync(onboardingVersionFile, 'utf-8').trim(); } catch { /* not yet */ }
    if (onboardingInstalled !== skillStamp) {
      fs.mkdirSync(onboardingSkillDir, { recursive: true });
      fs.writeFileSync(path.join(onboardingSkillDir, 'SKILL.md'), localizeSkillPorts(fs.readFileSync(
        isPackaged
          ? path.join(process.resourcesPath, 'mcp-server', 'onboarding-call-skill.md')
          : path.join(__dirname, '..', 'mcp-server', 'onboarding-call-skill.md'),
        'utf-8',
      )));
      fs.writeFileSync(onboardingVersionFile, skillStamp);
      console.log(`[electron] Installed/updated /onboarding-call skill v${SKILL_VERSION}`);
      changed = true;
    }
  } catch (err) {
    console.warn('[electron] /onboarding-call skill install failed:', err.message);
  }

  // --- Ensure global skill in ~/.claude/skills/emoji-set/ ---
  // /emoji-set generates a themed avatar image set (nanobanana) plus a matching
  // call background, and points a running bot at it via the `dir:`/`file:`
  // preference forms. Same version gate as the other skills, own directory.
  try {
    const emojiSetSkillDir = path.join(claudeDir, 'skills', 'emoji-set');
    const emojiSetVersionFile = path.join(emojiSetSkillDir, '.version');
    let emojiSetInstalled = '';
    try { emojiSetInstalled = fs.readFileSync(emojiSetVersionFile, 'utf-8').trim(); } catch { /* not yet */ }
    if (emojiSetInstalled !== skillStamp) {
      fs.mkdirSync(emojiSetSkillDir, { recursive: true });
      fs.writeFileSync(path.join(emojiSetSkillDir, 'SKILL.md'), localizeSkillPorts(fs.readFileSync(
        isPackaged
          ? path.join(process.resourcesPath, 'mcp-server', 'emoji-set-skill.md')
          : path.join(__dirname, '..', 'mcp-server', 'emoji-set-skill.md'),
        'utf-8',
      )));
      fs.writeFileSync(emojiSetVersionFile, skillStamp);
      console.log(`[electron] Installed/updated /emoji-set skill v${SKILL_VERSION}`);
      changed = true;
    }
  } catch (err) {
    console.warn('[electron] /emoji-set skill install failed:', err.message);
  }

  // Agent-activity overlay hook (independent of the MCP/skill version bumps).
  // Port-agnostic: app-spawned sessions inject VIBECONF_LOCAL_PORT themselves.
  // The fallback it bakes in is this user's default bot.
  ensureAgentActivityHook({ defaultPort });

  if (changed) {
    console.log('[electron] Claude integration installed. Restart Claude Code to pick up MCP changes.');
  }

  return changed;
}

// Which Vibeconferencing MCP server a named bot hands its agent (#301).
//
// Normally its own build's, pinned to its port. But an own server that cannot
// start (its dependencies were never installed: a fresh development checkout)
// left the agent with no tools at all, and the agent only ever saw "Connection
// closed" (2026-10-19). So check first, and if ours cannot start, fall back to
// the user-scoped one (normally the installed app's), still pinned to this
// bot's port, and say so. With neither, keep ours and report that plainly.
//
// Pure: the caller passes what it found, so this can be tested without disk.
// Returns { server, warning } where warning is null when all is well.
//
// portBase rides along when the block is moved (port-layout.js), so the
// agent's server scans and asks this user's block, not the primary user's.
function chooseAgentMcpServer({ ownPath, ownOk, launcher, inherited, fallbackOk, botName, port, portBase = DEFAULT_PORT_BASE }) {
  const pin = {
    VIBECONF_ROOM_ID: '', VIBECONF_BOT_NAME: botName, VIBECONF_BASE_URL: `http://127.0.0.1:${port}`,
    ...portBaseEnv(portBase),
  };
  const own = { command: launcher.command, args: [ownPath], env: { ...launcher.env, ...pin } };
  if (ownOk) return { server: own, warning: null };
  if (inherited && fallbackOk) {
    return {
      server: { ...inherited, env: { ...(inherited.env || {}), ...pin } },
      warning: `This bot's own agent tools cannot start (its MCP server at ${ownPath} is missing its dependencies), `
        + `so its agent uses the installed app's tools instead (${(inherited.args || [])[0]}).`,
    };
  }
  return {
    server: own,
    warning: `This bot's agent has no Vibeconferencing tools: its MCP server at ${ownPath} cannot start `
      + '(missing dependencies; run npm install in mcp-server) and there is no other one registered to fall back to.',
  };
}

module.exports = {
  chooseAgentMcpServer, buildClaudeMcpEntry, claudeMcpEntryNeedsUpdate,
  agentHookContent, localizeSkillPorts, skillVersionStamp,
  mcpNodeLauncher, bundledMcpServerRoot, bundledMcpServerPath, mcpServerDepsPresent,
  runningFromGitWorktree, AGENT_HOOK_CONTENT, ensureAgentActivityHook, ensureClaudeIntegration,
};
