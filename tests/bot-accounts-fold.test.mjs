// Bot accounts (Bot Settings): a calling app's call settings fold under its own
// row. They used to stack below the list (WhatsApp's, Telegram's and the phone
// number's allowlists plus Twilio's keys and passcode), and took the section over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const html = read('electron-app/renderer/panel.html');
const js = read('electron-app/renderer/panel.js');
const css = read('electron-app/renderer/panel.css');

const APPS = ['whatsapp', 'telegram', 'twilio'];

test('each calling app\'s settings sit right after its own row, inside the list', () => {
  const list = html.slice(html.indexOf('<div class="conn-group-label">Needs a bot account</div>'), html.indexOf('<div class="conn-group-label">Other sites</div>'));
  for (const app of APPS) {
    const row = list.indexOf(`data-calling-app-row="${app}"`);
    const block = list.indexOf(`id="${app}CallsBlock" class="field conn-detail"`);
    assert.ok(row > 0 && block > row, `${app}: block after row`);
    const nextRow = list.indexOf('data-calling-app-row=', row + 10);
    if (nextRow > 0) assert.ok(block < nextRow, `${app}: block before the next row`);
  }
  // Twilio's connect form folds under its row too, before the calls block.
  assert.ok(list.indexOf('id="twilioConnectForm" class="field conn-detail"') < list.indexOf('id="twilioCallsBlock"'));
  // Nothing of theirs is left below the list.
  const after = html.slice(html.indexOf('<div class="conn-group-label">Other sites</div>') - 2000, html.indexOf('<div class="conn-group-label">Other sites</div>'));
  assert.doesNotMatch(after.slice(after.lastIndexOf('</div>\n        </div>')), /CallsBlock|twilioConnectForm/);
});

test('each row has a summary line and a Calls toggle, hidden until connected', () => {
  for (const app of APPS) {
    assert.match(html, new RegExp(`data-calls-summary="${app}"`));
    assert.match(html, new RegExp(`data-calls-toggle="${app}" aria-expanded="false" style="display:none"`));
  }
});

test('folds start closed, open on the toggle, and only for a connected app', () => {
  const fold = js.slice(js.indexOf('function applyCallsFold(app)'), js.indexOf('// Calling-app calls (#843)'));
  assert.match(fold, /const open = connected && !!callsOpen\[app\];/);
  assert.match(fold, /block\.style\.display = open \? '' : 'none'/);
  assert.match(fold, /toggle\.style\.display = connected \? '' : 'none'/);
  assert.match(fold, /callsOpen\[app\] = !callsOpen\[app\];/);
  // The status update no longer shows every block outright.
  assert.doesNotMatch(js, /if \(block\) block\.style\.display = status\?\.\[app\] \? '' : 'none';/);
});

test('the summary says what the fold holds', () => {
  const fold = js.slice(js.indexOf('function callsSummary(app)'), js.indexOf('function applyCallsFold(app)'));
  assert.match(fold, /'Not answering calls'/);
  assert.match(fold, /Answers calls · \$\{n\} allowed caller/);
  assert.match(fold, /'Answers calls · no one allowed yet'/);
  assert.match(css, /\.field\.conn-detail \{/);
});
