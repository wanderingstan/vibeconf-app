// Classifying ElevenLabs /v1/voices failures.
//
// The case that motivated this: a key that works for speaking but lacks the
// `voices_read` scope 401s the list call. That used to be swallowed into an
// empty list, so the user saw "no voices" with no reason and assumed the key
// was wrong. These tests pin the distinction between the failure modes.

import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyVoicesError, classifyVoicesNetworkError } =
  require('../electron-app/elevenlabs-errors.js');

const missingPerms = (perm = 'voices_read') => ({
  detail: {
    status: 'missing_permissions',
    message: `The API key you used is missing the permission ${perm} to execute this operation.`,
  },
});

test('a scoped key missing voices_read is identified, not lumped in with a bad key', () => {
  const e = classifyVoicesError(401, missingPerms());
  assert.equal(e.kind, 'missing_permissions');
  assert.equal(e.permission, 'voices_read');
  assert.match(e.message, /voices_read/);
  // The actionable part: this key is not necessarily broken.
  assert.match(e.message, /Speaking may still work/i);
});

test('the permission name is taken from the API message, not hardcoded', () => {
  const e = classifyVoicesError(401, missingPerms('user_read'));
  assert.equal(e.permission, 'user_read');
  assert.match(e.message, /user_read/);
});

test('missing permissions is detected from the message even if the status string changes', () => {
  const e = classifyVoicesError(401, {
    detail: { status: 'something_new', message: 'This key is missing the permission voices_read.' },
  });
  assert.equal(e.kind, 'missing_permissions');
  assert.equal(e.permission, 'voices_read');
});

test('an invalid key is distinguished from a valid key with the wrong scope', () => {
  const e = classifyVoicesError(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } });
  assert.equal(e.kind, 'invalid_key');
  assert.doesNotMatch(e.message, /permission/i);
});

test('quota exhaustion is its own case', () => {
  const e = classifyVoicesError(401, { detail: { status: 'quota_exceeded', message: 'Quota exceeded' } });
  assert.equal(e.kind, 'quota');
});

test('a string detail body is handled as well as an object one', () => {
  const e = classifyVoicesError(422, { detail: 'Unprocessable' });
  assert.equal(e.kind, 'http');
  assert.match(e.message, /Unprocessable/);
});

test('an unparseable body still yields a visible message rather than silence', () => {
  const e = classifyVoicesError(502, null);
  assert.equal(e.kind, 'http');
  assert.match(e.message, /502/);
  assert.ok(e.message.length > 0);
});

test('429 is reported as rate limiting', () => {
  assert.equal(classifyVoicesError(429, null).kind, 'rate_limited');
});

test('an unrecognized 401 still says the key was rejected', () => {
  const e = classifyVoicesError(401, {});
  assert.equal(e.kind, 'unauthorized');
  assert.match(e.message, /401/);
});

test('a timeout is distinguished from a hard network failure', () => {
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  assert.equal(classifyVoicesNetworkError(abort).kind, 'timeout');
  assert.equal(classifyVoicesNetworkError(new Error('getaddrinfo ENOTFOUND')).kind, 'network');
});
