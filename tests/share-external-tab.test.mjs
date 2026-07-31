// share-external-tab.test.mjs — the pure, deterministic pieces of the
// share-a-specific-tab POC: AppleScript string escaping, script shape, and the
// desktopCapturer source matcher. The osascript / desktopCapturer calls are
// environment-dependent and not unit-tested here.
//
// Run: node --test tests/share-external-tab.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appleScriptStringLiteral,
  buildActivateTabScript,
  pickWindowSource,
} from '../electron-app/share-external-tab.js';

test('appleScriptStringLiteral escapes quotes and backslashes', () => {
  assert.equal(appleScriptStringLiteral('https://x.com'), '"https://x.com"');
  assert.equal(appleScriptStringLiteral('a"b'), '"a\\"b"');
  assert.equal(appleScriptStringLiteral('a\\b'), '"a\\\\b"');
  assert.equal(appleScriptStringLiteral(null), '""');
});

test('buildActivateTabScript embeds the URL and targets the app, sets active tab', () => {
  const s = buildActivateTabScript('https://dashboard.example.com/abc', { appName: 'Google Chrome' });
  assert.match(s, /tell application "Google Chrome"/);
  assert.match(s, /URL of t contains "https:\/\/dashboard\.example\.com\/abc"/);
  assert.match(s, /set active tab index of w to tabIndex/);
  assert.match(s, /return \(title of t\)/);
});

test('buildActivateTabScript guards against sharing the call window (collision detection)', () => {
  const s = buildActivateTabScript('https://dashboard.example.com/abc', {});
  assert.match(s, /URL of t contains "meet\.google\.com"/, 'detects the Meet window');
  assert.match(s, /return "COLLISION"/, 'returns COLLISION when the tab shares the Meet window');
  assert.match(s, /return "NOTFOUND"/, 'returns NOTFOUND when no tab matches');
  // the collision check must come BEFORE the activate line, so a colliding tab is never activated
  assert.ok(s.indexOf('return "COLLISION"') < s.indexOf('set active tab index'), 'collision returns before activating');
});

test('buildActivateTabScript can target another browser + custom meet fragment', () => {
  const s = buildActivateTabScript('https://x.com', { appName: 'Brave Browser', meetFragment: 'zoom.us' });
  assert.match(s, /tell application "Brave Browser"/);
  assert.match(s, /URL of t contains "zoom\.us"/);
});

test('pickWindowSource: exact title wins', () => {
  const sources = [
    { id: 'window:1:0', name: 'Some other window' },
    { id: 'window:2:0', name: 'My Dashboard' },
  ];
  assert.equal(pickWindowSource(sources, { title: 'My Dashboard' }).id, 'window:2:0');
});

test('pickWindowSource: falls back to prefix then containment', () => {
  const prefix = [{ id: 'w:1', name: 'My Dashboard - Google Chrome' }];
  assert.equal(pickWindowSource(prefix, { title: 'My Dashboard' }).id, 'w:1');
  const contains = [{ id: 'w:2', name: 'Dashboard' }];
  assert.equal(pickWindowSource(contains, { title: 'Live Dashboard' }).id, 'w:2');
});

test('pickWindowSource: excludeIds drops our own windows (infinity-mirror guard)', () => {
  const sources = [
    { id: 'window:self:0', name: 'Vibeconferencing' },
    { id: 'window:tab:0', name: 'Vibeconferencing' },
  ];
  const picked = pickWindowSource(sources, { title: 'Vibeconferencing', excludeIds: ['window:self:0'] });
  assert.equal(picked.id, 'window:tab:0');
});

test('pickWindowSource: no match returns null', () => {
  assert.equal(pickWindowSource([{ id: 'w:1', name: 'Nope' }], { title: 'Missing' }), null);
  assert.equal(pickWindowSource([], { title: 'x' }), null);
  assert.equal(pickWindowSource([{ id: 'w:1', name: 'x' }], {}), null);
});
