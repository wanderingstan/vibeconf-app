// idle-page-navigation.test.mjs — every navigation of the Meet view to the idle
// page must announce itself.
//
// 2026-08-13 (v0.8.25 nightly): a bot reached "AUTO-JOIN STARTING" and 2.1s later
// the Meet view was on /bot-view, which the landing classifier reported as
// "landed on not-meet" — join failed, 14 downstream steps failed with it. A full
// night of logs could not say what navigated: showIdle() logs only AFTER the
// fact ('Returned to idle state' — absent, which is how we knew teardown had NOT
// run), and the other caller was silent. Un-attributable from the evidence.
//
// These are source assertions because the call sites live inside Electron window
// construction, which needs a real app to exercise. The property being defended
// is narrow and worth defending: no silent route to the idle page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(join(root, 'electron-app/main.js'), 'utf8');

test('nothing loads the idle URL except the announced helper', () => {
  // Every `loadURL(getIdleUrl())` in the file should be the one inside
  // loadIdlePage(). A second one is a silent navigation — exactly the gap that
  // made the 2026-08-13 regression un-diagnosable.
  const direct = main.split('\n')
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => /loadURL\(\s*getIdleUrl\(\)\s*\)/.test(l));
  assert.equal(direct.length, 1,
    `expected exactly one loadURL(getIdleUrl()) — the one in loadIdlePage(); found ${direct.length} at lines ${direct.map((d) => d.n).join(', ')}`);

  // ...and that one must be inside loadIdlePage, not somewhere that happens to
  // look similar.
  const helper = main.slice(main.indexOf('function loadIdlePage('));
  const helperBody = helper.slice(0, helper.indexOf('\n}'));
  assert.match(helperBody, /loadURL\(getIdleUrl\(\)\)/, 'the single call site is loadIdlePage()');
});

test('the reason is logged BEFORE the navigation, not after', () => {
  const helper = main.slice(main.indexOf('function loadIdlePage('));
  const body = helper.slice(0, helper.indexOf('\n}'));
  const logAt = body.indexOf('console.log');
  const navAt = body.indexOf('loadURL(getIdleUrl())');
  assert.ok(logAt > -1 && navAt > -1, 'both present');
  // showIdle logged after its loadURL, so a navigation that broke something
  // downstream had no line preceding it in the log. Order is the fix.
  assert.ok(logAt < navAt, 'log precedes the navigation');
});

test('a join in flight is called out by name, not left to be inferred', () => {
  const helper = main.slice(main.indexOf('function loadIdlePage('));
  const body = helper.slice(0, helper.indexOf('\n}'));
  // 'navigating' and 'joining' are the two statuses that mean a join is underway
  // (see rejoin-guard.js, which treats exactly these as in-flight).
  assert.match(body, /'navigating'/, 'checks navigating');
  assert.match(body, /'joining'/, 'checks joining');
  assert.match(body, /ABANDONING A JOIN IN FLIGHT/, 'says so loudly in the log');
});

test('both known callers pass a distinguishable reason', () => {
  // The whole point is telling the two apart in a log after the fact.
  assert.match(main, /loadIdlePage\('main-window created'\)/, 'createMainWindow site');
  assert.match(main, /loadIdlePage\('showIdle — call teardown'\)/, 'teardown site');
});

test('creating a Meet view still navigates nowhere on its own', () => {
  // Load-bearing for reading the logs: if createMeetView ever starts loading a
  // URL, a view RECREATE becomes a third, unlogged way to land on the idle page
  // and the instrumentation above stops being exhaustive.
  const start = main.indexOf('function createMeetView(');
  assert.ok(start > -1, 'createMeetView exists');
  const body = main.slice(start, main.indexOf('\n}', start));
  assert.doesNotMatch(body, /loadURL\(/, 'createMeetView does not navigate');
});
