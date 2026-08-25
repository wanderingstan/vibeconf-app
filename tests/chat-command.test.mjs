// chat-command.test.mjs — the line a human runs to talk to their bot (#500 follow-up).
//
// A bot keeps ONE Claude session named after itself, so the session it uses on
// calls is the same one a person can open at a prompt. This builds that line.
// Tested for the same reason every command builder here is: it is interpolated
// into a shell command, and on macOS into an AppleScript string wrapping it.
//
// Run: node --test tests/chat-command.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildChatCommand, shellQuote } = require('../electron-app/chat-command.js');

const DIR = '/Users/x/Library/Application Support/Vibeconferencing/profiles/Default/agent';

test('the common case: blank field means the bot resumes its own name', () => {
  assert.equal(
    buildChatCommand({ workdir: DIR, sessionField: '', botName: 'Jimmy' }),
    `cd '${DIR}' && claude --resume 'Jimmy'`,
  );
});

test('the workdir is quoted — it lives under "Application Support"', () => {
  // #305: an unquoted cd split this path at the first space and the shell
  // reported "string not in pwd". The same path reaches here.
  const cmd = buildChatCommand({ workdir: DIR, sessionField: '', botName: 'Jimmy' });
  assert.ok(cmd.includes(`cd '${DIR}'`), 'the whole path is one argument');
});

test('a pinned UUID resumes the id, not a name', () => {
  const id = '1cf12b6c-c297-4bb0-baa9-963c1d040172';
  assert.equal(
    buildChatCommand({ workdir: DIR, sessionField: id, botName: 'Jimmy' }),
    `cd '${DIR}' && claude --resume '${id}'`,
  );
});

test('the field wins over the bot name when it holds a name', () => {
  assert.equal(
    buildChatCommand({ workdir: DIR, sessionField: 'Pepper', botName: 'Jimmy' }),
    `cd '${DIR}' && claude --resume 'Pepper'`,
  );
});

test('a cached id resumes by id, not name — the whole point of #530', () => {
  // The bot's own launch path (planAgentSession) never resumes by name once it
  // has an id cached, because `--resume <name>` is ambiguous the moment the
  // working directory holds a second session with that title. The copied
  // command must get the same guarantee.
  const id = '1cf12b6c-c297-4bb0-baa9-963c1d040172';
  assert.equal(
    buildChatCommand({ workdir: DIR, sessionField: '', botName: 'Jimmy', cachedSessionId: id }),
    `cd '${DIR}' && claude --resume '${id}'`,
  );
});

test('no cached id falls back to the name, same as before', () => {
  assert.equal(
    buildChatCommand({ workdir: DIR, sessionField: '', botName: 'Jimmy', cachedSessionId: '' }),
    `cd '${DIR}' && claude --resume 'Jimmy'`,
  );
});

test('a pinned UUID in the field wins over a cached id — the pin is explicit', () => {
  const pinned = '1cf12b6c-c297-4bb0-baa9-963c1d040172';
  const cached = '00000000-0000-4000-8000-000000000000';
  assert.equal(
    buildChatCommand({ workdir: DIR, sessionField: pinned, botName: 'Jimmy', cachedSessionId: cached }),
    `cd '${DIR}' && claude --resume '${pinned}'`,
  );
});

test('a cachedSessionId that sanitizes away entirely falls back to the name', () => {
  const cmd = buildChatCommand({ workdir: DIR, sessionField: '', botName: 'Jimmy', cachedSessionId: '🤖🤖' });
  // resolveSessionId strips everything outside [A-Za-z0-9._-]; empty means "no
  // id to prefer", same as when no cache lookup was ever done.
  assert.equal(cmd, `cd '${DIR}' && claude --resume 'Jimmy'`);
});

test('a two-word name stays ONE argument', () => {
  const cmd = buildChatCommand({ workdir: DIR, sessionField: '', botName: 'Doctor Who' });
  assert.ok(cmd.endsWith(`--resume 'Doctor Who'`), cmd);
});

test('nothing to resume still puts you in the right directory', () => {
  // Both blank: no session to name. Starting fresh in the right place is most
  // of the value, and is what the bot's own first launch does.
  assert.equal(
    buildChatCommand({ workdir: DIR, sessionField: '', botName: '' }),
    `cd '${DIR}' && claude`,
  );
});

test('a name that sanitizes away entirely does not become a stray argument', () => {
  // agent-session.js drops everything outside [A-Za-z0-9 ._-].
  assert.equal(
    buildChatCommand({ workdir: DIR, sessionField: '', botName: '🤖🤖' }),
    `cd '${DIR}' && claude`,
  );
});

test('injection: a hostile workdir cannot break out of the quotes', () => {
  const evil = `/tmp/x'; rm -rf ~; echo '`;
  const cmd = buildChatCommand({ workdir: evil, sessionField: '', botName: 'Jimmy' });
  // Every embedded quote is closed-escaped-reopened, so `rm` stays literal text
  // inside the cd argument rather than becoming its own command.
  assert.ok(!/&& rm/.test(cmd), cmd);
  assert.ok(cmd.includes(`'\\''`), 'the quote was escaped, not passed through');
});

test('injection: $ and backticks in a path are inert under single quotes', () => {
  const cmd = buildChatCommand({ workdir: '/tmp/$(whoami)/`id`', sessionField: '', botName: 'Jimmy' });
  assert.ok(cmd.includes(`'/tmp/$(whoami)/\`id\`'`), cmd);
});

test('shellQuote handles nullish without printing "null"', () => {
  assert.equal(shellQuote(null), `''`);
  assert.equal(shellQuote(undefined), `''`);
});

test('the output is SHELL form, not AppleScript form', () => {
  // launch-command.js escapes for `do script "…"` and its output carries \".
  // This string is shown to people and copied to the clipboard, so pasting it
  // must not yield `cd \"/Users/…`.
  const cmd = buildChatCommand({ workdir: DIR, sessionField: '', botName: 'Jimmy' });
  assert.ok(!cmd.includes('\\"'), cmd);
});
