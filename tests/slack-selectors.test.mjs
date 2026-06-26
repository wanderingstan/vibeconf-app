// slack-selectors.test.mjs — unit tests for the pure Slack URL/title helpers
// (#270). These are the deterministic functions behind the room-code and
// multi-tab-disambiguation logic we kept validating by hand with `node -e`.
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

// slack-selectors.js is CommonJS; load it from this ESM test.
const require = createRequire(import.meta.url);
const { SLACK } = require('../electron-app/slack-selectors.js');

test('roomCodeFor: team+channel → lowercased slack-<team>-<channel> slug', () => {
  assert.equal(SLACK.roomCodeFor('T0BCX7N0RA6', 'C0BCZ4E3Q49'), 'slack-t0bcx7n0ra6-c0bcz4e3q49');
});

test('roomCodeFromUrl: derives the code from a /client URL', () => {
  assert.equal(
    SLACK.roomCodeFromUrl('https://app.slack.com/client/T02NE0TFV/C02NE0TG9'),
    'slack-t02ne0tfv-c02ne0tg9',
  );
});

test('roomCodeFromUrl: null for a non-/client URL', () => {
  assert.equal(SLACK.roomCodeFromUrl('https://app.slack.com/'), null);
  assert.equal(SLACK.roomCodeFromUrl(''), null);
  assert.equal(SLACK.roomCodeFromUrl(null), null);
});

test('the derived room code is a valid local-server slug ([a-z0-9-]+)', () => {
  // This is the exact pattern the local-server /api/sync/:room route accepts.
  // A code that fails it 404s every sync/wait_for_speech (the bug we fixed).
  const code = SLACK.roomCodeFromUrl('https://app.slack.com/client/T0BCX7N0RA6/C0BCZ4E3Q49');
  assert.match(code, /^[a-z0-9-]+$/);
});

test('parseClientUrl: extracts {team, channel}', () => {
  assert.deepEqual(
    SLACK.parseClientUrl('https://app.slack.com/client/T1ABC/C2DEF'),
    { team: 'T1ABC', channel: 'C2DEF' },
  );
});

test('parseClientUrl: ignores query/hash and rejects non-client URLs', () => {
  assert.deepEqual(
    SLACK.parseClientUrl('https://app.slack.com/client/T1/C2?foo=bar#x'),
    { team: 'T1', channel: 'C2' },
  );
  assert.equal(SLACK.parseClientUrl('https://app.slack.com/'), null);
});

test('buildClientUrl: round-trips with parseClientUrl', () => {
  const url = SLACK.buildClientUrl('T9', 'C9');
  assert.equal(url, 'https://app.slack.com/client/T9/C9');
  assert.deepEqual(SLACK.parseClientUrl(url), { team: 'T9', channel: 'C9' });
});

test('isHuddleWindowTitle: true for a live huddle popup, false otherwise', () => {
  assert.equal(SLACK.isHuddleWindowTitle('Huddle: #testing - Vibeconferencing - Slack 🎤'), true);
  assert.equal(SLACK.isHuddleWindowTitle('  Huddle: #x'), true); // tolerates leading space
  assert.equal(SLACK.isHuddleWindowTitle('Slack - Huddle Preview'), false);
  assert.equal(SLACK.isHuddleWindowTitle('#testing (Channel) - Vibeconferencing - Slack'), false);
  assert.equal(SLACK.isHuddleWindowTitle(''), false);
});

test('participantName: parses the tile aria-label, null when it does not match', () => {
  assert.equal(SLACK.participantName("View Stan James's profile"), 'Stan James');
  assert.equal(SLACK.participantName("View Gabriel Pickard's profile"), 'Gabriel Pickard');
  assert.equal(SLACK.participantName('something else'), null);
  assert.equal(SLACK.participantName(''), null);
});
