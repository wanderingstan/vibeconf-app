// call-link.test.mjs — findCallLink pulls the meeting link out of a pasted
// invite and ignores the prose and the other links around it.
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { findCallLink } = require('../electron-app/renderer/call-link.js');

test('bare links of every provider, with and without a scheme', () => {
  assert.deepEqual(findCallLink('https://meet.google.com/abc-defg-hij'), { provider: 'meet', url: 'https://meet.google.com/abc-defg-hij' });
  assert.deepEqual(findCallLink('meet.google.com/abc-defg-hij'), { provider: 'meet', url: 'https://meet.google.com/abc-defg-hij' });
  assert.equal(findCallLink('https://app.slack.com/client/T02NE0TFV/C02NE0TG9').provider, 'slack');
  assert.equal(findCallLink('us05web.zoom.us/j/84935088002?pwd=8cakq7E2NU').provider, 'zoom');
  assert.equal(findCallLink('https://teams.live.com/meet/9356141248380?p=BCVZW8Nwpa0dZ6Vzr7').provider, 'teams');
});

test('a full Zoom invite: finds the join link among the prose', () => {
  const invite = `Stan James is inviting you to a scheduled Zoom meeting.

Topic: Stan's Zoom Meeting
Time: Oct 15, 2026 11:00 AM Mountain Time (US and Canada)

Join Zoom Meeting
https://us05web.zoom.us/j/84935088002?pwd=8cakq7E2NUnAPk0WiFGXJhSigR3su9.1

Meeting ID: 849 3508 8002
Passcode: 4Hq7Lk`;
  assert.deepEqual(findCallLink(invite), {
    provider: 'zoom',
    url: 'https://us05web.zoom.us/j/84935088002?pwd=8cakq7E2NUnAPk0WiFGXJhSigR3su9.1',
  });
});

test('a Teams invite: skips "Meeting options" and "Learn more", takes the join link', () => {
  const invite = `Microsoft Teams meeting
Join: https://teams.microsoft.com/meet/27389117658431?p=AbCdEf123
Meeting ID: 273 891 176 584 31
Passcode: AbCdEf
Need help? <https://aka.ms/JoinTeamsMeeting?omkt=en-US>
For organizers: Meeting options <https://teams.microsoft.com/meetingOptions/?organizerId=x&tenantId=y>`;
  assert.deepEqual(findCallLink(invite), { provider: 'teams', url: 'https://teams.microsoft.com/meet/27389117658431?p=AbCdEf123' });
});

test('non-meeting links from a provider are ignored, even when they come first', () => {
  const text = 'Get the app: https://zoom.us/download then join https://zoom.us/j/81234567890';
  assert.equal(findCallLink(text).url, 'https://zoom.us/j/81234567890');
  assert.equal(findCallLink('https://teams.microsoft.com/meetingOptions/?x=1'), null);
  assert.equal(findCallLink('https://meet.google.com/'), null);
});

test('a Meet invite with phone numbers and PINs', () => {
  const invite = `Join with Google Meet
meet.google.com/xpq-rstu-vwy
Join by phone
(US) +1 401-555-0199 PIN: 123 456 789#`;
  assert.deepEqual(findCallLink(invite), { provider: 'meet', url: 'https://meet.google.com/xpq-rstu-vwy' });
});

test('angle brackets and trailing punctuation are stripped', () => {
  assert.equal(findCallLink('Join here: <https://zoom.us/j/81234567890>.').url, 'https://zoom.us/j/81234567890');
  assert.equal(findCallLink('(see meet.google.com/abc-defg-hij).').url, 'https://meet.google.com/abc-defg-hij');
});

test('Outlook Safe Links and Google redirects are unwrapped', () => {
  const real = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_NzQ5ZmY0@thread.v2/0?context=%7b%7d';
  const safe = 'https://nam12.safelinks.protection.outlook.com/?url=' + encodeURIComponent(real) + '&data=05%7C01&reserved=0';
  const found = findCallLink('Click to join: ' + safe);
  assert.equal(found.provider, 'teams');
  assert.match(found.url, /^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//);
  const g = 'https://www.google.com/url?q=' + encodeURIComponent('https://zoom.us/j/81234567890') + '&sa=D';
  assert.equal(findCallLink(g).url, 'https://zoom.us/j/81234567890');
});

test('nothing joinable → null', () => {
  assert.equal(findCallLink(''), null);
  assert.equal(findCallLink(null), null);
  assert.equal(findCallLink('see you at 3pm, link to follow'), null);
  assert.equal(findCallLink('https://example.com/j/81234567890'), null);
});
