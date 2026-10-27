// whiteboard-images.test.mjs: update_whiteboard finds local image paths in the
// markdown, including paths with spaces, and rewrites them to asset URLs.
//
// The old pattern, /!\[..\]\((?:file:\/\/)?(\/[^)\s]+)\)/, stopped at the first
// space, so "![p](/Volumes/Archive/Family Archives/675.jpg)" was never
// registered and the board showed a broken image with no error.
//
// Run: node --test tests/whiteboard-images.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLocalImages, rewriteLocalImages, localImagePath } from '../mcp-server/whiteboard-images.js';

const SPACEY = '/Volumes/Stan-Exos14-Archive/Family Archives/Ronald Vernon James - Archives/Claude Analysis/thumbs/675.jpg';

test('plain path, angle brackets, raw spaces and file URL all resolve to the same path', () => {
  const md = [
    '![a](/tmp/plain.png)',
    `![b](<${SPACEY}>)`,
    `![c](${SPACEY})`,
    `![d](file://${SPACEY.replaceAll(' ', '%20')})`,
  ].join('\n');
  assert.deepEqual(findLocalImages(md).map((i) => i.path), ['/tmp/plain.png', SPACEY, SPACEY, SPACEY]);
});

test('a markdown title is not part of the path', () => {
  assert.equal(localImagePath('/tmp/x y.png "caption here"'), '/tmp/x y.png');
});

test('file URL percent-escapes beyond %20 decode (%23, unicode)', () => {
  assert.equal(localImagePath('file:///tmp/photo%20%231.jpg'), '/tmp/photo #1.jpg');
  assert.equal(localImagePath('file:///tmp/Gro%C3%9Fmutter.png'), '/tmp/Großmutter.png');
});

test('remote, data and relative images are left alone', () => {
  const md = '![r](https://x.com/a.png) ![d](data:image/png;base64,AA) ![rel](imgs/a.png)';
  assert.deepEqual(findLocalImages(md), []);
  assert.equal(rewriteLocalImages(md, new Map()), md);
});

test('rewrite replaces registered paths and leaves failed ones as written', () => {
  const md = `# Photos\n\n| ![one](${SPACEY}) | ![two](/tmp/missing.png) |\n\n![again](<${SPACEY}>)`;
  const urls = new Map([[SPACEY, 'http://127.0.0.1:7865/asset/abc.jpg']]);
  assert.equal(
    rewriteLocalImages(md, urls),
    '# Photos\n\n| ![one](http://127.0.0.1:7865/asset/abc.jpg) | ![two](/tmp/missing.png) |\n\n![again](http://127.0.0.1:7865/asset/abc.jpg)',
  );
});

test('two images on one line are two matches, not one long path', () => {
  const md = '![a](/tmp/a b.png) and ![b](/tmp/c d.png)';
  assert.deepEqual(findLocalImages(md).map((i) => i.path), ['/tmp/a b.png', '/tmp/c d.png']);
});
