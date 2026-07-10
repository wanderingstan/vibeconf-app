// meet-modal-guard.test.mjs — the modal sweeper must not report OUR OWN dialog.
//
// setStudioSound() deliberately opens Meet's Settings dialog and walks it for
// several seconds. installCallHealthTick() runs dismissBlockingModals() every
// ~1s. Nothing stopped the sweeper from seeing that dialog, failing to recognise
// it, and telling the agent + the header banner:
//
//   Notice: an unhandled Meet dialog appeared: "Settings" (buttons: Close dialog
//   / Audio / Video / General / Captions / Meeting records)
//
// Observed in three separate logs on 2026-07-09, including Seth's — where the
// title was "VIDEO settings", which the old exact-match selector could not see at
// all, so the safety-net close couldn't rescue it either.
//
// google-meet-provider.js runs in the Meet page (it registers window listeners at
// load), so it can't be required here. The guard is pinned at the source. The
// selector IS requireable, so its semantics are tested against real aria-labels
// via a narrow matcher for the two attribute forms it uses.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MEET } = require('../electron-app/meet-selectors.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const provider = readFileSync(join(root, 'electron-app/google-meet-provider.js'), 'utf8');

// Evaluate a selector list of the two attribute forms we actually use —
// [aria-label="X" i] (exact) and [aria-label$=" X" i] (suffix) — against a label.
// Deliberately narrow: if someone adds a third form, this throws rather than
// silently passing.
function selectorMatchesLabel(selector, label) {
  return selector.split(',').some((part) => {
    const exact = /\[aria-label="([^"]+)"\s+i\]/.exec(part);
    if (exact) return label.toLowerCase() === exact[1].toLowerCase();
    const suffix = /\[aria-label\$="([^"]+)"\s+i\]/.exec(part);
    if (suffix) return label.toLowerCase().endsWith(suffix[1].toLowerCase());
    throw new Error(`unhandled selector form: ${part.trim()}`);
  });
}

test('the Settings-dialog selector matches every title Meet actually uses', () => {
  const sel = MEET.studioSound.settingsDialog;
  for (const label of ['Settings', 'settings', 'Video settings', 'Audio settings', 'VIDEO SETTINGS']) {
    assert.equal(selectorMatchesLabel(sel, label), true, `must match ${JSON.stringify(label)}`);
  }
});

test('it does not match unrelated dialogs', () => {
  const sel = MEET.studioSound.settingsDialog;
  for (const label of ['Your call ends soon', 'People', 'Foosettings', 'Settings saved', '']) {
    assert.equal(selectorMatchesLabel(sel, label), false, `must NOT match ${JSON.stringify(label)}`);
  }
});

test('the unknown-modal report is guarded by _studioSoundInProgress', () => {
  // The line that decides whether to dump DOM + notify the agent.
  // The condition contains nested parens (isVisible(dlg)), so match up to `) {`.
  const line = /const dlg = document\.querySelector\(MEET\.modals\.anyDialog\);\s*\n\s*if \((.*)\) \{/.exec(provider);
  assert.ok(line, 'the unknown-modal guard should still look like this');
  assert.match(line[1], /!_studioSoundInProgress/,
    'while we drive a dialog, ANY open dialog is ours — do not report it as unhandled');
});

test('the guard is on the flag, not on the dialog title', () => {
  // Titles vary ("Settings", "Video settings"), so a title-based guard would have
  // missed Seth's case. Make sure nobody "simplifies" it back to a title check.
  const block = provider.slice(provider.indexOf('const dlg = document.querySelector(MEET.modals.anyDialog);'));
  const guard = block.slice(0, block.indexOf('\n', block.indexOf('if (')));
  assert.ok(!/aria-label|Settings/i.test(guard), 'guard must not depend on the dialog title');
});

test('the safety-net close still refuses to fire while the flow is running', () => {
  // Otherwise the sweeper would slam the dialog shut mid-walk (#416).
  assert.match(provider, /if \(settingsDlg && isVisible\(settingsDlg\) && !_studioSoundInProgress\)/);
});

test('the flag is always cleared, even when the flow throws', () => {
  const finallyBlock = /finally \{\s*\n\s*_studioSoundInProgress = false;/.exec(provider);
  assert.ok(finallyBlock, 'a thrown studio-sound flow must not wedge the sweeper off forever');
});
