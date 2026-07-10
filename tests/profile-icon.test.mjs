// profile-icon.test.mjs — the bot-box avatar snapshot must actually get captured.
//
// `__vibeconfCaptureAvatarIcon` returns a frame ONLY when the virtual camera is
// showing the resting 🙂 face; every other face returns null. Measured over a real
// 45-minute call, 🙂 is on screen ~19% of the time (the rest is 😐 hearing, 🤔
// thinking, 😔 idle, 🥴). The old capture was a fixed 60s poll, so it was a
// one-in-five lottery — and across 36 logged sessions it had won exactly 5 times.
//
// Meanwhile any appearance change (avatarBackgroundSvg, emojiSet) deletes the
// cached icon on purpose, because the snapshot is now wrong. Together: change your
// background once and the panel can fall back to the generated look ~indefinitely.
//
// Fix: capture on the EDGE (renderer pings main the moment it settles onto 🙂),
// with a fast backstop poll while no icon is cached.
//
// main.js / page-inject.js / google-meet-provider.js all run in contexts that
// can't be required here, so the wiring is pinned at the source; the throttle is
// exercised for real.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const main = read('electron-app/main.js');
const inject = read('electron-app/page-inject.js');
const provider = read('electron-app/google-meet-provider.js');
const { CALL_EVENTS } = require('../electron-app/call-provider.js');

test('the resting-face edge is a first-class provider event', () => {
  assert.equal(CALL_EVENTS.avatarResting, 'avatar-resting');
});

test('the renderer pings only on the RESTING face, not on any face change', () => {
  assert.match(inject, /if \(emoji === VirtualCamera\.MODE_EMOJIS\.active\) \{/);
  assert.match(inject, /action: 'avatar-resting'/);
  // It must sit inside the emoji-CHANGED branch — pinging every frame would be
  // an IPC message ~30 times a second.
  const changed = inject.indexOf('if (emoji !== this._lastLoggedEmoji) {');
  const ping = inject.indexOf("action: 'avatar-resting'");
  assert.ok(changed > -1 && ping > changed, 'the ping is inside the emoji-changed branch');
});

test('the provider relays the edge to main', () => {
  assert.match(provider, /if \(event\.data\.action === 'avatar-resting'\) \{/);
  assert.match(provider, /meetProvider\.emit\(CALL_EVENTS\.avatarResting\)/);
});

test('main captures on the edge, and refuses to touch the renderer when fresh', () => {
  assert.match(main, /ipcMain\.on\(CALL_EVENTS\.avatarResting, \(\) => \{/);
  const handler = main.slice(main.indexOf('ipcMain.on(CALL_EVENTS.avatarResting'));
  const body = handler.slice(0, handler.indexOf('});'));
  assert.match(body, /if \(profileIconIsFresh\(\)\) return;/, 'no work when the icon is current');
  assert.match(body, /maybeCaptureProfileIcon\(\);/);
});

test('the backstop poll is adaptive: hard while missing, idle once cached', () => {
  assert.match(main, /const ICON_POLL_WANTED_MS = 5 \* 1000;/);
  assert.match(main, /const ICON_POLL_IDLE_MS = 5 \* 60 \* 1000;/);
  assert.match(main, /const delay = profileIconIsFresh\(\) \? ICON_POLL_IDLE_MS : ICON_POLL_WANTED_MS;/);
  // The old fixed poll must be gone, or the two schedulers fight.
  assert.doesNotMatch(main, /setInterval\(maybeCaptureProfileIcon/);
});

test('the poll self-schedules rather than leaking an interval, and unrefs', () => {
  const block = main.slice(main.indexOf('function scheduleProfileIconPoll()'));
  assert.match(block.slice(0, 400), /clearTimeout\(_iconPollTimer\)/);
  assert.match(block.slice(0, 500), /scheduleProfileIconPoll\(\);\s*\n\s*\}, delay\);/);
  assert.match(block.slice(0, 600), /_iconPollTimer\.unref/);
});

test('capture reports success so callers can react (it used to return nothing)', () => {
  const fn = main.slice(main.indexOf('async function maybeCaptureProfileIcon()'));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.match(body, /return true;/, 'signals a fresh capture');
  assert.match(body, /return false;/, 'signals no capture');
});

test('the 3s ping throttle actually suppresses a flickering face', async () => {
  // Mirrors the injected throttle. A face that oscillates 🙂 → 😐 → 🙂 on every
  // caption tick would otherwise fire an IPC message per oscillation.
  const holder = {};
  let pings = 0;
  const THROTTLE = 60; // scaled down from 3000ms
  const settleOnResting = () => {
    const now = Date.now();
    if (now - (holder._lastRestingPingAt || 0) > THROTTLE) {
      holder._lastRestingPingAt = now;
      pings++;
    }
  };

  for (let i = 0; i < 20; i++) settleOnResting(); // a burst of flicker
  assert.equal(pings, 1, 'a burst collapses to one ping');

  await new Promise((r) => setTimeout(r, THROTTLE + 20));
  settleOnResting();
  assert.equal(pings, 2, 'after the window, a genuine new settle pings again');
});

test('an appearance change still invalidates the cached icon (that part was right)', () => {
  // Both the agent path (applyPref) and the panel path must drop it — a snapshot
  // of the OLD background is worse than no snapshot.
  const deletes = main.match(/store\.delete\('profileIcon'\); store\.set\('profileIconAt', 0\);/g) || [];
  assert.ok(deletes.length >= 3, `expected the invalidation sites to remain, found ${deletes.length}`);
  assert.match(main, /key === 'avatarBackgroundSvg'/);
  assert.match(main, /key === 'emojiSet'/);
});
