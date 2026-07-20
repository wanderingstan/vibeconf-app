// updates.test.mjs — "Check for Updates…" version math and release picking.
//
// Not electron-updater: our releases carry no latest-mac.yml, and every one is a
// PRERELEASE — which GitHub's /releases/latest excludes by design, so the obvious
// endpoint would report "no updates" forever. We list and choose ourselves, which
// means the choosing has to be right.
//
// The trap this file exists for: under strict semver, prerelease identifiers
// compare lexically, so "beta9" > "beta60" — and beta60 would never be offered
// to a beta9 user. Our tags glue a number onto a word, so we split them.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseVersion, compareVersions, pickUpdate, pickDmgAsset } = require('../electron-app/updates.js');

const cmp = compareVersions;

test('parses our tag shapes, rejects nonsense', () => {
  assert.deepEqual(parseVersion('v0.7.0-beta60'), { major: 0, minor: 7, patch: 0, pre: 'beta60' });
  assert.deepEqual(parseVersion('0.7.0'), { major: 0, minor: 7, patch: 0, pre: null });
  for (const bad of ['', 'latest', 'v1.2', 'nightly-2026-07-09', null, undefined]) {
    assert.equal(parseVersion(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
});

test('numeric ordering of major/minor/patch', () => {
  assert.equal(cmp('1.0.0', '0.9.9'), 1);
  assert.equal(cmp('0.7.0', '0.7.1'), -1);
  assert.equal(cmp('0.10.0', '0.9.0'), 1, '10 > 9, not "10" < "9"');
  assert.equal(cmp('v0.7.0', '0.7.0'), 0, 'the v prefix is noise');
});

test('beta60 is newer than beta9 — the whole reason this module exists', () => {
  assert.equal(cmp('0.7.0-beta60', '0.7.0-beta9'), 1);
  assert.equal(cmp('0.7.0-beta9', '0.7.0-beta60'), -1);
  assert.equal(cmp('0.7.0-beta60', '0.7.0-beta52'), 1, 'the actual upgrade Stan just did');
  assert.equal(cmp('0.7.0-beta60', '0.7.0-beta60'), 0);
});

test('a release outranks its own prereleases', () => {
  assert.equal(cmp('0.7.0', '0.7.0-beta60'), 1);
  assert.equal(cmp('0.7.0-beta60', '0.7.0'), -1);
});

test('unparsable versions sort below everything and can never be "newer"', () => {
  assert.equal(cmp('nightly', '0.0.1'), -1);
  assert.equal(cmp('0.0.1', 'nightly'), 1);
  assert.equal(cmp('nightly', 'nightly'), 0);
});

const rel = (tag, extra = {}) => ({ tag_name: tag, draft: false, prerelease: true, html_url: `u/${tag}`, assets: [], ...extra });

test('picks the newest release strictly newer than current', () => {
  const releases = [rel('v0.7.0-beta58'), rel('v0.7.0-beta60'), rel('v0.7.0-beta59')];
  assert.equal(pickUpdate(releases, '0.7.0-beta52').tag_name, 'v0.7.0-beta60');
  assert.equal(pickUpdate(releases, '0.7.0-beta59').tag_name, 'v0.7.0-beta60');
});

test('no update when current is latest — or ahead of it (a dev build)', () => {
  const releases = [rel('v0.7.0-beta60')];
  assert.equal(pickUpdate(releases, '0.7.0-beta60'), null, 'equal is not newer');
  assert.equal(pickUpdate(releases, '0.7.0-beta61'), null, 'a local build must not be told to downgrade');
  assert.equal(pickUpdate(releases, '0.8.0'), null);
});

test('drafts are never offered', () => {
  const releases = [rel('v0.9.0', { draft: true }), rel('v0.7.0-beta60')];
  assert.equal(pickUpdate(releases, '0.7.0-beta52').tag_name, 'v0.7.0-beta60');
});

test('prereleases are offered by default — they are all we ship — but can be opted out', () => {
  const releases = [rel('v0.7.0-beta60'), rel('v0.6.1', { prerelease: false })];
  assert.equal(pickUpdate(releases, '0.6.0').tag_name, 'v0.7.0-beta60');
  assert.equal(pickUpdate(releases, '0.6.0', { includePrereleases: false }).tag_name, 'v0.6.1');
});

test('a release with an unparsable tag is skipped, not crashed on', () => {
  const releases = [rel('nightly'), rel('v0.7.0-beta60')];
  assert.equal(pickUpdate(releases, '0.7.0-beta52').tag_name, 'v0.7.0-beta60');
  assert.equal(pickUpdate([rel('nightly')], '0.7.0-beta52'), null);
});

test('empty / missing release list is not an update', () => {
  assert.equal(pickUpdate([], '0.7.0-beta60'), null);
  assert.equal(pickUpdate(null, '0.7.0-beta60'), null);
  assert.equal(pickUpdate(undefined, '0.7.0-beta60'), null);
});

// --- asset selection ---------------------------------------------------------

const asset = (name) => ({ name, browser_download_url: `https://x/${name}`, size: 1 });

test('picks the DMG matching this machine’s architecture', () => {
  const r = rel('v0.7.0-beta60', {
    assets: [
      asset('Vibeconferencing-0.7.0-beta60-arm64-mac.zip'),
      asset('Vibeconferencing-0.7.0-beta60-arm64.dmg'),
      asset('Vibeconferencing-0.7.0-beta60-x64.dmg'),
    ],
  });
  assert.equal(pickDmgAsset(r, 'arm64').name, 'Vibeconferencing-0.7.0-beta60-arm64.dmg');
  assert.equal(pickDmgAsset(r, 'x64').name, 'Vibeconferencing-0.7.0-beta60-x64.dmg',
    'an Intel Mac must never be handed an arm64 image');
});

test('a lone DMG is accepted regardless of arch tagging', () => {
  const r = rel('v0.7.0-beta60', { assets: [asset('Vibeconferencing-0.7.0-beta60-arm64.dmg')] });
  assert.equal(pickDmgAsset(r, 'arm64').name, 'Vibeconferencing-0.7.0-beta60-arm64.dmg');
});

test('no DMG, or no DMG for this arch, yields null rather than the wrong file', () => {
  const zipOnly = rel('v0.7.0-beta60', { assets: [asset('Vibeconferencing-0.7.0-beta60-arm64-mac.zip')] });
  assert.equal(pickDmgAsset(zipOnly, 'arm64'), null);

  const twoWrongArch = rel('v1', { assets: [asset('a-arm64.dmg'), asset('b-arm64.dmg')] });
  assert.equal(pickDmgAsset(twoWrongArch, 'x64'), null, 'ambiguous and wrong → offer nothing');

  assert.equal(pickDmgAsset(null, 'arm64'), null);
});

test('the real beta60 release shape resolves correctly for an arm64 Mac', () => {
  const real = rel('v0.7.0-beta60', {
    assets: [
      asset('Vibeconferencing-0.7.0-beta60-arm64-mac.zip'),
      asset('Vibeconferencing-0.7.0-beta60-arm64.dmg'),
    ],
  });
  const update = pickUpdate([real], '0.7.0-beta52');
  assert.equal(update.tag_name, 'v0.7.0-beta60');
  assert.equal(pickDmgAsset(update, 'arm64').name, 'Vibeconferencing-0.7.0-beta60-arm64.dmg');
});

// --- downloadAsset: a partial file must never look like a finished one --------

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { downloadAsset } = require('../electron-app/updates.js');

function serve(payload) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/good.dmg') { res.setHeader('content-length', payload.length); res.end(payload); }
    else if (req.url === '/short.dmg') { res.setHeader('content-length', payload.length * 2); res.end(payload); }
    else { res.writeHead(404); res.end('nope'); }
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res(srv)));
}

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcup-'));

test('downloads to Downloads-style dir, reports progress, renames on success', async () => {
  const payload = Buffer.alloc(512 * 1024, 7);
  const srv = await serve(payload);
  const dir = tmpdir();
  try {
    const port = srv.address().port;
    let last = 0;
    const file = await downloadAsset(
      { name: 'good.dmg', browser_download_url: `http://127.0.0.1:${port}/good.dmg`, size: payload.length },
      { dir, onProgress: (f) => { last = f; } }
    );
    assert.equal(path.basename(file), 'good.dmg');
    assert.equal(fs.statSync(file).size, payload.length);
    assert.equal(last, 1, 'progress reaches 100%');
    assert.deepEqual(fs.readdirSync(dir), ['good.dmg'], 'no .part left behind');
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a truncated download is rejected and leaves no .part file', async () => {
  const payload = Buffer.alloc(256 * 1024, 7);
  const srv = await serve(payload);
  const dir = tmpdir();
  try {
    const port = srv.address().port;
    await assert.rejects(() => downloadAsset(
      { name: 'short.dmg', browser_download_url: `http://127.0.0.1:${port}/short.dmg`, size: payload.length * 2 },
      { dir }
    ));
    assert.deepEqual(fs.readdirSync(dir), [], 'a half-downloaded installer must not survive');
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an HTTP error is surfaced, not written to disk', async () => {
  const srv = await serve(Buffer.alloc(16));
  const dir = tmpdir();
  try {
    const port = srv.address().port;
    await assert.rejects(
      () => downloadAsset({ name: 'missing.dmg', browser_download_url: `http://127.0.0.1:${port}/missing.dmg`, size: 16 }, { dir }),
      /HTTP 404/
    );
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- private repo: never mistake "can't see it" for "no updates" -------------
// The repo is private. GitHub answers 404 (not 401/403) to a client that cannot
// see it. A naive implementation reads that as an empty release list and reports
// "you're up to date" forever — the worst possible failure for an updater.

const { fetchReleases, NoTokenError, githubToken } = require('../electron-app/updates.js');

function withoutToken(fn) {
  const saved = [process.env.VIBECONF_GITHUB_TOKEN, process.env.GITHUB_TOKEN];
  delete process.env.VIBECONF_GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  return Promise.resolve(fn()).finally(() => {
    if (saved[0] !== undefined) process.env.VIBECONF_GITHUB_TOKEN = saved[0];
    if (saved[1] !== undefined) process.env.GITHUB_TOKEN = saved[1];
  });
}

test('no token is fine — the public repo needs no auth (token optional)', async () => {
  await withoutToken(async () => {
    assert.equal(githubToken(), null);
    // Default requireToken is false now (public repo): fetchReleases works anonymously.
    const releases = await fetchReleases({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => [{ tag_name: 'v0.7.0-beta1' }] }),
    });
    assert.equal(releases.length, 1);
    // The strict opt-in path still errors when a caller explicitly requires a token.
    await assert.rejects(
      () => fetchReleases({ requireToken: true, fetchImpl: () => { throw new Error('must not be called'); } }),
      (e) => e instanceof NoTokenError);
  });
});

test('a 404 from GitHub is reported as not-found', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, json: async () => [] });
  await assert.rejects(
    () => fetchReleases({ fetchImpl, requireToken: false }),
    /404 — the releases endpoint or repo could not be found/
  );
});

test('the token is sent as a bearer header', async () => {
  let seen = null;
  const fetchImpl = async (_url, opts) => { seen = opts.headers; return { ok: true, status: 200, json: async () => [] }; };
  process.env.VIBECONF_GITHUB_TOKEN = 'tok123';
  try {
    await fetchReleases({ fetchImpl });
    assert.equal(seen.Authorization, 'Bearer tok123');
    assert.equal(seen.Accept, 'application/vnd.github+json');
  } finally { delete process.env.VIBECONF_GITHUB_TOKEN; }
});
