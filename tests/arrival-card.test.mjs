// arrival-card.test.mjs — "nobody home" must not look like somebody home.
//
// 🫥 was meant to say "the agent isn't on the line yet". It does not work: new
// users start talking to the bot the moment its tile appears and are confused
// when nothing answers. The reason is that 🫥 is still a FACE, and a face
// filling a Meet tile means someone is there — the dots are a subtlety nobody
// parses on their first call.
//
// The fix is scale plus words: a thumbnail-sized avatar beside a line of text
// reads as a photo on a name badge, not as presence.
//
// Run: node --test tests/arrival-card.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'electron-app/page-inject.js'), 'utf8');
const card = src.slice(src.indexOf('_renderArrivalCard(emojiImg, emoji) {'),
                       src.indexOf('_renderRecordingIndicator() {'));

test('the not-on-line branch draws the card instead of a tile-filling face', () => {
  assert.match(src, /if \(notOnLine\) \{\s*\n\s*ctx\.restore\(\);\s*\n\s*try \{ this\._renderArrivalCard/);
});

test('the thumbnail is small — that is the whole mechanism', () => {
  // Presence scale is emojiSize = min(w,h) * 0.77. A badge photo has to be a
  // different order of thing, not a slightly smaller face.
  const m = card.match(/const thumb = Math\.min\(w, h\) \* ([\d.]+)/);
  assert.ok(m, 'thumb is sized off the tile');
  assert.ok(Number(m[1]) < 0.25, `thumbnail scale ${m[1]} must be far below the 0.77 presence scale`);
});

test('it says who is coming, by name', () => {
  assert.match(card, /config && config\.botName/);
  assert.match(card, /name \+ ' is on the way'/);
});

test('the name actually REACHES the renderer', () => {
  // The bug this catches: page-inject has a config.botName, but nothing ever
  // sent one, so it stayed on its "AI Assistant" placeholder and every bot's
  // arrival card claimed to be an AI Assistant. Reported live 2026-08-24 and
  // reproduced on a second bot — the tell that it was not about one name.
  //
  // It rides on set-call-status because that is the ONE message that fires
  // exactly when the card appears, so the name is right from the first frame.
  const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
  assert.match(main, /action: 'set-call-status',[\s\S]{0,700}?payload: \{ status, botName: resolvedBotName\(\) \}/);
  assert.match(src, /if \(payload\?\.botName\) config\.botName = payload\.botName;/);
});

test('the card sits below centre — the middle of a tile is where a face goes', () => {
  const m = card.match(/const midY = h \* ([\d.]+)/);
  assert.ok(m, 'midY is a fraction of the tile height');
  assert.ok(Number(m[1]) > 0.5, `${m[1]} must be below centre, or it occupies the presence spot`);
});

test('and it degrades to a real name when the bot has none', () => {
  assert.match(card, /\|\| 'The bot'/);
});

test('a stalled join says so instead of looking identical to a healthy one', () => {
  // The failure of 🫥 was ambiguity: working and wedged looked the same. An
  // empty tile would have inherited exactly that.
  assert.match(card, /const troubled = !inLobby && waited > TROUBLE_MS/);
  assert.match(card, /is having trouble connecting/);
  const m = card.match(/const TROUBLE_MS = (\d+)/);
  assert.ok(m && Number(m[1]) >= 45000 && Number(m[1]) <= 180000,
    'must clear a real join by a wide margin — measured joins take 7-9s, and 15000 left only '
    + '6s of headroom, so the warning fired on ordinary joins');
});

test('waiting in the lobby is never called trouble', () => {
  // A bot in `waiting-to-be-admitted` is not broken — a human has not clicked
  // Admit. Meet now hides Admit behind a ⋮ overflow on a "review potential
  // risks" prompt, so this wait is routinely minutes, and calling it "trouble
  // connecting" blames the software for a person's pending decision. It also
  // sends whoever is watching to debug the wrong subsystem.
  assert.match(card, /const inLobby = this\.callStatus === 'waiting-to-be-admitted'/);
  assert.match(card, /is waiting to be let in/);

  // The lobby must short-circuit the timer, not merely be worded differently:
  // an hour in the lobby is still not trouble.
  assert.match(card, /const troubled = !inLobby &&/,
    'inLobby has to gate the escalation, otherwise a long lobby wait still flips to trouble');

  // Three distinct messages, and the lobby one has to win over both others.
  const branch = card.match(/const text = ([\s\S]*?);\n/);
  assert.ok(branch, 'the three-way choice is one expression');
  assert.match(branch[1], /inLobby \?/, 'lobby is tested first');
});

test('the clock times a JOIN ATTEMPT, not an idle app', () => {
  // The bug: `idle` is a not-on-line status too, so timing "since notOnLine
  // began" measured how long the app had had nothing to do. An app open on its
  // Settings screen while someone created a profile was already 15s+ "late"
  // before it attempted anything, so the card opened straight on "having
  // trouble connecting" and the on-the-way window was never seen. Hit live
  // 2026-08-24 the first time a brand-new bot was created in front of anyone.
  assert.match(src, /const attempting = notOnLine && this\.callStatus !== 'idle' && this\.callStatus !== 'left'/);
  assert.match(src, /if \(attempting\) \{ if \(!this\._notOnLineSince\)/);
});

test('the clock starts when the condition starts, and resets when it clears', () => {
  // Otherwise a later disconnect would immediately inherit an old elapsed time
  // and jump straight to the trouble message.
  assert.match(src, /if \(attempting\) \{ if \(!this\._notOnLineSince\) this\._notOnLineSince = Date\.now\(\); \}/);
  assert.match(src, /else this\._notOnLineSince = 0;/);
});

test('the tile is never a frozen frame', () => {
  // A static Meet tile reads as "it crashed" (#223) — the opposite of the
  // reassurance this card exists to give.
  assert.match(card, /const bob = Math\.sin\(this\.frameCount/);
});

test('the text is outlined, because the background is user-chosen', () => {
  assert.match(card, /strokeText\(text/);
  assert.match(card, /strokeStyle = 'rgba\(0, 0, 0, 0\.85\)'/);
});

test('a bug in the card can never black out the camera frame', () => {
  // Same rule as the other overlays: the face already rendered, and diagnostic
  // or decorative chrome must not be able to take the feed down with it.
  assert.match(src, /try \{ this\._renderArrivalCard\(emojiImg, emoji\); \} catch \(e\) \{/);
});
