// participant-pruning.test.mjs — the tracker forgets people who left.
//
// Nothing ever left DOMSpeakerTracker's participants Map. Someone who hung up
// stayed in it for the rest of the session, still reported to the agent as
// being in the room, and a REJOIN doubled them: Meet issues a new device id, so
// the same human came back as a second entry beside the dead one.
//
// Measured on the 2026-08-13 call, which ended holding five rows for four
// people — two of them "Pepper" — the dead one permanently reading
// `item=STALE mtr=blind`. Those two symptoms together are also what made the
// logs read as though speaking detection had gone blind for long stretches,
// when 141 heard events that call had a speaking rise within 20s every time.
//
// The risk in fixing it runs the other way: forgetting a LIVE participant costs
// their meter calibration and their place in the roster. So most of these tests
// are about what must NOT be pruned.
//
// Run: node --test tests/participant-pruning.test.mjs

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

const start = src.indexOf('const METER_SAMPLE_MS');
const end = src.indexOf('const domSpeakerTracker');
assert.ok(start > 0 && end > start, 'could not slice DOMSpeakerTracker out of the provider');

// The provider is a renderer script that requires electron, so the class is
// lifted out and run against a fake people pane. Collaborators it closes over
// arrive as parameters; `Date` is one of them so tests can move the clock.
const load = new Function(
  'document', 'console', 'Date', 'MEET', 'isPresentationTile', 'visiblePeopleTileCount',
  'getComputedStyle', 'MutationObserver', 'meetProvider', 'CALL_EVENTS', 'window', `
  ${src.slice(start, end)}
  return { DOMSpeakerTracker };
`);

// A people-pane tile. `id` is Meet's per-device participant id — a rejoin gets
// a new one, which is exactly how a duplicate used to appear.
const tile = (name, { id = null, self = false, presentation = false } = {}) => ({
  name, id, self, presentation,
  getAttribute(attr) {
    if (attr === 'aria-label') return this.name;
    if (attr === MEET.people.idAttr) return this.id;
    return null;
  },
  get textContent() { return this.name + (this.self ? MEET.people.selfMarker : ''); },
  querySelectorAll: () => [],
  contains: () => false,
});

function setup(initialTiles = []) {
  const logs = [];
  let tiles = initialTiles;
  let clock = 1_000_000;
  const region = { querySelectorAll: () => tiles };
  const doc = { querySelector: () => region, contains: () => true };
  const api = load(
    doc,
    { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push('WARN ' + a.join(' ')) },
    { now: () => clock },
    MEET,
    (item) => item.presentation,
    () => tiles.length,
    () => ({ backgroundImage: 'none', backgroundPositionX: '0px' }),
    class { observe() {} disconnect() {} },
    { emit: () => {} },
    { speakingChanged: 'speaking', participantsUpdated: 'participants' },
    { postMessage: () => {} },
  );
  const tracker = new api.DOMSpeakerTracker();
  return {
    tracker, logs,
    names: () => tracker.getParticipantList().map((p) => p.name),
    setTiles: (t) => { tiles = t; },
    advance: (ms) => { clock += ms; },
    scan: () => tracker._scanParticipants(),
    GONE_MS: api.DOMSpeakerTracker.GONE_MS,
  };
}

test('someone who leaves is forgotten, and stops being reported to the agent', () => {
  const alice = tile('Alice', { id: 'dev/1' });
  const bob = tile('Bob', { id: 'dev/2' });
  const s = setup([alice, bob]);
  s.scan();
  assert.deepEqual(s.names().sort(), ['Alice', 'Bob']);

  s.setTiles([alice]);              // Bob hangs up
  s.scan();
  assert.deepEqual(s.names().sort(), ['Alice', 'Bob'], 'not on the first absence');

  s.advance(s.GONE_MS + 1000);
  s.scan();
  assert.deepEqual(s.names(), ['Alice']);
  assert.ok(s.logs.some((l) => l.includes('forgot departed participant: Bob')));
});

test('a rejoin does not leave the old device id behind', () => {
  // The exact 2026-08-13 shape: same human, new device id, both rows present.
  const pepperOld = tile('Pepper', { id: 'dev/9' });
  const s = setup([pepperOld]);
  s.scan();

  const pepperNew = tile('Pepper', { id: 'dev/10' });   // rejoined
  s.setTiles([pepperNew]);
  s.scan();
  assert.equal(s.names().length, 2, 'both rows exist while the old one is in its grace');

  s.advance(s.GONE_MS + 1000);
  s.scan();
  assert.deepEqual(s.names(), ['Pepper'], 'one Pepper, the live one');
  assert.equal(s.tracker.participants.get('dev/10').name, 'Pepper');
  assert.equal(s.tracker.participants.has('dev/9'), false);
});

test('a tile that blinks out for a re-render is NOT forgotten', () => {
  // Meet rebuilds tiles sub-second for reasons unrelated to leaving. Pruning on
  // a single absence would drop a live participant and their meter calibration.
  const alice = tile('Alice', { id: 'dev/1' });
  const s = setup([alice]);
  s.scan();

  s.setTiles([]);                    // mid-render
  s.advance(2000);
  s.scan();
  s.setTiles([alice]);               // back, well inside the grace
  s.advance(2000);
  s.scan();

  assert.deepEqual(s.names(), ['Alice']);
  s.advance(s.GONE_MS + 1000);
  s.scan();
  assert.deepEqual(s.names(), ['Alice'], 'the absence clock reset when it came back');
});

test('a closed people pane wipes nothing', () => {
  // Opening chat CLOSES the people pane — they share the side panel — and every
  // tile leaves the DOM while it is. Pruning on an empty scan would clear the
  // whole roster several times a call, silently, mid-conversation.
  const alice = tile('Alice', { id: 'dev/1' });
  const bob = tile('Bob', { id: 'dev/2' });
  const s = setup([alice, bob]);
  s.scan();

  s.setTiles([]);                    // chat pane open, no tiles rendered
  for (let i = 0; i < 5; i++) { s.advance(s.GONE_MS); s.scan(); }

  assert.deepEqual(s.names().sort(), ['Alice', 'Bob'], 'an empty pane is not an empty call');
});

test('the self tile is prunable like any other — the bot leaves too', () => {
  const me = tile('jimmy bot', { id: 'dev/1', self: true });
  const guest = tile('Guest', { id: 'dev/2' });
  const s = setup([me, guest]);
  s.scan();
  assert.equal(s.tracker.getParticipantList().find((p) => p.isSelf)?.name, 'jimmy bot');

  // The grace clock starts at the first scan that MISSES them, not at the
  // moment they left, so eviction takes GONE_MS plus up to one scan interval.
  s.setTiles([guest]);
  s.scan();
  s.advance(s.GONE_MS + 1000);
  s.scan();
  assert.deepEqual(s.names(), ['Guest']);
});

test('a share tile is not a participant and never blocks pruning', () => {
  // Shares carry the sharer's aria-label and are tracked separately. If the pane
  // holds only a share, that is not evidence anybody is still present — but it
  // also must not be mistaken for the participant of the same name.
  const stan = tile('Stan James', { id: 'dev/1' });
  const stanShare = tile('Stan James', { id: 'dev/2', presentation: true });
  const s = setup([stan, stanShare]);
  s.scan();
  assert.deepEqual(s.names(), ['Stan James'], 'the share is not a person');
  assert.equal(s.tracker.getScreenShares().length, 1);

  s.setTiles([stanShare]);           // Stan left, his share lingers a moment
  s.scan();
  s.advance(s.GONE_MS + 1000);
  s.scan();
  assert.deepEqual(s.names(), [], 'the person is forgotten; the share is still a share');
  assert.equal(s.tracker.getScreenShares().length, 1);
});
