// onboarding-call-order.test.mjs — four fixes from watching a real setup call.
//
// A skill file is prose, so nothing here fails loudly on its own: the bot just
// behaves slightly worse and nobody can point at a stack trace. These pin the
// specific things that went wrong in an observed call, each of which reads as a
// small wording choice and is actually a step the user notices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skill = readFileSync(join(root, 'mcp-server/onboarding-call-skill.md'), 'utf8');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

const idx = (s) => {
  const i = skill.indexOf(s);
  assert.ok(i > 0, `expected the skill to contain: ${s}`);
  return i;
};

test('the rename flow re-shares the whiteboard after rejoining', () => {
  // Observed: the bot renamed itself in 4b, left and rejoined so Meet would take
  // the new name, and never re-shared. Leaving ends the presentation, but the
  // board KEEPS its content and update_whiteboard keeps succeeding — so the rest
  // of setup was written to a screen nobody could see, with no symptom.
  const start = idx('### 4b. Name');
  const rename = skill.slice(start, idx('### 4c. Voice'));
  const leave = rename.indexOf('`leave_call`');
  const rejoin = rename.indexOf('`join_call` with the SAME room id');
  const reshare = rename.indexOf('`share_whiteboard` again');
  assert.ok(leave < rejoin, 'leave must still come before rejoin');
  assert.ok(rejoin < reshare, 're-sharing comes after the rejoin');
  assert.match(rename.slice(reshare, reshare + 400), /nobody can see|cannot see|no one can see/i,
    'say why it is invisible, or the step reads as optional');
});

test('Step 3 warns that a share does not survive leaving', () => {
  const step3 = skill.slice(idx('## Step 3:'), idx('## Step 4:'));
  assert.match(step3, /does NOT survive leaving/);
  assert.match(step3, /screenshare_screenshot/, 'give a way to check rather than guess');
  // The original rule must survive: re-sharing an already-presented board is
  // disruptive, so this is an exception, not a licence to share every step.
  assert.match(step3, /Once per call, not once per step/);
});

test('the demo step puts its offer on the whiteboard', () => {
  // Every other step had a board. The demo arriving as bare speech left the
  // screen showing the Step 5 settings summary at the most interesting moment.
  const step6 = skill.slice(idx('## Step 6:'));
  assert.match(step6, /update_whiteboard/, 'the demo offer needs a board of its own');
  assert.ok(step6.indexOf('update_whiteboard') < step6.indexOf('Pick TWO or THREE'),
    'put it on the board as part of making the offer, not as an afterthought');
});

test('leaving and inviting are offered only AFTER the demo', () => {
  // The bug: Step 5 said "tell me when you're done and I'll drop off" one
  // sentence before the demo, so people took the exit and never saw the half of
  // the product that makes the bot worth keeping.
  const step5 = skill.slice(idx('## Step 5:'), idx('## Step 6:'));
  assert.doesNotMatch(step5, /I'll drop off/, 'the exit offer must not live in Step 5');
  assert.match(step5, /Do NOT offer to leave yet/);

  const step6 = skill.slice(idx('## Step 6:'));
  assert.match(step6, /I'll drop off/, 'it moved to the end of the demo step');
  assert.match(step6, /invite them in/);
  // ...and specifically after the demo has actually happened.
  assert.ok(step6.indexOf('Pick TWO or THREE') < step6.indexOf("I'll drop off"),
    'the exit offer comes after the demo, not before it');
  // "Before I go" did the same damage as the explicit offer.
  assert.match(step6, /Don't open with "before I go"/i);
});

test('the skill version was bumped, or none of this reaches an installed app', () => {
  // The installed skill file is app-owned and overwritten from this source on a
  // version change; without a bump, existing installs keep the old text.
  const m = main.match(/const SKILL_VERSION = '(\d+)'/);
  assert.ok(m, 'SKILL_VERSION must exist');
  assert.ok(Number(m[1]) >= 54, `SKILL_VERSION is ${m[1]}, expected >= 54 for these edits`);
});

test('image grids clear the header-cell background', () => {
  // A markdown table's first row IS its header row, so in both grids the IMAGES
  // land in <th> and the labels in <td> — and the board stylesheet fills th with
  // grey (#3c4043). Every emoji then sits in its own grey box with its label on
  // the normal background, which reads as broken or half-loaded art.
  for (const step of ['### 4d. Emoji set', '### 4e. Background']) {
    const start = idx(step);
    const body = skill.slice(start, start + 3000);
    const style = body.match(/set_whiteboard_style\("([^"]+)"\)/);
    assert.ok(style, `${step} should still set a style before drawing its grid`);
    assert.match(style[1], /th, td/, `${step}: header cells must be styled too, not just td`);
    assert.match(style[1], /background: transparent/, `${step}: clear the grey th fill`);
  }
});

test('the emoji step reads the set list instead of remembering one', () => {
  // redpanda arrived after this step was written, and appeared in the picker on
  // its own because the step uses list_visual_assets. A hardcoded list would
  // have quietly kept offering the old four — the failure being that nobody
  // notices a missing OPTION.
  const step = skill.slice(idx('### 4d. Emoji set'), idx('### 4e. Background'));
  assert.match(step, /list_visual_assets/);
  assert.match(step, /do not hardcode the list/i);
  assert.match(step, /redpanda/, 'the newest bundled set should be visible in the example');
  // Six options is two rows of three, not one row of six.
  assert.ok((step.match(/\|---\|---\|---\|/g) || []).length >= 2,
    'the example grid should show the real number of options, in rows of three');
});

test('the tutorial offers to GENERATE a set, by naming the skill that does it', () => {
  const step = skill.slice(idx('### 4d. Emoji set'), idx('### 4e. Background'));
  assert.match(step, /\/emoji-set/, 'name the skill — "with an image generator" is not actionable');
  assert.match(step, /dir:/, 'and the bring-your-own-folder path stays');
  // Honest about the dependency: the skill needs nanobanana on this machine.
  assert.match(step, /[Ww]ithout one/, 'say what to do when no generator is connected');
});
