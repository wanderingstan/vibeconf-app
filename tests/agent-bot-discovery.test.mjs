// agent-bot-discovery.test.mjs: agents find bots through the app, not port 7865 (#301).
//
// Bots now run on their own ports, often in the background with no window
// (the app window shows them). The /join-call skill used to decide "the app
// is not running" by curling 7865, where a background bot is not, and then
// launched the app with --meet-url, which starts the DEFAULT bot straight into
// the call. On 2026-10-18 that put a second, unwanted "bot" into a test call
// next to the one the agent belonged to. The MCP already asked the app's
// directory (askSupervisor); these pin that the skills do too.
//
// Run: node --test tests/agent-bot-discovery.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const joinCall = read('mcp-server/join-call-skill.md');
const callNewBot = read('mcp-server/call-new-bot-skill.md');
const step2 = joinCall.slice(joinCall.indexOf('## Step 2'), joinCall.indexOf('## Step 3'));

test('/join-call decides whether its bot is up by asking the MCP, not a fixed port', () => {
  assert.match(step2, /list_call_instances/);
  assert.doesNotMatch(step2, /curl -sf "\$\{VIBECONF_BASE_URL:-http:\/\/127\.0\.0\.1:7865\}/);
  assert.doesNotMatch(step2, /NOT_RUNNING/);
});

test('/join-call opens a missing bot through the app, and never launches with --meet-url', () => {
  assert.match(step2, /curl -sf -X POST "http:\/\/127\.0\.0\.1:7864\/api\/select\?profile=/);
  assert.match(step2, /^open -a Vibeconferencing$/m, 'a plain launch, when the app is not running at all');
  assert.doesNotMatch(step2, /open -a Vibeconferencing \\\s*\n\s*--meet-url/);
});

test('/call-new-bot finds a running bot through the app\'s directory first', () => {
  assert.match(callNewBot, /curl -sf -m 2 http:\/\/127\.0\.0\.1:7864\/api\/instances/);
  assert.match(callNewBot, /\/api\/adopt-session-as-bot/);
  assert.doesNotMatch(callNewBot, /127\.0\.0\.1:\$\{VIBECONF_LOCAL_PORT:-7865\}\/api\/adopt/);
});

test('the MCP asks the app\'s directory before scanning ports', () => {
  const server = read('mcp-server/server.js');
  const discover = server.slice(server.indexOf('async function discoverInstances()'));
  assert.match(discover.slice(0, 300), /const fromSupervisor = await askSupervisor\(\);\s*\n\s*if \(fromSupervisor\) return fromSupervisor;/);
});

test('the app\'s "select" with no profile means the default bot', () => {
  const sup = read('electron-app/supervisor-app.js');
  assert.match(sup, /const name = url\.searchParams\.get\('profile'\) \|\| paths\.defaultProfile;/);
});

test('the skills are reinstalled: SKILL_VERSION moved past the old wording', () => {
  const main = read('electron-app/agent-integration.js');
  const v = Number((main.match(/const SKILL_VERSION = '(\d+)'/) || [])[1]);
  assert.ok(v >= 71, `SKILL_VERSION ${v}`);
});

// ── Who installs the machine-wide agent setup ──
//
// Skills, the agent-activity hook and the user-scoped MCP registration are the
// app's, so the app window installs them as the single writer. Before it, only
// the default bot did, so new skills reached ~/.claude/skills only when that
// one bot restarted (2026-10-19: the fixed /join-call sat uninstalled because
// only named bots had been started).

test('the app window installs the agent setup on start', () => {
  const sup = read('electron-app/supervisor-app.js');
  assert.match(sup, /function installAgentIntegration\(\)/);
  assert.match(sup, /startBrowserScan\(\);\s*\n\s*installAgentIntegration\(\);/);
  assert.match(sup, /require\('\.\/agent-integration\.js'\)\.ensureClaudeIntegration\(\{ defaultPort: DEFAULT_PORT, botName \}\)/);
});

test('it honours the default bot\'s backend and a deliberate uninstall', () => {
  const sup = read('electron-app/supervisor-app.js');
  const fn = sup.slice(sup.indexOf('function installAgentIntegration()'));
  assert.match(fn.slice(0, 1500), /\(cfg\.agentBackend \|\| 'claude'\) !== 'claude'/);
  assert.match(fn.slice(0, 1500), /cfg\.claudeIntegrationRemoved === true/);
});

test('a bot hosted in the app window leaves it to the app; a classic default bot still installs', () => {
  const main = read('electron-app/main.js');
  assert.match(main, /\} else if \(HEADLESS\) \{\s*\n\s*\/\/ #301: running inside the app window/);
  assert.match(main, /ensureClaudeIntegration\(\{ defaultPort: DEFAULT_PORT, botName: resolvedBotName\(\) \}\)/);
});

test('the installer is one module, shared, not two copies', () => {
  const ai = read('electron-app/agent-integration.js');
  const main = read('electron-app/main.js');
  assert.match(ai, /function ensureClaudeIntegration\(\{ defaultPort, botName \} = \{\}\)/);
  assert.doesNotMatch(main, /const AGENT_HOOK_CONTENT = `/, 'the hook script lives in agent-integration.js only');
  assert.doesNotMatch(main, /const SKILL_VERSION = '/, 'and so does the skill version');
});
