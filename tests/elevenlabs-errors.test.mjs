// Classifying ElevenLabs /v1/voices failures.
//
// The case that motivated this: a key that works for speaking but lacks the
// `voices_read` scope 401s the list call. That used to be swallowed into an
// empty list, so the user saw "no voices" with no reason and assumed the key
// was wrong. These tests pin the distinction between the failure modes.

import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
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

// A key from before ElevenLabs moved to `sk_`-prefixed keys. Seen in the field:
// one had been stored for months, every ElevenLabs call failed, the bot silently
// used a system voice, and the only symptom was "it won't let me set an 11labs
// voice" — with nothing pointing at the key.
test('a legacy-format key is named as such, not as a typo', () => {
  // The REAL body ElevenLabs returns. Note status and code disagree, which is
  // why reading status alone missed it and it fell through to generic HTTP.
  const body = { detail: {
    type: 'authentication_error',
    code: 'invalid_api_key',
    message: "API key must start with 'sk_'.",
    status: 'invalid_api_key_prefix',
  } };
  const e = classifyVoicesError(400, body);
  assert.equal(e.kind, 'legacy_key');
  // "Check for a typo" is the WRONG advice here — the key is not repairable.
  assert.doesNotMatch(e.message, /typo/i);
  assert.match(e.message, /old format/i);
  assert.match(e.message, /sk_/);
  assert.match(e.message, /generate a new one/i);
});

test('code is read as well as status, since ElevenLabs sends both', () => {
  // A body whose status is unfamiliar but whose code is the known one must still
  // be recognised as a bad key rather than a generic HTTP failure.
  const e = classifyVoicesError(401, {
    detail: { code: 'invalid_api_key', status: 'some_new_status', message: 'nope' },
  });
  assert.equal(e.kind, 'invalid_key');
});

test('missing voices_read explains the manual voice-id route', () => {
  // Without the list, picking a voice by name is impossible — but pasting an id
  // still works, and that is the only way forward until the scope is fixed.
  const e = classifyVoicesError(401, {
    detail: { status: 'missing_permissions', message: 'missing the permission voices_read' },
  });
  // Name the actual control, not just the concept — the whole point is that
  // someone in this state can still get to an ElevenLabs voice, and they need to
  // know WHERE. It was behind an "Advanced" disclosure until this change.
  assert.match(e.message, /ElevenLabs Voice ID/);
  assert.match(e.message, /Bot Settings/);
  assert.match(e.message, /page URL/i);
});

test('the voice-id field is a plain setting, not hidden behind a disclosure', () => {
  // It used to sit inside <details>Advanced: custom ElevenLabs Voice ID</details>.
  // That is the wrong place for the ONE control that still works when the voice
  // LIST does not — a key scoped without voices_read can synthesise but not
  // enumerate, so pasting an id here is the only route to an ElevenLabs voice.
  // Hiding the escape hatch behind "advanced" made a recoverable state look like
  // a dead end, and the error message now points people straight at it.
  // Comments stripped first: the markup now CARRIES a comment explaining that it
  // used to live in a <details>, and matching that would fail the test for
  // saying so.
  const html = readFileSync(join(root, 'electron-app/renderer/panel.html'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');
  const i = html.indexOf('id="ttsVoiceId"');
  assert.ok(i > 0, 'the field must exist');
  // Walk back from the field: if a <details> opened and never closed before we
  // reach it, the field is inside one.
  const before = html.slice(0, i);
  const opens = (before.match(/<details[\s>]/g) || []).length;
  const closes = (before.match(/<\/details>/g) || []).length;
  assert.equal(opens, closes, 'the voice-id field must not sit inside an open <details>');
  assert.match(before.slice(-300), /<label for="ttsVoiceId">/,
    'and it should carry a plain label like every other setting');
});

test('typing a voice id sets the PROVIDER too, not just the id', () => {
  // The failure this prevents, seen live: ttsVoiceId was stored while
  // ttsProvider stayed 'macos-say', so the bot spoke in a system voice and
  // ignored the id — the setting looked saved and did nothing.
  const panel = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');
  const h = panel.slice(panel.indexOf("ttsVoiceIdInput.addEventListener('change'"));
  assert.match(h.slice(0, 400), /provider: 'elevenlabs', voiceId: id/);
});
