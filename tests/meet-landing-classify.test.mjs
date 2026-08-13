// meet-landing-classify.test.mjs — the join-automation gate (#346).
//
// WHY this exists: on 2026-08-12 a calendar auto-join fired correctly and then
// hung for five and a half minutes. Google had thrown an identity challenge
// ("confirm it's you", password re-entry) and the gate misread it as Meet home,
// bailed out silently, and left callStatus at 'navigating' forever. From the UI
// the bot looked like it had never tried to join at all.
//
// The bug was one substring test. The challenge URL is
//   https://accounts.google.com/v3/signin/challenge/pwd?continue=https%3A%2F%2Fmeet.google.com%2Fabc-defg-hij
// and percent-encoding leaves "meet.google.com" readable inside `continue=`, so
// `href.includes('meet.google.com')` was TRUE on a page served by
// accounts.google.com. It passed the "is this Meet?" guard, failed the
// meeting-code guard, and got reported as Meet home.
//
// The real page can't be summoned on demand (Google decides when to challenge),
// but the gate is pure, and the gate is where the bug lived. So: assert the
// classification directly, URL by URL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MEET } = require('../electron-app/meet-selectors.js');

// Classify from a URL string the way the preload does, so each case reads as
// the address bar the bot would actually be sitting on.
function classify(href) {
  const u = new URL(href);
  return MEET.classifyLanding({ href, hostname: u.hostname, pathname: u.pathname });
}

test('a real meeting code is the only thing that runs join automation', () => {
  assert.equal(classify('https://meet.google.com/wcj-odpo-wrb'), 'meeting');
  assert.equal(classify('https://meet.google.com/abc-defg-hij?authuser=bot@example.com'), 'meeting');
  // The authuser pin (#282) must not change the classification — it was wrongly
  // suspected of causing the 08-12 outage, and the URL that eventually DID join
  // carried it.
  assert.equal(classify('https://meet.google.com/wcj-odpo-wrb?authuser=jimmy@spiritprotocol.io'), 'meeting');
});

test('THE REGRESSION: a Google identity challenge is not Meet home', () => {
  // Verbatim shape of the page that blocked the 2026-08-12 standup join.
  const challenge = 'https://accounts.google.com/v3/signin/challenge/pwd?continue='
    + encodeURIComponent('https://meet.google.com/wcj-odpo-wrb?authuser=jimmy@spiritprotocol.io');

  // The exact trap: the meeting host really is present in the href.
  assert.ok(challenge.includes('meet.google.com'),
    'precondition — the continue param leaves the Meet host readable in the href');

  assert.equal(classify(challenge), 'sign-in');
});

test('every Google sign-in shape classifies as sign-in, not as a Meet page', () => {
  const signInUrls = [
    'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmeet.google.com%2Fabc-defg-hij',
    'https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmeet.google.com%2F',
    'https://accounts.google.com/signin/v2/challenge/pwd',
    'https://accounts.google.com/',
  ];
  for (const url of signInUrls) {
    assert.equal(classify(url), 'sign-in', url);
  }
});

test('Meet home and its non-meeting paths stay benign', () => {
  // These are normal at rest: the operator can sign in / start meetings here,
  // and a call that just ended returns to something like this. Main only treats
  // them as a failure when a join was in flight.
  assert.equal(classify('https://meet.google.com/'), 'meet-home');
  assert.equal(classify('https://meet.google.com/new'), 'meet-home');
  assert.equal(classify('https://meet.google.com/landing'), 'meet-home');
  assert.equal(classify('https://meet.google.com/_meet/abc'), 'meet-home');
});

test('the idle bot-view page is not-meet', () => {
  assert.equal(classify('https://vibeconferencing.com/bot-view'), 'not-meet');
});

test('a hostile lookalike host cannot pass as Meet', () => {
  // hostname equality, not substring: the old href.includes() would have called
  // both of these Meet pages.
  assert.equal(classify('https://meet.google.com.evil.example/abc-defg-hij'), 'not-meet');
  assert.equal(classify('https://evil.example/?x=meet.google.com/abc-defg-hij'), 'not-meet');
});

test('meeting-code matching is shape-based, not merely non-empty', () => {
  // /abc-defg-hij only. A path that is just present must not read as a meeting,
  // or every Meet sub-page would trigger join automation.
  assert.equal(classify('https://meet.google.com/abc-defg-hij'), 'meeting');
  assert.equal(classify('https://meet.google.com/ab-defg-hij'), 'meet-home');
  assert.equal(classify('https://meet.google.com/abc-def-hij'), 'meet-home');
});
