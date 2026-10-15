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

test('the onboarding-call skill sets the flag once the card is up and the sentence said', () => {
  // The one-screen setup (2026-10-15) has nothing to "finish": every setting has
  // a value the moment the card is drawn. So the flag is set right after the
  // one spoken sentence — the fast path (get right to work) must not need a
  // closing step to count as onboarded, and someone who leaves now is done.
  const step4 = onboardingSkill.slice(onboardingSkill.indexOf('## Step 4:'), onboardingSkill.indexOf('## Step 5:'));
  assert.match(step4, /set_preference\("onboardingCallComplete", true\)/);
  const setIdx = step4.indexOf('set_preference("onboardingCallComplete"');
  const sayIdx = step4.indexOf("I've put all my settings on the whiteboard");
  assert.ok(sayIdx > 0 && sayIdx < setIdx, 'after the sentence, not before');
  // Not before the card exists: a bot that never showed its settings has not
  // been onboarded.
  const beforeCard = onboardingSkill.slice(0, onboardingSkill.indexOf('## Step 4:'));
  assert.doesNotMatch(beforeCard, /set_preference\("onboardingCallComplete"/,
    'must not be set before the card is on screen');
  // Exactly once: the change/demo paths must not need to set it again.
  assert.equal((onboardingSkill.match(/set_preference\("onboardingCallComplete"/g) || []).length, 1);
});

test('re-running onboarding when already complete offers a menu, not the whole walkthrough', () => {
  // This was once a placeholder asserting the skill said "future work" — the
  // behavior was deliberately left undesigned. It has since been designed: a
  // re-run is someone changing ONE thing, and the one-screen card (showing the
  // CURRENT values) is the menu. Assert the real behavior, so the branch can't
  // quietly rot back to a fresh start.
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
  assert.match(reRun, /SAME\s+items\s+the\s+"Changing\s+one\s+setting"\s+reference/,
    'the menu must track the reference sections, not drift into a second hand-maintained list');
  assert.match(reRun, /never\s+overwrite\s+a\s+choice/, 'a re-run shows current values, not fresh defaults');
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
  // Must land in the SAME write as the name — a separate write could fail
  // independently and leave a bot named but not marked fresh.
  //
  // Checked as "there is exactly ONE write, and the stamp is in the object it
  // writes". The earlier version asserted the stamp appeared textually AFTER
  // `fs.writeFileSync(`, which only held while the object was inline at the call
  // site. Building it into a variable first (as the session-adoption seeding
  // needs to, since claudeWorkDir/agentSession are conditional) kept the
  // invariant perfectly and broke the proxy.
  const writes = fn.match(/fs\.writeFileSync\(file/g) || [];
  assert.equal(writes.length, 1, 'exactly one write — the name and the stamp cannot diverge');
  const stampIdx = fn.indexOf('onboardingCallComplete: false');
  assert.ok(stampIdx > 0, 'the stamp exists');
  // The written value carries it: either inline in the call, or in the object
  // the call writes.
  const written = fn.match(/fs\.writeFileSync\(file,\s*JSON\.stringify\((\w+|\{[^}]*\})/);
  assert.ok(written, 'the write serialises a recognisable value');
  const target = written[1];
  if (target.startsWith('{')) {
    assert.match(target, /onboardingCallComplete: false/, 'stamped inline in the written object');
  } else {
    // Written from a variable — the stamp must be in ITS construction, and that
    // construction must come before the write.
    const buildIdx = fn.indexOf(`const ${target} =`);
    assert.ok(buildIdx > 0 && buildIdx < fn.indexOf('fs.writeFileSync(file'),
      `${target} is built before it is written`);
    assert.ok(stampIdx > buildIdx, 'the stamp is part of that construction');
  }
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
