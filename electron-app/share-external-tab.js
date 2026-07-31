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

// Build the AppleScript that finds the first tab whose URL contains `url`,
// makes it active in its window, and returns that tab's title (or "" if none).
// `appName` lets callers target Brave etc.; defaults to Chrome (where the
// claude-in-chrome extension lives).
function buildActivateTabScript(url, appName = 'Google Chrome') {
  const u = appleScriptStringLiteral(url);
  const app = appleScriptStringLiteral(appName);
  return [
    `tell application ${app}`,
    `  repeat with w in windows`,
    `    set tabIndex to 0`,
    `    repeat with t in tabs of w`,
    `      set tabIndex to tabIndex + 1`,
    `      if (URL of t contains ${u}) then`,
    `        set active tab index of w to tabIndex`,
    `        return (title of t)`,
    `      end if`,
    `    end repeat`,
    `  end repeat`,
    `  return ""`,
    `end tell`,
  ].join('\n');
}

// Run the AppleScript. Resolves { ok, title } — ok=false if the tab wasn't found
// (empty title) or AppleScript errored. Never rejects.
function activateChromeTabByUrl(url, appName = 'Google Chrome') {
  return new Promise((resolve) => {
    if (!url) return resolve({ ok: false, title: null, reason: 'no url' });
    const script = buildActivateTabScript(url, appName);
    execFile('osascript', ['-e', script], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, title: null, reason: err.message });
      const title = String(stdout || '').trim();
      if (!title) return resolve({ ok: false, title: null, reason: 'tab not found' });
      resolve({ ok: true, title });
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
async function resolveTabShareSource(desktopCapturer, url, { appName = 'Google Chrome', excludeIds = [] } = {}) {
  const activated = await activateChromeTabByUrl(url, appName);
  if (!activated.ok) return { ok: false, source: null, title: null, reason: activated.reason };

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
