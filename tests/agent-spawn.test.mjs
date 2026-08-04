// agent-spawn.test.mjs — running the agent as our own child (#242).
//
// The Terminal launcher stays the default. This is the path where the app owns
// the process, which is what makes the activity stream first-hand instead of
// scraped from a file Claude Code may or may not write. "May or may not" is the
// operative part: an earlier note here claimed transcripts had stopped entirely
// for app-launched agents, and that was too strong — a headless agent wrote a
// 92-line transcript on 2026-08-04. Intermittent is worse to build on than
// absent, because it looks fine right up until the brain pane goes dark with no
// error anywhere.
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

test('the preference is reachable from App Settings', () => {
  // It was per-profile for one commit, and therefore invisible: App Settings
  // renders app-level schema prefs ONLY (get-app-settings-schema filters on
  // isAppLevel), so the toggle worked via set_preference and could not be found
  // by anyone actually using the app. Caught by someone looking for it.
  const { isAppLevel } = require('../electron-app/config-scope.js');
  assert.ok(isAppLevel('agentHosting'), 'app-level, or it renders nowhere');
  assert.ok(isAppLevel('agentBackend'), 'it qualifies this one — they must share a scope');
  const { PREFERENCES } = require('../electron-app/preferences-schema.js');
  assert.notEqual(PREFERENCES.agentHosting.hiddenInSettingsUI, true);
  assert.ok(PREFERENCES.agentHosting.label, 'without a label the UI shows the raw key');
});

test('the agent does not inherit a parent Claude session identity', () => {
  // These leak whenever the app is started from inside a Claude Code session —
  // every `pnpm dev` run, and never for a user opening the app from the Dock. So
  // the resulting misbehaviour appears in development ONLY, which is how it gets
  // misdiagnosed as a product bug.
  //
  // Observed directly: launched with the marker inherited, the CLI prints
  // "⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker".
  // The app process was confirmed carrying it, and it was being passed straight
  // through to the agent.
  const { cleanAgentEnv } = require('../electron-app/agent-spawn.js');
  const dirty = {
    PATH: '/usr/bin', HOME: '/Users/x',
    CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'abc',
    CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: '123', CLAUDE_EFFORT: 'high',
    CLAUDE_CODE_BRIDGE_SESSION_ID: 'z', CLAUDE_CODE_EXECPATH: '/x',
    VIBECONF_LOCAL_PORT: '7865',
  };
  const clean = cleanAgentEnv(dirty);
  for (const k of Object.keys(dirty)) {
    if (k.startsWith('CLAUDE')) assert.ok(!(k in clean), `${k} must not reach the agent`);
  }
  assert.equal(clean.PATH, '/usr/bin', 'and the rest of the environment survives');
  assert.equal(clean.VIBECONF_LOCAL_PORT, '7865', 'including our own routing');
  assert.ok(!('CLAUDECODE' in clean));
});

test('sanitising is a denylist, not a CLAUDE_* wildcard', () => {
  // CLAUDE_CONFIG_DIR and friends are legitimate user configuration. A wildcard
  // would break exactly the customised installs most likely to rely on them.
  const { cleanAgentEnv } = require('../electron-app/agent-spawn.js');
  const clean = cleanAgentEnv({ CLAUDE_CONFIG_DIR: '/custom', CLAUDE_CODE_SESSION_ID: 'x' });
  assert.equal(clean.CLAUDE_CONFIG_DIR, '/custom', 'user config must survive');
  assert.ok(!('CLAUDE_CODE_SESSION_ID' in clean));
});

test('the spawn actually uses the sanitised environment', () => {
  // Easy to define the helper and forget to call it.
  const spawn = readFileSync(join(root, 'electron-app/agent-spawn.js'), 'utf8');
  assert.match(spawn, /env: cleanAgentEnv\(env\)/);
});

test('the headless option warns that it needs Dangerous Mode', () => {
  // Picking headless without Dangerous Mode silently does nothing: the app
  // refuses and falls back to a Terminal. Without a visible marker in the option
  // itself, the setting looks like it took effect when it did not — and the only
  // evidence is a line in a log the user never reads.
  const { PREFERENCES } = require('../electron-app/preferences-schema.js');
  const label = PREFERENCES.agentHosting.enumLabels.headless;
  assert.match(label, /⚠️/, 'the hazard belongs in the option, not only the description');
  assert.match(label, /Dangerous Mode/i, 'and it must name what is missing');
});

test('headless does NOT silently enable Dangerous Mode', () => {
  // The tempting "fix" for the above is to turn it on automatically. That would
  // be the app granting itself machine-wide --dangerously-skip-permissions
  // because someone changed a hosting preference — a trust decision the user
  // never made. Refusing and falling back is the correct behaviour.
  const spawn = readFileSync(join(root, 'electron-app/agent-spawn.js'), 'utf8');
  assert.doesNotMatch(spawn, /set\(['"]dangerousMode['"]/);
  assert.doesNotMatch(main, /store\.set\('dangerousMode'/);
});
