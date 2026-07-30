// agent-mcp-config.test.mjs — an app-spawned agent keeps the tools it already had.
//
// The bug: a named profile launches Claude with --strict-mcp-config, which makes
// the generated config the ONLY source of MCP servers. That is what pins the
// session to THIS app's port — without it the user-scoped vibeconferencing entry
// carries a fallback port aimed at the primary app, and the agent drives the
// wrong bot.
//
// But the file was built from scratch, so strict mode also stripped every other
// server the user had. An agent spawned for a named profile could reach its bot
// and nothing else — no image generation, no search, no issue tracker. Same
// machine, same user, mysteriously fewer tools, and no error to explain it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

// The block that builds the pinned config.
const spawn = main.slice(main.indexOf('async function launchClaudeTerminal'));
const block = spawn.slice(spawn.indexOf('const inherited = {}'), spawn.indexOf('const cfgPath = path.join'));

test('the pinned config starts from the user\'s own servers', () => {
  assert.match(block, /\.claude\.json/, 'must read the user config');
  assert.match(block, /Object\.assign\(inherited, userCfg\.mcpServers \|\| \{\}\)/);
  assert.match(block, /\.\.\.inherited,/, 'inherited servers must land in the generated config');
});

test('only USER scope is inherited, never project scope', () => {
  // Project-scoped servers are tied to a directory the bot isn't working in.
  // Inheriting one scoped to the user's home into a bot session would be
  // surprising, and on a shared machine, wrong.
  assert.ok(!/userCfg\.projects/.test(block), 'must not pull project-scoped servers');
});

test('the vibeconferencing pin always wins', () => {
  // The entire reason this file exists. If an inherited entry of the same name
  // could override it, the agent would drive whichever app the user-scoped
  // fallback port happens to point at.
  const spread = block.indexOf('...inherited,');
  const pin = block.indexOf('vibeconferencing: {');
  assert.ok(spread > 0 && pin > spread, 'the pinned entry must come after the spread');
});

test('a bot can be given servers the others do not have', () => {
  // Without this there is no per-bot extension point at all: .mcp.json in the
  // workdir is a source --strict ignores, so it would sit there inert.
  assert.match(block, /\.mcp\.json/);
  assert.match(block, /Object\.assign\(inherited, botMcp\.mcpServers \|\| \{\}\)/);
  // Read from the dir the session actually starts in, which honours a
  // claudeWorkDir override rather than assuming the default agent dir.
  assert.match(block, /path\.join\(claudeDir, '\.mcp\.json'\)/);
});

test('an unreadable user config does not break the launch', () => {
  // The pin is what matters; losing the inherited extras is a degradation, not
  // a failure, and must not stop the bot getting an agent.
  const tries = block.match(/try \{/g) || [];
  assert.ok(tries.length >= 2, 'both reads must be individually guarded');
  assert.match(block, /catch \{ \/\* no user config/);
});

test('the launch log says what the agent actually got', () => {
  // Silent tool loss is the whole failure mode here — if it happens again, the
  // log should show it rather than leaving someone to notice a missing tool.
  assert.match(spawn.slice(0, 12000), /Object\.keys\(cfg\.mcpServers\)\.length, 'MCP server\(s\):'/);
});

test('--strict-mcp-config is still passed', () => {
  // Dropping it would "fix" the missing tools by letting the user-scoped
  // vibeconferencing entry load too — pointing the agent at the wrong app.
  assert.match(spawn.slice(0, 9000), /mcpFlags = ` --mcp-config .* --strict-mcp-config`/);
});

test('the default profile is left alone', () => {
  // It uses the global config and never had this problem; the pin exists only
  // to disambiguate NAMED profiles from the primary app.
  assert.match(spawn.slice(0, 9000), /if \(!isDefaultInstance\)/);
});
