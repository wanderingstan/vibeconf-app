// docs-origins.js: which browser origins the local servers answer cross-origin.
// The API explorer at vibeconferencing.com/api is allowed by default; anything
// else gets no CORS headers (and so cannot read a response), as #356 intended.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { allowedOrigins, applyCors, DEFAULT_ALLOWED_ORIGINS } = require('../electron-app/docs-origins.js');

function fakeRes() {
  const headers = {};
  return { headers, setHeader: (k, v) => { headers[k] = v; }, getHeader: (k) => headers[k] };
}

test('the site is allowed by default, nothing else is', () => {
  const prev = process.env.VIBECONF_ALLOWED_ORIGINS;
  delete process.env.VIBECONF_ALLOWED_ORIGINS;
  const set = allowedOrigins();
  for (const o of DEFAULT_ALLOWED_ORIGINS) assert.ok(set.has(o), o);
  assert.ok(!set.has('http://evil.example'));
  assert.ok(!set.has('http://127.0.0.1:3000'));
  if (prev !== undefined) process.env.VIBECONF_ALLOWED_ORIGINS = prev;
});

test('VIBECONF_ALLOWED_ORIGINS adds, and extra origins add per call', () => {
  const prev = process.env.VIBECONF_ALLOWED_ORIGINS;
  process.env.VIBECONF_ALLOWED_ORIGINS = ' http://a.test , http://b.test ';
  const set = allowedOrigins(['http://127.0.0.1:7871']);
  assert.ok(set.has('http://a.test') && set.has('http://b.test'));
  assert.ok(set.has('http://127.0.0.1:7871'));
  assert.ok(set.has('https://vibeconferencing.com'), 'env adds to the defaults, it does not replace them');
  if (prev === undefined) delete process.env.VIBECONF_ALLOWED_ORIGINS; else process.env.VIBECONF_ALLOWED_ORIGINS = prev;
});

test('applyCors sets the headers for an allowed origin, including the private-network opt-in', () => {
  const res = fakeRes();
  const ok = applyCors({ headers: { origin: 'https://vibeconferencing.com' } }, res);
  assert.equal(ok, true);
  assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://vibeconferencing.com');
  assert.equal(res.headers['Access-Control-Allow-Private-Network'], 'true');
  assert.match(res.headers['Access-Control-Allow-Headers'], /Authorization/);
  assert.equal(res.headers['Vary'], 'Origin');
});

test('applyCors sets nothing for an unknown origin or no origin', () => {
  for (const headers of [{ origin: 'http://evil.example' }, {}]) {
    const res = fakeRes();
    assert.equal(applyCors({ headers }, res), false);
    assert.equal(Object.keys(res.headers).length, 0);
  }
});
