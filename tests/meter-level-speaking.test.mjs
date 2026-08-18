// meter-level-speaking.test.mjs — reading Meet's mic meter as a LEVEL (#142).
//
// Speaking detection has been mutation counting: 3 mutations anywhere inside a
// participant's tile within 1200ms. Meet churns the meter at 5-10Hz, so the
// third event lands ~300-600ms after speech starts, and that delay is the floor
// under every turn-taking decision the bot makes (#115, #236).
//
// Meet already publishes the level. The meter's bars share one background-image
// (a sprite of bars at increasing heights) and Meet animates
// `background-position-x` to choose which bar shows — so that one property is
// the loudness, as a number, readable on the first sample after onset.
//
// The hazard is history, not novelty: the previous attempt to read one specific
// element (findSpeakingIndicator) latched onto the wrong "3 empty divs" — mute
// and pin controls have them too — or held a stale ref after a re-render, and
// went silently deaf. So these tests are mostly about the discovery rules:
// identify by BEHAVIOUR (which sprite element actually moves), never by class
// name, re-check staleness every sample, and report NOTHING rather than
// "silent" when no meter has proved itself.
//
// Run: node --test tests/meter-level-speaking.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'electron-app/google-meet-provider.js'), 'utf8');
const { PREFERENCES } = require('../electron-app/preferences-schema.js');

// The tracker lives in a renderer script that requires electron, so lift the
// constants + class out and run them against a fake DOM. Slicing beats mocking
// electron: the code under test is exercised verbatim, and if the boundaries
// move the slice fails loudly rather than testing a stale copy.
// Slice from the first tracker-scope declaration (the echo guard's state) to
// the singleton at the bottom — everything the class closes over lives between
// them, so the class runs here exactly as it does in the app.
const start = src.indexOf('// Raw event capture (#422)');
const end = src.indexOf('const domSpeakerTracker');
assert.ok(start > 0 && end > start, 'could not slice DOMSpeakerTracker out of the provider');
const load = new Function('getComputedStyle', 'document', 'console', 'MutationObserver', 'emits', 'ipcRenderer', `
  // Stubs for the module-level collaborators the slice closes over. The emits
  // array is what the tracker would send upward. (The speakerDebugBorder stub
  // that lived here died with the border itself — #407.)
  const CALL_EVENTS = { speakingChanged: 'speaking', participantsUpdated: 'participants' };
  const meetProvider = { emit: (name, payload) => emits.push({ name, payload }) };
  const window = { postMessage: () => {} };
  ${src.slice(start, end)}
  return { DOMSpeakerTracker, setMode: (m) => { speakingDetectionMode = m; },
           noteSelfAudioLoud,
           METER_HOLD_MS, METER_DISCOVER_MS, METER_SAMPLE_MS, METER_ATTACK_MS };
`);

// --- fake DOM -------------------------------------------------------------
// An element is just its style. getComputedStyle returns it, which is the
// honest shape here: the real code reads computed style precisely because Meet
// may apply the position from a stylesheet or animation rather than inline.
const el = (backgroundImage = 'none', backgroundPositionX = '0px') =>
  ({ style: { backgroundImage, backgroundPositionX } });

const SPRITE = 'url("data:image/png;base64,iVBORw0KGgo=")';

function tile(children) {
  const item = {
    children,
    querySelectorAll: () => item.children,
    contains: (node) => item.children.includes(node),
  };
  return item;
}

function setup({ mode = 'either' } = {}) {
  const logs = [];
  const fakeConsole = {
    log: (...a) => logs.push(a.join(' ')),
    warn: (...a) => logs.push('WARN ' + a.join(' ')),
  };
  // Stands in for the browser's MutationObserver. `watched` lets a test fire
  // the callback the way Meet writing a style attribute would.
  const watched = [];
  class FakeObserver {
    constructor(cb) { this.cb = cb; }
    observe(target, opts) { watched.push({ target, opts, fire: () => this.cb([]) }); }
    disconnect() { this.disconnected = true; }
  }
  const emits = [];
  const api = load((node) => node.style, { contains: () => true }, fakeConsole, FakeObserver, emits,
    { invoke: () => Promise.resolve({}), send: () => {} });
  api.watched = watched;
  api.emits = emits;
  api.setMode(mode);
  const tracker = new api.DOMSpeakerTracker();
  return { ...api, tracker, logs };
}

const participant = (item, extra = {}) =>
  ({ name: 'Stan', item, speaking: false, mutTimes: [], ...extra });

// Onset: baseline sample, the meter rises, then it stays up long enough to
// clear the attack. Leaves the meter verdict true as of `t0 + 100`.
function speakInto(tracker, info, bar, t0 = 1000) {
  tracker._sampleMeter(info, t0);
  bar.style.backgroundPositionX = '-32px';
  tracker._sampleMeter(info, t0 + 50);
  tracker._sampleMeter(info, t0 + 100);
}

// --- discovery ------------------------------------------------------------

test('a meter that has never moved reports nothing, not silence', () => {
  // The load-bearing rule. Going deaf is the expensive failure, so an
  // unproven meter must fall back to the mutation counter rather than
  // asserting that a talking participant is quiet.
  const { tracker } = setup();
  const info = participant(tile([el(SPRITE, '-16px'), el(SPRITE, '-16px')]));

  tracker._sampleMeter(info, 1000);
  tracker._sampleMeter(info, 1050);

  assert.equal(tracker._isSpeakingByMeter(info, 1050), null, 'no verdict without a proven meter');
  // ...and with the meter blind, "meter only" still answers from mutations.
  info.mutTimes = [900, 950, 1000];
  assert.equal(tracker._rawSpeaking(info, 1050), true);
});

test('a static decoration is never promoted, however sprite-like it looks', () => {
  // Mute and pin controls carry the same kind of background. What separates
  // the meter from them is movement, not markup — the lesson from
  // findSpeakingIndicator matching "3 empty divs".
  const { tracker } = setup({ mode: 'meter' });
  const decoration = el(SPRITE, '-8px');
  const info = participant(tile([decoration]));

  for (let t = 1000; t < 5000; t += 50) tracker._sampleMeter(info, t);

  assert.equal(info.meter.el, null, 'a motionless element must not become the meter');
  assert.equal(tracker._isSpeakingByMeter(info, 5000), null);
});

test('the bar with the biggest excursion wins, and only one is promoted', () => {
  // Measured live 2026-08-12: the meter is three bars that step together
  // (0px -> -5px / -20px / -40px), so "first element that moves" is a DOM-order
  // coin flip between them, and promoting on each in turn re-seeded rest from a
  // bar that had ALREADY moved. The bar that travels furthest is the one that
  // reacts first and hardest to sound, so excursion picks the winner.
  const { tracker, logs } = setup({ mode: 'meter' });
  const bars = [el(SPRITE, '0px'), el(SPRITE, '0px'), el(SPRITE, '0px')];
  const info = participant(tile(bars));
  tracker._sampleMeter(info, 1000);
  bars[0].style.backgroundPositionX = '-5px';
  bars[1].style.backgroundPositionX = '-40px';   // centre bar: furthest travel
  bars[2].style.backgroundPositionX = '-20px';
  tracker._sampleMeter(info, 1050);

  assert.equal(info.meter.el, bars[1]);
  assert.equal(info.meter.rest, '0px', 'rest is where it sat BEFORE anything moved');
  assert.equal(logs.filter((l) => l.includes('meter found')).length, 1);
});

test('the element that moves is the meter, and 100ms of level is enough', () => {
  const { tracker } = setup({ mode: 'meter' });
  const decoration = el(SPRITE, '-8px');
  const bar = el(SPRITE, '0px');
  const info = participant(tile([decoration, bar, el('none', '0px')]));

  tracker._sampleMeter(info, 1000);          // baseline: nothing has moved yet
  assert.equal(tracker._isSpeakingByMeter(info, 1000), null);

  bar.style.backgroundPositionX = '-32px';   // speech starts
  tracker._sampleMeter(info, 1050);
  assert.equal(info.meter.el, bar, 'the moving element wins');
  assert.equal(info.meter.rest, '0px', 'resting bar = where it sat before it moved');
  assert.equal(tracker._isSpeakingByMeter(info, 1050), false, 'one frame is not a turn');

  bar.style.backgroundPositionX = '-48px';
  const flipped = tracker._sampleMeter(info, 1100);
  assert.equal(flipped, true, 'the caller is told to re-evaluate immediately');
  assert.equal(tracker._isSpeakingByMeter(info, 1100), true);
});

test('a single raised frame is a keystroke, not a speaker', () => {
  // The analyser's fast path was switched off because an immediate rising edge
  // let one loud frame buy 350ms of "busy" — 26.5% of measured busy periods
  // were under 500ms. This signal is not allowed to repeat that: with the hold
  // and SPEAKING_GRACE_MS on top, a one-frame blip would have cost 1.25s.
  const { tracker, METER_ATTACK_MS } = setup({ mode: 'meter' });
  const bar = el(SPRITE, '0px');
  const info = participant(tile([bar]));
  tracker._sampleMeter(info, 1000);
  bar.style.backgroundPositionX = '-32px';   // blip
  tracker._sampleMeter(info, 1050);
  bar.style.backgroundPositionX = '0px';     // and gone
  tracker._sampleMeter(info, 1100);

  assert.equal(METER_ATTACK_MS, 50);
  assert.equal(tracker._isSpeakingByMeter(info, 1100), false);
  assert.equal(tracker._isSpeakingByMeter(info, 1200), false, 'nothing to hold');
});

test('100ms of level beats three mutations', () => {
  // The point of the issue, as arithmetic: the mutation counter cannot answer
  // true before its third event, which at Meet's 5-10Hz meter is 200-400ms
  // away. The level needs two samples.
  const { tracker } = setup({ mode: 'either' });
  const bar = el(SPRITE, '0px');
  const info = participant(tile([bar]));
  tracker._sampleMeter(info, 1000);

  // Speech starts at t=1000. One mutation has landed; the meter is up.
  info.mutTimes = [1000];
  bar.style.backgroundPositionX = '-48px';
  tracker._sampleMeter(info, 1050);
  tracker._sampleMeter(info, 1100);

  assert.equal(tracker._isSpeakingByMutation(info, 1100), false, 'churn needs 3 events');
  assert.equal(tracker._rawSpeaking(info, 1100), true, 'the level already knows');
});

// --- holding and releasing ------------------------------------------------

test('the verdict holds across the sprite steps, then releases', () => {
  // The sprite is quantised, so a speaking meter shows the same bar for several
  // samples in a row and steps between bars. METER_HOLD_MS bridges the gap back
  // to rest without holding so long that a blip reads as a turn.
  const { tracker, METER_HOLD_MS } = setup({ mode: 'meter' });
  const bar = el(SPRITE, '0px');
  const info = participant(tile([bar]));
  speakInto(tracker, info, bar);
  assert.equal(tracker._isSpeakingByMeter(info, 1100), true);

  // Parked on a raised bar — still speaking, no new movement required.
  tracker._sampleMeter(info, 1150);
  assert.equal(tracker._isSpeakingByMeter(info, 1150), true);

  // Back to rest and staying there: released once the hold expires.
  bar.style.backgroundPositionX = '0px';
  tracker._sampleMeter(info, 1200);
  assert.equal(tracker._isSpeakingByMeter(info, 1150 + METER_HOLD_MS - 10), true, 'still held');
  assert.equal(tracker._isSpeakingByMeter(info, 1150 + METER_HOLD_MS + 10), false, 'released');
});

test('rest is the bar the meter PARKS on, so a redraw self-corrects', () => {
  // Not the most common value: on the first utterance of a call a raised bar
  // can out-count a rest that has only been seen a handful of times, and the
  // detector would then read speech as silence. Rest is a value held still for
  // a full second, which speech never does.
  const { tracker } = setup({ mode: 'meter' });
  const bar = el(SPRITE, '0px');
  const info = participant(tile([bar]));
  speakInto(tracker, info, bar);             // promoted, rest = 0px

  // Meet redraws the sprite and the new resting position is -64px. The meter
  // parks there, so rest follows it over.
  bar.style.backgroundPositionX = '-64px';
  for (let t = 1100; t < 3000; t += 50) tracker._sampleMeter(info, t);

  assert.equal(info.meter.rest, '-64px');
  assert.equal(tracker._isSpeakingByMeter(info, 3000), false, 'sitting at the new rest is silence');
});

// --- staleness ------------------------------------------------------------

test('a meter torn out by a re-render is rediscovered, not read as silence', () => {
  // A detached node still answers getComputedStyle, so a stale reference looks
  // exactly like a quiet participant forever. That is how the old pinned
  // element went deaf, and containment is checked every sample because of it.
  const { tracker, METER_DISCOVER_MS } = setup({ mode: 'meter' });
  const oldBar = el(SPRITE, '0px');
  const item = tile([oldBar]);
  const info = participant(item);
  speakInto(tracker, info, oldBar);
  assert.equal(info.meter.el, oldBar);

  // Meet rebuilds the tile: new nodes, same participant.
  const newBar = el(SPRITE, '0px');
  item.children = [el(SPRITE, '-8px'), newBar];
  const t0 = 1100 + METER_DISCOVER_MS + 50;
  tracker._sampleMeter(info, t0);
  assert.equal(info.meter.el, null, 'the dead reference is dropped');

  newBar.style.backgroundPositionX = '-16px';
  tracker._sampleMeter(info, t0 + 50);
  assert.equal(info.meter.el, newBar, 'the rebuilt meter is found again');
  tracker._sampleMeter(info, t0 + 100);
  assert.equal(tracker._isSpeakingByMeter(info, t0 + 100), true, 'and it hears them again');
});

test('a tile with no sprite at all warns once — a silent break is the bug', () => {
  const { tracker, logs } = setup();
  const info = participant(tile([el('none', '0px'), el('none', '0px')]));
  tracker._sampleMeter(info, 1000);
  tracker._sampleMeter(info, 1000 + 5000);

  const warns = logs.filter((l) => l.startsWith('WARN'));
  assert.equal(warns.length, 1, 'exactly one canary line, not a per-sample flood');
  assert.match(warns[0], /mic-meter DOM/);
});

// --- the event path -------------------------------------------------------

test('a tile mutation reads the level, it does not just count', () => {
  // The old signal COUNTED tile mutations, because it had no idea which element
  // or property carried speech. Both are known now, so the same event is reused
  // as a trigger to READ the meter — the verdict sees the level as of this
  // instant instead of as of the last poll tick.
  //
  // Live 2026-08-12, in two rounds: an observer on the bar's `style` never fired
  // (the attribute is empty — the level comes from a stylesheet), and one on its
  // `class` never fired either (evt=0 for a whole call). Meet mutates an
  // ANCESTOR; the bar's computed value follows. Hence: ride the tile observer.
  const { tracker } = setup({ mode: 'meter' });
  const bar = el(SPRITE, '0px');
  const item = tile([bar]);
  const info = participant(item);
  tracker.participants.set('p1', info);
  tracker._sampleMeter(info, 1000);
  bar.style.backgroundPositionX = '-32px';
  tracker._sampleMeter(info, 1050);            // promoted; attack not met yet
  assert.equal(tracker._isSpeakingByMeter(info, 1050), false);

  // Meet redraws the meter. No poll tick happens — only the tile observer fires.
  bar.style.backgroundPositionX = '-40px';
  const flipped = tracker._readMeterNow(info, 1120);

  assert.equal(flipped, true, 'the caller re-evaluates on this edge');
  assert.equal(tracker._isSpeakingByMeter(info, 1120), true);
  assert.ok(info.meter._hbEvents >= 1, 'counted as an event-driven reading');
});

test('the mutation path counts AND reads, in that order', () => {
  const { tracker } = setup({ mode: 'either' });
  const bar = el(SPRITE, '0px');
  const item = tile([bar]);
  const info = participant(item);
  tracker.participants.set('p1', info);
  tracker._sampleMeter(info, 1000);
  bar.style.backgroundPositionX = '-32px';
  tracker._sampleMeter(info, 1050);

  bar.style.backgroundPositionX = '-40px';
  tracker._checkSpeakingChange(bar);

  assert.equal(info.mutTimes.length, 1, 'the mutation counter still gets its event');
  assert.ok(info.meter._hbEvents >= 1, 'and the meter got a fresh reading from it');
  assert.equal(info.speaking, true, 'the verdict flipped inside the same callback');
});

test('the poll still carries it when nothing mutates at all', () => {
  // A build that drives the bar from a CSS animation mutates nothing, so no
  // read is ever triggered. The health line reports evt=0 against off>0, which
  // is how that shows up in production.
  const { tracker } = setup({ mode: 'meter' });
  const bar = el(SPRITE, '0px');
  const info = participant(tile([bar]));
  speakInto(tracker, info, bar);

  assert.equal(info.meter._hbEvents || 0, 0, 'no mutations on this build');
  assert.ok(info.meter._hbOffRest > 0, 'but the level was still read');
  assert.equal(tracker._isSpeakingByMeter(info, 1100), true);
});

// --- combining the two signals -------------------------------------------

test('each mode takes its verdict from the signal it names', () => {
  const mk = (mode) => {
    const api = setup({ mode });
    const bar = el(SPRITE, '0px');
    const info = participant(tile([bar]));
    speakInto(api.tracker, info, bar);       // meter: true
    return { ...api, info, bar };             // mutations: false (empty mutTimes)
  };

  const level = mk('meter');
  assert.equal(level.tracker._rawSpeaking(level.info, 1100), true);

  const churn = mk('mutation');
  assert.equal(churn.tracker._rawSpeaking(churn.info, 1100), false,
    'mutation mode ignores the meter entirely');

  const either = mk('either');
  assert.equal(either.tracker._rawSpeaking(either.info, 1100), true);

  // ...and the OR runs the other way too: churn alone still counts. Here the
  // meter has gone back to its resting bar while the tile is still churning.
  const quietMeter = mk('either');
  quietMeter.bar.style.backgroundPositionX = '0px';
  quietMeter.tracker._sampleMeter(quietMeter.info, 1150);
  quietMeter.info.mutTimes = [1300, 1400, 1450];
  assert.equal(quietMeter.tracker._isSpeakingByMeter(quietMeter.info, 1500), false);
  assert.equal(quietMeter.tracker._rawSpeaking(quietMeter.info, 1500), true,
    'the mutation counter still covers what the meter misses');
});

test('the lead over the mutation counter is measured, not assumed', () => {
  // #142 asks for the same [floor-latency]-style comparison the analyser has,
  // so the claimed 300-600ms saving becomes a number from real calls.
  const { tracker, logs } = setup({ mode: 'either' });
  const bar = el(SPRITE, '0px');
  const info = participant(tile([bar]));
  speakInto(tracker, info, bar);

  tracker._rawSpeaking(info, 1100);            // meter rises
  info.mutTimes = [1000, 1100, 1400];
  tracker._rawSpeaking(info, 1400);            // churn finally agrees

  const line = logs.find((l) => l.startsWith('[meter-latency]'));
  assert.ok(line, 'a rising edge on both signals logs their gap');
  assert.match(line, /meter led by \+300ms/);
});

// --- no echo guard, deliberately (#378) --------------------------------------

test('our own TTS does NOT suppress another participant\'s rising edge', () => {
  // A blanket guard used to sit here: any rise within 700ms of our own speech
  // was withheld as probable echo. A real call with two humans on SPEAKERS
  // (~/vibeconf-corpus/echo-speakers-2026-08-17) measured the trade and found
  // it backwards — one echo-driven false rise in 54 minutes, against three
  // genuine interruptions in the same windows, all of which the guard would
  // have delayed. Yielding late to someone who really is interrupting is the
  // costlier error, so the guard is gone and this pins its absence.
  //
  // The envelope itself is still tracked and still captured; it is the axis
  // every echo question gets asked along.
  const { tracker, noteSelfAudioLoud } = setup({ mode: 'mutation' });
  const info = participant(tile([]));
  info.mutTimes = [1000, 1100, 1200];

  noteSelfAudioLoud(1200);                 // we are mid-utterance
  assert.equal(tracker._rawSpeaking(info, 1250), true,
    'a participant who starts talking over us is reported immediately');
});

// --- the preference -------------------------------------------------------

test('both signals keep running whatever the mode is set to', () => {
  const pref = PREFERENCES.speakingDetectionMode;
  assert.deepEqual(pref.enum, ['either', 'meter', 'mutation']);
  // Defaults to the SAFE signal, not the fast one. The meter buys ~300ms, but
  // it fires on any sound reaching the mic — a human on laptop speakers hears
  // the bot's own TTS come back in and the tracker reads it as that human
  // interrupting, cutting the bot off mid-sentence (seen live, call
  // ded-iika-yrs-20260815T133138Z). A slow start is invisible; a false cut-off
  // is not. `either` is opt-in for clean-audio setups. See #378 for earning it
  // back per-tile.
  assert.equal(pref.default, 'mutation');
  // The module-level fallback in the provider declares the default a SECOND
  // time; it drifting from the schema is exactly the kind of thing nobody
  // notices, so pin them together.
  assert.match(src, /let speakingDetectionMode = 'mutation';/);
  // The mode picks the VERDICT only — comparison data must keep accruing even
  // for someone who has pinned the setting, the way the analyser keeps
  // recording while fastFloorDetection is off.
  assert.match(src, /_logSignalDisagreement\(info, mut, meter, now\)/);
  const raw = src.slice(src.indexOf('_rawSpeaking(info, now)'));
  assert.match(raw.slice(0, 600), /const meter = this\._isSpeakingByMeter/);
});

test('the meter is found by behaviour, never by class name', () => {
  // Meet's class names (IisKdb, HPxjXe, ...) are minified build output and
  // rotate without notice. Hardcoding one is what this repo already has a scar
  // from.
  const region = src.slice(src.indexOf('_discoverMeterCandidates(info, st, now) {'),
    src.indexOf('_isSpeakingByMeter(info, now) {'));
  assert.doesNotMatch(region, /IisKdb|HPxjXe|UBNDXc|DwvCqe|QgSmzd|ES310d/);
  assert.match(region, /backgroundImage/);
  assert.match(region, /backgroundPositionX/);
});

// --- #407: the flag must settle -------------------------------------------

test('mutation verdict is a Schmitt trigger: arms at 3, survives a dip to 2, releases below 2', () => {
  const { tracker } = setup({ mode: 'mutation' });
  const info = participant(tile([]));
  // Two mutations in-window: not armed.
  info.mutTimes = [1000, 1100];
  assert.equal(tracker._isSpeakingByMutation(info, 1200), false);
  // Third arrives: armed.
  info.mutTimes.push(1200);
  assert.equal(tracker._isSpeakingByMutation(info, 1250), true);
  // The exact flap from call cpf-hnso-quk: the window drains to 2. A bare
  // threshold reported false here (then true again 1ms later, 190 times over).
  // Armed state must ride the dip out.
  assert.equal(tracker._isSpeakingByMutation(info, 1000 + 1201), true,
    'a dip to 2 in-window mutations must not release an armed verdict');
  // Genuine quiet: window drains below 2 — NOW it releases...
  assert.equal(tracker._isSpeakingByMutation(info, 1200 + 1201), false);
  // ...and a single stray mutation cannot re-arm it.
  info.mutTimes.push(2500);
  assert.equal(tracker._isSpeakingByMutation(info, 2550), false,
    're-arming must take the full arm count, not one borderline mutation');
});

test('self-authored DOM writes never feed the speaking counter', () => {
  const { tracker } = setup({ mode: 'mutation' });
  const attr = (oldValue, className) =>
    ({ type: 'attributes', attributeName: 'class', oldValue, target: { className } });
  // Pure vibeconf-* class delta (the deleted debug border's exact signature,
  // both directions): ours, discarded.
  assert.equal(tracker._isSelfAuthoredMutation(attr('tile', 'tile vibeconf-spk-debug')), true);
  assert.equal(tracker._isSelfAuthoredMutation(attr('tile vibeconf-spk-debug', 'tile')), true);
  // Meet churning its own meter classes: counted.
  assert.equal(tracker._isSelfAuthoredMutation(attr('tile IisKdb', 'tile HPxjXe')), false);
  // A Meet change arriving in the same record as ours: still counted — the
  // filter may only discard when the ENTIRE delta is app-authored.
  assert.equal(tracker._isSelfAuthoredMutation(attr('tile', 'tile QgSmzd vibeconf-marker')), false);
  // No delta at all (re-set to the same value): nothing to attribute, counted
  // conservatively as Meet's.
  assert.equal(tracker._isSelfAuthoredMutation(attr('tile', 'tile')), false);
  // Our own injected elements coming or going: ours. A Meet node alongside: not.
  const node = (id, className) => ({ nodeType: 1, id, className });
  assert.equal(tracker._isSelfAuthoredMutation(
    { type: 'childList', addedNodes: [node('vibeconf-overlay', '')], removedNodes: [] }), true);
  assert.equal(tracker._isSelfAuthoredMutation(
    { type: 'childList', addedNodes: [node('vibeconf-overlay', ''), node('', 'meet-thing')], removedNodes: [] }), false);
});

test('the debug border is gone, and the observer diffs class deltas to keep it gone', () => {
  // The border was not dead code — it was a feedback loop (every verdict flip
  // wrote a class mutation into the counter that produced the verdict). Pin
  // both the removal and the guard that makes any future reintroduction inert.
  assert.doesNotMatch(src, /_applyDebugBorder|speakerDebugBorder|_injectDebugStyle/);
  assert.match(src, /attributeOldValue: true/);
  assert.match(src, /_isSelfAuthoredMutation\(mutation\)/);
});
