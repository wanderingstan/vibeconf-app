// agent-backend.test.mjs — the app can be told which agent drives this machine,
// and stops nagging about Claude Code when the answer is "something else" (#231).
//
// The user this exists for: someone deliberately using Codex, LM Studio, Cline,
// or a hand-rolled MCP client. Before this, the only way to express that was to
// SKIP the onboarding step — which recorded nothing, so the app went on assuming
// Claude Code forever and warning about a tool they had decided against. #137's
// sign-in check made that worse by polling every 60s while "signed out".
//
// Run: node --test tests/agent-backend.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { PREFERENCES, validate } = require('../electron-app/preferences-schema.js');
const { isAppLevel, MIGRATE_KEYS } = require('../electron-app/config-scope.js');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const onbJs = readFileSync(join(root, 'electron-app/renderer/onboarding.js'), 'utf8');
const onbHtml = readFileSync(join(root, 'electron-app/renderer/onboarding.html'), 'utf8');

test('the enum names what actually exists', () => {
  const spec = PREFERENCES.agentBackend;
  assert.deepEqual(spec.enum, ['claude', 'codex', 'other']);
  // codex is NOT hypothetical — docs/codex.md, scripts/install-codex-mcp.mjs and
  // tests/codex-install.test.mjs all exist. Shipping only claude|other would
  // describe the product as less capable than it is, and would put existing
  // Codex users in a bucket named after not being supported.
  assert.equal(spec.default, 'claude', 'unchanged behaviour for everyone who never touches it');
  assert.equal(validate('agentBackend', 'lmstudio').ok, false, 'the enum is closed');
});

test('the options are not presented as equal peers', () => {
  // They are not equal: one is automated, one is experimental and needs manual
  // setup, one is bring-your-own. A raw enum value would imply parity that does
  // not exist — Codex has had minimal validation (its smoke test checks that
  // tools/list works, not that a bot holds up in a call).
  const labels = PREFERENCES.agentBackend.enumLabels;
  assert.match(labels.claude, /recommended/i);
  assert.match(labels.codex, /experimental/i);
  assert.match(labels.other, /MCP/i);
});

test('it is machine-level, and must never be auto-promoted', () => {
  assert.ok(isAppLevel('agentBackend'), 'which CLI is installed is a property of the machine');
  // Same hazard documented for dangerousMode: promoting one profile's guess
  // would silently reconfigure every bot on the machine.
  assert.ok(!MIGRATE_KEYS.includes('agentBackend'));
});

test('the gate is about who LAUNCHES the agent, not which backend it is', () => {
  // Phrased this way so the rule stays correct if Codex ever gains app-driven
  // launch: what makes a warning ours is being responsible for starting the
  // thing, not the brand name.
  assert.match(main, /function appLaunchesAgent\(\)/);
  assert.match(main, /prefValue\('agentBackend'\) === 'claude'/);
  // Fails safe: an unreadable pref must behave like today, not silently disable
  // the warnings that catch a genuinely broken install.
  const fn = main.slice(main.indexOf('function appLaunchesAgent()'));
  assert.match(fn.slice(0, 200), /catch \{ return true; \}/);
});

test('a non-Claude machine is neither warned nor polled', () => {
  // Not just cosmetic. refreshClaudeAuth spawns a LOGIN SHELL, and #137 polls
  // every 60s while signed out — so without this, someone who will never install
  // Claude Code pays for a shell a minute, forever, to be told so.
  const refresh = main.slice(main.indexOf('async function refreshClaudeAuth'));
  assert.match(refresh.slice(0, 500), /if \(!appLaunchesAgent\(\)\)/);
  assert.match(refresh.slice(0, 500), /method: 'not-managed'/);
  // And the join path skips the whole launch, not just the install prompt.
  // This was `throw { skip: true }` swallowed by the detection catch — which
  // suppressed the nag but fell through and spawned a Claude Terminal at a
  // user who had said they run something else. A RETURN, not a throw.
  const launch = main.slice(main.indexOf('async function launchClaudeTerminal'));
  const gateAt = launch.indexOf('if (!appLaunchesAgent()) {');
  assert.ok(gateAt !== -1, 'the launcher gates on appLaunchesAgent');
  assert.match(launch.slice(gateAt, gateAt + 200), /return;/);
  assert.ok(gateAt < launch.indexOf('try {'),
    'the gate is an unconditional early return, outside the non-fatal detection try/catch');
});

test('switching backends takes effect immediately', () => {
  // Going to codex/other must clear a stale "signed out" banner now, not at the
  // next poll; coming back to claude must re-check rather than sit on the null
  // parked while it was not our business.
  const notify = main.slice(main.indexOf('function notifyConfigChanged'));
  assert.match(notify.slice(0, 700), /key === 'agentBackend'/);
  assert.match(notify.slice(0, 700), /refreshClaudeAuth\(\)/);
});

test('onboarding can state the choice, rather than only skipping', () => {
  assert.match(onbHtml, /id="agentBackend"/);
  assert.match(onbJs, /set-config', 'agentBackend'/, 'the choice has to persist');
  // And the "you will have nothing driving your bot" warning must not fire at
  // someone who just said they have something else — that premise is false for
  // them, and a false warning is how warnings become noise.
  assert.match(onbJs, /const appManagesAgent = !backendSel \|\| backendSel\.value === 'claude'/);
  assert.match(onbJs, /steps\[i\] === 'claude' && !claudeIsGreen && appManagesAgent/);
});

test('choosing another agent removes the Claude setup, rather than dimming it', () => {
  // Dimming still shows an install button for a product the user just said they
  // are not using, and invites a click that would do the wrong thing.
  assert.match(onbHtml, /id="claudeSetup"/, 'the Claude-specific block needs a wrapper to hide');
  assert.match(onbJs, /setup\.style\.display = sel\.value === 'claude' \? '' : 'none'/);
  assert.doesNotMatch(onbJs, /style\.opacity = managed/, 'dimming is not hiding');

  // The wrapper must ENCLOSE the rows loadClaude() manages, so hiding it leaves
  // that logic untouched instead of fighting it.
  const block = onbHtml.slice(onbHtml.indexOf('id="claudeSetup"'));
  const end = block.indexOf('</section>');
  for (const id of ['claudeStatus', 'claudeInstallRow', 'claudeVerifyRow']) {
    assert.ok(block.slice(0, end).includes(id), `${id} must live inside claudeSetup`);
  }
});

test('the step asks the question before offering one answer to it', () => {
  // The selector used to sit BELOW the install button as an afterthought, which
  // is backwards — the choice governs whether the rest of the step applies.
  assert.ok(onbHtml.indexOf('id="agentBackend"') < onbHtml.indexOf('id="claudeSetup"'),
    'the choice comes first');
  // Labelled for what it is, not for the exception it used to serve. It read
  // "Using a different agent?" when it sat below the install button — a question
  // that only makes sense if Claude is already assumed.
  assert.match(onbHtml, /<label for="agentBackend"[^>]*>Agent<\/label>/);
  assert.doesNotMatch(onbHtml, /Using a different agent/);
  // The app ships on Windows and Linux too, so copy that names one platform is
  // a string someone has to remember to fork later. "machine" needs no variant.
  const step = onbHtml.slice(onbHtml.indexOf('data-step="claude"'));
  assert.doesNotMatch(step.slice(0, step.indexOf('</section>')), /\bMac\b/);
  // Named for the question, not for one of the three answers.
  assert.match(onbJs, /claude: 'Brains'/);
  assert.doesNotMatch(onbJs, /claude: 'Claude Code'/);
  // The step KEY stays 'claude' — SKIPPABLE, the skip-confirm and data-step all
  // reference it, and renaming it would be a silent behaviour change.
  assert.match(onbHtml, /data-step="claude"/);
  assert.match(onbJs, /steps\[i\] === 'claude'/);
});
