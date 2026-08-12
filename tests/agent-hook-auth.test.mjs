// agent-hook-auth.test.mjs — the auto-installed PostToolUse hook must
// authenticate, because the control API requires a token (#201).
//
// The regression this pins: #201 made /api/* require a bearer token on Aug 1 and
// this hook was not updated, so every POST 401'd and the agent session was never
// bound. Nothing surfaced it — the hook swallows all errors by design, and a
// hook that has silently stopped working looks exactly like one with nothing to
// report.
//
// The visible symptom was the avatar never reaching 🧑‍💻 working (#339): that
// state is driven entirely by this feed, so no binding means no tool lines,
// which means the escalation can never fire. Confirmed in the logs — "Agent
// session bound" appears through Jul 31 and stops dead on Aug 1.
//
// Run: node --test tests/agent-hook-auth.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const server = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');

// The hook ships as a template literal; work on its text.
const hook = main.slice(
  main.indexOf('const AGENT_HOOK_CONTENT = `'),
  main.indexOf('\n`;', main.indexOf('const AGENT_HOOK_CONTENT = `')),
);

test('the hook sends a bearer token', () => {
  assert.match(hook, /headers\.authorization = 'Bearer ' \+ token/);
  // From the same 0600 file the MCP server reads, keyed by port — not a second
  // scheme that could drift from it.
  assert.match(hook, /'\.vibeconferencing', 'local-tokens', port \+ '\.token'/);
});

test('a missing token file does not break the hook', () => {
  // The server can legitimately run with auth off (VIBECONF_REQUIRE_TOKEN=0, as
  // the test fleet does). A hook that threw on a missing file would take the
  // agent's PostToolUse with it, which is far worse than a lost binding.
  const read = hook.slice(hook.indexOf('let token'));
  assert.match(read.slice(0, 400), /catch \(e\)/);
  assert.match(hook, /if \(token\) headers\.authorization/, 'absent token must simply send no header');
});

test('/api/agent-session is not an open route — the token is genuinely required', () => {
  // If this ever becomes open, the test above stops meaning anything. Verified
  // live against a running instance: no token -> 401, with token -> 200.
  const open = server.slice(server.indexOf('const isOpen ='));
  const line = open.slice(0, open.indexOf('\n'));
  assert.doesNotMatch(line, /agent-session/, 'it must stay behind auth');
  assert.match(line, /\/api\/sync\/no-room/, 'only discovery and assets are open');
});

test('the hook is rewritten when its content changes', () => {
  // There is no version counter, so self-repair depends on this comparison —
  // otherwise everyone keeps the old, unauthenticated hook forever and the fix
  // reaches nobody.
  assert.match(main, /if \(existing !== AGENT_HOOK_CONTENT\) fs\.writeFileSync\(hookPath, AGENT_HOOK_CONTENT\)/);
});

test('the working state still depends on this feed', () => {
  // Documents WHY the hook matters, so a future reader connects a silent hook to
  // a missing avatar state rather than treating them as unrelated.
  assert.match(server, /_onAgentActivity\(last\)/);
  assert.match(server, /\/🔧\/\.test\(line\)/, 'tool lines are what escalate to working');
  assert.match(server, /_setBotState\('working'\)/);
});
