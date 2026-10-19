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
  const main = read('electron-app/main.js');
  const v = Number((main.match(/const SKILL_VERSION = '(\d+)'/) || [])[1]);
  assert.ok(v >= 71, `SKILL_VERSION ${v}`);
});
