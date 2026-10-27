// local-file-access.test.mjs: file:// URLs are decoded, and "can the app read
// this file" means open() + read, not stat().
//
// Both bugs came from a bot showing photos off a USB archive drive at
// "/Volumes/Stan-Exos14-Archive/Family Archives/...":
//   - svg-resolver opened "Family%20Archives" literally (ENOENT);
//   - the whiteboard asset server registered a file macOS would not let the
//     app open (TCC denies open() with EPERM but allows stat()), and the board
//     silently showed nothing.
//
// Run: node --test tests/local-file-access.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { localPathFromRef, describeReadError, probeReadable, checkLoadUrlTarget } =
  require('../electron-app/local-file-access.js');
const { resolveSvg, resolveRef } = require('../electron-app/svg-resolver.js');

const posix = { platform: 'darwin', homedir: '/Users/ted' };

test('file URL with %20 decodes to a path with spaces', () => {
  assert.equal(
    localPathFromRef('file:///Volumes/Stan-Exos14-Archive/Family%20Archives/Ronald%20Vernon%20James%20-%20Archives/Claude%20Analysis/thumbs/675.jpg', posix),
    '/Volumes/Stan-Exos14-Archive/Family Archives/Ronald Vernon James - Archives/Claude Analysis/thumbs/675.jpg',
  );
});

test('file URL decodes %23, %25 and unicode', () => {
  assert.equal(localPathFromRef('file:///tmp/photo%20%231.jpg', posix), '/tmp/photo #1.jpg');
  assert.equal(localPathFromRef('file:///tmp/100%25.png', posix), '/tmp/100%.png');
  assert.equal(localPathFromRef('file:///tmp/Gro%C3%9Fmutter%20%E2%9D%A4.png', posix), '/tmp/Großmutter ❤.png');
  // Already-decoded unicode in the URL is fine too.
  assert.equal(localPathFromRef('file:///tmp/Großmutter.png', posix), '/tmp/Großmutter.png');
});

test('file://localhost/ is the same as file:///', () => {
  assert.equal(localPathFromRef('file://localhost/tmp/a%20b.png', posix), '/tmp/a b.png');
});

test('file URL with a remote host or an encoded slash is rejected, not guessed at', () => {
  assert.throws(() => localPathFromRef('file://otherhost/tmp/a.png', posix));
  assert.throws(() => localPathFromRef('file:///tmp/a%2Fb.png', posix));
});

test('Windows-style file URLs decode to drive paths on win32', () => {
  assert.equal(localPathFromRef('file:///C:/Users/Ted/My%20Pictures/a.png', { platform: 'win32', homedir: 'C:\\Users\\Ted' }),
    'C:\\Users\\Ted\\My Pictures\\a.png');
});

test('raw paths are used as written (a raw path is not a URL)', () => {
  assert.equal(localPathFromRef('/tmp/with space/a.png', posix), '/tmp/with space/a.png');
  assert.equal(localPathFromRef('/tmp/literally%20.png', posix), '/tmp/literally%20.png');
  assert.equal(localPathFromRef('~/Library/Application Support/x.png', posix), '/Users/ted/Library/Application Support/x.png');
});

test('non-local refs return null', () => {
  for (const r of ['https://x/a.png', 'data:image/png;base64,AA', 'relative/a.png', '', null, undefined]) {
    assert.equal(localPathFromRef(r, posix), null, String(r));
  }
});

test('describeReadError: EPERM on /Volumes on macOS names Removable Volumes', () => {
  const msg = describeReadError({ code: 'EPERM', message: 'operation not permitted' },
    '/Volumes/Drive/Family Archives/a.jpg', { platform: 'darwin' });
  assert.match(msg, /permission denied \(EPERM\)/);
  assert.match(msg, /Removable Volumes/);
  assert.match(msg, /Privacy & Security/);
  assert.match(msg, /\/Volumes\/Drive\/Family Archives\/a\.jpg/);
});

test('describeReadError: EPERM elsewhere on macOS names Files and Folders', () => {
  const msg = describeReadError({ code: 'EPERM' }, '/Users/ted/Documents/a.jpg', { platform: 'darwin' });
  assert.match(msg, /Files and Folders/);
});

test('describeReadError: EACCES is Unix permissions, not a privacy-settings hint', () => {
  const msg = describeReadError({ code: 'EACCES' }, '/Users/stan/a.jpg', { platform: 'darwin' });
  assert.match(msg, /permission denied \(EACCES\)/);
  assert.match(msg, /OS user/);
  assert.doesNotMatch(msg, /Privacy/);
});

test('describeReadError: ENOENT says not found, other platforms get no macOS hint', () => {
  assert.match(describeReadError({ code: 'ENOENT' }, '/x', { platform: 'darwin' }), /not found/);
  assert.doesNotMatch(describeReadError({ code: 'EPERM' }, '/x', { platform: 'linux' }), /Privacy/);
});

function tmpWithSpaces() {
  const dir = mkdtempSync(join(tmpdir(), 'vibeconf lfa '));
  const sub = join(dir, 'Family Archives', 'Claude Analysis');
  mkdirSync(sub, { recursive: true });
  return { dir, sub };
}

test('probeReadable: readable file in a dir with spaces passes and returns stats', () => {
  const { dir, sub } = tmpWithSpaces();
  try {
    const f = join(sub, 'photo #1.png');
    writeFileSync(f, 'abc');
    assert.equal(probeReadable(f).size, 3);
    const empty = join(sub, 'empty.png');
    writeFileSync(empty, '');
    assert.equal(probeReadable(empty).size, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('probeReadable: missing file, directory and unreadable file all throw with a code', () => {
  const { dir, sub } = tmpWithSpaces();
  try {
    assert.throws(() => probeReadable(join(sub, 'nope.png')), (e) => e.code === 'ENOENT' && /not found/.test(e.message));
    assert.throws(() => probeReadable(sub), (e) => e.code === 'EISDIR');
    if (process.getuid && process.getuid() !== 0) {
      const f = join(sub, 'locked.png');
      writeFileSync(f, 'abc');
      chmodSync(f, 0o000);
      // The stat()-only check this replaces would have passed here.
      assert.throws(() => probeReadable(f), (e) => e.code === 'EACCES' && /permission denied/.test(e.message));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('checkLoadUrlTarget: http passes, readable file URL passes, unreadable file URL explains', () => {
  const { dir, sub } = tmpWithSpaces();
  try {
    const f = join(sub, 'clip.mp4');
    writeFileSync(f, 'x');
    assert.deepEqual(checkLoadUrlTarget('https://example.com'), { ok: true });
    assert.deepEqual(checkLoadUrlTarget(pathToFileURL(f).href), { ok: true });
    const missing = checkLoadUrlTarget(pathToFileURL(join(sub, 'gone.mp4')).href);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /not found/);
    assert.equal(checkLoadUrlTarget('file://otherhost/x.mp4').ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// svg-resolver end to end: the exact failure from the bot's log.
test('svg-resolver inlines a file:// image whose path has spaces', async () => {
  const { dir, sub } = tmpWithSpaces();
  try {
    const f = join(sub, '675.png');
    writeFileSync(f, Buffer.from([1, 2, 3]));
    const href = pathToFileURL(f).href;
    assert.match(href, /%20/);
    assert.equal(await resolveRef(href), 'data:image/png;base64,AQID');
    // A raw absolute path with spaces still works too.
    assert.equal(await resolveRef(f), 'data:image/png;base64,AQID');
    const out = await resolveSvg(`<svg><image href="${href}"/></svg>`);
    assert.match(out, /href="data:image\/png;base64,AQID"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('svg-resolver failure message carries the decoded path and the reason', async () => {
  await assert.rejects(resolveRef('file:///tmp/no%20such%20dir/x.jpg'),
    (e) => /\/tmp\/no such dir\/x\.jpg/.test(e.message) && /not found/.test(e.message));
});
