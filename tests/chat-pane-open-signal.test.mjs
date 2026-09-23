// chat-pane-open-signal.test.mjs — "is the chat pane open?" must mean the chat
// panel is actually showing, not that a chat input exists somewhere (#572).
//
// Meet keeps the chat composer mounted, hidden, after the side panel switches
// back to People. `isChatPaneOpen()` used to be `!!getChatInput()`, so from the
// second send of a call onward it answered "already open". The flow skipped
// opening chat, typed into the hidden input (which posts, by accident), and then
// restorePeoplePane clicked People while People was already showing, which
// toggled it SHUT. Seen on 3 of 3 sends on 2026-09-21 (two-wumx-ifj):
//
//   [chat] Chat pane already open
//   [electron-meet] sendChat via button — sent: true
//   [chat] People pane not visible after attempt 1 — retrying
//   [chat] ✓ People pane restored (3 visible tiles) after attempt 2
//
// The provider requires electron, so, like the other chat tests, slice the
// functions out verbatim and run them against a fake document.
//
// Run: node --test tests/chat-pane-open-signal.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'electron-app/google-meet-provider.js'), 'utf8');

// Pull one top-level function out by name: from its declaration up to the next
// line that closes a top-level block.
function fn(name) {
  const re = new RegExp(`^(async )?function ${name}\\(`, 'm');
  const m = re.exec(src);
  assert.ok(m, `could not find ${name} in the provider`);
  const endIdx = src.indexOf('\n}\n', m.index);
  return src.slice(m.index, endIdx + 2);
}

const SEL = { input: 'CHAT_INPUT', toggle: 'CHAT_TOGGLE', tile: 'PEOPLE_TILE' };

function el({ visible = true, attrs = {} } = {}) {
  const e = {
    attrs: { ...attrs },
    visible,
    clicks: 0,
    getClientRects() { return this.visible ? [{}] : []; },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    click() { this.clicks++; if (this.onClick) this.onClick(); },
  };
  return e;
}

function build(doc, extra = {}) {
  const body = [
    fn('getChatToggle'), fn('getChatInput'), fn('isChatPaneOpen'),
    fn('isChatPaneToggleExpanded'), fn('visiblePeopleTileCount'), fn('restorePeoplePane'),
  ].join('\n');
  return new Function('document', 'MEET', 'console', 'delay', 'findPeopleButton', `
    ${body}
    return { getChatInput, isChatPaneOpen, restorePeoplePane };
  `)(
    doc,
    { chat: { input: SEL.input, toggle: SEL.toggle }, people: { tile: SEL.tile } },
    { log() {}, warn() {} },
    () => Promise.resolve(),
    extra.findPeopleButton || (() => null),
  );
}

function fakeDoc({ inputs = [], toggle = null, tiles = [] }) {
  return {
    querySelector(sel) {
      if (sel === SEL.input) return inputs[0] || null;
      if (sel === SEL.toggle) return toggle;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === SEL.input) return inputs;
      if (sel === SEL.tile) return tiles;
      return [];
    },
  };
}

test('#572 a hidden leftover chat input does NOT count as the pane being open', () => {
  const { isChatPaneOpen } = build(fakeDoc({
    inputs: [el({ visible: false })],
    toggle: el({ attrs: { 'aria-expanded': 'false' } }),
  }));
  assert.equal(isChatPaneOpen(), false);
});

test('an input that is on screen but whose toggle says collapsed is not open either', () => {
  const { isChatPaneOpen } = build(fakeDoc({
    inputs: [el({ visible: true })],
    toggle: el({ attrs: { 'aria-expanded': 'false' } }),
  }));
  assert.equal(isChatPaneOpen(), false);
});

test('open = toggle expanded AND input visible', () => {
  const { isChatPaneOpen } = build(fakeDoc({
    inputs: [el({ visible: true })],
    toggle: el({ attrs: { 'aria-expanded': 'true' } }),
  }));
  assert.equal(isChatPaneOpen(), true);
});

test('a lazy input that has not rendered yet is still "not open" (Stage 2 keeps waiting)', () => {
  const { isChatPaneOpen } = build(fakeDoc({
    inputs: [],
    toggle: el({ attrs: { 'aria-expanded': 'true' } }),
  }));
  assert.equal(isChatPaneOpen(), false);
});

test('getChatInput prefers the visible input over a hidden leftover that comes first', () => {
  const hidden = el({ visible: false });
  const shown = el({ visible: true });
  const { getChatInput } = build(fakeDoc({ inputs: [hidden, shown] }));
  assert.equal(getChatInput(), shown);
});

test('#572 restorePeoplePane does not click People when People is already showing', async () => {
  const people = el();
  const { restorePeoplePane } = build(
    fakeDoc({ tiles: [el(), el()], toggle: el({ attrs: { 'aria-expanded': 'false' } }) }),
    { findPeopleButton: () => people },
  );
  assert.equal(await restorePeoplePane(), true);
  assert.equal(people.clicks, 0, 'clicking an already-open People panel toggles it shut');
});

test('restorePeoplePane still clicks People when chat is the open panel', async () => {
  const tiles = [];
  const chatToggle = el({ attrs: { 'aria-expanded': 'true' } });
  const people = el();
  // Clicking People swaps the side panel: tiles appear, chat collapses.
  people.onClick = () => { tiles.push(el(), el()); chatToggle.attrs['aria-expanded'] = 'false'; };
  const { restorePeoplePane } = build(
    fakeDoc({ tiles, toggle: chatToggle }),
    { findPeopleButton: () => people },
  );
  assert.equal(await restorePeoplePane(), true);
  assert.equal(people.clicks, 1, 'restored on the FIRST attempt');
});
