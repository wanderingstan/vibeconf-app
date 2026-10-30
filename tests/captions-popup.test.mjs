// captions-popup.test.mjs: Meet's new captions control (2026-10-22).
//
// Meet replaced its "Turn on captions" / "Turn off captions" toolbar toggle
// with a "Captions and translation" button that opens a pop-up; the toggle is
// inside it ("Turn on captions" / "Turn off live captions"). The old code never
// found a button to click (the bot sat deaf for 60s, then escalated) and, once
// a person turned captions on, never saw them as on, so the 🙉 face stayed.
// The toolbar button's aria-pressed is the state now. These run the real
// helpers against a fake page shaped like the live one (inspected on Charlie's
// call, cgj-kfzh-yvy).
//
// Run: node --test tests/captions-popup.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MEET } = require('../packages/calls/providers/meet-selectors.js');
const src = readFileSync(new URL('../packages/calls/providers/google-meet-provider.js', import.meta.url), 'utf8');
const START = src.indexOf("// ── Captions: Meet's old toggle and its new pop-up");
const END = src.indexOf('// The last-resort aria-label match for the JOIN button.');
assert.ok(START > 0 && END > START, 'could not slice the caption helpers');

function newMeet({ on = false, label = 'Captions and translation', icon = 'translate_cc' } = {}) {
  const page = { on, open: false, toolbarClicks: 0, toggleClicks: 0 };
  const toolbar = {
    getAttribute: (a) => ({ 'aria-pressed': String(page.on), 'aria-expanded': String(page.open), 'aria-label': label })[a] ?? null,
    querySelector: (s) => (s === 'i' ? { textContent: icon } : null),
    click: () => { page.toolbarClicks++; page.open = !page.open; },
  };
  const toggle = { click: () => { page.toggleClicks++; page.on = !page.on; } };
  const dialog = {
    getAttribute: (a) => (a === 'aria-label' ? label : null),
    querySelector: (s) => (s === 'button:not([aria-haspopup])' ? toggle : null),
  };
  const document = {
    querySelectorAll: (s) => {
      if (s === 'button[aria-haspopup="dialog"][aria-pressed]') return [toolbar];
      if (s === '[role="dialog"]') return page.open ? [dialog] : [];
      return [];
    },
    querySelector: (s) => (s === `button[aria-label="${MEET.captions.toolbarLabelEn}"]` && label === MEET.captions.toolbarLabelEn ? toolbar : null),
  };
  const helpers = new Function('MEET', 'document', 'findByAriaLabel', 'console', 'setTimeout', `
    ${src.slice(START, END)}
    return { captionsState, captionsToggleAvailable, setCaptions, findCaptionsToolbarButton };
  `)(MEET, document, () => null, { log() {}, warn() {} }, setTimeout);
  return { page, ...helpers };
}

test('the toolbar button\'s aria-pressed is the captions state', () => {
  assert.equal(newMeet({ on: false }).captionsState(), 'off');
  assert.equal(newMeet({ on: true }).captionsState(), 'on');
  assert.equal(newMeet().captionsToggleAvailable(), true);
});

test('found by its icon, so a localized label still works', () => {
  const m = newMeet({ label: 'Subtítulos y traducción', icon: 'translate_cc' });
  assert.ok(m.findCaptionsToolbarButton());
  assert.equal(m.captionsState(), 'off');
});

test('turning captions on: open the pop-up, click its toggle, close the pop-up', async () => {
  const m = newMeet({ on: false });
  assert.equal(await m.setCaptions(true), true);
  assert.equal(m.page.on, true);
  assert.equal(m.page.toggleClicks, 1);
  assert.equal(m.page.open, false, 'the pop-up is closed again');
  assert.equal(m.captionsState(), 'on');
});

test('already on: nothing is clicked, so captions can never be toggled the wrong way', async () => {
  const m = newMeet({ on: true });
  assert.equal(await m.setCaptions(true), false);
  assert.equal(m.page.toolbarClicks + m.page.toggleClicks, 0);
});

test('turning captions off (the stall recovery\'s first half) uses the same pop-up', async () => {
  const m = newMeet({ on: true });
  assert.equal(await m.setCaptions(false), true);
  assert.equal(m.page.on, false);
  assert.equal(m.page.open, false);
});

test('every caption check in the provider goes through the helpers', () => {
  // Outside the helpers and the diagnostics dump, nothing reads the old labels directly.
  const rest = src.slice(0, START) + src.slice(END).replace(/function dumpCaptionDiagnostics[\s\S]*?\n}\n/, '');
  const direct = rest.split('\n').filter((l) => /MEET\.captions\.(enable|disable)Label|MEET\.captions\.onSelector/.test(l)
    && !/inCallUI|findByAriaLabel\(MEET\.captions\.(enable|disable)LabelEn\) \|\|$/.test(l));
  assert.deepEqual(direct.filter((l) => !/^\s+findByAriaLabel\(MEET\.captions\.(enable|disable)LabelEn\) \|\|$/.test(l)), []);
});
