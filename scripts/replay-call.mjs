#!/usr/bin/env node
//
// replay-call.mjs — play a recorded conversation into a real Meet, one speaker
// per participant, so speaking detection can be scored against ground truth
// (#422).
//
// Why replay rather than a live A/B: repeatability. A live call gives one
// unrepeatable sample and no labels. A recording with one speaker per track
// gives an exact labelled timeline (scripts/label-tracks.mjs), and because none
// of our detector constants change what MEET does — only what we conclude — one
// replay capture can then be re-scored at every candidate value offline
// (scripts/score-speaking.mjs).
//
// Everything downstream of the microphone is REAL here: Meet's own VAD, its
// noise suppression, its indicator animation, our DOM observers. That is the
// part no offline simulation can reproduce, and the reason this pushes audio
// through an actual call instead of unit-testing a detector against a waveform.
//
// PREREQ:
//   1. A fleet with one instance per speaker:   scripts/spawn-test-fleet.sh 2
//   2. speakingEventCapture=true on each instance (this script sets it).
//
// Run:
//   node scripts/replay-call.mjs --media call.mov --bots Alice:7901,Jimmy:7902
//   node scripts/replay-call.mjs --media a.wav,b.wav --bots Alice:7901,Jimmy:7902
//   node scripts/replay-call.mjs --media call.mov --start 300 --duration 300
//
// Writes a manifest next to the extracted audio recording which bot played
// which track and when playback began — that is what aligns the labels to the
// captured events afterwards.
//
// WHAT THIS CANNOT DO: echo. play_audio injects into the virtual mic, so no
// audio ever crosses a speaker-to-microphone path, and the #378 failure (our
// own TTS returning through a participant's speakers) will never occur here.
// Tuning DOM_ECHO_LOOKBACK_MS needs a real speaker-path recording — see #422.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { Bot, sleep, record, report } from './meet-test-lib.mjs';
import { resolveTarget } from './meet-targets.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };

const MEDIA = (flag('media', '') || '').split(',').filter(Boolean);
const START = flag('start', '0');
const DURATION = flag('duration', null);
const ROOM = flag('room', resolveTarget(flag('target', 'default')).room);
const BOTS = flag('bots', 'Alice:7901,Jimmy:7902').split(',').map((s) => {
  const [name, port] = s.split(':');
  return new Bot(name, Number(port), ROOM);
});

if (!MEDIA.length) {
  console.error('usage: replay-call.mjs --media <file[,file2]> --bots Alice:7901,Jimmy:7902 [--start s] [--duration s]');
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'vibeconf-replay-'));

// Extract one WAV per speaker. WAV because the virtual mic decodes it without
// surprises and because we are about to measure milliseconds — a container that
// might introduce its own priming delay would land straight in the numbers.
function extractTracks() {
  const out = [];
  if (MEDIA.length === 1) {
    const streams = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=index', '-of', 'csv=p=0', MEDIA[0]], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
    if (streams.length < 2) {
      console.error(`${basename(MEDIA[0])} has ${streams.length} audio stream(s); this needs one per speaker.`);
      process.exit(2);
    }
    streams.forEach((idx, i) => {
      const dest = join(work, `speaker${i + 1}.wav`);
      const args = ['-v', 'error'];
      if (Number(START)) args.push('-ss', START);
      args.push('-i', MEDIA[0]);
      if (DURATION) args.push('-t', DURATION);
      args.push('-map', `0:${idx}`, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', dest, '-y');
      execFileSync('ffmpeg', args);
      out.push({ track: `speaker${i + 1}`, path: dest, sourceStream: Number(idx) });
    });
  } else {
    MEDIA.forEach((f, i) => {
      const dest = join(work, `speaker${i + 1}.wav`);
      const args = ['-v', 'error'];
      if (Number(START)) args.push('-ss', START);
      args.push('-i', f);
      if (DURATION) args.push('-t', DURATION);
      args.push('-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', dest, '-y');
      execFileSync('ffmpeg', args);
      out.push({ track: `speaker${i + 1}`, path: dest, sourceFile: f });
    });
  }
  return out;
}

async function setCapture(bot, on) {
  const { data } = await bot._post('/api/preferences',
    JSON.stringify({ key: 'speakingEventCapture', value: on }));
  record(bot.name, `capture:${on ? 'on' : 'off'}`, data?.success !== false, data?.error || '');
}

async function run() {
  const tracks = extractTracks();
  console.log(`extracted ${tracks.length} track(s) to ${work}`);
  if (tracks.length > BOTS.length) {
    console.error(`${tracks.length} speakers but only ${BOTS.length} bots — start a bigger fleet.`);
    process.exit(2);
  }

  for (const bot of BOTS) await bot.join();
  for (const bot of BOTS) await bot.warmUp();

  // Assert every bot is ACTUALLY in the call before playing a note.
  //
  // warmUp deliberately proceeds when it cannot confirm ("not in-call in
  // 40000ms — proceeding"), which is right for the feature lanes and wrong
  // here: a replay that plays 120s of audio into a Meet nobody joined produces
  // a capture with no events, scores as 100% missed, and reports PASS. That
  // happened on the second end-to-end run — both bots sat on a Google landing
  // page while the audio played out.
  const outside = [];
  for (const bot of BOTS) {
    const st = await bot.status();
    const inCall = st.callStatus === 'in-call' || st.callStatus === 'active';
    record(bot.name, 'inCallBeforeReplay', inCall, `callStatus=${st.callStatus}`);
    if (!inCall) outside.push(`${bot.name} (${st.callStatus})`);
  }
  if (outside.length) {
    console.error(`\nnot replaying: ${outside.join(', ')} never joined ${ROOM}.`);
    console.error('Audio played now would be recorded against an empty call and score as all-missed.');
    return;
  }

  for (const bot of BOTS) await setCapture(bot, true);

  // Playback starts as close to simultaneously as HTTP allows, and each bot's
  // ACTUAL start time is recorded rather than assumed: the alignment step later
  // depends on this, and a few hundred ms of scheduling skew here would be
  // indistinguishable from detector latency there.
  const started = [];
  await Promise.all(tracks.map(async (t, i) => {
    const bot = BOTS[i];
    const at = Date.now();
    // uninterruptible (#422): without it each bot hears the other, arms
    // barge-in, and stops its OWN playback — the first end-to-end run lost one
    // side's audio 4s in and scored it as 26 missed turns.
    await bot.playAudio({ path: t.path, uninterruptible: true });
    started.push({ bot: bot.name, track: t.track, path: t.path, startedAt: at });
  }));

  const durationSec = Number(DURATION || execFileSync('ffprobe', ['-v', 'error',
    '-show_entries', 'format=duration', '-of', 'csv=p=0', tracks[0].path], { encoding: 'utf8' }).trim());
  console.log(`playing ${durationSec.toFixed(0)}s — waiting it out`);
  await sleep((durationSec + 5) * 1000);

  for (const bot of BOTS) await setCapture(bot, false);
  for (const bot of BOTS) await bot.leave();

  const manifest = {
    room: ROOM,
    media: MEDIA.map((m) => basename(m)),
    startOffsetSec: Number(START),
    durationSec,
    // The pairing the scorer needs: which bot carried which speaker's audio,
    // and when that audio actually began.
    played: started,
    note: 'Score with: node scripts/score-speaking.mjs --events <call>/speaking-events.jsonl '
      + '--labels <labels.json> --map ' + started.map((s) => `${s.track}=${s.bot}`).join(','),
  };
  const mpath = join(work, 'replay-manifest.json');
  writeFileSync(mpath, JSON.stringify(manifest, null, 2));
  console.log(`\nmanifest: ${mpath}`);
  console.log(manifest.note);
}

run()
  .catch((err) => record('harness', 'run', false, err.message))
  .finally(() => {
    const { fails } = report();
    process.exit(fails > 0 ? 1 : 0);
  });
