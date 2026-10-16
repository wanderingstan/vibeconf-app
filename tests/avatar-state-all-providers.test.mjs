// #828: the camera avatar's starting look and state (background, emoji set, call
// status, mode, bot state, overlay, posture) used to be pushed only from
// the Meet view's did-finish-load handler (loadMeetURL → _openMeetInFreshView), so Zoom, Teams and Slack tiles showed
// the built-in defaults (blue gradient, native emoji) for the whole call. These
// guard the wiring: every provider's call view pushes it on load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

const fnBody = (name) => {
  const i = main.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} not found in main.js`);
  // Up to the next top-level function declaration.
  const next = main.slice(i + 1).search(/\n(async )?function [A-Za-z_]+\(/);
  return next < 0 ? main.slice(i) : main.slice(i, i + 1 + next);
};

for (const provider of ['activateZoomProvider', 'activateTeamsProvider', 'activateSlackProvider']) {
  test(`${provider} pushes the avatar state on its call view's page loads`, () => {
    const body = fnBody(provider);
    const created = body.search(/meetView = (createMeetView\(|surface\.view)/);
    const wired = body.indexOf('pushInitialAvatarStateOnLoad(meetView)');
    assert.ok(created >= 0, 'view creation not found');
    assert.ok(wired > created, 'pushInitialAvatarStateOnLoad(meetView) must follow the view being created');
  });
}

test('Meet still pushes the same state, through the shared helper', () => {
  // loadMeetURL → _openMeetInFreshView, which wires the Meet view's did-finish-load.
  const body = fnBody('_openMeetInFreshView');
  assert.match(body, /pushInitialAvatarState\(\)/);
});

test('the shared helper sends the background and the emoji set', () => {
  const body = fnBody('pushInitialAvatarState');
  for (const call of ['pushAvatarBackground(', 'pushEmojiSet(', "'set-call-status'", "'set-bot-state'", 'pushAvatarPosture(']) {
    assert.ok(body.includes(call), `pushInitialAvatarState should include ${call}`);
  }
});
