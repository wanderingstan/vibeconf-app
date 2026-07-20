// eval-call-log.test.mjs — unit tests for the call-log stats analyzer.
// Feeds analyzeLog() a synthetic log covering each marker and asserts the
// derived stats. Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLog } from '../scripts/eval-call-log.mjs';

// A compact synthetic session log exercising every extractor.
const LOG = [
  '[session-log] version=0.7.0-beta52',
  '[session-log] platform=darwin',
  '[session-log] profile=default',
  '[session-log] defaultSilenceSeconds=1.4',
  '[session-log] probeFiring=true',
  '[session-log] botName=Jimmy (updated at 2026-01-01T00:00:00.000Z)',
  '[session-log] roomId=abc-defg-hij (updated at 2026-01-01T00:00:00.000Z)',
  '00:00:01.000 [call] id=abc-defg-hij-20260101T000001Z room=abc-defg-hij status=joining',
  '00:00:01.500 [local-server] Call status: in-call',
  '00:00:02.000 👂 [heard] Stan James: hi jimmy',
  '00:00:03.000 🛑 [silence] User(s) stopped speaking: Stan James, Jimmy',
  '00:00:03.500 ✅ [resolve] wait_for_speech resolved — reason=silence, waited=1500ms',
  '00:00:04.000 [local-server] Bot speech: Hi everyone! (emoji: 😄)',
  '00:00:04.001 ⚡ [perf] Claude responded in 520ms (resolve→first speak) — avg 520ms p90 520ms n=1',
  "00:00:06.000 [local-server] Bot speech: Here's the detailed answer. (emoji: 🤓)",
  '00:00:10.000 ✅ [resolve] wait_for_speech resolved — reason=silence, waited=2000ms',
  '00:00:11.000 [local-server] Bot speech: Got it. (emoji: 😄)',
  '00:00:11.001 ⚡ [perf] Claude responded in 980ms (resolve→first speak) — avg 750ms p90 980ms n=2',
  '00:00:12.000 🛡️  [barge-in] Dropped bot speech — user is currently speaking: never mind',
  '00:00:13.000 🫧 [background-tick] surfacing slow model — 40 new words ≥ threshold 35',
  '00:00:14.000 [ack] trigger: "hey jimmy" (wordCount=2, addressivity=me)',
  '00:00:14.001 🤐 [ack] Skipping (wordCount=2, addressivity=me)',
  '00:00:15.000 [local-server] Whiteboard update from Jimmy : # Notes',
  '00:00:16.000 [electron] Some real error: kaboom',
  '00:00:17.000 [electron] Meet poll failed (5s): timeout',
  '00:00:18.000 [local-server] Call status: idle',
  // Post-call idle polling — must NOT extend the call duration.
  '00:05:00.000 [electron] Meet poll ok (4s)',
].join('\n');

const r = analyzeLog(LOG, 'fixture.log');

test('call: id / room / platform / url', () => {
  assert.equal(r.call.id, 'abc-defg-hij-20260101T000001Z');
  assert.equal(r.call.room, 'abc-defg-hij');
  assert.equal(r.call.platform, 'google-meet');
  assert.equal(r.call.url, 'https://meet.google.com/abc-defg-hij');
});

test('duration bounded by Call status (in-call→idle), NOT the idle-poll tail', () => {
  // [call] marker at 1.0s → idle at 18.0s = 17s; the 5-min trailing poll is excluded.
  assert.equal(r.call.durationMs, 17000);
  assert.equal(r.call.durationBasis, 'status:idle');
  assert.equal(r.call.logSpanMs, 299000); // whole-log span (1.0s → 5:00.0) for reference
});

test('app + settings header (roomId not leaked into settings)', () => {
  assert.equal(r.app.version, '0.7.0-beta52');
  assert.equal(r.app.botName, 'Jimmy');
  assert.equal(r.settings.defaultSilenceSeconds, '1.4');
  assert.equal(r.settings.probeFiring, 'true');
  assert.equal(r.settings._roomId, undefined);
  assert.equal(r.settings.roomId, undefined);
});

test('participants exclude the bot', () => {
  assert.equal(r.participants.count, 1);
  assert.deepEqual(r.participants.names, ['Stan James']);
  assert.equal(r.participants.bot, 'Jimmy');
});

test('bot speak count + greeting', () => {
  assert.equal(r.bot.spoke, 3);
  assert.equal(r.bot.greeting, 'Hi everyone!');
});

test('latency: quick reply vs full response (split-response timing)', () => {
  assert.equal(r.latency.turnsWithResponse, 2);
  // turn1: first speech 4.0s − resolve 3.5s = 500; turn2: 11.0 − 10.0 = 1000 → mean 750
  assert.equal(r.latency.quickReply.meanMs, 750);
  // turn1: last speech 6.0s − resolve 3.5s = 2500; turn2: 1000 → mean 1750
  assert.equal(r.latency.fullResponse.meanMs, 1750);
  assert.equal(r.latency.waitForSpeechMeanMs, 1750); // (1500 + 2000) / 2
});

test('latency: measured Claude reaction time (from the [perf] marker)', () => {
  const meas = r.latency.measured;
  assert.equal(meas.count, 2);
  assert.equal(meas.meanMs, 750);   // (520 + 980) / 2
  assert.equal(meas.medianMs, 750);
  assert.equal(meas.minMs, 520);
  assert.equal(meas.maxMs, 980);
  assert.equal(meas.p90Ms, 980);    // nearest-rank over [520, 980]
});

test('turn-taking: barge-in yields + silence resolutions', () => {
  assert.equal(r.turnTaking.botYieldedToHuman, 1);
  assert.equal(r.turnTaking.silenceResolutions, 2);
  // The fixture's single yield discarded its reply (old-style drop), so nothing
  // was stashed or replayed.
  assert.equal(r.turnTaking.bargeStashed, 0);
  assert.equal(r.turnTaking.stashReplays, 0);
});

test('turn-taking: #239 stashed-drop + replay are counted as yields', () => {
  const s = analyzeLog([
    '00:00:12.000 🛡️  [barge-in] Stashed dropped bot speech for replay (1 entry): here is my point',
    '00:00:14.000 🛡️  [barge-in] replaying stash — 1 entries, 1200ms old',
    '00:00:20.000 🛡️  [barge-in] Dropped bot speech — user is currently speaking (nothing to stash): never mind',
  ].join('\n'), 'stash.log');
  // Both the stashed drop and the plain drop count as the bot yielding.
  assert.equal(s.turnTaking.botYieldedToHuman, 2);
  assert.equal(s.turnTaking.bargeStashed, 1);
  assert.equal(s.turnTaking.stashReplays, 1);
});

test('emojis sorted by frequency', () => {
  assert.deepEqual(r.emojis, [{ emoji: '😄', count: 2 }, { emoji: '🤓', count: 1 }]);
});

test('errors: real vs transient (Meet poll)', () => {
  assert.equal(r.errors.total, 2);
  assert.equal(r.errors.real, 1);
  assert.equal(r.errors.transient, 1);
});

test('engagement knobs', () => {
  assert.equal(r.engagement.backgroundTicks, 1);
  assert.equal(r.engagement.acksTriggered, 1);
  assert.equal(r.engagement.acksSkipped, 1);
  assert.equal(r.engagement.whiteboardUpdates, 1);
  assert.equal(r.engagement.captionStalls, 0);
});

test('empty log produces a zeroed report, no throw', () => {
  const e = analyzeLog('', 'empty.log');
  assert.equal(e.bot.spoke, 0);
  assert.equal(e.participants.count, 0);
  assert.equal(e.emojis.length, 0);
  assert.equal(e.errors.total, 0);
  assert.equal(e.latency.measured.count, 0);
  assert.equal(e.latency.measured.meanMs, null);
});
