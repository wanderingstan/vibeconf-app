// agent-spawn.test.mjs — running the agent as our own child (#242).
//
// The Terminal launcher stays the default. This is the path where the app owns
// the process, which is what makes the activity stream first-hand instead of
// scraped from a file Claude Code may or may not write (it stopped writing them
// for app-launched agents on 2026-08-04, and the brain pane went dark with no
// error anywhere).
//
// Run: node --test tests/agent-spawn.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { buildAgentArgs, headlessBlockedReason } = require('../electron-app/agent-spawn.js');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

const args = (over = {}) => buildAgentArgs({
  meetCode: 'abc-defg-hij', botName: 'Jimmy', dangerous: true, model: 'opus', ...over,
});

test('stream-json is requested WITH --verbose', () => {
  // Not stylistic: the CLI hard-rejects the combination without it —
  // "When using --print, --output-format=stream-json requires --verbose".
  // Verified against the installed CLI rather than assumed. Without it the
  // agent exits immediately and the bot sits mute in the call.
  const a = args();
  assert.ok(a.includes('--output-format') && a[a.indexOf('--output-format') + 1] === 'stream-json');
  assert.ok(a.includes('--verbose'), 'stream-json without --verbose is a startup error');
});

test('the prompt is one argv element, however the bot is named', () => {
  // The reason for spawning over shelling out. Through AppleScript this string
  // crossed two escaping layers, so the Terminal path has to strip quotes out of
  // the bot name and hope. Here nothing can split it.
  const a = args({ botName: 'Bob "The Bot" O\'Neill; rm -rf /' });
  const prompt = a[a.indexOf('-p') + 1];
  assert.equal(prompt, '/join-call abc-defg-hij Bob "The Bot" O\'Neill; rm -rf /');
  assert.equal(a.filter((x) => x.includes('rm -rf')).length, 1, 'exactly one element carries it');
});

test('headless is refused without dangerous mode, with a reason', () => {
  // A permission prompt has no terminal to draw in, so the agent stops on its
  // first tool call and waits forever — presenting as a bot that joined and then
  // never spoke. Silent stalls are the failure mode this whole issue is about,
  // so this must be a refusal up front, not a discovery mid-call.
  assert.equal(headlessBlockedReason({ dangerous: true }), null);
  const why = headlessBlockedReason({ dangerous: false });
  assert.ok(why, 'must refuse');
  assert.match(why, /Dangerous Mode|Terminal/, 'and say what to do about it');
});

test('a refusal falls back to the Terminal launcher rather than joining mute', () => {
  const fn = main.slice(main.indexOf('if (store.get(\'agentHosting\') === \'headless\')'));
  const body = fn.slice(0, 900);
  assert.match(body, /if \(launched\) return;/, 'only skip the Terminal path on success');
  assert.match(body, /falling back to the Terminal launcher/);
});

test('the model and MCP pin survive the transport change', () => {
  // A headless agent that ignores --mcp-config would drive the PRIMARY app's bot
  // rather than this profile's — the exact bug --strict-mcp-config exists to stop.
  const a = args({ mcpConfigPath: '/Users/x/Application Support/cfg.json' });
  assert.equal(a[a.indexOf('--mcp-config') + 1], '/Users/x/Application Support/cfg.json',
    'the UNESCAPED path — argv needs no quoting, and the escaped form would not resolve');
  assert.ok(a.includes('--strict-mcp-config'));
  assert.equal(a[a.indexOf('--model') + 1], 'opus');
  assert.ok(!args().includes('--mcp-config'), 'the default instance stays on the global config');
});

test('dangerous mode is passed through, not merely checked', () => {
  assert.ok(args().includes('--dangerously-skip-permissions'));
  assert.ok(!args({ dangerous: false }).includes('--dangerously-skip-permissions'));
});

test('the stream becomes the activity source before the agent starts', () => {
  // Ordering matters twice: the first event needs somewhere to land, and binding
  // early is what makes the agent's OWN PostToolUse hook a no-op instead of a
  // rebind that clears the feed one tool call in.
  const fn = main.slice(main.indexOf('function launchClaudeHeadless'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(body.indexOf('useStreamAgentSource()') < body.indexOf('spawnHeadlessAgent('),
    'bind the source, then spawn');
});

test('a spawn failure cannot take the app down', () => {
  // ENOENT is the likely one: a GUI Electron app inherits launchd PATH, not the
  // user\'s. An unhandled child 'error' event is a hard crash of the whole app.
  const spawn = readFileSync(join(root, 'electron-app/agent-spawn.js'), 'utf8');
  assert.match(spawn, /child\.on\('error'/);
  // And the resolved absolute path is used, so ENOENT should not happen at all.
  assert.match(main, /if \(det\.path\) claudeBin = det\.path/);
  assert.match(main, /claudePath: claudeBin/);
});

test('a dead agent says so instead of leaving a stale feed', () => {
  // The pane renders a buffer. A buffer that stops updating looks exactly like a
  // quiet call — which is how a broken feed went unnoticed for three days.
  const fn = main.slice(main.indexOf('function launchClaudeHeadless'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /onExit:/);
  assert.match(body, /agent exited with code/);
  assert.match(body, /agent failed to launch/);
});

test('leaving the call ends the agent', () => {
  // An orphaned headless agent is worse than an orphaned Terminal window: it has
  // no window to notice, and it keeps acting on the bot through MCP.
  const fn = main.slice(main.indexOf('function closeClaudeTerminal'));
  assert.match(fn.slice(0, 500), /headlessAgentChild/);
  assert.match(fn.slice(0, 500), /kill\('SIGTERM'\)/);
  assert.match(fn.slice(0, 500), /headlessAgentChild = null/);
});

test('stderr is logged, never parsed as activity', () => {
  // It carries auth errors and stack traces. Fed to the parser those would
  // render as things the bot said.
  const spawn = readFileSync(join(root, 'electron-app/agent-spawn.js'), 'utf8');
  const block = spawn.slice(spawn.indexOf("child.stderr.on('data'"));
  assert.doesNotMatch(block.slice(0, 300), /source\.push/);
  assert.match(spawn, /child\.stdout\.on\('data', \(chunk\) => source\.push\(chunk\)\)/);
});

test('stdin is closed immediately — an open pipe costs 3s per launch', () => {
  // Measured, not theorised: under -p the CLI treats stdin as more prompt text
  // and waits 3s for it before proceeding. Held open for a future write path,
  // that would have been three seconds added to every join — and it would not
  // even have bought the write path, since this stdin is prompt input rather
  // than a message channel (that needs --input-format stream-json).
  const spawn = readFileSync(join(root, 'electron-app/agent-spawn.js'), 'utf8');
  assert.match(spawn, /child\.stdin\.end\(\)/);
  assert.ok(spawn.indexOf('child.stdin.end()') < spawn.indexOf("child.stdout.on('data'"),
    'close it before anything can await it');
});

test('the preference ships off, and says why it is experimental', () => {
  const { PREFERENCES } = require('../electron-app/preferences-schema.js');
  const p = PREFERENCES.agentHosting;
  assert.equal(p.default, 'terminal', 'the proven path stays the default');
  assert.deepEqual(p.enum, ['terminal', 'headless']);
  assert.match(p.description, /Dangerous Mode/, 'the hard requirement must be discoverable');
});
