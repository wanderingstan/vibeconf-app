// onboarding-call-flag.test.mjs — auto-redirecting an un-onboarded bot into the
// guided onboarding call, instead of letting /join-call or /call proceed normally.
//
// Three pieces have to agree for this to work: a real persisted flag (distinct
// from the app's first-run DIALOG WIZARD flag, which only tracks whether that
// dialog was dismissed, not whether the bot's name/voice/emoji/background were
// ever actually set live); the two everyday entry points checking it BEFORE
// anything else; and the onboarding-call skill itself setting it once it's
// actually done. Skill files are prose, so nothing here fails loudly on its own
// — these pin the specific wiring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { PREFERENCES } = require('../electron-app/preferences-schema.js');
const { isAppLevel } = require('../electron-app/config-scope.js');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const joinSkill = readFileSync(join(root, 'mcp-server/join-call-skill.md'), 'utf8');
const callSkill = readFileSync(join(root, 'mcp-server/call-skill.md'), 'utf8');
const onboardingSkill = readFileSync(join(root, 'mcp-server/onboarding-call-skill.md'), 'utf8');

test('onboardingCallComplete is a real preference, boolean, defaulting TRUE, per-profile', () => {
  const p = PREFERENCES.onboardingCallComplete;
  assert.ok(p, 'the preference should exist');
  assert.equal(p.type, 'boolean');
  // Deliberately backwards from how a "have you done X" flag would normally
  // default: true, not false. Every profile that predates this preference
  // (real bots people have been running for weeks) must read as already
  // onboarded with NO migration required — "unknown" has to mean "assume
  // configured", the safe direction to be wrong in. A genuinely new bot only
  // gets false because main.js writes it explicitly at creation time.
  assert.equal(p.default, true);
  // Per-profile, not app-level: each bot completes its own onboarding call —
  // one profile finishing setup must not mark every other profile "done" too.
  assert.equal(isAppLevel('onboardingCallComplete'), false);
});

test('the preference is distinct from the dialog wizard\'s onboardingComplete flag', () => {
  // Same-sounding name, different mechanism: `onboardingComplete` (no "Call")
  // is an Electron `store` key set the moment the first-run DIALOG is
  // dismissed (main.js), regardless of whether the live guided call ever ran.
  // `onboardingCallComplete` is a schema preference, set only by the skill
  // itself. Conflating them would mean clicking "Finish" on the dialog — which
  // the wizard rework made even thinner — silently counts as having done the
  // live walkthrough.
  assert.match(main, /store\.set\('onboardingComplete', true\)/, 'the dialog flag should still exist, unmodified');
  assert.notEqual('onboardingComplete', 'onboardingCallComplete');
});

test('join-call and call both check the flag before anything else, and redirect when unset', () => {
  for (const [name, skill] of [['join-call', joinSkill], ['call', callSkill]]) {
    const zeroIdx = skill.indexOf('## Step 0:');
    const oneIdx = skill.indexOf('## Step 1:');
    assert.ok(zeroIdx > 0, `${name}-skill.md should have a Step 0`);
    assert.ok(zeroIdx < oneIdx, `${name}-skill.md's Step 0 must come before Step 1`);
    const step0 = skill.slice(zeroIdx, oneIdx);
    assert.match(step0, /list_preferences/, `${name}-skill.md must read preferences to check the flag`);
    assert.match(step0, /onboardingCallComplete/);
    assert.match(step0, /onboarding-call-skill\.md/, `${name}-skill.md must hand off to the onboarding-call skill`);
    assert.match(step0, /\$ARGUMENTS/, `${name}-skill.md must pass its arguments through on handoff`);
    // The false branch must actually stop the skill, not just mention the
    // handoff in passing — otherwise a model could read Step 0 and continue
    // into Step 1 regardless of what it found.
    assert.match(step0, /Stop reading this skill here/);
  }
});

test('the redirect only fires on `false` — a re-onboarded bot proceeds normally', () => {
  for (const skill of [joinSkill, callSkill]) {
    const step0 = skill.slice(skill.indexOf('## Step 0:'), skill.indexOf('## Step 1:'));
    assert.match(step0, /\*\*`true`\*\*/, 'must explicitly say what true means, not just what false means');
    assert.match(step0, /Continue with the normal (join|call) below/);
  }
});

test('the onboarding-call skill sets the flag once the walkthrough is actually done, not earlier', () => {
  const step5 = onboardingSkill.slice(onboardingSkill.indexOf('## Step 5:'), onboardingSkill.indexOf('## Step 6:'));
  assert.match(step5, /set_preference\("onboardingCallComplete", true\)/);
  // It must sit in Step 5 (wrap-up, after every 4a-4h step was asked or
  // skipped) — not in Step 1-4, where the walkthrough could still be
  // abandoned partway and shouldn't count as complete.
  const setIdx = step5.indexOf('set_preference("onboardingCallComplete"');
  // Matched by title, not by letter: the sub-step letters shift whenever one is
  // inserted (this was 4h until "Personality / role" and "What you can do"
  // arrived and pushed it to 4i).
  const lastSubstepIdx = onboardingSkill.search(/^### 4[a-z]\. After-call routine\b/m);
  assert.ok(setIdx > 0 && lastSubstepIdx > 0);
  // Step 5 starts after 4h in the file, so finding it inside the Step 5 slice
  // at all is sufficient proof of ordering; also check it isn't in 4a-4h.
  const walkthrough = onboardingSkill.slice(onboardingSkill.indexOf('## Step 4:'), onboardingSkill.indexOf('## Step 5:'));
  assert.doesNotMatch(walkthrough, /set_preference\("onboardingCallComplete"/,
    'must not be set mid-walkthrough, where a skip/abandon would leave it wrongly true');
});

test('re-running onboarding when already complete offers a menu, not the whole walkthrough', () => {
  // This was once a placeholder asserting the skill said "future work" — the
  // behavior was deliberately left undesigned. It has since been designed: a
  // re-run is someone changing ONE thing, and marching them through all of
  // 4a-4i to get a new voice is the chore the menu exists to avoid. Assert the
  // real behavior now, so the branch can't quietly rot back to a fresh start.
  assert.match(onboardingSkill, /onboardingCallComplete/);
  const reRun = onboardingSkill.slice(
    onboardingSkill.indexOf('If it\'s already `true`'),
    onboardingSkill.indexOf('## Step 1:'),
  );
  assert.ok(reRun.length > 0, 'the skill must still branch on the flag already being true');
  // Prose is hard-wrapped, so any phrase long enough to be worth pinning can
  // have a newline anywhere inside it — match on whitespace, not on spaces.
  assert.match(reRun, /menu\s+of\s+what\s+can\s+be\s+reconfigured/,
    'a re-run opens with a menu, so they can name one item');
  assert.match(reRun, /SAME\s+items\s+Step\s+4's\s+sub-steps\s+cover/,
    'the menu must track Step 4, not drift into a second hand-maintained list');
});

test('a bot created via the "New bot" button is explicitly stamped false at creation', () => {
  // seedNewBotName is the one place a profile gets a real botName BEFORE its
  // first launch — so by the time that profile's own process starts up, its
  // config.json already exists with a real name in it. That means "does this
  // profile already have a real botName?" can NEVER be used to detect
  // freshness from the profile's own startup path; freshness has to be
  // recorded here, at the moment of creation, or nowhere reliable at all.
  const fn = main.slice(main.indexOf('function seedNewBotName'), main.indexOf('async function launchOrFocusProfile'));
  assert.match(fn, /onboardingCallComplete: false/);
  // Must land in the SAME write as the name (one file write, not a second
  // one) — a separate write could fail independently and leave a bot named
  // but not marked fresh.
  const writeIdx = fn.indexOf('fs.writeFileSync(file');
  const stampIdx = fn.indexOf('onboardingCallComplete: false');
  const nextWriteIdx = fn.indexOf('fs.writeFileSync', writeIdx + 1);
  assert.ok(stampIdx > writeIdx, 'the stamp should be part of the write, not before it');
  assert.ok(nextWriteIdx === -1 || stampIdx < nextWriteIdx, 'must be in the same write as botName, not a separate one');
});

test('a profile launched fresh via --profile (no "New bot" button involved) is also stamped false', () => {
  // Covers the OTHER way a profile can come into existence: a bare
  // --profile=<name> launch with nothing pre-seeding it (e.g. the test
  // fleet). This has to be captured before any file gets written for the
  // profile, or migrating the legacy loose-config path (right below it in
  // the same block) could make an old profile look brand new.
  const blockStart = main.indexOf("const appLevelStore = new Store(BASE_USER_DATA, { fresh: true });");
  const blockEnd = main.indexOf('#366: inherit');
  const block = main.slice(blockStart, blockEnd);
  const isBrandNewIdx = block.indexOf('const isBrandNewProfile');
  const migrationIdx = block.indexOf('One-time, non-destructive migration');
  assert.ok(isBrandNewIdx > 0, 'must capture brand-new-ness up front');
  assert.ok(isBrandNewIdx < migrationIdx, 'must capture it BEFORE the legacy-config migration can create newCfgPath');
  assert.match(block, /isBrandNewProfile && profileStore\.get\('onboardingCallComplete'\) === undefined/,
    'must not clobber a value seedNewBotName (or anything else) already wrote');
  assert.match(block, /profileStore\.set\('onboardingCallComplete', false\)/);
});
