// dom-probe.js: the opt-in research tool that found Teams' speaking ring (#847).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { probeConfig, diffSnapshots, installDomProbe } = require('../electron-app/dom-probe.js');

test('probeConfig: off unless asked; "1" means the provider default; anything else is a selector', () => {
  assert.equal(probeConfig({}, '.tile'), null);
  assert.equal(probeConfig({ VIBECONF_DOM_PROBE: '0' }, '.tile'), null);
  assert.equal(probeConfig({ VIBECONF_DOM_PROBE: 'false' }, '.tile'), null);
  assert.deepEqual(probeConfig({ VIBECONF_DOM_PROBE: '1' }, '.tile'), { selector: '.tile', intervalMs: 100 });
  assert.deepEqual(probeConfig({ VIBECONF_DOM_PROBE: '.row', VIBECONF_DOM_PROBE_MS: '250' }, '.tile'), { selector: '.row', intervalMs: 250 });
  // A provider with no default (Slack) needs an explicit selector.
  assert.equal(probeConfig({ VIBECONF_DOM_PROBE: '1' }, null), null);
  // Absurd intervals fall back rather than pegging the CPU.
  assert.equal(probeConfig({ VIBECONF_DOM_PROBE: '1', VIBECONF_DOM_PROBE_MS: '5' }, '.t').intervalMs, 100);
});

test('diffSnapshots: class lists diff by token, other fields as [before, after]', () => {
  const d = diffSnapshots(
    { '@class': 'fui-Flex vdi-frame-occlusion ___lrjjjw0', opacity: '0', width: '10px' },
    { '@class': 'fui-Flex ___1ikhnuj', opacity: '1', width: '10px' },
  );
  assert.deepEqual(d, {
    '@class': { added: ['___1ikhnuj'], removed: ['vdi-frame-occlusion', '___lrjjjw0'] },
    opacity: ['0', '1'],
  });
});

test('installDomProbe: logs a ::before opacity flip on a descendant (the #847 case)', () => {
  // One tile with one outline child. The outline's ::before opacity is what flips.
  const state = { ring: '0' };
  const outline = { tagName: 'DIV', attributes: [{ name: 'data-tid', value: 'voice-level-stream-outline' }], parentElement: null, getAttribute: (a) => (a === 'data-tid' ? 'voice-level-stream-outline' : null) };
  const tile = { tagName: 'DIV', attributes: [{ name: 'data-tid', value: 'Stan James' }], parentElement: null, getAttribute: (a) => (a === 'data-tid' ? 'Stan James' : null), querySelectorAll: () => [outline] };
  outline.parentElement = tile;
  const computed = (el, pseudo) => {
    const base = { content: pseudo ? '""' : 'normal', opacity: el === outline && pseudo === '::before' ? state.ring : '1', length: 0 };
    return new Proxy(base, { get: (t, k) => (k in t ? t[k] : '') });
  };
  const lines = [];
  let tickFn = null;
  const win = {
    console: { log: (...a) => lines.push(a.join(' ')) },
    getComputedStyle: computed,
    document: { querySelectorAll: () => [tile] },
    setInterval: (fn) => { tickFn = fn; return 1; },
  };
  assert.equal(installDomProbe({ tag: '[teams]', defaultSelector: '[data-tid]', env: { VIBECONF_DOM_PROBE: '1' }, win }), true);
  tickFn();               // first sample: init lines only
  state.ring = '1';
  tickFn();               // the ring lights up
  const changes = lines.filter((l) => l.includes('CHANGE'));
  assert.equal(changes.length, 1, lines.join('\n'));
  assert.match(changes[0], /^\[teams\] \[dom-probe\] CHANGE Stan James \| div\[voice-level-stream-outline\]::before \{"opacity":\["0","1"\]\}$/);
});

test('installDomProbe is a no-op when not switched on', () => {
  const win = { console: { log: () => assert.fail('logged') }, setInterval: () => assert.fail('started'), document: {}, getComputedStyle: () => ({}) };
  assert.equal(installDomProbe({ tag: '[zoom]', defaultSelector: '.x', env: {}, win }), false);
});

test('every provider page installs it, tagged with a prefix its console forwarder keeps', () => {
  for (const [file, tag] of [['preload-teams.js', '[teams]'], ['preload-telegram.js', '[telegram]'], ['preload-whatsapp.js', '[whatsapp]'], ['preload-twilio.js', '[phone]'], ['preload-zoom.js', '[zoom]'], ['preload-meet.js', '[bots-in-calls]'], ['preload-slack-main.js', '[slack]']]) {
    const src = readFileSync(join(root, 'electron-app', file), 'utf8');
    assert.ok(src.includes(`installDomProbe({ tag: '${tag}'`), `${file} should install the probe with tag ${tag}`);
  }
  // Teams deletes window.process at the end of its preload; the probe must be
  // installed before that, since it reads process.env.
  const teams = readFileSync(join(root, 'electron-app/preload-teams.js'), 'utf8');
  assert.ok(teams.indexOf("require('./dom-probe')") < teams.indexOf('try { delete window.process; }'));
  // The command-line flag is recognised (so the space form gets the loud warning too).
  const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
  assert.match(main, /KNOWN_VALUE_FLAGS = new Set\([^)]*'dom-probe'/);
  assert.match(main, /process\.env\.VIBECONF_DOM_PROBE = cliArgs\['dom-probe'\]/);
});
