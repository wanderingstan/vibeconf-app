// call-subtitles.test.mjs — the caption-turns -> .srt/.vtt pipeline.
//
// The thing worth pinning down here is the ANCHOR: cue times are
// `firstSeen - videoTrack.startWallClock`, not `firstSeen - manifest.startedAt`.
// Those two differ by however long the capture window took to open, which is
// small enough to look like nothing and large enough to visibly desync every
// subtitle in the file. Several tests below exist only to hold that line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildCues, renderSrt, renderVtt, parseCaptionLog,
  formatSrtTime, formatVttTime, wrapLines, chunkText,
} = require('../electron-app/subtitles.js');
const { writeSubtitleSidecars, resolveAnchorMs } = require('../electron-app/call-subtitles-write.js');
const { CallRecordingSession } = require('../electron-app/call-recorder.js');

const T0 = 1_700_000_000_000; // an arbitrary but fixed wall clock

function turn(id, speaker, text, startOffset, endOffset) {
  return {
    id, speaker, text,
    firstSeen: T0 + startOffset,
    lastUpdated: T0 + (endOffset ?? startOffset + 2000),
  };
}

function tmpdir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `subs-${label}-`));
}

// --- time formatting --------------------------------------------------------

test('SRT uses a comma before ms, WebVTT uses a dot', () => {
  assert.equal(formatSrtTime(3_661_042), '01:01:01,042');
  assert.equal(formatVttTime(3_661_042), '01:01:01.042');
});

test('negative and non-finite times clamp to zero rather than emitting garbage', () => {
  assert.equal(formatSrtTime(-5000), '00:00:00,000');
  assert.equal(formatSrtTime(NaN), '00:00:00,000');
  assert.equal(formatVttTime(undefined), '00:00:00.000');
});

// --- cue placement ----------------------------------------------------------

test('cue times are measured from the anchor, not from the turn clock', () => {
  const cues = buildCues([turn('t1', 'Ada', 'hello there', 5000, 7000)], { anchorMs: T0 });
  assert.equal(cues.length, 1);
  assert.equal(cues[0].startMs, 5000);
  assert.equal(cues[0].endMs, 7000);
  assert.equal(cues[0].speaker, 'Ada');
});

test('an anchor later than startedAt shifts every cue earlier by that much', () => {
  // The capture window took 1.8s to open: the video track's t=0 is T0+1800,
  // so a turn at T0+5000 is at 3.2s in the mp4 — not 5s.
  const cues = buildCues([turn('t1', 'Ada', 'hello there', 5000, 7000)], { anchorMs: T0 + 1800 });
  assert.equal(cues[0].startMs, 3200);
  assert.equal(cues[0].endMs, 5200);
});

test('speech from before the recording started is dropped, not clamped to zero', () => {
  const cues = buildCues([
    turn('early', 'Ada', 'said before we hit record', -9000, -6000),
    turn('kept', 'Ada', 'said on tape', 1000, 3000),
  ], { anchorMs: T0 });
  assert.deepEqual(cues.map((c) => c.text), ['said on tape']);
});

test('a turn straddling the recording start is kept, clamped to zero', () => {
  const cues = buildCues([turn('straddle', 'Ada', 'mid sentence', -1000, 2000)], { anchorMs: T0 });
  assert.equal(cues.length, 1);
  assert.equal(cues[0].startMs, 0);
});

test('speech after the recording stopped is dropped', () => {
  const cues = buildCues([
    turn('during', 'Ada', 'on tape', 1000, 3000),
    turn('after', 'Ada', 'after we stopped', 60_000, 63_000),
  ], { anchorMs: T0, durationMs: 30_000 });
  assert.deepEqual(cues.map((c) => c.text), ['on tape']);
});

test('a cue running past the end of the media is clipped to it', () => {
  const cues = buildCues([turn('t', 'Ada', 'trailing off', 28_000, 40_000)], {
    anchorMs: T0, durationMs: 30_000,
  });
  assert.equal(cues[0].endMs, 30_000);
});

test('offsetMs shifts every cue, negative pulling them earlier', () => {
  const cues = buildCues([turn('t1', 'Ada', 'hello there', 5000, 7000)], {
    anchorMs: T0, offsetMs: -800,
  });
  assert.equal(cues[0].startMs, 4200);
  assert.equal(cues[0].endMs, 6200);
});

test('no anchor means no cues — a subtitle with no timeline is worse than none', () => {
  assert.deepEqual(buildCues([turn('t1', 'Ada', 'hi', 1000)], {}), []);
  assert.deepEqual(buildCues([turn('t1', 'Ada', 'hi', 1000)], { anchorMs: NaN }), []);
});

// --- growing turns ----------------------------------------------------------

test('a growing utterance collapses to one cue holding the final text', () => {
  // Captions arrive as repeated snapshots of the same turn: the log holds
  // every version, and only the last one is the whole sentence.
  const cues = buildCues([
    turn('t1', 'Ada', 'Hi', 1000, 1200),
    turn('t1', 'Ada', 'Hi Jimmy', 1000, 1800),
    turn('t1', 'Ada', 'Hi Jimmy, how are you', 1000, 2600),
  ], { anchorMs: T0 });
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'Hi Jimmy, how are you');
  assert.equal(cues[0].startMs, 1000);  // firstSeen: when they STARTED talking
  assert.equal(cues[0].endMs, 2600);    // lastUpdated: when they stopped
});

test('a truncated replay cannot overwrite the fuller text of the same turn', () => {
  const cues = buildCues([
    turn('t1', 'Ada', 'Hi Jimmy, how are you', 1000, 2600),
    turn('t1', 'Ada', 'Hi Jimmy', 1000, 2600), // Meet re-rendered a shorter row
  ], { anchorMs: T0 });
  assert.equal(cues[0].text, 'Hi Jimmy, how are you');
});

// --- readability ------------------------------------------------------------

test('a cue too brief to read is extended to a readable minimum', () => {
  const cues = buildCues([turn('t', 'Ada', 'Yes', 1000, 1100)], { anchorMs: T0 });
  assert.ok(cues[0].endMs - cues[0].startMs >= 1200, `got ${cues[0].endMs - cues[0].startMs}ms`);
});

test('a long utterance splits into several cues spanning the turn', () => {
  const long = 'This is a considerably longer utterance that no one would want to read '
    + 'as a single wall of subtitle text across the bottom of the video frame.';
  const cues = buildCues([turn('t', 'Ada', long, 1000, 15_000)], { anchorMs: T0 });
  assert.ok(cues.length > 1, 'expected a split');
  assert.equal(cues[0].startMs, 1000);
  assert.equal(cues.at(-1).endMs, 15_000);
  // Chunks advance, never overlap, and preserve the words in order.
  for (let i = 0; i < cues.length - 1; i++) {
    assert.ok(cues[i].endMs <= cues[i + 1].startMs, 'chunks must not overlap');
  }
  assert.equal(cues.map((c) => c.text).join(' '), long);
});

test('two people talking over each other keeps both cues overlapping', () => {
  // This is a real thing that happened on the call; both formats can show it.
  const cues = buildCues([
    turn('a', 'Ada', 'as I was saying', 1000, 6000),
    turn('b', 'Bob', 'sorry, go ahead', 2000, 4000),
  ], { anchorMs: T0 });
  assert.equal(cues.length, 2);
  const ada = cues.find((c) => c.speaker === 'Ada');
  const bob = cues.find((c) => c.speaker === 'Bob');
  assert.ok(bob.startMs < ada.endMs, 'overlap between speakers should survive');
});

test('one speaker cannot overlap themselves', () => {
  const cues = buildCues([
    turn('a1', 'Ada', 'Yes', 1000, 1100),   // will be extended for readability
    turn('a2', 'Ada', 'and also this', 1500, 3000),
  ], { anchorMs: T0 });
  const [first, second] = cues;
  assert.ok(first.endMs <= second.startMs, `${first.endMs} should not exceed ${second.startMs}`);
});

test('cues come out in chronological order regardless of log order', () => {
  const cues = buildCues([
    turn('c', 'Ada', 'third', 9000, 10_000),
    turn('a', 'Ada', 'first', 1000, 2000),
    turn('b', 'Bob', 'second', 5000, 6000),
  ], { anchorMs: T0 });
  assert.deepEqual(cues.map((c) => c.text), ['first', 'second', 'third']);
});

test('blank and malformed entries are skipped, not rendered as empty cues', () => {
  const cues = buildCues([
    turn('ok', 'Ada', 'real speech', 1000, 2000),
    { id: 'blank', speaker: 'Ada', text: '   ', firstSeen: T0 + 3000 },
    { id: 'notime', speaker: 'Ada', text: 'when?' },
    null,
  ], { anchorMs: T0 });
  assert.deepEqual(cues.map((c) => c.text), ['real speech']);
});

// --- rendering --------------------------------------------------------------

test('SRT renders numbered blocks with the speaker on its own line', () => {
  const srt = renderSrt(buildCues([
    turn('a', 'Ada', 'hello', 1000, 3000),
    turn('b', 'Bob', 'hi back', 4000, 6000),
  ], { anchorMs: T0 }));
  assert.equal(srt.split('\n\n').length, 2);
  assert.match(srt, /^1\n00:00:01,000 --> 00:00:03,000\nAda:\nhello\n\n2\n/);
  assert.ok(srt.endsWith('\n'), 'a missing trailing newline loses the last cue in some parsers');
});

test('WebVTT renders a header and <v Speaker> markup', () => {
  const vtt = renderVtt(buildCues([turn('a', 'Ada', 'hello', 1000, 3000)], { anchorMs: T0 }));
  assert.ok(vtt.startsWith('WEBVTT\n'));
  assert.match(vtt, /00:00:01\.000 --> 00:00:03\.000\n<v Ada>hello/);
});

test('a speaker name containing markup characters cannot break the <v> tag', () => {
  const vtt = renderVtt(buildCues([turn('a', 'A<b>d&a', 'hello', 1000, 3000)], { anchorMs: T0 }));
  assert.match(vtt, /<v A&lt;b&gt;d&amp;a>hello/);
  assert.ok(!/<v A<b>/.test(vtt));
});

test('includeSpeaker:false drops the name from both formats', () => {
  const cues = buildCues([turn('a', 'Ada', 'hello', 1000, 3000)], {
    anchorMs: T0, includeSpeaker: false,
  });
  assert.ok(!renderSrt(cues).includes('Ada'));
  assert.ok(!renderVtt(cues).includes('<v'));
});

test('no cues renders an empty SRT, not a stray "1"', () => {
  assert.equal(renderSrt([]), '');
});

test('long text wraps to subtitle-width lines', () => {
  const lines = wrapLines('the quick brown fox jumps over the lazy dog and keeps on going', 42);
  assert.ok(lines.length > 1);
  for (const line of lines) assert.ok(line.length <= 42, `"${line}" is ${line.length} chars`);
  assert.equal(lines.join(' '), 'the quick brown fox jumps over the lazy dog and keeps on going');
});

test('a single word longer than the line limit is left intact rather than broken', () => {
  const url = 'https://example.com/an/extremely/long/path/that/exceeds/the/limit';
  assert.deepEqual(wrapLines(url, 42), [url]);
  assert.deepEqual(chunkText(url, 42), [url]);
});

// --- log parsing ------------------------------------------------------------

test('a truncated final line costs one caption, not the whole file', () => {
  const log = '{"id":"a","text":"one","firstSeen":1}\n'
    + '{"id":"b","text":"two","firstSeen":2}\n'
    + '{"id":"c","text":"thr';  // app was killed mid-write
  const entries = parseCaptionLog(log);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.text), ['one', 'two']);
});

// --- the recorder's capture side -------------------------------------------

test('captionTurns writes only actual text changes, last record winning', () => {
  const dir = tmpdir('rec');
  const session = new CallRecordingSession(dir, { startedAt: T0 });
  session.captionTurns([turn('t1', 'Ada', 'Hi', 1000, 1200)]);
  session.captionTurns([turn('t1', 'Ada', 'Hi', 1000, 1400)]);       // no text change
  session.captionTurns([turn('t1', 'Ada', 'Hi Jimmy', 1000, 1800)]); // changed
  session.stop();

  const lines = fs.readFileSync(path.join(dir, 'captions.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'an unchanged snapshot should not be re-written');
  assert.equal(JSON.parse(lines.at(-1)).text, 'Hi Jimmy');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('captionTurns ignores blank text and turns with no id or clock', () => {
  const dir = tmpdir('rec-blank');
  const session = new CallRecordingSession(dir, { startedAt: T0 });
  session.captionTurns([
    { id: 't1', speaker: 'Ada', text: '  ', firstSeen: T0 },
    { id: null, speaker: 'Ada', text: 'no id', firstSeen: T0 },
    { id: 't2', speaker: 'Ada', text: 'no clock' },
    turn('t3', 'Ada', 'real', 1000, 2000),
  ]);
  session.stop();
  const lines = fs.readFileSync(path.join(dir, 'captions.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).text, 'real');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('captionTurns after stop() is a no-op, not a crash', () => {
  const dir = tmpdir('rec-closed');
  const session = new CallRecordingSession(dir, { startedAt: T0 });
  session.stop();
  session.captionTurns([turn('t1', 'Ada', 'too late', 1000, 2000)]);
  assert.ok(!fs.existsSync(path.join(dir, 'captions.jsonl')));
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- the anchor, end to end -------------------------------------------------

test("the anchor is the video track's startWallClock, not the session's startedAt", () => {
  assert.equal(
    resolveAnchorMs({
      startedAt: T0,
      tracks: [
        { track: 'bot', startWallClock: T0 + 900 },
        { track: 'video', startWallClock: T0 + 1800 },
      ],
    }),
    T0 + 1800,
  );
});

test('with no video track at all, startedAt is the fallback anchor', () => {
  assert.equal(resolveAnchorMs({ startedAt: T0, tracks: [{ track: 'bot', startWallClock: T0 + 900 }] }), T0);
  assert.equal(resolveAnchorMs({ tracks: [] }), null);
  assert.equal(resolveAnchorMs(null), null);
});

test('writeSubtitleSidecars produces both files, timed off the video track', () => {
  const callDir = tmpdir('call');
  const tracksDir = path.join(callDir, 'call-recording-tracks');
  fs.mkdirSync(tracksDir);
  fs.writeFileSync(path.join(tracksDir, 'captions.jsonl'),
    [turn('a', 'Ada', 'hello there', 5000, 7000), turn('b', 'Bob', 'hi back', 8000, 10_000)]
      .map((t) => JSON.stringify(t)).join('\n') + '\n');
  fs.writeFileSync(path.join(tracksDir, 'manifest.json'), JSON.stringify({
    startedAt: T0,
    tracks: [{ track: 'video', startWallClock: T0 + 1800 }],
  }));

  const res = writeSubtitleSidecars({ tracksDir, outDir: callDir, baseName: 'call-recording' });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.cues, 2);

  const srt = fs.readFileSync(path.join(callDir, 'call-recording.srt'), 'utf8');
  // 5000 - 1800 = 3200, proving the video track won over startedAt.
  assert.match(srt, /00:00:03,200 --> 00:00:05,200\nAda:\nhello there/);
  assert.ok(fs.readFileSync(path.join(callDir, 'call-recording.vtt'), 'utf8').startsWith('WEBVTT'));
  fs.rmSync(callDir, { recursive: true, force: true });
});

test('writeSubtitleSidecars reports, rather than throws, when there is nothing to build', () => {
  const callDir = tmpdir('call-empty');
  const tracksDir = path.join(callDir, 'call-recording-tracks');
  fs.mkdirSync(tracksDir);

  // No captions.jsonl at all.
  let res = writeSubtitleSidecars({ tracksDir, outDir: callDir });
  assert.equal(res.ok, false);
  assert.match(res.reason, /captions\.jsonl/);

  // Captions but no manifest — nothing to place them against.
  fs.writeFileSync(path.join(tracksDir, 'captions.jsonl'),
    JSON.stringify(turn('a', 'Ada', 'hi', 1000, 2000)) + '\n');
  res = writeSubtitleSidecars({ tracksDir, outDir: callDir });
  assert.equal(res.ok, false);
  assert.match(res.reason, /startWallClock/);

  // A manifest whose recording started after everything anyone said.
  fs.writeFileSync(path.join(tracksDir, 'manifest.json'), JSON.stringify({
    tracks: [{ track: 'video', startWallClock: T0 + 600_000 }],
  }));
  res = writeSubtitleSidecars({ tracksDir, outDir: callDir });
  assert.equal(res.ok, false);
  assert.match(res.reason, /inside the recording/);

  assert.ok(!fs.existsSync(path.join(callDir, 'call-recording.srt')), 'no empty file on failure');
  fs.rmSync(callDir, { recursive: true, force: true });
});
