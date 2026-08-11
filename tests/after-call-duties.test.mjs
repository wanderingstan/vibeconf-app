// after-call-duties.test.mjs — the after-call checklist must reach EVERY
// driving session, not just app-spawned ones.
//
// The gap this closes: the duties (summary, get_call_log → session-log.txt)
// live in the workdir CLAUDE.md, which only app-spawned agents auto-load. On
// the 2026-08-10 Seth call a terminal-driven session drove the call, saw only
// "its CLAUDE.md says what that is", and ended the session in 0.6s — no
// summary, no log copy. Now: afterCallSection() extracts the section,
// afterCallWorkPlan() ships it in the plan, and the MCP note inlines it.
//
// Run: node --test tests/after-call-duties.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { afterCallSection, defaultClaudeMd } = require('../electron-app/agent-workdir.js');

const MD = `# Bot personality

## Who you are
- Nice.

## After the call
When a call ends you may get an AFTER-CALL WORK phase.

### Where call artifacts go
One folder per call: \`calls/<call-id>/\`.
5. Call \`get_call_log({ call_id })\` and save it as \`calls/<call-id>/session-log.txt\`.

## Make it yours
Anything.
`;

test('afterCallSection: extracts heading through the last subsection, stops at the next h2', () => {
  const s = afterCallSection(MD);
  assert.ok(s.startsWith('## After the call'));
  assert.match(s, /get_call_log/);
  assert.match(s, /### Where call artifacts go/, 'h3 subsections belong to the section');
  assert.doesNotMatch(s, /Make it yours/, 'the next h2 is not included');
});

test('afterCallSection: null when the section is absent, empty, or input is nullish', () => {
  assert.equal(afterCallSection('# Bot\n## Who you are\n- hi\n'), null);
  assert.equal(afterCallSection('## After the call\n\n## Next\n'), null, 'blank section is null, not ""');
  assert.equal(afterCallSection(null), null);
});

test('afterCallSection: the SEEDED default CLAUDE.md yields duties (the common case must never regress)', () => {
  const s = afterCallSection(defaultClaudeMd());
  assert.ok(s && s.length > 100, 'the starter file ships a real after-call section');
});

test('afterCallWorkPlan ships workdir + duties to any transport', () => {
  require('../electron-app/local-server.js');
  const LocalServer = globalThis.LocalServer;

  const dir = mkdtempSync(join(tmpdir(), 'after-call-duties-'));
  writeFileSync(join(dir, 'CLAUDE.md'), MD);

  const s = new LocalServer({ port: 0, getAgentWorkdir: () => dir, getPref: () => 300 });
  // An agent must appear present for the plan to enable — mimic a live waiter.
  s.agentState = () => 'active';

  const plan = s.afterCallWorkPlan();
  assert.equal(plan.enabled, true);
  assert.equal(plan.workdir, dir);
  assert.match(plan.duties, /^## After the call/);
  assert.match(plan.duties, /session-log\.txt/, 'step 5 travels with the plan');

  // Missing CLAUDE.md degrades to workdir-only — never throws, never disables.
  const bare = mkdtempSync(join(tmpdir(), 'after-call-bare-'));
  const s2 = new LocalServer({ port: 0, getAgentWorkdir: () => bare, getPref: () => 300 });
  s2.agentState = () => 'active';
  const plan2 = s2.afterCallWorkPlan();
  assert.equal(plan2.enabled, true);
  assert.equal(plan2.workdir, bare);
  assert.equal(plan2.duties, undefined);

  // No workdir thunk at all (tests, headless embedders) — plain plan.
  const s3 = new LocalServer({ port: 0, getPref: () => 300 });
  s3.agentState = () => 'active';
  const plan3 = s3.afterCallWorkPlan();
  assert.equal(plan3.enabled, true);
  assert.equal(plan3.workdir, undefined);

  rmSync(dir, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
});

test('the MCP note inlines the duties, and still points at the file when only the path is known', () => {
  // afterCallWorkNote is module-internal to server.js; assert on source like
  // call-phase.test.mjs does — the contract is the text handed to the agent.
  const mcp = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'mcp-server', 'server.js'), 'utf8');
  const fn = mcp.slice(mcp.indexOf('function afterCallWorkNote'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /plan\.duties/, 'duties from the plan are used');
  assert.match(body, /plan\.workdir/, 'the workdir path is surfaced');
  assert.match(body, /CLAUDE\.md/, 'fallback still names the file to read');
});
