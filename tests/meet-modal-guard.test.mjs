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

test('the unknown-modal report is guarded by _settingsDialogInProgress', () => {
  // The line that decides whether to dump DOM + notify the agent.
  // The condition contains nested parens (isVisible(dlg)), so match up to `) {`.
  const line = /const dlg = document\.querySelector\(MEET\.modals\.anyDialog\);\s*\n\s*if \((.*)\) \{/.exec(provider);
  assert.ok(line, 'the unknown-modal guard should still look like this');
  assert.match(line[1], /!_settingsDialogInProgress/,
    'while we drive a dialog, ANY open dialog is ours — do not report it as unhandled');
});

test('the guard is on the flag, not on the dialog title', () => {
  // Titles vary ("Settings", "Video settings"), so a title-based guard would have
  // missed Seth's case. Make sure nobody "simplifies" it back to a title check.
  const block = provider.slice(provider.indexOf('const dlg = document.querySelector(MEET.modals.anyDialog);'));
  const guard = block.slice(0, block.indexOf('\n', block.indexOf('if (')));
  // The FLAG is now named for the dialog (_settingsDialogInProgress), since two
  // flows drive it — so a bare /Settings/i search hits the flag itself. Drop the
  // flag name first, then assert nothing title-shaped remains: no aria-label
  // read, and no quoted "Settings" literal to compare against.
  const withoutFlag = guard.replace(/_settingsDialogInProgress/g, '');
  assert.ok(!/aria-label/i.test(withoutFlag), 'guard must not read the dialog title');
  assert.ok(!/['"][^'"]*settings/i.test(withoutFlag), 'guard must not compare a title literal');
});

test('the safety-net close still refuses to fire while the flow is running', () => {
  // Otherwise the sweeper would slam the dialog shut mid-walk (#416).
  assert.match(provider, /if \(settingsDlg && isVisible\(settingsDlg\) && !_settingsDialogInProgress\)/);
});

// #61: Meet's idle-timeout prompt. Unanswered, Meet EJECTS the bot — which is
// its normal state between turns. The sweeper must click "Stay in the call",
// never "Leave now".
test('the "Are you still there?" matcher hits Meet\'s wording', () => {
  const re = MEET.modals.stillThereRe;
  for (const s of ['Are you still there?', 'are you still there', 'ARE YOU STILL THERE?']) {
    assert.equal(re.test(s), true, `must match ${JSON.stringify(s)}`);
  }
  for (const s of ['Your call ends in 5 minutes', 'Others may see your video differently', '']) {
    assert.equal(re.test(s), false, `must NOT match ${JSON.stringify(s)}`);
  }
});

test('the still-there handler picks Stay, never Leave now', () => {
  const start = provider.indexOf('MEET.modals.stillThereRe');
  assert.ok(start > 0, 'the #61 handler should still live in dismissBlockingModals');
  const block = provider.slice(start, start + 1200);
  assert.match(block, /startsWith\('stay'\)/, 'must select the Stay affordance by prefix');
  const code = block.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/leave now/i.test(code), 'must never click Leave now');
  // Prefix match so "Stay in call" / "Stay in the call" both work.
  assert.equal(MEET.modals.stayInCallText.startsWith('stay'), true);
});

test('the still-there handler scans every open dialog, not just the first', () => {
  // It can appear alongside another toast-style dialog; querySelector would miss it.
  const start = provider.indexOf('MEET.modals.stillThereRe');
  const preceding = provider.slice(Math.max(0, start - 600), start);
  assert.match(preceding, /querySelectorAll\(MEET\.modals\.anyDialog\)/);
});

test('the flag is always cleared, even when the flow throws', () => {
  const finallyBlock = /finally \{\s*\n\s*_settingsDialogInProgress = false;/.exec(provider);
  assert.ok(finallyBlock, 'a thrown studio-sound flow must not wedge the sweeper off forever');
});

// Meet's Gemini notice: "Gemini is available to answer questions about meeting
// discussions…", with Learn more / Don't show again. We click the SUPPRESS
// button, not a close: closing brings it back next call, and a bot that joins
// all day would meet it every time.
test('the Gemini notice matcher hits its copy and nothing else', () => {
  const re = MEET.modals.geminiNoticeRe;
  assert.equal(re.test('Gemini is available to answer questions about meeting discussions.'), true);
  assert.equal(re.test('GEMINI IS AVAILABLE'), true);
  for (const other of ['Your call ends in 5 minutes', 'Are you still there?', '']) {
    assert.equal(re.test(other), false, `must NOT match ${JSON.stringify(other)}`);
  }
});

test('"Don\'t show again" matches whichever apostrophe Meet renders', () => {
  // Meet uses U+2019, not ASCII — comparing raw text would silently never match,
  // and the notice would sit there unanswered every call.
  const normalise = (s) => (s || '').replace(/[’ʼ]/g, "'").trim().toLowerCase();
  for (const label of ['Don’t show again', "Don't show again", 'DON’T SHOW AGAIN', '  Don’t show again  ']) {
    assert.equal(normalise(label), MEET.modals.dontShowAgainText, `must match ${JSON.stringify(label)}`);
  }
  assert.notEqual(normalise('Learn more'), MEET.modals.dontShowAgainText);
});

test('the Gemini handler clicks suppress, never the Learn more link', () => {
  const start = provider.indexOf('MEET.modals.geminiNoticeRe');
  assert.ok(start > 0, 'the Gemini arm should still live in dismissBlockingModals');
  // Reach back far enough to include the normaliser, which is declared just
  // above the loop that tests the marker.
  const block = provider.slice(Math.max(0, start - 600), start + 1400);
  const code = block.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(code, /dontShowAgainText/, 'must select the suppress button');
  assert.ok(!/learn more/i.test(code), 'must never click Learn more');
  // Normalising the apostrophe is what makes the match work at all.
  assert.match(code, /replace\(/, 'must normalise the apostrophe before comparing');
});
