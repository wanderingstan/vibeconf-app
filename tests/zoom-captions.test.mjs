// zoom-captions.test.mjs — the Zoom caption-overlay → turns tracker (#318).
// Zoom shows one ephemeral caption line per speaker that grows and gets its
// tail revised; these pin how that becomes the turn snapshots updateTurns eats.
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ZoomCaptionTracker, continues } = require('../electron-app/zoom-captions.js');

const STAN = 'https://us04images.zoom.us/p/stan.png';
const ANA = 'https://us04images.zoom.us/p/ana.png';
const row = (key, speaker, text) => ({ key, speaker, text });

test('continues: growth and a revised tail are the same utterance; a new line is not', () => {
  assert.equal(continues('Hi, I am', 'Hi, I am talking.'), true);
  assert.equal(continues('Hi, I am talking to', 'Hi, I am talking, this is Stan.'), true); // tail revised
  assert.equal(continues('Hi, I am talking.', 'Something else entirely now'), false);
  assert.equal(continues('', 'anything'), false);
});

test('a growing line updates one turn instead of adding turns', () => {
  const t = new ZoomCaptionTracker();
  assert.equal(t.update([row(STAN, 'Stan', 'Hi, I')]), true);
  assert.equal(t.update([row(STAN, 'Stan', "Hi, I'm talking.")]), true);
  assert.equal(t.update([row(STAN, 'Stan', "Hi, I'm talking.")]), false); // unchanged
  assert.deepEqual(t.snapshot(), [{ turnId: 1, speaker: 'Stan', text: "Hi, I'm talking.", isBottommost: true }]);
});

test('a replaced line, or a different avatar, starts a new turn', () => {
  const t = new ZoomCaptionTracker();
  t.update([row(STAN, 'Stan', 'First thing I said.')]);
  t.update([row(STAN, 'Stan', 'A whole new sentence.')]);
  t.update([row(ANA, 'Ana', 'And my reply.')]);
  assert.deepEqual(t.snapshot().map((x) => [x.speaker, x.text]), [
    ['Stan', 'First thing I said.'],
    ['Stan', 'A whole new sentence.'],
    ['Ana', 'And my reply.'],
  ]);
  assert.equal(t.snapshot().at(-1).isBottommost, true);
});

test('when the overlay clears, the same words again are a new turn', () => {
  const t = new ZoomCaptionTracker();
  t.update([row(STAN, 'Stan', 'Yes.')]);
  t.update([]); // overlay faded
  t.update([row(STAN, 'Stan', 'Yes.')]);
  assert.equal(t.snapshot().length, 2);
});

test('a name that resolves after the first words is backfilled onto the turn', () => {
  const t = new ZoomCaptionTracker();
  t.update([row(STAN, 'unknown', 'Hello')]);
  t.update([row(STAN, 'Stan', 'Hello there')]);
  assert.deepEqual(t.snapshot().map((x) => x.speaker), ['Stan']);
});

test('history is capped, oldest dropped first', () => {
  const t = new ZoomCaptionTracker({ maxTurns: 3 });
  for (const w of ['one', 'two', 'three', 'four']) { t.update([row(STAN, 'Stan', w)]); t.update([]); }
  assert.deepEqual(t.snapshot().map((x) => x.text), ['two', 'three', 'four']);
});
