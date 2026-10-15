// onboarding-one-screen.test.mjs — setup is one card, one sentence, three paths.
//
// The guided setup used to walk nine questions (language, name, voice,
// personality, emoji, background, whiteboard style, skills, after-call), and
// users said it took too long. Stan decided on 2026-10-15 (call
// suc-skmh-yqt-20261015T192124Z) to replace it: the bot pre-picks everything,
// shows it on ONE whiteboard card, says ONE sentence, and the user picks one of
// three paths. The fast path asks nothing at all.
//
// A skill file is prose, so the walk-through could creep back one "quick
// question" at a time with nothing failing. These pin the shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skill = readFileSync(join(root, 'mcp-server/onboarding-call-skill.md'), 'utf8');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

const section = (from, to) => {
  const a = skill.indexOf(from);
  const b = to ? skill.indexOf(to) : skill.length;
  assert.ok(a > -1 && b > a, `expected the skill to contain ${from} before ${to}`);
  return skill.slice(a, b);
};
const step2 = section('## Step 2:', '## Step 3:');
const step3 = section('## Step 3:', '## Step 4:');
const step4 = section('## Step 4:', '## Step 5:');
const step5 = section('## Step 5:', '## Step 6:');

test('Step 4 is no longer a lettered walk through every setting', () => {
  assert.doesNotMatch(skill, /^### 4[a-z]\./m, 'no 4a-4i sub-steps');
  assert.doesNotMatch(skill, /Work through the steps below \*\*in order\*\*/);
  // The know-how is kept, as a reference to run ONE section from.
  const ref = section('## Changing one setting (reference)');
  for (const t of ['Language', 'Name', 'Voice', 'Personality / role', 'Emoji set',
    'Background', 'Whiteboard style', 'What you can do', 'After-call routine']) {
    assert.match(ref, new RegExp(`^### ${t}`, 'm'), `reference keeps the ${t} section`);
  }
  assert.match(ref, /Run ONE of these[^]*never as a sequence/);
});

test('Step 2 picks every default without asking', () => {
  assert.match(step2, /No questions in this step/);
  for (const row of ['Name', 'Language', 'Voice', 'Personality', 'Emoji set', 'Background',
    'Whiteboard style', 'After-call routine']) {
    assert.match(step2, new RegExp(`^\\| ${row} \\|`, 'm'), `a default for ${row}`);
  }
  // Background reuses the random preset main.js seeds for every new bot.
  assert.match(step2, /avatarBackgroundCaption[^|]*random preset/);
  // Either form of the seed: the original brand-new-only check, or #817's
  // (new bots get a random background) marker-aware one, so this PR and that
  // one can land in either order.
  assert.match(main, /if \(isBrandNewProfile && !profileStore\.get\('avatarBackgroundSvg'\)\)|shouldSeedRandomBackground\(/);
});

test('ONE card, sized for one unscrollable screen, inviting changes', () => {
  assert.match(step3, /share_whiteboard` first, then `update_whiteboard` with the card/);
  assert.equal((step3.match(/update_whiteboard/g) || []).length, 2,
    'one update in the step (plus the warning that update alone does not present)');
  assert.match(step3, /fit one 800px screen: the whiteboard cannot scroll/);
  assert.match(step3, /Just tell me if you want to change any of these/);
  // The example card is compact: one row per setting, nothing more.
  const rows = step3.split('\n').filter((l) => /^> \| \S/.test(l) && !/^> \| \| \|/.test(l));
  assert.ok(rows.length <= 10, `the example card has ${rows.length} rows; keep it to one screen`);
});

test('ONE spoken sentence, not a readout', () => {
  assert.match(step4, /ONE short phrase\. Not a readout of the settings/);
  assert.match(step4, /"I've put all my settings on the whiteboard\. Let me know if you want to change anything,\s+> get a demo, or get right to work\."/);
  assert.equal((step4.match(/^> "/gm) || []).length, 1, 'exactly one scripted line on a first run');
});

test('three paths: get to work, change one thing, demo', () => {
  assert.match(step5, /1\. \*\*Get right to work\.\*\*/);
  assert.match(step5, /2\. \*\*Change one thing\.\*\*[^]*Changing one\s+setting/);
  assert.match(step5, /3\. \*\*A demo\.\*\* Step 6/);
  assert.match(skill, /^## Step 6: The demo/m);
});

test('the fast path is zero questions', () => {
  assert.match(skill, /\*\*The fast\s+path asks zero questions\.\*\*/);
  const fast = step5.slice(step5.indexOf('1. **Get right to work'), step5.indexOf('2. **Change'));
  assert.match(fast, /say\s+nothing at all/, 'silence is the fast path, not a timeout to retry');
  assert.match(fast, /Don't confirm, don't recap, don't ask\s+a follow-up/);
  assert.match(fast, /zero-question path/);
  // An English locale sets the caption language without asking.
  assert.match(step2, /\*\*English\*\*[^]*No question\./);
  // After a change, don't march them on to the next item.
  assert.match(step5, /Don't offer the next item/);
});

test('the name is right before joining; leave+rejoin only for a requested rename', () => {
  // Meet takes the display name at join. Stan (2026-10-15): start with a random
  // name; leave and rejoin only when the user asks to change it.
  const step1 = section('## Step 1:', '## Step 2:');
  assert.match(step1, /name must be right BEFORE you join/);
  assert.match(step1, /suggest_bot_names` with `count: 1`/);
  assert.match(step1, /Do not leave and\s+rejoin for a name nobody asked for/);
  const name = section('### Name', '### Voice');
  assert.match(name, /A rename the user asked for is the one time a leave and rejoin is the\s+normal procedure/);

  // The app seeds a brand-new default-profile bot's name before any join, so
  // its very first tile is not "Unnamed bot" — and never overrides a --bot-name
  // or a stray instance of an existing profile.
  const block = main.slice(main.indexOf('const isBrandNewProfile'), main.indexOf('#366: inherit'));
  assert.match(block,
    /if \(isBrandNewProfile && isDefaultInstance && !cliArgs\['bot-name'\] && !profileStore\.get\('botName'\)\)/);
  assert.match(block, /profileStore\.set\('botName', randomBotName\(\{ taken: takenBotNames\(\) \}\)\)/);
});

test('the skill got shorter, not longer', () => {
  const lines = skill.split('\n').length;
  assert.ok(lines < 668, `the skill is ${lines} lines; it was 668 before the one-screen rewrite`);
});

test('the skill version was bumped, or installed apps keep the nine-question walk', () => {
  const m = main.match(/const SKILL_VERSION = '(\d+)'/);
  assert.ok(m && Number(m[1]) >= 67, `SKILL_VERSION is ${m && m[1]}, expected >= 67`);
});
