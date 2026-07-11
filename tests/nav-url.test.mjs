// nav-url.test.mjs — the ⌘⇧L "Navigate Webview…" URL normalizer.
//
// A bare host typed into the box should just work (prepend https://); anything
// with a non-http scheme must still be refused, since the result feeds
// meetView.loadURL and we only ever navigate the bot's webview to http(s).
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeNavUrl } = require('../electron-app/nav-url.js');

test('a bare host gets https:// prepended — the whole point', () => {
  assert.deepEqual(normalizeNavUrl('example.com'), { ok: true, url: 'https://example.com' });
  assert.deepEqual(normalizeNavUrl('meet.google.com/abc-defg-hij'),
    { ok: true, url: 'https://meet.google.com/abc-defg-hij' });
  assert.deepEqual(normalizeNavUrl('localhost:3000/path?q=1'),
    { ok: true, url: 'https://localhost:3000/path?q=1' });
});

test('an explicit http(s):// scheme is left exactly as typed', () => {
  assert.equal(normalizeNavUrl('https://example.com').url, 'https://example.com');
  assert.equal(normalizeNavUrl('http://example.com').url, 'http://example.com');
  assert.equal(normalizeNavUrl('HTTPS://Example.com/Path').url, 'HTTPS://Example.com/Path',
    'scheme detection is case-insensitive; the rest is untouched');
});

test('surrounding whitespace is trimmed before deciding', () => {
  assert.equal(normalizeNavUrl('   example.com  ').url, 'https://example.com');
  assert.equal(normalizeNavUrl('\thttp://x\n').url, 'http://x');
});

test('a non-http scheme is refused, not silently prefixed', () => {
  for (const bad of ['ftp://host/f', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'about:blank']) {
    const r = normalizeNavUrl(bad);
    assert.equal(r.ok, false, `${bad} must be refused`);
    assert.match(r.error, /http\(s\)/);
  }
});

test('we never turn a non-http scheme INTO an https URL by prefixing', () => {
  // The guard is: has-a-scheme → keep it → then require http(s). So file:// is
  // kept (not prefixed) and then rejected — it must never become
  // "https://file:///…".
  const r = normalizeNavUrl('file:///etc/passwd');
  assert.equal(r.ok, false);
  assert.equal(r.url, undefined);
});

test('empty / blank / nullish input is an error, not "https://"', () => {
  for (const empty of ['', '   ', '\t', null, undefined]) {
    const r = normalizeNavUrl(empty);
    assert.equal(r.ok, false, `${JSON.stringify(empty)} → error`);
    assert.match(r.error, /Enter a URL/);
  }
});

test('scheme-relative and odd-but-hostish inputs still resolve to https', () => {
  // No scheme (the leading // is not "<scheme>://"), so treated as a host.
  assert.equal(normalizeNavUrl('example.com/a//b').url, 'https://example.com/a//b');
  // A port-only host.
  assert.equal(normalizeNavUrl('127.0.0.1:8080').url, 'https://127.0.0.1:8080');
});
