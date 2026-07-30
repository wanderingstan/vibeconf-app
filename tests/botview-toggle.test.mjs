// botview-toggle.test.mjs — 👀 is available before a call, not only during one.
//
// The bot's view is hidden by default, so 👀 is the only way to see what its
// browser is doing. That matters BEFORE a call too — ⌘⇧L navigates somewhere
// first, so it cannot show you the CURRENT state. Stan hit exactly that.
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

const rowButtons = (blockClass) => {
  const block = html.slice(html.indexOf(`class="${blockClass}"`));
  const row = block.slice(block.indexOf('class="join-row"'), block.indexOf('</div>', block.indexOf('class="join-row"')) + 6);
  return row;
};

test('both the pre-call and in-call rows carry a bot-view toggle', () => {
  assert.match(rowButtons('hero-precall'), /botview-toggle-btn/, 'pre-call row needs one');
  assert.match(rowButtons('hero-incall'), /botview-toggle-btn/, 'in-call row needs one');
});

test('the toggle leads its row, left of the main button', () => {
  for (const [block, main] of [['hero-precall', 'id="joinBtn"'], ['hero-incall', 'id="leaveCallBtn"']]) {
    const row = rowButtons(block);
    const toggleAt = row.indexOf('botview-toggle-btn');
    const mainAt = row.indexOf(main);
    assert.ok(toggleAt > 0 && mainAt > 0, `${block}: both buttons should be present`);
    assert.ok(toggleAt < mainAt, `${block}: the toggle must come before the main button`);
  }
});

test('the two buttons are driven as a set, not one by id', () => {
  // A single getElementById would leave the other button stuck showing 👀 while
  // the view is popped out, so its click would read as "open" when it closes.
  assert.match(js, /querySelectorAll\('\.botview-toggle-btn'\)/);
  assert.ok(!/getElementById\('botViewToggleBtn'\)/.test(js),
    'the single-element lookup should be gone');
  // The label routine must iterate them.
  const fn = js.slice(js.indexOf('function applyBotViewLabel'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /for \(const btn of botViewToggleBtns\)/);
});
