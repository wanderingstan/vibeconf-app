// presentation-tiles.test.mjs — the people pane lists shares and pseudo-tiles,
// not only people.
//
// Measured live 2026-08-04 with three shares up at once. The pane held SEVEN
// listitems for four real slots:
//
//   jimmy bot        …/devices/566            person
//   jimmy bot        …                        share  ("Your presentation")
//   Merged audio     data-cohort-id, NO id    neither — two mics merged (#257)
//   Bob              …                        person
//   Stan James       …                        person
//   Bob              …Presentation            share
//   Stan James       …Presentation            share
//
// Participants were keyed by aria-label, so each share OVERWROTE the person of
// the same name. A share tile never pulses, so that participant read as silent
// for the whole call: 0 speaking flags, wait_for_speech timing out at
// peakSpeakers=0, barge-in blind. Captions still worked, so the bot answered and
// nothing looked broken.
//
// Run: node --test tests/presentation-tiles.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const provider = readFileSync(join(root, 'electron-app/google-meet-provider.js'), 'utf8');
const selectors = readFileSync(join(root, 'electron-app/meet-selectors.js'), 'utf8');
const mcp = readFileSync(join(root, 'mcp-server/server.js'), 'utf8');
const { MEET } = require('../electron-app/meet-selectors.js');

test('participants are keyed by device id, not display name', () => {
  // aria-label was never unique: a share carries the sharer's name, and two
  // people can simply share a name. The share case just made it reproducible.
  assert.equal(MEET.people.idAttr, 'data-participant-id');
  assert.match(provider, /const key = pid \|\| name;/);
  assert.doesNotMatch(provider, /this\.participants\.set\(name,/, 'name must not be the key');
  // And no consumer may treat the key as a name any more.
  assert.doesNotMatch(provider, /\[name, info\] of this\.participants/);
});

test('a share tile is classified as a share, not a person', () => {
  assert.match(provider, /function isPresentationTile\(item\)/);
  const fn = provider.slice(provider.indexOf('function isPresentationTile'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  // Text, not class: the class is a minified token that changes between Meet
  // builds; the word does not.
  assert.match(body, /presentationRow/);
  assert.match(body, /toLowerCase\(\)\.includes/);
  assert.equal(MEET.people.presentationText, 'presentation');
});

test("the bot's own share is worded differently, and still matches", () => {
  // Meet says "Your presentation" for self and "Presentation" for everyone
  // else. A test asserting the exact string would have passed on one and failed
  // on the other, so the check is a lowercased substring.
  const marker = MEET.people.presentationText;
  for (const label of ['Presentation', 'Your presentation', 'VisitorPresentation']) {
    assert.ok(label.toLowerCase().includes(marker), `${label} should classify as a share`);
  }
  for (const label of ['', 'Visitor', 'Host']) {
    assert.ok(!label.toLowerCase().includes(marker), `${label} must NOT classify as a share`);
  }
});

test('pseudo-tiles are tracked for speech but are not people', () => {
  // "Merged audio" (two mics merged, #257) carries no participant id. It is
  // NOT dropped: it is the only tile that pulses when either of the merged
  // people speaks, so discarding it would make both undetectable — the same bug
  // in a new place. It is filtered where the question is "who is in the room".
  assert.match(provider, /const isPseudo = MEET\.people\.requireIdForPerson && !pid;/);
  assert.doesNotMatch(provider, /if \(isPseudo\) \{[\s\S]{0,200}continue;/, 'must not be skipped');
  // Anchored on the METHOD, not the first mention: there is also a
  // `getParticipants() { return domSpeakerTracker.getParticipantList(); }`
  // delegate, and slicing from that reads the wrong body entirely.
  const list = provider.slice(provider.indexOf('  getParticipantList() {'));
  assert.match(list.slice(0, 400), /isPseudo: !!info\.isPseudo/, 'flagged, not filtered, here');

  const server = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');
  assert.match(server, /participants: \(this\.participants \|\| \[\]\)\.filter\(\(p\) => !p\.isPseudo\)/,
    'filtered at the reporting edge, where it is safe');
});

test('anyoneSpeaking still sees the merged tile', () => {
  // The regression guard for the above: activeSpeakerCount is derived from
  // local-server's participants list, so the pseudo tile has to remain in it.
  const server = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');
  const setter = server.slice(server.indexOf('setParticipants(participants)'));
  assert.doesNotMatch(setter.slice(0, 600), /isPseudo/,
    'setParticipants must store the FULL list, pseudo tiles included');
});

test('every share is reported, not just the newest', () => {
  // The toolbar has one slot ("<name> is presenting") and shows the most recent
  // sharer only — confirmed live with three shares up. It also reports NOBODY
  // while the bot is presenting, since self-presenting suppresses someone-else.
  assert.match(provider, /getScreenShares\(\)/);
  assert.match(provider, /screenSharesUpdated/);
  assert.match(mcp, /function formatScreenShares\(status, data\)/);
  const fn = mcp.slice(mcp.indexOf('function formatScreenShares'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /shares\.map\(\(s\) => s\.name\)/, 'names all of them');
  assert.match(body, /one of them is you/, 'and says when the bot is among them');
});

test('with no share list, it falls back rather than asserting "no"', () => {
  // On a Meet build where the people-pane markup has moved, silence beats a
  // confident wrong answer — the old line said "Screen sharing: no" while
  // someone was mid-presentation.
  const fn = mcp.slice(mcp.indexOf('function formatScreenShares'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /status\.presenterName/, 'fall back to the toolbar signal');
  assert.match(body, /Screen sharing: nobody/);
  assert.doesNotMatch(body, /'Screen sharing: no'/);
});

test('an ended share disappears rather than lingering', () => {
  // Rebuilt from scratch each scan. An incremental update would leave a phantom
  // presenter after someone stopped sharing.
  assert.match(provider, /this\.screenShares = shares;/);
  const server = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');
  assert.match(server, /setScreenShares\(shares\)/);
  assert.match(server, /this\.screenShares = Array\.isArray\(shares\) \? shares : \[\]/);
});
