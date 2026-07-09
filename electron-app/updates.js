// updates.js — "Check for Updates…" against the GitHub releases API.
//
// Deliberately NOT electron-updater. That wants a `publish` provider and a
// latest-mac.yml generated at build time; our releases have neither, and every
// release so far is a PRERELEASE — which /releases/latest excludes by design, so
// the obvious endpoint would always report "no updates". We list releases and
// choose ourselves.
//
// No electron imports here on purpose: the version math and release-picking are
// where the bugs live, and they're worth testing without a desktop. The dialogs,
// menus and shell integration stay in main.js.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const REPO = process.env.VIBECONF_UPDATE_REPO || 'wanderingstan/vibeconferencing';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=30`;

// The repo is PRIVATE. Both the releases API and browser_download_url return 404
// to an anonymous client — not 401, so a naive implementation reads "no releases"
// and cheerfully reports "you're up to date" forever. A token is therefore
// mandatory today, and its absence must be an explicit, visible failure.
//
// (The durable fix is publishing a manifest + DMG from vibeconferencing.com, so
// friends don't each need a GitHub token. Until then: env var.)
function githubToken() {
  return (process.env.VIBECONF_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '').trim() || null;
}

class NoTokenError extends Error {
  constructor() {
    super('This repository is private, so checking for updates needs a GitHub token. ' +
      'Set VIBECONF_GITHUB_TOKEN (a fine-grained token with read access to Contents) and relaunch.');
    this.name = 'NoTokenError';
  }
}

function authHeaders() {
  const tok = githubToken();
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

// Parse "v0.7.0-beta60" / "0.7.0" / "1.2.3-rc.4" into comparable parts.
// Returns null for anything we can't understand, so an unparsable tag can never
// be mistaken for a newer version.
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(v || '').trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] || null, // e.g. "beta60", "rc.4"
  };
}

// Split a prerelease tag into comparable identifiers, per semver: numeric
// identifiers compare numerically, others lexically. "beta60" is ONE identifier
// with a number glued on, which semver would compare as a string ("beta60" <
// "beta9"). We split letters from digits so beta60 > beta9, because that is what
// our tags actually mean.
function preIdentifiers(pre) {
  return String(pre).split('.').flatMap((part) => {
    const m = /^([a-zA-Z-]+)(\d+)$/.exec(part);
    return m ? [m[1], Number(m[2])] : [/^\d+$/.test(part) ? Number(part) : part];
  });
}

function comparePre(a, b) {
  // No prerelease outranks a prerelease: 1.0.0 > 1.0.0-beta1.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const A = preIdentifiers(a);
  const B = preIdentifiers(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i];
    const y = B[i];
    if (x === undefined) return -1; // fewer identifiers = lower precedence
    if (y === undefined) return 1;
    const bothNum = typeof x === 'number' && typeof y === 'number';
    if (bothNum) { if (x !== y) return x < y ? -1 : 1; continue; }
    if (typeof x === 'number') return -1; // numeric < alphanumeric
    if (typeof y === 'number') return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// -1 / 0 / 1. Unparsable versions sort BELOW everything, never above.
function compareVersions(a, b) {
  const A = parseVersion(a);
  const B = parseVersion(b);
  if (!A && !B) return 0;
  if (!A) return -1;
  if (!B) return 1;
  for (const k of ['major', 'minor', 'patch']) {
    if (A[k] !== B[k]) return A[k] < B[k] ? -1 : 1;
  }
  return comparePre(A.pre, B.pre);
}

// The newest release strictly newer than `currentVersion`, or null.
// Drafts are never offered. Prereleases ARE offered — that is all we ship — but
// a caller can opt out with {includePrereleases: false}.
function pickUpdate(releases, currentVersion, { includePrereleases = true } = {}) {
  const candidates = (releases || [])
    .filter((r) => r && !r.draft)
    .filter((r) => includePrereleases || !r.prerelease)
    .filter((r) => parseVersion(r.tag_name))
    .filter((r) => compareVersions(r.tag_name, currentVersion) > 0)
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  return candidates[0] || null;
}

// The .dmg asset of a release, or null. Prefers an arch-specific build matching
// this machine so an Intel host is never handed an arm64 image.
function pickDmgAsset(release, arch = process.arch) {
  const assets = (release && release.assets) || [];
  const dmgs = assets.filter((a) => /\.dmg$/i.test(a.name || ''));
  if (!dmgs.length) return null;
  const wanted = arch === 'arm64' ? /arm64/i : /(x64|intel)/i;
  return dmgs.find((a) => wanted.test(a.name)) || (dmgs.length === 1 ? dmgs[0] : null);
}

async function fetchReleases({ fetchImpl = globalThis.fetch, timeoutMs = 10000, requireToken = true } = {}) {
  if (requireToken && !githubToken()) throw new NoTokenError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'vibeconferencing-app', ...authHeaders() },
      signal: controller.signal,
    });
    // A private repo answers 404 (not 403) to a client that can't see it, so an
    // expired or under-scoped token looks exactly like "repo doesn't exist".
    if (resp.status === 404) {
      throw new Error('GitHub returned 404 — the token is missing, expired, or lacks read access to this private repo.');
    }
    if (!resp.ok) throw new Error(`GitHub API returned ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// Download to a .part file and rename only on success, so an interrupted
// download can never look like a finished one sitting in ~/Downloads.
async function downloadAsset(asset, { dir = path.join(os.homedir(), 'Downloads'), fetchImpl = globalThis.fetch, onProgress } = {}) {
  const dest = path.join(dir, asset.name);
  const part = `${dest}.part`;

  // browser_download_url is a public-web URL and 404s on a private repo even with
  // a token. The API asset endpoint (asset.url) serves the bytes when asked for
  // octet-stream. Prefer it whenever we have a token; fall back to the public URL
  // so this keeps working if the repo is ever made public.
  const tok = githubToken();
  const url = tok && asset.url ? asset.url : asset.browser_download_url;
  const headers = { 'User-Agent': 'vibeconferencing-app', ...(tok ? authHeaders() : {}) };
  if (tok && asset.url) headers.Accept = 'application/octet-stream';

  const resp = await fetchImpl(url, { headers, redirect: 'follow' });
  if (!resp.ok) throw new Error(`download failed: HTTP ${resp.status}`);

  const total = Number(resp.headers.get('content-length')) || asset.size || 0;
  let seen = 0;

  // pipeline() honors backpressure and destroys both ends on failure. Hand-rolling
  // `for await (chunk) out.write(chunk)` ignores write()'s return value, so a
  // 127MB image can buffer in memory faster than the disk drains it.
  const body = Readable.fromWeb(resp.body);
  body.on('data', (chunk) => {
    seen += chunk.length;
    if (onProgress && total) onProgress(seen / total);
  });
  try {
    await pipeline(body, fs.createWriteStream(part));
  } catch (err) {
    fs.rmSync(part, { force: true }); // never leave a truncated .part behind
    throw err;
  }
  if (total && seen !== total) {
    fs.rmSync(part, { force: true });
    throw new Error(`download truncated: got ${seen} of ${total} bytes`);
  }
  fs.renameSync(part, dest);
  return dest;
}

module.exports = {
  RELEASES_URL,
  NoTokenError,
  githubToken,
  parseVersion,
  compareVersions,
  pickUpdate,
  pickDmgAsset,
  fetchReleases,
  downloadAsset,
};
