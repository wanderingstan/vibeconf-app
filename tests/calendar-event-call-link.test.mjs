// #813: calendar auto-join finds the meeting in a Zoom or Teams event, not just
// Meet's hangoutLink. Fixtures are real invites as the Google Calendar API
// returns them (identifiers kept, nothing here is secret: a meeting link
// without its organizer admitting you gets you a lobby).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveEventCallLink, eventLinkText } = require('../electron-app/calendar-auto-join.js');

// Outlook-sent Teams invite, new short-link format (2026-10-15). The
// description also carries "Need help?", "System reference" (a meetup-join
// link) and "Meeting options" links; the Join link comes first and must win.
const TEAMS_NEW = {
  id: 'teams-new',
  summary: 'Test run',
  location: 'Microsoft Teams Meeting',
  description: '\n________________________________________________________________________________\nMicrosoft Teams meeting\nJoin: https://teams.microsoft.com/meet/228789313340874?p=ucUGCVuh5rAoojfTDy\nMeeting ID: 228 789 313 340 874\nPasscode: Um3bA9eE\n________________________________\nNeed help?<https://aka.ms/JoinTeamsMeeting?omkt=en-US> | System reference<https://teams.microsoft.com/l/meetup-join/19%3ameeting_NmFkMDJmODUtOTE2NC00Yzg4LWI4MzctOTA1M2M4OTQ0YWQx%40thread.v2/0?context=%7b%22Tid%22%3a%22ff9422e8-ee7f-4ccd-adba-b28bb9b342f1%22%7d>\nFor organizers: Meeting options<https://teams.microsoft.com/meetingOptions/?organizerId=d246dc76&tenantId=ff9422e8&threadId=19_meeting_x@thread.v2&messageId=0&language=en-US>\n________________________________________________________________________________\n',
};

// Outlook-sent Teams invite, classic format (2023): the only join link is
// "Click here to join the meeting<…/l/meetup-join/…>", preceded in the text by
// nothing joinable and followed by download / dial-in / options links.
const TEAMS_CLASSIC = {
  id: 'teams-classic',
  location: 'Microsoft Teams Meeting',
  description: 'Where: Microsoft Teams Meeting\n\n________________________________________________________________________________\nMicrosoft Teams meeting\nJoin on your computer, mobile app or room device\nClick here to join the meeting<https://teams.microsoft.com/l/meetup-join/19%3ameeting_MWY3ZDYwZWUtMTg4NC00Y2RiLTlkNjctYzEzMzZhYzQ1ZDAw%40thread.v2/0?context=%7b%22Tid%22%3a%22f509e65c%22%7d>\nMeeting ID: 264 270 998 658\nDownload Teams<https://www.microsoft.com/en-us/microsoft-teams/download-app> | Join on the web<https://www.microsoft.com/microsoft-teams/join-a-meeting>\nLearn More<https://aka.ms/JoinTeamsMeeting> | Meeting options<https://teams.microsoft.com/meetingOptions/?organizerId=2f9cb793>\n',
};

test('Teams: new-format Outlook invite → the Join link, not System reference or Meeting options', () => {
  assert.deepEqual(resolveEventCallLink(TEAMS_NEW), {
    provider: 'teams',
    url: 'https://teams.microsoft.com/meet/228789313340874?p=ucUGCVuh5rAoojfTDy',
  });
});

test('Teams: classic Outlook invite → the meetup-join link inside "Click here…<…>"', () => {
  const link = resolveEventCallLink(TEAMS_CLASSIC);
  assert.equal(link.provider, 'teams');
  assert.match(link.url, /^https:\/\/teams\.microsoft\.com\/l\/meetup-join\/19%3ameeting_MWY3ZDYw/);
});

test('Teams: link only in conferenceData (Teams add-on, when the backend passes it through)', () => {
  const link = resolveEventCallLink({
    id: 'x',
    location: 'Microsoft Teams Meeting',
    conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://teams.microsoft.com/meet/228789313340874?p=ucUGCVuh5rAoojfTDy' }] },
  });
  assert.equal(link.provider, 'teams');
});

test('Zoom: conferenceData video entry point, skipping the phone entry before it', () => {
  assert.deepEqual(resolveEventCallLink({
    id: 'z',
    conferenceData: { entryPoints: [
      { entryPointType: 'phone', uri: 'tel:+16699006833,,85512345678#' },
      { entryPointType: 'video', uri: 'https://us02web.zoom.us/j/85512345678?pwd=abc123' },
    ] },
  }), { provider: 'zoom', url: 'https://us02web.zoom.us/j/85512345678?pwd=abc123' });
});

test('Zoom: link in a Google Calendar HTML description (<a href>), past a download link', () => {
  const link = resolveEventCallLink({
    id: 'z2',
    description: 'Stan is inviting you to a scheduled Zoom meeting.<br><br>Download Zoom: <a href="https://zoom.us/download">zoom.us/download</a><br>Join Zoom Meeting<br><a href="https://us02web.zoom.us/j/85512345678?pwd=abc&amp;uname=x">https://us02web.zoom.us/j/85512345678</a><br>Meeting ID: 855 1234 5678',
  });
  assert.equal(link.provider, 'zoom');
  assert.equal(link.url, 'https://us02web.zoom.us/j/85512345678?pwd=abc&uname=x');
});

test('Zoom: link in location (how many people paste it)', () => {
  assert.equal(resolveEventCallLink({ id: 'z3', location: 'https://zoom.us/j/98765432101' }).provider, 'zoom');
});

test('Meet: hangoutLink wins over any other link in the event', () => {
  assert.deepEqual(resolveEventCallLink({
    id: 'm', hangoutLink: 'https://meet.google.com/abc-defg-hij',
    description: 'Backup: https://zoom.us/j/98765432101',
  }), { provider: 'meet', url: 'https://meet.google.com/abc-defg-hij' });
});

test('Meet: a Meet link pasted into the description, with no hangoutLink', () => {
  assert.deepEqual(resolveEventCallLink({ id: 'm2', description: 'join at meet.google.com/abc-defg-hij please' }),
    { provider: 'meet', url: 'https://meet.google.com/abc-defg-hij' });
});

test('Outlook Safe Links are unwrapped', () => {
  const wrapped = 'https://nam12.safelinks.protection.outlook.com/?url=' + encodeURIComponent('https://teams.microsoft.com/meet/228789313340874?p=ucUGCVuh5rAoojfTDy') + '&data=05';
  assert.equal(resolveEventCallLink({ id: 's', description: `Join: <${wrapped}>` }).url,
    'https://teams.microsoft.com/meet/228789313340874?p=ucUGCVuh5rAoojfTDy');
});

test('no joinable link → null (Meeting options alone, a Slack link, plain prose, nothing)', () => {
  assert.equal(resolveEventCallLink({ id: 'n1', description: 'Meeting options<https://teams.microsoft.com/meetingOptions/?organizerId=1>' }), null);
  assert.equal(resolveEventCallLink({ id: 'n2', description: 'https://app.slack.com/client/T0ABC/C0DEF' }), null);
  assert.equal(resolveEventCallLink({ id: 'n3', location: "They'll call you @ 917-555-0100", description: 'Phone screen' }), null);
  assert.equal(resolveEventCallLink({ id: 'n4' }), null);
  assert.equal(resolveEventCallLink(null), null);
});

test('eventLinkText keeps Outlook-style <https://…> links while stripping HTML tags', () => {
  const t = eventLinkText('<p>Join<https://zoom.us/j/12345678901></p><a href="https://x.test/a">x</a>');
  assert.match(t, /<https:\/\/zoom\.us\/j\/12345678901>/);
  assert.match(t, /https:\/\/x\.test\/a/);
  assert.doesNotMatch(t, /<p>|<\/p>|<a /);
});
