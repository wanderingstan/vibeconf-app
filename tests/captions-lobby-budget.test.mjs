// captions-lobby-budget.test.mjs — a bot admitted from Meet's lobby must not
// arrive deaf (#497).
//
// The failure, seen live on three calls (2026-08-15, -19, -21): the caption
// retry budget started at the JOIN CLICK, not at admission. A guest bot sits in
// the waiting room for as long as a human takes to press admit — arbitrarily
// long — and every retry fired against a lobby that has no captions button at
// all. All three rounds were spent on nothing; the bot gave up on the very
// round Meet finally rendered the real UI, and then nothing was watching, so a
// human clicking CC by hand could not rescue it either.
//
// Two invariants under test:
//   (a) a round with no button to click costs no budget, and a lobby of any
//       length is survivable;
//   (b) escalating deaf arms a watcher instead of ending the story.
//
// The code under test lives in a renderer script that requires electron, so —
// as in chat-scrape-attribution.test.mjs and meter-level-speaking.test.mjs — we
// slice it out and run it verbatim against a fake DOM and a virtual clock. If
// the slice boundaries move, the slice fails loudly.
//
// Run: node --test tests/captions-lobby-budget.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'electron-app/google-meet-provider.js'), 'utf8');
const { MEET } = require('../electron-app/meet-selectors.js');

const CLICK_START = src.indexOf('let captionsClickArmed = false;');
const CLICK_END = src.indexOf('\n// Diagnostic: snapshot the full page DOM');
const CLASS_START = src.indexOf('class CaptionScraper {');
const CLASS_END = src.indexOf('const captionScraper = new CaptionScraper();');
assert.ok(CLICK_START > 0 && CLICK_END > CLICK_START, 'could not slice clickCaptionsWhenReady out of the provider');
assert.ok(CLASS_START > 0 && CLASS_END > CLASS_START, 'could not slice CaptionScraper out of the provider');

const CALL_EVENTS = { captionsState: 'captions-state', captionStall: 'caption-stall' };

// --- virtual clock --------------------------------------------------------
// Real time would make a 90-second lobby a 90-second test. Everything under
// test is timer-driven, so drive the timers.
function makeClock() {
  let now = 1_000_000; // non-zero: the code treats 0 as "never"
  let nextId = 1;
  const timers = new Map();
  const add = (fn, ms, repeat) => { const id = nextId++; timers.set(id, { fn, ms: Math.max(1, ms | 0), next: now + Math.max(1, ms | 0), repeat }); return id; };
  const clear = (id) => { timers.delete(id); };
  return {
    Date: { now: () => now },
    setInterval: (fn, ms) => add(fn, ms, true),
    setTimeout: (fn, ms) => add(fn, ms, false),
    clearInterval: clear,
    clearTimeout: clear,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let due = null;
        for (const [id, t] of timers) if (t.next <= end && (!due || t.next < due[1].next)) due = [id, t];
        if (!due) break;
        now = due[1].next;
        if (due[1].repeat) due[1].next = now + due[1].ms; else timers.delete(due[0]);
        due[1].fn();
      }
      now = end;
    },
  };
}

// --- fake Meet page -------------------------------------------------------
// Three states matter: the LOBBY (no toolbar, no captions button), ADMITTED
// (toolbar, "Turn on captions"), and CAPTIONS ON ("Turn off captions").
function makeWorld() {
  const clock = makeClock();
  const page = { admitted: false, ccButton: false, captionsOn: false, clicks: 0 };
  const events = [];
  const warnings = [];

  const btn = (onClick) => ({ click: onClick, getAttribute: () => null });
  const findByAriaLabel = (label) => {
    if (label === MEET.captions.enableLabelEn) {
      return page.admitted && page.ccButton && !page.captionsOn
        ? btn(() => { page.clicks++; })
        : null;
    }
    if (label === MEET.captions.disableLabelEn) {
      return page.admitted && page.captionsOn ? btn(() => { page.captionsOn = false; }) : null;
    }
    return null; // Spanish labels / More options: absent in this fixture
  };
  const document = {
    querySelector(sel) {
      if (sel === MEET.people.buttonFallback || sel === MEET.chat.toggle) return page.admitted ? {} : null;
      if (sel === MEET.captions.onSelector) return page.captionsOn ? {} : null;
      return null; // no caption region, no dialogs
    },
    querySelectorAll: () => [],
  };
  const console_ = {
    log: () => {},
    warn: (...a) => { warnings.push(a.join(' ')); },
    error: () => {},
  };
  const meetProvider = { emit: (ev, payload) => { events.push({ ev, payload }); } };
  const deafEvents = () => events.filter(e => e.ev === CALL_EVENTS.captionsState && e.payload.on === false);
  const hearingEvents = () => events.filter(e => e.ev === CALL_EVENTS.captionsState && e.payload.on === true);

  const deps = [
    'MEET', 'document', 'console', 'findByAriaLabel', 'isVisible', 'visiblePeopleTileCount',
    'ipcRenderer', 'meetProvider', 'CALL_EVENTS', 'MutationObserver',
    'Date', 'setInterval', 'setTimeout', 'clearInterval', 'clearTimeout',
  ];
  const args = [
    MEET, document, console_, findByAriaLabel, () => true, () => 0,
    { send: () => {} }, meetProvider, CALL_EVENTS,
    // The observer only ever fires attempt() again; the safety poll covers the
    // same ground on this fake page, so a no-op observer is honest here.
    class { observe() {} disconnect() {} },
    clock.Date, clock.setInterval, clock.setTimeout, clock.clearInterval, clock.clearTimeout,
  ];

  // dumpCaptionDiagnostics is a pure logger; keep it real enough to count.
  const load = new Function(...deps, `
    function dumpCaptionDiagnostics(reason) { console.warn('[CC-diag] ' + reason); }
    function inCallToolbarPresent() {
      return !!document.querySelector(MEET.people.buttonFallback) ||
        !!document.querySelector(MEET.chat.toggle);
    }
    ${src.slice(CLICK_START, CLICK_END)}
    ${src.slice(CLASS_START, CLASS_END)}
    return { clickCaptionsWhenReady, CaptionScraper };
  `);
  const { clickCaptionsWhenReady, CaptionScraper } = load(...args);

  return { page, clock, events, warnings, deafEvents, hearingEvents, clickCaptionsWhenReady, CaptionScraper };
}

// --- (a) the budget counts attempts, not elapsed time ---------------------

test('a lobby longer than the old 90s budget does not make the bot deaf', () => {
  const w = makeWorld();
  const scraper = new w.CaptionScraper();
  let ready = 0;
  scraper.onReady = () => { ready++; };
  scraper.start();

  // Four minutes in the waiting room — well past the old 30+40+50s budget.
  w.clock.advance(240_000);
  assert.equal(w.deafEvents().length, 0, 'rounds spent in the lobby must not exhaust the budget');

  // The host finally presses admit and the real toolbar renders.
  w.page.admitted = true;
  w.page.ccButton = true;
  w.clock.advance(30_000);          // the in-flight round ends and clicks for real
  assert.ok(w.page.clicks > 0, 'the first real attempt should click "Turn on captions"');
  w.page.captionsOn = true;         // Meet flips them on
  w.clock.advance(1_000);

  assert.equal(w.deafEvents().length, 0, 'a bot that got captions on was never deaf');
  assert.equal(ready, 1, 'onReady fires exactly once');
});

test('a real failure still escalates after three attempted rounds', () => {
  // Admitted, button present, clicking it never flips captions on: that is the
  // genuine fault the budget exists for, and it must still be reported.
  const w = makeWorld();
  w.page.admitted = true;
  w.page.ccButton = true;
  const scraper = new w.CaptionScraper();
  scraper.start();

  w.clock.advance(119_000); // 30 + 40 + 50s of real attempts, minus a little
  assert.equal(w.deafEvents().length, 0, 'must not give up before the budget is actually spent');
  w.clock.advance(5_000);
  assert.equal(w.deafEvents().length, 1, 'three failed attempts escalate deaf');
  assert.ok(w.page.clicks >= 2, 'each failed round re-clicks the button');
});

// --- (b) escalating deaf arms a watcher, it does not end the story --------

test('a human clicking CC rescues a bot that already escalated deaf', () => {
  const w = makeWorld();
  w.page.admitted = true;
  w.page.ccButton = true;
  const scraper = new w.CaptionScraper();
  let ready = 0;
  scraper.onReady = () => { ready++; };
  scraper.start();

  w.clock.advance(125_000);
  assert.equal(w.deafEvents().length, 1, 'precondition: the bot has escalated deaf');

  // Seth turns captions on by hand. Before #497 nothing was looking at the
  // button any more, so this changed nothing and the bot stayed deaf all call.
  w.page.captionsOn = true;
  w.clock.advance(3_000);

  assert.equal(w.hearingEvents().length, 1, 'the flip to ON must be noticed and reported');
  assert.equal(ready, 1, 'captions becoming usable fires onReady, even this late');
});

test('the deaf watcher re-clicks a captions button that appears later', () => {
  const w = makeWorld();
  w.page.admitted = true;
  w.page.ccButton = true;
  const scraper = new w.CaptionScraper();
  scraper.start();
  w.clock.advance(125_000);
  const clicksAtGiveUp = w.page.clicks;

  w.clock.advance(30_000);
  assert.ok(w.page.clicks > clicksAtGiveUp, 'the watcher keeps trying the button after giving up');
});

test('the deaf watcher does not flood the session log', () => {
  // It runs for the rest of the call. _enableCaptions dumps every toolbar
  // aria-label whenever it finds nothing, and a 5s self-heal tick calling it
  // blind would write that dump ~120 times per 10 minutes (#141 territory).
  const w = makeWorld();
  w.page.admitted = true;   // admitted, but Meet never renders a captions button
  const scraper = new w.CaptionScraper();
  scraper.start();
  w.clock.advance(125_000);
  const warnsAtGiveUp = w.warnings.length;

  w.clock.advance(600_000); // ten more minutes of deafness
  const added = w.warnings.length - warnsAtGiveUp;
  assert.ok(added < 40, `deaf watcher wrote ${added} log lines in 10 minutes — too chatty`);
});

// --- clickCaptionsWhenReady: the clock starts at admission ----------------

test('the 60s captions clock starts at admission, not at the join click', () => {
  const w = makeWorld();
  w.clickCaptionsWhenReady();

  w.clock.advance(300_000); // five minutes in the lobby
  assert.equal(w.deafEvents().length, 0, 'a long lobby wait is not a caption failure');

  w.page.admitted = true;
  w.page.ccButton = true;
  w.clock.advance(2_000);
  assert.ok(w.page.clicks > 0, 'the button is clicked as soon as it exists');
  assert.equal(w.deafEvents().length, 0);
});

test('escalating deaf does not stop the waiter from watching', () => {
  // The old backstop ran cleanup() — observer disconnected, poll cleared — so a
  // button rendering one second later was never clicked by anybody.
  const w = makeWorld();
  w.clickCaptionsWhenReady();
  w.page.admitted = true;   // admitted, but no captions button for a long while

  w.clock.advance(65_000);
  assert.equal(w.deafEvents().length, 1, 'still reports deaf 60s after admission');

  w.page.ccButton = true;
  w.clock.advance(2_000);
  assert.ok(w.page.clicks > 0, 'a late-rendering button must still get clicked');
});

// --- waiting forever is only right while there is still a call ------------

test('the caption waiter stands down when the call ends', () => {
  // #417: "wait indefinitely for the button" must not outlive the meeting, or
  // it becomes the ghost loop that logged "no captions button in DOM" for nine
  // minutes after everyone had left.
  const w = makeWorld();
  w.page.admitted = true;
  const scraper = new w.CaptionScraper();
  scraper.start();
  w.clickCaptionsWhenReady();

  w.clock.advance(30_000);
  w.page.admitted = false;       // the call is over; the in-call UI collapses
  w.clock.advance(120_000);
  const quietAt = w.warnings.length;

  w.clock.advance(600_000);      // ten minutes of no call at all
  assert.equal(w.warnings.length, quietAt, 'nothing should still be logging after the call ended');

  // And a stood-down waiter does not click a button that reappears.
  w.page.admitted = true;
  w.page.ccButton = true;
  const clicksBefore = w.page.clicks;
  w.clock.advance(10_000);
  assert.equal(w.page.clicks, clicksBefore, 'the waiter for the old call stays down');
});
