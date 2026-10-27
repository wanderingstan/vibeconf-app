// share-keepalive.test.mjs: the shared whiteboard keeps sending frames while
// it sits still. The capture is repaint-driven, so a static board sent no
// frames and WhatsApp mobile replaced it with the bot's profile photo after a
// few seconds (live, 2026-10-27). share-keepalive.js repaints one invisible
// pixel a few times a second; these pin what that stylesheet must be and that
// the share window gets it on every document.
// Run: node --test tests/share-keepalive.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const K = require('../electron-app/share-keepalive.js');

const alphaOf = (rgba) => Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(rgba)[1]);

test('the default rate is a few repaints a second', () => {
  assert.ok(K.KEEPALIVE_FPS >= 2 && K.KEEPALIVE_FPS <= 10, `got ${K.KEEPALIVE_FPS}`);
});

test('stepped animation: exactly fps distinct colours per one-second cycle', () => {
  assert.match(K.keepaliveCss(), new RegExp(`animation: ${K.KEYFRAMES_NAME} 1s steps\\(${K.KEEPALIVE_FPS}, end\\) infinite !important`));
  assert.match(K.keepaliveCss(3), /steps\(3, end\)/);
  assert.match(K.keepaliveCss(2.6), /steps\(3, end\)/, 'rounded to a whole step count');
  assert.match(K.keepaliveCss(0.2), /steps\(1, end\)/, 'never zero steps (invalid CSS)');
  assert.match(K.keepaliveCss('junk'), new RegExp(`steps\\(${K.KEEPALIVE_FPS}, end\\)`));
});

test('invisible: one corner pixel, nearly transparent, never in the way', () => {
  const css = K.keepaliveCss();
  assert.match(css, /^html::after \{/);
  assert.match(css, /width: 1px !important;/);
  assert.match(css, /height: 1px !important;/);
  assert.match(css, /position: fixed !important;/);
  assert.match(css, /pointer-events: none !important;/);
  for (const c of [K.COLOR_A, K.COLOR_B]) {
    const a = alphaOf(c);
    assert.ok(a > 0 && a <= 0.05, `${c}: alpha must be visible to Blink but not to people`);
  }
});

test('the two colours differ, so every step is a real repaint', () => {
  assert.notEqual(K.COLOR_A, K.COLOR_B);
  const css = K.keepaliveCss();
  assert.ok(css.includes(`from { background-color: ${K.COLOR_A}; }`));
  assert.ok(css.includes(`to { background-color: ${K.COLOR_B}; }`));
});

function fakeWebContents({ url = '', destroyed = false, insertCSS } = {}) {
  const wc = new EventEmitter();
  wc.inserted = [];
  wc.getURL = () => url;
  wc.isDestroyed = () => destroyed;
  wc.setDestroyed = (d) => { destroyed = d; };
  wc.insertCSS = insertCSS || (async (css, opts) => { wc.inserted.push({ css, opts }); return `key${wc.inserted.length}`; });
  return wc;
}

test('inserted as a USER-origin sheet on every dom-ready, so content updates and navigations keep it', () => {
  const wc = fakeWebContents();
  assert.equal(K.installShareKeepalive(wc), true);
  assert.equal(wc.inserted.length, 0, 'nothing loaded yet: wait for the first document');
  wc.emit('dom-ready');
  wc.emit('dom-ready'); // a reload / load_url navigation
  assert.equal(wc.inserted.length, 2);
  for (const { css, opts } of wc.inserted) {
    assert.equal(css, K.keepaliveCss());
    assert.deepEqual(opts, { cssOrigin: 'user' }, 'user !important beats any page style');
  }
});

test('a window that already has a document gets it right away', () => {
  const wc = fakeWebContents({ url: 'https://vibeconf.app/board/x' });
  K.installShareKeepalive(wc);
  assert.equal(wc.inserted.length, 1);
});

test('idempotent per webContents: a re-asked getDisplayMedia does not stack listeners', () => {
  const wc = fakeWebContents();
  assert.equal(K.installShareKeepalive(wc), true);
  assert.equal(K.installShareKeepalive(wc), false);
  wc.emit('dom-ready');
  assert.equal(wc.inserted.length, 1);
});

test('a destroyed webContents is left alone', () => {
  const wc = fakeWebContents();
  K.installShareKeepalive(wc);
  wc.setDestroyed(true);
  wc.emit('dom-ready');
  assert.equal(wc.inserted.length, 0);
});

test('an insert failure is logged, never thrown', async () => {
  const lines = [];
  const wc = fakeWebContents({ insertCSS: async () => { throw new Error('frame gone'); } });
  K.installShareKeepalive(wc, { log: (l) => lines.push(l) });
  wc.emit('dom-ready');
  await new Promise((r) => setImmediate(r));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[share-keepalive\].*frame gone/);
});

test('missing or odd webContents: no-op', () => {
  assert.equal(K.installShareKeepalive(null), false);
  assert.equal(K.installShareKeepalive({}), false);
});

test('main.js installs it on the share window before the board loads', () => {
  const main = readFileSync(new URL('../electron-app/main.js', import.meta.url), 'utf8');
  assert.match(main, /require\('\.\/share-keepalive\.js'\)/);
  const start = main.indexOf('function createWhiteboardWindow(');
  assert.ok(start > 0, 'createWhiteboardWindow exists');
  const body = main.slice(start, main.indexOf('\n}\n', start));
  const install = body.indexOf('installShareKeepalive(win.webContents');
  const load = body.indexOf('win.loadURL(roomUrl)');
  assert.ok(install > 0, 'createWhiteboardWindow installs the keepalive');
  assert.ok(load > install, 'before loadURL, so the first dom-ready is not missed');
});
