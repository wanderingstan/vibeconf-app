// meet-close-dialogs.test.mjs — dialogs whose only control is Close (#141).
//
// Meet's "Your screen is still visible to others" toast has exactly one button,
// Close, and the sweeper knew only "Got it" and "Dismiss". On the 2026-07-29
// call it sat over the UI for 13 minutes covering the captions, and re-dumped
// its DOM every 15s — ~82KB of the same thing into the session log.
//
// It is also the dialog most likely to be sitting over Meet's Stop-presenting
// button, which is the leading explanation for #68's stop click not landing.
//
// Run: node --test tests/meet-close-dialogs.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const provider = readFileSync(join(root, 'electron-app/google-meet-provider.js'), 'utf8');
const selectorsSrc = readFileSync(join(root, 'electron-app/meet-selectors.js'), 'utf8');
const sel = require('../electron-app/meet-selectors.js');
const MODALS = (sel.MEET || sel).modals;

test('the toast is matched by its words, never by a generated attribute', () => {
  // jsname/jscontroller are minified build output and rotate whenever Google
  // rebuilds. This file already lost speaker detection once by indexing on
  // generated structure ("3 empty divs"), so text and aria-label are the only
  // durable contract.
  assert.ok(MODALS.stillVisibleRe.test('Your screen is still visible to others. Click to resume presenting.'));
  assert.ok(!MODALS.stillVisibleRe.test('Your call ends in 5 minutes'));
  // Comment-stripped: the prose here explains WHY we don't use jsname, and an
  // unstripped check trips on its own explanation. (Third time this pattern has
  // bitten in this suite — assertions over source have to read code, not words
  // about code.)
  const block = provider.slice(provider.indexOf('#141: "Your screen is still visible'));
  const code = block.slice(0, block.indexOf('// General case')).replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /jsname|jscontroller|jsaction/,
    'a generated attribute here is a time bomb — match on text');
});

test('a close affordance is found by label, not position', () => {
  const fn = provider.slice(provider.indexOf('function findCloseAffordance'));
  const body = fn.slice(0, fn.indexOf('\n}')).replace(/^\s*\/\/.*$/gm, '');
  assert.match(body, /aria-label/);
  assert.match(body, /textContent/);
  assert.doesNotMatch(body, /jsname/);
  assert.match(body, /isVisible\(b\)/, 'an invisible button is not an affordance');
});

test('the general rule fires ONLY when there is nothing to decide', () => {
  // This is the whole safety argument. A dialog offering Leave/Join, Stay/Leave
  // now, or Cancel/Confirm is asking a question, and answering it for the user
  // can cost the call — those must keep falling through to their own handlers.
  const block = provider.slice(provider.indexOf('// General case (#141)'));
  const body = block.slice(0, block.indexOf('// No "Got it" found'));
  assert.match(body, /buttons\.every\(closeish\)/, 'every visible button must be close-ish');
  assert.match(body, /buttons\.length > 0/, 'a dialog with no buttons is not ours to close');
  assert.match(body, /isRecordingConsent/, 'the recording-consent dialog is handled elsewhere');
  assert.match(body, /_settingsDialogInProgress/, 'and never a Settings dialog we opened ourselves');
});

test('close-ish labels stay conservative', () => {
  // Anything that commits to an outcome must NOT be in this list.
  for (const safe of ['close', 'dismiss', 'ok']) {
    assert.ok(MODALS.closeTexts.includes(safe), `${safe} should count as "just make it go away"`);
  }
  for (const decision of ['leave', 'leave now', 'join now', 'stay', 'cancel', 'confirm', "don't show again"]) {
    assert.ok(!MODALS.closeTexts.includes(decision),
      `${decision} decides something — the general rule must not click it`);
  }
});

test('the unknown-modal dump is capped per title, not per 15 seconds', () => {
  // The 13-minute toast produced ~52 identical 2.5KB dumps. One sample is all
  // the dev team needs, and the session log is what we read to debug everything
  // else — so a stuck dialog must not drown it.
  assert.match(provider, /const _unknownModalDumped = new Set\(\)/);
  const dump = provider.slice(provider.indexOf('const dlg = document.querySelector(MEET.modals.anyDialog)'));
  const body = dump.slice(0, dump.indexOf('\n  return false;'));
  assert.match(body, /_unknownModalDumped\.has\(title\)/, 'a repeat title must short-circuit');
  assert.match(body, /_unknownModalDumped\.add\(title\)/);
  // The agent notification stays once-per-title as it already was — it is a
  // different budget from the DOM sample and must not be collapsed into it.
  assert.match(body, /_unknownModalNotified\.has\(title\)/);
});
