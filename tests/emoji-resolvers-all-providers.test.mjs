// emoji-resolvers-all-providers.test.mjs — every view that hosts the camera
// avatar can also draw the profile's emoji set (#828).
//
// page-inject.js draws the face but has no fs: a bundled image set, colour font
// or dir: set reaches it only through globals a preload installs. Only the Meet
// preload installed them, so on Teams (seen live, v0.8.58) the profile's
// emojiSet arrived, page-inject logged "Emoji set: redpanda", and every face
// still drew as native Apple emoji. Nothing errors when this breaks, so pin it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const APP = join(process.cwd(), 'electron-app');
const ASSETS = join(APP, 'emoji-assets.js');

test('every preload that evals page-inject.js installs the emoji resolvers', () => {
  // The resolvers are read lazily, at draw time, so order within the preload
  // does not matter; presence does.
  const hosts = readdirSync(APP)
    .filter((f) => /^preload-.*\.js$/.test(f))
    .filter((f) => /join\(__dirname, 'page-inject\.js'\)/.test(readFileSync(join(APP, f), 'utf-8')));
  // Meet, Teams, Zoom, Slack. If a new provider shows up it is checked too.
  for (const h of ['preload-meet.js', 'preload-teams.js', 'preload-zoom.js', 'preload-slack-main.js']) {
    assert.ok(hosts.includes(h), `${h} hosts page-inject`);
  }
  for (const f of hosts) {
    const src = readFileSync(join(APP, f), 'utf-8');
    assert.ok(src.includes('installPageResolvers(globalThis'), `${f}: installs the emoji resolvers`);
  }
});

test('installPageResolvers gives page-inject a working face for the image sets', () => {
  const A = require(ASSETS);
  const g = A.installPageResolvers({}, APP);
  for (const set of ['fluent3d', 'redpanda']) {
    const uri = g.__vibeEmojiDataUri(A.relPathFor(set, '\u{1F642}'));
    assert.match(uri || '', /^data:image\/png;base64,/, `${set}: 🙂 resolves to an image`);
  }
  assert.equal(typeof g.__vibeEmojiFontBytes, 'function');
  assert.equal(typeof g.__vibeEmojiDirUri, 'function');
  assert.equal(typeof g.__vibeEmojiDirCount, 'function');
});

test('packaged lookups survive the Teams preload deleting `process`', () => {
  // preload-teams.js removes window.process after setup. In a packaged build
  // baseDir() goes through resourcesPath, so it must not read `process` lazily.
  const had = Object.prototype.hasOwnProperty.call(process, 'resourcesPath');
  const prev = process.resourcesPath;
  process.resourcesPath = '/fake/Resources';
  delete require.cache[require.resolve(ASSETS)];
  try {
    const A = require(ASSETS);
    delete process.resourcesPath; // stands in for `delete window.process`
    assert.equal(A.baseDir('/fake/Resources/app.asar'), join('/fake/Resources', 'emoji'));
  } finally {
    if (had) process.resourcesPath = prev; else delete process.resourcesPath;
    delete require.cache[require.resolve(ASSETS)];
  }
});
