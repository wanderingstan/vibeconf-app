// agent-session.test.mjs — the `--resume` flag that keeps a bot in ONE session.
//
// Without this every launch started a fresh conversation, so a bot forgot the
// last call the moment it left. The session id is remembered in a per-bot
// preference and passed back as --resume, and the id itself is captured from the
// SessionStart hook rather than from the agent's stdout — deliberately, because
// Terminal.app and tmux own that pipe and headless is the only mode where we
// could have parsed it. The hook fires in all three.
//
// Same sanitizing contract as claude-model.js, and for the same reason: on the
// macOS path this value lands inside a shell command inside an AppleScript
// string. The one difference is the failure mode — a model that sanitizes away
// falls back to a default, but a session id MUST NOT. Resuming some other
// session is worse than starting a new one.
//
// Run: node --test tests/agent-session.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { resolveSessionId, claudeResumeFlag, sessionExists } = require('../electron-app/agent-session.js');
const { buildAgentArgs, buildInteractiveAgentArgs } = require('../electron-app/agent-spawn.js');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

test('a real session id survives untouched', () => {
  const id = '0c7d62da-e284-4670-a089-1ab02ece1b15';
  assert.equal(resolveSessionId(id), id);
  assert.equal(claudeResumeFlag(id), ` --resume ${id}`);
});

test('blank means start a new session, not resume an empty one', () => {
  // The flag has to vanish entirely. `--resume ''` is not "start fresh" — it is
  // a malformed flag that takes the next argument as its value.
  for (const blank of ['', '   ', null, undefined]) {
    assert.equal(resolveSessionId(blank), '');
    assert.equal(claudeResumeFlag(blank), '');
  }
});

test('shell metacharacters are dropped, not escaped', () => {
  // Two quoting layers deep on the macOS Terminal path. Nothing that could end a
  // string or start a command may reach the command line.
  const flag = claudeResumeFlag('abc"; rm -rf ~; echo "');
  assert.ok(!/["'$`;|&<>()\s]/.test(flag.replace(' --resume ', '')),
    `unsafe characters survived: ${flag}`);
});

test('a value that sanitizes away to nothing starts fresh rather than guessing', () => {
  // The difference from resolveClaudeModel, and the whole reason this is its own
  // module. A bad model id falling back to opus is a shrug; a bad session id
  // falling back to *some other session* would hand this bot another bot's
  // memory. Empty is the only safe answer.
  assert.equal(resolveSessionId('"""'), '');
  assert.equal(claudeResumeFlag('"""'), '');
});

test('both argv builders pass --resume as its own element', () => {
  const id = '0c7d62da-e284-4670-a089-1ab02ece1b15';
  for (const build of [buildAgentArgs, buildInteractiveAgentArgs]) {
    const a = build({ meetCode: 'abc-defg-hij', botName: 'Jimmy', dangerous: true, model: 'opus', resumeSessionId: id });
    const i = a.indexOf('--resume');
    assert.ok(i >= 0, `${build.name} dropped --resume`);
    assert.equal(a[i + 1], id);
  }
});

test('no session id means no --resume in either builder', () => {
  for (const build of [buildAgentArgs, buildInteractiveAgentArgs]) {
    const a = build({ meetCode: 'abc-defg-hij', botName: 'Jimmy', dangerous: true, model: 'opus' });
    assert.ok(!a.includes('--resume'), `${build.name} added --resume with no id`);
  }
});

test('the SessionStart hook forwards its payload, or no id is ever captured', () => {
  // The hook is the ONLY capture path that works for Terminal.app and tmux. A
  // curl without --data-binary posts an empty body and the session id is lost
  // in exactly the two hosting modes that cannot fall back to stdout parsing.
  assert.match(main, /--data-binary @-/,
    'the /claude-ready hook must forward stdin — that is where session_id lives');
});

test('an already-installed pre-session-id hook is rewritten, not left alone', () => {
  // The original guard was "is there any hook mentioning /claude-ready", which
  // means every workdir that already had one would keep the old payload-less
  // command forever and never report a session id.
  const fn = main.slice(main.indexOf('function ensureClaudeReadyHook'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(body.includes('h.command === cmd') || body.includes('command === cmd'),
    'the hook must be compared against the CURRENT command, not merely detected');
});

test('a session id already set is never overwritten by the hook', () => {
  // A set value is the user pinning this bot to a session by hand. The hook
  // fires on resume too and reports that same id, so the only thing overwriting
  // could ever do is clobber a deliberate choice.
  const fn = main.slice(main.indexOf('function recordAgentSessionId'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(/if \(resolveSessionId\(store\.get\('agentSessionId'\)\)\) return;/.test(body),
    'recordAgentSessionId must bail when the preference already holds an id');
});

test('every launch path resolves the id through the staleness guard', () => {
  // Three hosting modes (macOS Terminal, Linux terminal/tmux, headless). A path
  // that reads the preference directly skips the sessionExists check, and a
  // stale id there is not a degraded session — it is an agent that exits before
  // starting, i.e. a bot sitting mute in the call.
  const uses = main.match(/(?<!function )effectiveResumeSessionId\(claudeDir\)/g) || [];
  assert.equal(uses.length, 3, `expected all three launch paths to use the guard, saw ${uses.length}`);
  // And none of them may read the raw preference instead, which would bypass it.
  assert.ok(!/resumeSessionId: resolveSessionId\(/.test(main),
    'a launch path is reading agentSessionId directly, skipping the staleness guard');
});

test('a stale session id is dropped rather than passed to a doomed launch', () => {
  // Measured against the installed CLI: `--resume <unknown-id>` prints "No
  // conversation found" and exits with is_error before running anything.
  const tmp = mkdtempSync(join(tmpdir(), 'vc-session-'));
  const cwd = '/Users/someone/bots/jimmy';
  const dir = join(tmp, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const live = '11111111-2222-3333-4444-555555555555';
  writeFileSync(join(dir, `${live}.jsonl`), '{}\n');

  assert.equal(sessionExists(live, cwd, { home: tmp }), true, 'a session that IS there must resume');
  assert.equal(sessionExists('99999999-2222-3333-4444-555555555555', cwd, { home: tmp }), false,
    'an id missing from an existing project dir is not resumable');
  rmSync(tmp, { recursive: true, force: true });
});

test('the guard only acts on positive evidence of absence', () => {
  // The ~/.claude/projects layout is undocumented. If it changes, the project
  // dir simply will not be found — and the check must then say nothing rather
  // than concluding "no session" and silently starting fresh forever. Being
  // wrong this way costs one failed launch (today's behaviour); being wrong the
  // other way quietly throws away the bot's memory.
  const tmp = mkdtempSync(join(tmpdir(), 'vc-session-'));
  assert.equal(sessionExists('11111111-2222-3333-4444-555555555555', '/no/such/dir', { home: tmp }), true);
  assert.equal(sessionExists('11111111-2222-3333-4444-555555555555', '/tmp/x', { home: '/no/such/home' }), true);
  rmSync(tmp, { recursive: true, force: true });
});

test('dropping a stale id also clears it, so the hook can record a live one', () => {
  // Left set, every launch would re-check, re-warn, and never converge — the
  // bot would start fresh forever while the field kept showing a dead id.
  const fn = main.slice(main.indexOf('function effectiveResumeSessionId'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(body.includes("store.set('agentSessionId', '')"),
    'a session found to be unresumable must be cleared from the preference');
});
