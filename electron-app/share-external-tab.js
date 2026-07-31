// share-external-tab.js — POC (#NN): share a SPECIFIC external browser tab into
// the call, given its URL. This is the "share the tab Claude is browsing" path:
// the same agent drives a Chrome tab via the claude-in-chrome extension AND the
// bot, so it already knows the URL; it hands that URL here.
//
// How it works (macOS):
//   1. AppleScript finds the Chrome tab whose URL matches and makes it the
//      ACTIVE tab of its window. (No need to raise/focus the window — macOS
//      ScreenCaptureKit captures a window even when it's occluded. We only need
//      the target tab to be the visible one in its window, since a window shows
//      one tab at a time.)
//   2. A Chrome window's OS title == its active tab's page title, which is
//      exactly what desktopCapturer reports as a window source's `name`. So we
//      match the source by that title and hand it to getDisplayMedia — reusing
//      the same capture path the whiteboard share already uses.
//
// The pure pieces (script building, source matching) are unit-tested in
// share-external-tab.test.mjs; the osascript/desktopCapturer calls are thin
// wrappers around them.
//
// Windows note: swap step 1 for the UI-Automation tab activation (see the
// Windows Meet-detection work) — everything downstream (desktopCapturer source
// match → share) is already cross-platform.

'use strict';

const { execFile } = require('child_process');

// AppleScript string literal: escape backslashes then double quotes so a URL
// can be embedded safely inside `"..."`. URLs rarely contain quotes, but never
// trust input into a shell/scripting boundary.
function appleScriptStringLiteral(s) {
  return '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// Build the AppleScript that finds the first tab whose URL contains `url` and
// makes it active in its window, returning that tab's title. It ALSO guards the
// call: if that tab lives in the same window as a Google Meet tab, activating it
// would flip the window away from the call and hide it — so in that case it does
// NOT activate and returns the sentinel `COLLISION`. Returns `NOTFOUND` if no
// tab matches. `meetFragment` identifies the call tab; `appName` targets the
// browser (Chrome by default — where the claude-in-chrome extension lives).
function buildActivateTabScript(url, { appName = 'Google Chrome', meetFragment = 'meet.google.com' } = {}) {
  const u = appleScriptStringLiteral(url);
  const app = appleScriptStringLiteral(appName);
  const meet = appleScriptStringLiteral(meetFragment);
  return [
    `tell application ${app}`,
    `  set meetWinId to missing value`,
    `  repeat with w in windows`,
    `    repeat with t in tabs of w`,
    `      if (URL of t contains ${meet}) then`,
    `        set meetWinId to (id of w)`,
    `        exit repeat`,
    `      end if`,
    `    end repeat`,
    `    if meetWinId is not missing value then exit repeat`,
    `  end repeat`,
    `  repeat with w in windows`,
    `    set tabIndex to 0`,
    `    repeat with t in tabs of w`,
    `      set tabIndex to tabIndex + 1`,
    `      if (URL of t contains ${u}) then`,
    `        if (meetWinId is not missing value) and ((id of w) is meetWinId) then`,
    `          return "COLLISION"`,
    `        end if`,
    `        set active tab index of w to tabIndex`,
    `        return (title of t)`,
    `      end if`,
    `    end repeat`,
    `  end repeat`,
    `  return "NOTFOUND"`,
    `end tell`,
  ].join('\n');
}

// Run the AppleScript. Resolves { ok, title, reason }. Never rejects.
//   ok=true                          → activated; `title` is the tab title.
//   reason='collision'               → the tab shares the call's window; NOT activated.
//   reason='tab not found'           → no open tab matches the URL.
function activateChromeTabByUrl(url, { appName = 'Google Chrome', meetFragment = 'meet.google.com' } = {}) {
  return new Promise((resolve) => {
    if (!url) return resolve({ ok: false, title: null, reason: 'no url' });
    const script = buildActivateTabScript(url, { appName, meetFragment });
    execFile('osascript', ['-e', script], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, title: null, reason: err.message });
      const out = String(stdout || '').trim();
      if (out === 'COLLISION') return resolve({ ok: false, title: null, reason: 'collision' });
      if (out === 'NOTFOUND' || out === '') return resolve({ ok: false, title: null, reason: 'tab not found' });
      resolve({ ok: true, title: out });
    });
  });
}

// Pure source picker (unit-tested). Given desktopCapturer window sources and a
// target title, return the best match. Mirrors the whiteboard-share strategy:
// exact title, then prefix. `excludeIds` drops our own windows (main/whiteboard)
// so we never capture ourselves (the #158 infinity-mirror guard).
function pickWindowSource(sources, { title, excludeIds = [] } = {}) {
  if (!Array.isArray(sources) || !title) return null;
  const pool = sources.filter((s) => !excludeIds.includes(s.id));
  return (
    pool.find((s) => s.name === title) ||
    pool.find((s) => s.name.startsWith(title)) ||
    // last resort: the title often appears as "<page title>" but a browser may
    // append/prepend chrome; match on containment both ways.
    pool.find((s) => s.name.includes(title) || title.includes(s.name)) ||
    null
  );
}

// Orchestrate: activate the tab, then resolve the desktopCapturer window source
// showing it. `desktopCapturer` is passed in (Electron main-process object) so
// this module stays testable and import-light. Returns
// { ok, source, title, reason }.
async function resolveTabShareSource(desktopCapturer, url, { appName = 'Google Chrome', meetFragment = 'meet.google.com', excludeIds = [] } = {}) {
  const activated = await activateChromeTabByUrl(url, { appName, meetFragment });
  if (!activated.ok) {
    // Turn the terse sentinels into something the agent can act on.
    const reason = activated.reason === 'collision'
      ? "the page is in the same browser window as the call — open it in a SEPARATE window first "
        + "(e.g. make a new window, then load the URL there) so presenting it doesn't hide the call"
      : activated.reason;
    return { ok: false, source: null, title: null, reason };
  }

  // Small settle so the window server picks up the new active-tab title before
  // we read the source list. Titles are read right after activation to minimise
  // drift (SPA route/notification-count changes).
  await new Promise((r) => setTimeout(r, 150));

  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 },
  });
  const source = pickWindowSource(sources, { title: activated.title, excludeIds });
  if (!source) {
    return {
      ok: false,
      source: null,
      title: activated.title,
      reason: `activated tab "${activated.title}" but no matching window source`,
    };
  }
  return { ok: true, source, title: activated.title, reason: null };
}

// List candidate browser windows for a picker UI / list_windows tool. Thin
// wrapper so callers don't import desktopCapturer semantics.
async function listBrowserWindows(desktopCapturer) {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 },
  });
  return sources.map((s) => ({ id: s.id, name: s.name }));
}

module.exports = {
  appleScriptStringLiteral,
  buildActivateTabScript,
  activateChromeTabByUrl,
  pickWindowSource,
  resolveTabShareSource,
  listBrowserWindows,
};
