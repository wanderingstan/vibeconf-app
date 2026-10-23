import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PAGE_PROBES, probeSource, describeAccount } = require('../electron-app/calling-app-accounts.js');

// Run a page probe against a fake localStorage (no indexedDB, like a page
// whose idb cache isn't written yet).
async function runProbe(app, items) {
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k in items ? items[k] : null) };
  try { return await PAGE_PROBES[app](); } finally { globalThis.localStorage = saved; }
}

test('whatsapp: signed out when there is no linked number', async () => {
  assert.equal(describeAccount('whatsapp', await runProbe('whatsapp', {})), null);
});

test('whatsapp: shows the linked number, and the push name when known', async () => {
  const raw = await runProbe('whatsapp', { 'last-wid-md': '"15551234567:12@c.us"', 'last-pushname': '"Jimmy"' });
  assert.deepEqual(describeAccount('whatsapp', raw), { label: 'Jimmy · +15551234567' });
  const bare = await runProbe('whatsapp', { 'last-wid-md': '"15551234567:3@c.us"' });
  assert.deepEqual(describeAccount('whatsapp', bare), { label: '+15551234567' });
});

test('telegram: signed out without user_auth', async () => {
  assert.equal(describeAccount('telegram', await runProbe('telegram', {})), null);
});

test('telegram: name, active username and phone from the cached global state', async () => {
  const state = {
    currentUserId: '42',
    users: { byId: { 42: { firstName: 'Jimmy', lastName: 'Bot', phoneNumber: '15551234567', usernames: [{ username: 'old', isActive: false }, { username: 'jimmybot', isActive: true }] } } },
  };
  const raw = await runProbe('telegram', { user_auth: '{"dcID":2,"id":"42"}', 'tt-global-state': JSON.stringify(state) });
  assert.deepEqual(describeAccount('telegram', raw), { label: 'Jimmy Bot · @jimmybot · +15551234567' });
});

test('telegram: falls back to the user id before the profile is cached', async () => {
  const raw = await runProbe('telegram', { user_auth: '{"dcID":2,"id":"42"}' });
  assert.deepEqual(describeAccount('telegram', raw), { label: 'user id 42' });
});

test('probeSource is a self-contained expression for every app', () => {
  for (const app of ['whatsapp', 'telegram']) assert.match(probeSource(app), /^\((async )?function/);
  assert.equal(probeSource('nope'), null);
});
