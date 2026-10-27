// How to reach a bot, under its call button and Meeting link box (#843): the
// platforms whose links it can join, then the calling app it answers. Only
// what it can actually do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const panel = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');
const html = readFileSync(join(root, 'electron-app/renderer/panel.html'), 'utf8');
const css = readFileSync(join(root, 'electron-app/renderer/provider-logos.css'), 'utf8');

test('Slack is listed only while the bot is signed in to it', () => {
  assert.match(panel, /\{ id: 'slack', name: 'Slack', full: 'Slack huddle', needsSignIn: true \}/);
  assert.match(panel, /LINK_PROVIDERS\.filter\(\(p\) => \(!p\.needsSignIn \|\| slackSignedInForLinks\)/);
  assert.match(panel, /\(!p\.needsWhatsApp \|\| !!callingAccountsForLinks\.whatsapp\)/, 'WhatsApp call links only for a bot signed in to WhatsApp');
  assert.match(panel, /slackSignedInForLinks = signedIn;/);
});

test('the link box placeholder lists the same platforms as the logos', () => {
  const fn = panel.slice(panel.indexOf('function renderLinkProviders()'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /input\.placeholder = `Paste a \$\{list\} link \(or invite\)`;/);
});

test('the answering app shows only when it is connected AND switched on to answer', () => {
  assert.match(panel, /find\(\(a\) => cfg\?\.\[a \+ 'AnswerCalls'\] && callingAccountsForLinks\[a\]\)/);
});

test('in the one-window app the row moves with the call controls (the hero is hidden there)', () => {
  assert.match(html, /<div class="link-providers" id="linkProviders"/);
  const hosted = panel.slice(panel.indexOf("controls.id = 'hostedControls';"));
  assert.match(hosted.slice(0, 800), /const reach = document\.getElementById\('linkProviders'\);\n  if \(reach\) controls\.append\(reach\);/);
});

test('the shared logo file has every logo the row can show, with no raw # in a url()', () => {
  for (const id of ['meet', 'zoom', 'teams', 'slack', 'telegram', 'whatsapp']) {
    assert.match(css, new RegExp(`\\.conn-logo\\.provider-${id} \\{ background-image: url\\("data:image/svg\\+xml,`));
  }
  for (const m of css.matchAll(/url\("([^"]*)"\)/g)) assert.ok(!m[1].includes('#'));
});
