// provider-view-teardown.test.mjs — discarding the embedded provider view must
// STOP it, not merely detach it.
//
// The 2026-08-14 whiteboard-e2e "could not join … ended up at bot-view" failure:
// call teardown navigated the Meet view to /bot-view, then a re-join started
// ~75ms later. The old discard pattern — `removeBrowserView(meetView);
// meetView = null` — only detached the view and dropped our reference; its
// webContents kept running, finished loading /bot-view ~270ms later, and its
// preload emitted a 'meet-landing' event. The handler, by then seeing the NEW
// join in flight, misread the stale landing as that join failing and killed it.
//
// The fix is destroyProviderView(): stop() + close() the webContents so a
// discarded page can't finish loading, run script, or emit into our IPC
// handlers. These pin that a later "simplify the teardown" refactor can't
// quietly regress to detach-only — which would look harmless and reopen the bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

// The body of a named function, for scoping assertions to one definition.
function bodyOf(signature) {
  const i = main.indexOf(signature);
  assert.ok(i > 0, `expected to find ${signature}`);
  const rest = main.slice(i);
  return rest.slice(0, rest.indexOf('\n}\n'));
}

test('destroyProviderView stops and closes the webContents, not just detaches it', () => {
  const body = bodyOf('function destroyProviderView()');
  // Detaching alone (removeBrowserView) is what left the orphaned page alive.
  assert.match(body, /removeBrowserView\(meetView\)/,
    'must detach from its host window');
  // The two that actually make the discard total: cancel the in-flight load,
  // then destroy the page so it cannot run script or emit any more IPC.
  assert.match(body, /\.stop\(\)/, 'must cancel any in-flight navigation');
  assert.match(body, /\.close\(\)/, 'must destroy the webContents so the page cannot emit');
  // It hosts across three windows (main / popout / hidden); a discard that only
  // knew about mainWindow would leak a view that was popped or hidden.
  for (const win of ['mainWindow', 'meetPopoutWindow', 'meetHiddenWindow']) {
    assert.ok(body.includes(win), `must detach from ${win}`);
  }
});

test('every provider-view discard site goes through destroyProviderView', () => {
  // The leak-prone inline pattern must not reappear in any of the three
  // functions that throw a view away. (showIdle KEEPS the view at idle, so it is
  // deliberately not on this list — it navigates, it does not discard.)
  for (const sig of [
    'async function _openMeetInFreshView(meetUrl',
    'function activateSlackProvider(',
    'function activateMeetProvider(',
  ]) {
    const body = bodyOf(sig);
    assert.match(body, /destroyProviderView\(\)/,
      `${sig} must discard via destroyProviderView`);
    assert.doesNotMatch(body, /removeBrowserView\(meetView\)/,
      `${sig} must not detach the view inline — that is the detach-only leak`);
  }
});
