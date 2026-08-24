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
const { resolveSessionId, claudeResumeFlag, resolveSessionName, claudeNameFlag, sessionExists, resolveSessionRef, sessionCacheKey } = require('../electron-app/agent-session.js');
const { buildAgentArgs, buildInteractiveAgentArgs } = require('../electron-app/agent-spawn.js');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

// The body of planAgentSession, which is where the launch-time policy lives.
const planBody = () => {
  const fn = main.slice(main.indexOf('function planAgentSession'));
  return fn.slice(0, fn.indexOf('\n}\n'));
};


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

test('the session is named after the bot, so it is not a UUID in /resume', () => {
  assert.equal(resolveSessionName('Jimmy'), 'Jimmy');
  assert.equal(claudeNameFlag('Jimmy'), ' --name \\"Jimmy\\"');
  // Two-word names stay one name. The escaped quotes match how the prompt is
  // already passed on the AppleScript path.
  assert.equal(claudeNameFlag('Jimmy Bot'), ' --name \\"Jimmy Bot\\"');
});

test('a bot name is user-typed, so it is sanitized like every other spliced value', () => {
  // Reaches the macOS path inside a shell command inside an AppleScript string.
  const flag = claudeNameFlag('Jimmy"; rm -rf ~; echo "');
  assert.ok(!/[$`;|&<>()]/.test(flag), `unsafe characters survived: ${flag}`);
  assert.ok(!flag.includes('\\"Jimmy\\"; rm'), 'the name must not be able to close its own quoting');
  // Stripping must not leave ragged whitespace behind.
  assert.equal(resolveSessionName('Jimmy 🤖'), 'Jimmy');
  assert.equal(resolveSessionName('   '), '');
  assert.equal(claudeNameFlag(''), '', 'no name means no flag, not an empty one');
});

test('a pasted essay cannot become the command line', () => {
  assert.ok(resolveSessionName('x'.repeat(500)).length <= 60);
});

test('both argv builders pass the name as its own element', () => {
  for (const build of [buildAgentArgs, buildInteractiveAgentArgs]) {
    const a = build({ meetCode: 'abc-defg-hij', botName: 'Jimmy', dangerous: true, model: 'opus', sessionName: 'Jimmy Bot' });
    const i = a.indexOf('--name');
    assert.ok(i >= 0, `${build.name} dropped --name`);
    assert.equal(a[i + 1], 'Jimmy Bot', 'a two-word name must stay one argv element');
  }
});

test('the name is applied to resumed sessions too, not just new ones', () => {
  // Verified against the installed CLI: --name alongside --resume is accepted
  // and lands as `agentName` in the transcript. Since a bot resumes on every
  // launch after the first, a name only applied at creation would be a name
  // almost never applied.
  const a = buildAgentArgs({
    meetCode: 'abc-defg-hij', botName: 'Jimmy', dangerous: true, model: 'opus',
    resumeSessionId: '11111111-2222-3333-4444-555555555555', sessionName: 'Jimmy',
  });
  assert.ok(a.includes('--resume') && a.includes('--name'));
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


// ── One field, two meanings ──────────────────────────────────────────────────
// A session has both a name and an id, and people reach for whichever they
// have. Blank is the case that matters most: it means "the bot's own name",
// which is what makes one-session-per-bot need no configuration at all.

test('blank means the session is named after the bot', () => {
  const ref = resolveSessionRef('', 'Jimmy');
  assert.equal(ref.kind, 'name');
  assert.equal(ref.name, 'Jimmy');
  assert.equal(ref.id, '');
});

test('a UUID pins the bot to that exact session', () => {
  const id = '0c7d62da-e284-4670-a089-1ab02ece1b15';
  const ref = resolveSessionRef(id, 'Jimmy');
  assert.equal(ref.kind, 'id');
  assert.equal(ref.id, id);
  // Still labelled after the bot — a pinned session should not read as a UUID.
  assert.equal(ref.name, 'Jimmy');
});

test('anything that is not a UUID is a name, not a broken id', () => {
  // The failure this prevents: treating "Jimmy" as an id and passing it to
  // --resume, which errors out and leaves the bot mute.
  for (const v of ['Jimmy', 'research bot', 'not-a-uuid', '1234']) {
    assert.equal(resolveSessionRef(v, 'Bot').kind, 'name', `${v} should be a name`);
  }
  // A near-miss UUID is a name too, and names are matched case-insensitively
  // later, so this must not silently become a doomed --resume.
  assert.equal(resolveSessionRef('0c7d62da-e284-4670-a089', 'Bot').kind, 'name');
});

test('a session belongs to a working directory, so the key carries both', () => {
  // This is why changing the Working Directory correctly starts a new session
  // instead of resuming one that lives under the old path.
  const a = sessionCacheKey('/bots/jimmy', 'Jimmy');
  const b = sessionCacheKey('/bots/other', 'Jimmy');
  assert.notEqual(a, b);
  // Case-insensitive, matching how the CLI resolves titles.
  assert.equal(sessionCacheKey('/bots/jimmy', 'JIMMY'), a);
});

test('resume goes through an id, never through --resume <title>', () => {
  // Verified against the installed CLI: two sessions sharing a title make
  // `--resume "Jimmy"` fail with "matches 2 sessions. Pass one of these session
  // IDs to disambiguate" — unrecoverable without an id, and a mute bot. So the
  // name is resolved to an id here and the id is what gets passed.
  const fn = main.slice(main.indexOf('function planAgentSession'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(body.includes('agentSessionCache'), 'the name must resolve via the id cache');
  assert.ok(!/resumeSessionId: *ref\.name/.test(body), 'a title must never be passed as --resume');
});

test('every launch path goes through the planner', () => {
  // Three hosting modes. One that builds its own flags would miss the
  // name-to-id resolution and the per-directory scoping with it.
  const uses = (main.match(/(?<!function )planAgentSession\(claudeDir, botName\)/g) || []).length;
  assert.equal(uses, 3, `expected all three launch paths to use the planner, saw ${uses}`);
});

test('a pinned id is never silently replaced', () => {
  // An id in the field is an explicit instruction. If it is unresumable the
  // launch starts fresh rather than joining mute, but the field is left alone —
  // overwriting it would be the app overruling something the user typed.
  const fn = main.slice(main.indexOf('function planAgentSession'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  // The id branch only, up to where name resolution begins. It must return out
  // before reaching any write. Anchored on code, not comment text, so rewording
  // a comment cannot silently turn this into a no-op assertion.
  const start = body.indexOf("ref.kind === 'id'");
  const end = body.indexOf('let name = ref.name;');
  assert.ok(start >= 0 && end > start, 'planAgentSession no longer has the shape this test reads');
  const pinned = body.slice(start, end);
  assert.ok(!pinned.includes('store.set'), 'a pinned session id must not be rewritten by the app');
  assert.equal((pinned.match(/return \{/g) || []).length, 2,
    'both outcomes of a pinned id must return before the name-pinning write');
});

test('only a session WE started fresh is cached', () => {
  // The hook fires for any session in the bot's folder, including one a person
  // started by hand. Gating on the pending key is what stops that becoming the
  // bot's session — and stops a resumed session re-reporting an id we already had.
  const fn = main.slice(main.indexOf('function recordAgentSessionId'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(/const key = pendingSessionCacheKey;/.test(body));
  assert.ok(/if \(!id \|\| !key\) return;/.test(body), 'an unsolicited hook ping must not be cached');
});


test('a name the user typed is left exactly as they typed it', () => {
  // Only an implicit name gets written back. Rewriting an explicit one would
  // make the field un-editable in practice.
  assert.equal(resolveSessionRef('Research', 'Jimmy').implicit, false);
  assert.equal(resolveSessionRef('Research', 'Jimmy').name, 'Research');
  // A pinned id is not a name and must never be overwritten with one.
  assert.equal(resolveSessionRef('0c7d62da-e284-4670-a089-1ab02ece1b15', 'Jimmy').implicit, false);
});


// ── Following the bot's name ─────────────────────────────────────────────────
// Almost nobody edits this field, so the automatic path is the one that has to
// be right: rename the bot and the session follows, keeping its history.

test('the resolved name is written into the field, never left blank', () => {
  // A blank field hides that the session HAS a name, which is what makes
  // `claude --resume Jimmy` look impossible when it works.
  assert.equal(resolveSessionRef('', 'Jimmy').implicit, true);
  const body = planBody();
  assert.ok(body.includes("store.set('agentSession', name)"),
    'the name in use must be persisted so it is visible and typeable');
});

test('renaming the bot renames the session and keeps its history', () => {
  // The failure this replaces: a new key simply missed, so correcting a typo in
  // the bot's name started an empty session and read as the bot losing its
  // memory. --name renames in place (verified against the CLI), so the cache
  // entry moves with it.
  const body = planBody();
  assert.ok(/const auto = store\.get\('agentSessionAuto'\) !== false;/.test(body),
    'the field must follow the bot name unless taken over');
  assert.ok(body.includes('cache[key] = cache[from]') && body.includes('delete cache[from]'),
    'the cached session must MOVE to the new name, not be abandoned under the old one');
});

test('a rename never clobbers a session that already owns the new name', () => {
  // Carrying unconditionally would drag this bot's session on top of a
  // different one — switching to an existing session must stay a switch.
  const body = planBody();
  const carry = body.slice(body.indexOf('Only when the new name'));
  assert.ok(/if \(!cache\[key\] && ref\.name && ref\.name !== name\)/.test(carry),
    'the carry must be guarded on the new name having no session of its own');
});

test('taking the field over stops it following the bot', () => {
  // Otherwise a deliberate choice would be silently reverted on the next rename.
  const panel = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');
  assert.ok(/set-config', 'agentSessionAuto', !value/.test(panel),
    'typing a value must clear auto; clearing it must restore auto');
});

// ── Re-joining while the last call's agent is still winding down ─────────────
// Observed 2026-08-23: leave_call does NOT kill the agent — it stays up to write
// its summary and memory files, which took 87s. Calling back inside that window
// hit "already running — reusing it", the winding-down agent then exited, and
// the new call was left with no agent at all. A bot that joins and never speaks.

test('an agent is only reused for the call it was launched for', () => {
  const fn = main.slice(main.indexOf('function launchClaudeHeadless'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  // NOT on the meet code. Calling a bot back into the SAME room is a new call,
  // so a code match said "same call" about an agent already winding down —
  // exactly the reuse this guard exists to prevent (seen 20:51:31, 2026-08-23).
  assert.ok(/if \(headlessAgentChild && !headlessAgentCallOver\)/.test(body),
    'reuse must depend on the agent’s call still being live, not on the room');
  // Specifically the GUARD. The codes may still be compared for a log line —
  // what must not come back is deciding reuse on them.
  assert.ok(!/if \(headlessAgentChild && headlessAgentCall === meetCode\)/.test(main),
    'the meet code cannot distinguish a re-join into the same room from the same call');
  assert.ok(/headlessAgentCallOver = true;/.test(main),
    'the agent must be marked a lame duck when its call ends');
});

test('the replacement waits for the old agent to actually exit', () => {
  // The new agent resumes the SAME session id, so overlapping it with a process
  // still holding that session is a race worth not running.
  const fn = main.slice(main.indexOf('function launchClaudeHeadless'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(/stale\.once\('exit', startOnce\)/.test(body),
    'the replacement must start on the old agent’s exit, not immediately');
  assert.ok(/SIGKILL/.test(body) && /5000/.test(body),
    'a wrap-up that will not die must not strand the live call');
});

test('a superseded agent cannot tear down its replacement', () => {
  // Without this, the SIGKILL path lets a late exit null out the new child and
  // hand the new call’s activity feed back to the transcript tail.
  const fn = main.slice(main.indexOf('function launchClaudeHeadless'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(/if \(gen !== headlessAgentGeneration\) return;/.test(body),
    'the exit handler must ignore a superseded generation');
});

test('the after-call write-up window is visible in the UI', () => {
  // It used to be invisible: the avatar keeps reacting through the wrap-up, so
  // it reads as "still on the call". That is how the 2026-08-23 mute-bot
  // confusion started. The banner also has to say that calling now CUTS THE
  // WRITE-UP SHORT, since that is the decision it exists to inform.
  assert.ok(/action: 'agent-wrapping-up'/.test(main), 'main must broadcast the wrap-up state');
  // Specifically the lame-duck flag, NOT "callStatus is not in-call": a call
  // spends its first seconds in navigating/joining/waiting-to-be-admitted, so
  // that test fired the banner on every launch and told the user a brand-new
  // agent was finishing the previous call.
  assert.ok(/const wrapping = !!headlessAgentChild && headlessAgentCallOver;/.test(main),
    'the banner must use the same lame-duck flag the launcher does');
  assert.ok(!/callStatus === 'in-call'[^\n]*\n[^\n]*const wrapping/.test(main),
    'joining is not the same as wrapping up');
  const panel = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');
  assert.ok(/agent-wrapping-up/.test(panel), 'the panel must listen for it');
  assert.ok(/cut that short/.test(panel), 'the banner must warn that calling now truncates the write-up');
});

test('an interrupted write-up is handed to the next after-call pass', () => {
  // Cutting the write-up short (the deliberate trade when someone calls back)
  // used to lose it outright. It does not have to: the replacement resumes the
  // SAME session, so the work is still in the agent's history — it only needs
  // telling that it stopped early.
  assert.ok(/store\.set\('agentUnfinishedWrapUp'/.test(main),
    'retiring a lame-duck agent must record what it was interrupted doing');
  const ls = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');
  const fn = ls.slice(ls.indexOf('afterCallWorkPlan()'));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.ok(body.includes('plan.unfinished'),
    'the after-call plan must carry the unfinished write-up');
  assert.ok(body.includes('clearUnfinishedWrapUp'),
    'and clear it once told, or it would nag on every future call');
});

test('the handover reaches every transport, not just panel-initiated joins', () => {
  // Deliberately delivered via afterCallWorkPlan (the leave_call response)
  // rather than by appending to the join prompt: calendar auto-join and
  // CLI-initiated calls never build a prompt, and they need it just as much.
  const ls = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');
  assert.ok(/getUnfinishedWrapUp/.test(ls), 'the server must read the handover itself');
  assert.ok(!/join-call.*unfinished/i.test(main),
    'the handover must not be smuggled into the join prompt');
});
