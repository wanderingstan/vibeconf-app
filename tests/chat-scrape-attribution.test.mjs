// chat-scrape-attribution.test.mjs — read_chat must never attribute a message
// to the wrong named participant (#397).
//
// The failure this pins: scrapeChatMessages attributed by sticky carry-forward
// (last header seen wins), and senderFromHeader demanded EXACTLY two children.
// Meet's pin affordance added chrome to the header, the header stopped
// matching, and every message under it silently inherited the PREVIOUS
// sender — on call ded-iika-yrs every message this bot posted came back under
// Stan's or another bot's name. Worse than "unknown": confidently wrong, and
// nothing downstream could detect it. The pin UI text ("keep" — the Material
// icon ligature for the pin glyph — "Pin message", the hover hint) also fused
// into message bodies.
//
// So these tests pin the three invariants of the fix:
//   1. a header survives extra chrome children (predicate, not shape-match);
//   2. a message with NO resolvable adjacent header is senderless + warned,
//      never the previous person's name;
//   3. pin chrome is stripped from bodies without eating real words.
//
// Like meter-level-speaking.test.mjs, the functions live in a renderer script
// that requires electron, so slice them out and run them verbatim against a
// fake DOM — if the boundaries move, the slice fails loudly.
//
// Run: node --test tests/chat-scrape-attribution.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'electron-app/google-meet-provider.js'), 'utf8');
const { MEET } = require('../electron-app/meet-selectors.js');

const start = src.indexOf('// A sender header is a div containing');
const end = src.indexOf('async function readChatFlow');
assert.ok(start > 0 && end > start, 'could not slice the chat-scrape functions out of the provider');

const load = new Function('MEET', 'document', 'console', `
  ${src.slice(start, end)}
  return { senderFromHeader, headerFromSubtree, resolveSenderForMessage, stripPinChrome, scrapeChatMessages };
`);

// --- fake DOM -------------------------------------------------------------
// Just enough element for the code under test: tag, attributes, text,
// parent/sibling links, and the two selectors the scraper uses ('div' and
// '[data-message-id]'). innerText defaults to textContent, which is honest
// here: the scraper reads innerText precisely because it is rendered text.

function matchesSel(node, sel) {
  if (sel === 'div') return node.tagName === 'DIV';
  if (sel === MEET.chat.messageBody) return node.getAttribute(MEET.chat.messageIdAttr) != null;
  throw new Error('fake DOM: unsupported selector ' + sel);
}

function descendants(node) {
  const out = [];
  for (const c of node.children) { out.push(c, ...descendants(c)); }
  return out;
}

function el(tagName, { attrs = {}, text = '', innerText } = {}, children = []) {
  const node = {
    tagName: tagName.toUpperCase(),
    nodeType: 1,
    children,
    parentElement: null,
    previousElementSibling: null,
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    matches: (sel) => matchesSel(node, sel),
    querySelector: (sel) => descendants(node).find((d) => matchesSel(d, sel)) || null,
    querySelectorAll: (sel) => descendants(node).filter((d) => matchesSel(d, sel)),
    get textContent() { return text + node.children.map((c) => c.textContent).join(''); },
    get innerText() { return innerText !== undefined ? innerText : node.textContent; },
  };
  children.forEach((c, i) => {
    c.parentElement = node;
    c.previousElementSibling = i > 0 ? children[i - 1] : null;
  });
  return node;
}

const header = (name, time = '2:32 PM', extraChildren = []) =>
  el('div', {}, [el('div', { text: name }), el('div', { text: time }), ...extraChildren]);
const msg = (id, text) => el('div', { attrs: { 'data-message-id': `spaces/x/messages/${id}` }, innerText: text, text });

function setup(groupChildren) {
  const body = el('body', {}, [el('div', {}, groupChildren)]);
  const warns = [];
  const fakeConsole = { log: () => {}, warn: (...a) => warns.push(a.join(' ')) };
  const document = { querySelectorAll: (sel) => descendants(body).filter((d) => matchesSel(d, sel)) };
  const api = load(MEET, document, fakeConsole);
  return { api, warns };
}

const group = (...children) => el('div', {}, children);

// --- attribution ----------------------------------------------------------

test('baseline: plain name+time headers attribute their groups', () => {
  const { api } = setup([
    group(header('Stan James', '2:31 PM'), msg('1', 'hello bot')),
    group(header('Taylor', '2:32 PM'), msg('2', 'hi Stan'), msg('3', 'second line of the run')),
  ]);
  assert.deepEqual(api.scrapeChatMessages(), [
    { id: 'spaces/x/messages/1', sender: 'Stan James', text: 'hello bot' },
    { id: 'spaces/x/messages/2', sender: 'Taylor', text: 'hi Stan' },
    { id: 'spaces/x/messages/3', sender: 'Taylor', text: 'second line of the run' },
  ]);
});

test('#397 regression: a header with extra pin chrome STILL attributes correctly', () => {
  // The exact killer: the pin affordance makes the header 3+ children. The old
  // children.length === 2 check dropped it and the message inherited Stan.
  const pinChrome = el('div', { text: 'keep' }, []);
  const { api, warns } = setup([
    group(header('Stan James', '2:31 PM'), msg('1', 'hello bot')),
    group(header('Taylor', '2:32 PM', [pinChrome]), msg('2', 'PR: https://x/pull/391')),
  ]);
  assert.deepEqual(api.scrapeChatMessages()[1],
    { id: 'spaces/x/messages/2', sender: 'Taylor', text: 'PR: https://x/pull/391' });
  assert.equal(warns.length, 0);
});

test('chrome-before-name child order still yields the name, never "keep" or "Pin message"', () => {
  const h = el('div', {}, [
    el('div', { text: 'Pin message' }),
    el('div', { text: 'Taylor' }),
    el('div', { text: '2:32 PM' }),
    el('div', { text: 'keep' }),
  ]);
  const { api } = setup([group(h, msg('1', 'hi'))]);
  assert.equal(api.scrapeChatMessages()[0].sender, 'Taylor');
});

test('#397 regression: an unparseable header means SENDERLESS, not the previous sender', () => {
  // Group 2's header has no recognizable timestamp at all (whatever Meet ships
  // next). The message must NOT inherit Stan — that is the fabricated
  // attribution this issue is about — and the drop must be loud.
  const broken = el('div', {}, [el('div', { text: 'Taylor' }), el('div', { text: 'no time here' })]);
  const { api, warns } = setup([
    group(header('Stan James', '2:31 PM'), msg('1', 'hello bot')),
    group(broken, msg('2', 'who said this?')),
  ]);
  const out = api.scrapeChatMessages();
  assert.deepEqual(out[1], { id: 'spaces/x/messages/2', text: 'who said this?' });
  assert.equal('sender' in out[1], false);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /no resolvable sender header/);
  assert.match(warns[0], /spaces\/x\/messages\/2/);
});

test('a headerless group never reaches back into the PREVIOUS group for a name', () => {
  // Even with a perfectly parseable header one group up, adjacency must stop
  // at the group boundary: that header belongs to ITS messages.
  const { api } = setup([
    group(header('jimmy bot', '2:30 PM'), msg('1', 'earlier group')),
    group(msg('2', 'orphan')),
  ]);
  assert.deepEqual(api.scrapeChatMessages()[1], { id: 'spaces/x/messages/2', text: 'orphan' });
});

test('a header nested in a wrapper div is still found for its grouped run', () => {
  const wrapped = el('div', {}, [header('Taylor', '2:32 PM')]);
  const { api } = setup([group(wrapped, msg('1', 'first'), msg('2', 'second'))]);
  const out = api.scrapeChatMessages();
  assert.equal(out[0].sender, 'Taylor');
  assert.equal(out[1].sender, 'Taylor');
});

test('pin BUTTONS sharing data-message-id are skipped, not read as messages', () => {
  const pinBtn = el('button', { attrs: { 'data-message-id': 'spaces/x/messages/1', 'aria-label': 'Pin message' }, innerText: 'keep' });
  const { api } = setup([group(header('Taylor', '2:32 PM'), msg('1', 'real text'), pinBtn)]);
  const out = api.scrapeChatMessages();
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'real text');
});

// --- pin-chrome stripping -------------------------------------------------

test('#397 regression: fused pin chrome is stripped from message bodies', () => {
  const { api } = setup([]);
  // The exact shapes captured on ded-iika-yrs:
  assert.equal(api.stripPinChrome('Filed: https://x/issues/389keepPin message'),
    'Filed: https://x/issues/389');
  assert.equal(api.stripPinChrome('Pushed to main: 98a89a06Hover over a message to pin itkeepkeepPin message'),
    'Pushed to main: 98a89a06');
  assert.equal(api.stripPinChrome('PR: https://x/pull/396keep'), 'PR: https://x/pull/396');
});

test('stripping does not eat real words: a sentence can end in "keep"', () => {
  const { api } = setup([]);
  // "keep" as a WORD (space before it) is the user's; only the fused icon
  // ligature is chrome.
  assert.equal(api.stripPinChrome('these are the ones to keep'), 'these are the ones to keep');
  assert.equal(api.stripPinChrome('housekeeping is done'), 'housekeeping is done');
});

test('stripping happens inside scrapeChatMessages, so read_chat output is clean', () => {
  const { api } = setup([
    group(header('Taylor', '2:32 PM'), msg('1', 'Added the data to #392keepPin message')),
  ]);
  assert.equal(api.scrapeChatMessages()[0].text, 'Added the data to #392');
});

test('a body that is ONLY chrome is dropped entirely', () => {
  const { api } = setup([
    group(header('Taylor', '2:32 PM'), msg('1', 'Hover over a message to pin itkeep')),
  ]);
  assert.deepEqual(api.scrapeChatMessages(), []);
});

// --- unread-notice half (#397 part 2) — source assertions -----------------
// send_chat opens the chat pane, which makes Meet mark everything read and
// drop the badge; the page's false edge then cleared the server's chatUnread
// before any wait_for_speech could surface the notice. Only a successful
// read_chat proves the agent consumed the messages, so only it may clear.

const serverSrc = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');

test('only an authoritative read_chat clears chatUnread; page false edges are ignored', () => {
  assert.match(serverSrc, /setChatUnread\(unread, \{ authoritative = false \} = \{\}\)/);
  assert.match(serverSrc, /if \(!unread && !authoritative\)/);
  assert.match(serverSrc, /this\.setChatUnread\(false, \{ authoritative: true \}\)/);
});
