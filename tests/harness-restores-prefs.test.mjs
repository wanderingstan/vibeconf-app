// harness-restores-prefs.test.mjs — the meet suite must put back what it borrows.
//
// setPref writes a bot's REAL config; there is no sandbox around a live bot's
// preferences. The Alice scenario changes the avatar background to prove the
// change takes effect, and for a long time simply left it there — so a bot's
// seeded background survived exactly until the first nightly, and the stored
// caption went on naming a picture that was no longer displayed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const meetTest = fs.readFileSync(join(root, 'scripts/meet-test.mjs'), 'utf8');
const lib = fs.readFileSync(join(root, 'scripts/meet-test-lib.mjs'), 'utf8');

test('the scenario reads the background before overwriting it', () => {
  const setAt = meetTest.indexOf('setBackground(COLORADO_SVG)');
  const readAt = meetTest.indexOf("getPref('avatarBackgroundSvg')");
  assert.ok(readAt !== -1, 'must capture the prior background');
  assert.ok(readAt < setAt, 'the read has to happen BEFORE the overwrite');
});

test('and restores it before the bot leaves', () => {
  const setAt = meetTest.indexOf('setBackground(COLORADO_SVG)');
  const restoreAt = meetTest.indexOf('setBackground(priorBackground)');
  assert.ok(restoreAt > setAt, 'the restore must come after the change');
  assert.match(meetTest, /if \(priorBackground !== undefined\)/,
    'never write undefined back over a real background');
});

test('the lib can actually read a preference', () => {
  assert.match(lib, /async getPref\(key\)/);
  assert.match(lib, /preferences\|\| \[\]|\(data\?\.preferences \|\| \[\]\)/);
});
