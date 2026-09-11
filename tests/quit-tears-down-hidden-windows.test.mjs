// quit-tears-down-hidden-windows.test.mjs — #752: closing the window did not
// quit the app, on any platform.
//
// app.quit() is reached only via 'window-all-closed', which fires only when
// EVERY BrowserWindow is gone. Several of this app's windows are never visible
// (show:false, skipTaskbar:true, no parent), so they are easy to forget and
// invisible when forgotten. Each one that outlives the main window silently
// converts "quit" into "keep running with no UI".
//
// The main window's 'closed' handler already destroyed meetPopoutWindow, with a
// comment explaining this exact reasoning. It missed meetHiddenWindow — whose
// 'hidden' state is the DEFAULT and whose host persists in and out of a call —
// and the share/whiteboard window. So the common path was broken: the user got a
// dialog saying "Closing this window quits the app", clicked Quit, and the app
// carried on polling the calendar and holding its port and single-instance lock.
//
// A SOURCE test, in the style of agent-absent-clears.test.mjs, because main.js
// cannot be imported from node --test (it is an Electron main process). It
// guards the teardown lines against being dropped again. What it CANNOT do is
// notice a NEW never-shown window added later — for that, the audit is the
// last test here, which fails if an unrecognised skipTaskbar window appears.
//
// Run: node --test tests/quit-tears-down-hidden-windows.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

// The body of mainWindow.on('closed', () => { ... })
const closedHandler = (() => {
  const i = main.indexOf("mainWindow.on('closed'");
  assert.ok(i > 0, "mainWindow.on('closed') not found — did the handler move?");
  const end = main.indexOf('\n  });', i);
  assert.ok(end > i, "could not find the end of the 'closed' handler");
  return main.slice(i, end);
})();

test('#752 closing the main window destroys the hidden Meet host', () => {
  // The one that shipped broken. 'hidden' is the default bot-view state, so this
  // window exists for essentially every user, in and out of a call.
  assert.ok(closedHandler.includes('destroyHiddenMeetHost()'),
    "the 'closed' handler must tear down meetHiddenWindow or the app cannot quit");
});

test('#752 closing the main window closes the share/whiteboard window', () => {
  // Same hazard: show:false, skipTaskbar:true, no parent. It was closed on
  // stop-sharing, title-bar rebuild, the menu and call teardown, but nothing
  // closed it when the app window went away, so quitting mid-share hung.
  assert.ok(closedHandler.includes('closeWhiteboardWindow('),
    "the 'closed' handler must close the share window or quitting mid-share hangs");
});

test('the popout teardown that was already correct is still there', () => {
  // Pre-existing and right; pinned so a refactor of this handler cannot quietly
  // reintroduce the original leak while fixing the new ones.
  assert.ok(closedHandler.includes('meetPopoutWindow.destroy()'),
    "the 'closed' handler must still destroy meetPopoutWindow");
});

test('#752 the hidden-host teardown is shared, not duplicated', () => {
  // Two call sites need it: leaving the 'hidden' state, and closing the window.
  // Extracted rather than copied so the leak cannot return through one site
  // while the other stays correct.
  assert.ok(main.includes('function destroyHiddenMeetHost()'),
    'destroyHiddenMeetHost must exist as a single shared teardown');
  const calls = main.match(/destroyHiddenMeetHost\(\)/g) || [];
  // definition + leaving-'hidden' + the closed handler
  assert.ok(calls.length >= 3,
    `expected the shared teardown to be used by both paths, saw ${calls.length} occurrence(s)`);
  // removeBrowserView before destroy: meetView can be shared with another window
  // and must not be torn down along with its host.
  const fn = main.slice(main.indexOf('function destroyHiddenMeetHost()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(body.indexOf('removeBrowserView') < body.indexOf('destroy()'),
    'removeBrowserView must come before destroy so meetView survives its host');
});

test('#752 second-instance shows the window, not just focuses it', () => {
  // focus() on a HIDDEN window is a no-op, so relaunching the app — the first
  // thing anyone tries — silently did nothing. /api/focus always had this right.
  const i = main.indexOf("app.on('second-instance'");
  assert.ok(i > 0, "second-instance handler not found");
  const handler = main.slice(i, main.indexOf('\n  });', i));
  assert.ok(handler.includes('mainWindow.show()'),
    'second-instance must show() — focus() alone cannot reveal a hidden window');
});

test('#752 audit: every never-shown window is accounted for at quit', () => {
  // The real defect class is "someone adds another invisible BrowserWindow and
  // forgets it blocks the quit". This cannot see a new window's variable name,
  // but it CAN count them: skipTaskbar:true marks a window the user has no way
  // to close by hand, which is exactly the dangerous kind.
  //
  // If this fails because you added a window: make sure it either has a parent,
  // is destroyed in the 'closed' handler, or genuinely should keep the app
  // alive — then update the count and say which it is.
  //
  // Known at the time of #752:
  //   meetHiddenWindow   — destroyHiddenMeetHost()      (closed handler)
  //   whiteboardWindow   — closeWhiteboardWindow()      (closed handler)
  //   panel popout       — parent: mainWindow           (closes with the app)
  const KNOWN_SKIPTASKBAR_WINDOWS = 3;
  const found = (main.match(/skipTaskbar:\s*true/g) || []).length;
  assert.equal(found, KNOWN_SKIPTASKBAR_WINDOWS,
    `skipTaskbar window count changed (${found} vs ${KNOWN_SKIPTASKBAR_WINDOWS}). `
    + 'A never-shown window that outlives the main window stops the app quitting — '
    + 'see the note in this test before updating the number.');
});
