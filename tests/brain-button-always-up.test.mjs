// brain-button-always-up.test.mjs — 🧠 is up whether or not a call is running,
// exactly like 👀 (#547).
//
// It used to live ONLY inside .hero-incall, so it disappeared the instant the
// call ended. That is the worst possible moment to lose it: after-call work
// (issue filing, call notes) runs right then, the avatar keeps reacting, and
// there is no other affordance in the panel saying what the agent is up to.
// Stan wanted to check on exactly that and found the button gone.
//
// The fix is deliberately NOT a third visibility rule ("also show it during
// wrap-up"). 🧠 and 👀 are the same kind of control — "look inside the bot" — so
// 🧠 was given 👀's existing treatment verbatim: one button per row, both driven
// as a set from panel.js. These tests pin the two halves that would silently
// rot: a row losing its button, and a click handler bound by id (which reaches
// only ONE of the two elements, leaving the other inert).
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'electron-app/renderer/panel.html'), 'utf8');
const js = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');

// Same slicing as botview-toggle.test.mjs: the pre-call and in-call controls are
// separate blocks the stylesheet swaps, so "is the button reachable in state X"
// is answered by "is it in block X's join-row".
// Comments are stripped first: these rows are heavily commented, and the prose
// names the very class selectors being searched for ("panel.js drives them as a
// set via .botview-toggle-btn"). Without this, an ordering assertion matches a
// sentence rather than a <button> and reports the opposite of the truth.
const rowButtons = (blockClass) => {
  const block = html.slice(html.indexOf(`class="${blockClass}"`));
  const row = block.slice(block.indexOf('class="join-row"'), block.indexOf('</div>', block.indexOf('class="join-row"')) + 6);
  return row.replace(/<!--[\s\S]*?-->/g, '');
};

test('both the pre-call and in-call rows carry a brain button', () => {
  assert.match(rowButtons('hero-precall'), /brain-open-btn/, 'pre-call row needs one');
  assert.match(rowButtons('hero-incall'), /brain-open-btn/, 'in-call row needs one');
});

test('🧠 and 👀 have the SAME visibility rule, not two rules', () => {
  // This is the actual claim of #547. If someone later re-scopes one of them —
  // hides 🧠 outside a call again, or gates it on wrap-up — the two lists stop
  // matching and this fails, which is the intended alarm.
  for (const block of ['hero-precall', 'hero-incall']) {
    const row = rowButtons(block);
    assert.equal(/brain-open-btn/.test(row), /botview-toggle-btn/.test(row),
      `${block}: the brain and eyes buttons must appear together`);
  }
  // Neither may carry an inline display:none or a state attribute of its own —
  // "same rule" has to mean the rows are the only thing deciding.
  for (const cls of ['brain-open-btn', 'botview-toggle-btn']) {
    for (const m of html.matchAll(new RegExp(`<button[^>]*${cls}[^>]*>`, 'g'))) {
      assert.doesNotMatch(m[0], /style="display:none"/, `${cls} must not hide itself`);
    }
  }
});

test('🧠 leads its row in both states, left of 👀', () => {
  // Placement is part of "same treatment": the pair should read identically
  // before and during a call, so the eye doesn't have to re-find them.
  for (const [block, main] of [['hero-precall', 'id="joinBtn"'], ['hero-incall', 'id="leaveCallBtn"']]) {
    const row = rowButtons(block);
    const brainAt = row.indexOf('brain-open-btn');
    const eyesAt = row.indexOf('botview-toggle-btn');
    const mainAt = row.indexOf(main);
    assert.ok(brainAt > 0 && eyesAt > 0 && mainAt > 0, `${block}: all three should be present`);
    assert.ok(brainAt < eyesAt, `${block}: 🧠 sits left of 👀`);
    assert.ok(eyesAt < mainAt, `${block}: both sit left of the main button`);
  }
});

test('the two brain buttons are driven as a set, not one by id', () => {
  // getElementById('openBrainBtn') returns the in-call element only, so the
  // pre-call 🧠 would render and do nothing when clicked — a dead control is
  // worse than the missing one this issue started with.
  assert.match(js, /querySelectorAll\('\.brain-open-btn'\)/);
  assert.ok(!/getElementById\('openBrainBtn'\)/.test(js),
    'the single-element lookup should be gone');
});

test('only ONE of the pair keeps an id, so nothing binds by it twice', () => {
  // Mirrors 👀 (id on the in-call instance, none on the pre-call one). Two
  // elements sharing an id would be invalid HTML and would make any future
  // getElementById silently pick whichever came first.
  assert.equal((html.match(/id="openBrainBtn"/g) || []).length, 1);
  assert.equal((html.match(/id="botViewToggleBtn"/g) || []).length, 1);
});
