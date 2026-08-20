#!/usr/bin/env node
// etiquette-test.mjs — does the bot behave like someone you'd want in a meeting?
//
// WHY THIS EXISTS. Every turn-taking fix so far has been validated by holding a
// daily call and forming an impression. That loop is a day long, the evidence is
// a memory, and a fix that works for the wrong reason is indistinguishable from
// one that works. Three separate gate omissions shipped in the same week without
// anyone noticing (#430, #442, #449), and the one that mattered most —
// fastFloorDetection pinned off on one machine — took two days and three
// statistical arguments to find (#417).
//
// So: drive REAL bots in a REAL Meet through scripted conversational collisions,
// and assert on what the bot DECIDED, from its own log.
//
// ── the shape ────────────────────────────────────────────────────────────────
//
//   SUBJECT — the bot under test. Nothing is asserted about anyone else.
//   VOICE   — a second app instance whose only job is to make noise in the room
//             at controlled moments. It is the "other speaker".
//
// Each RULE below is one etiquette claim, its scenario, and what in the log
// proves it. Adding a rule is adding an entry — there are ~47 preferences that
// shape conversational behaviour and only a handful are covered here, so this is
// built to grow rather than to be finished.
//
// ── what a bot-as-VOICE can and cannot stand in for ──────────────────────────
//
// The floor is identity-blind: `anyoneSpeaking` and the Web Audio analyser both
// answer "is anyone audible", never "who". So for the floor rules — do not start
// over someone, yield when they start, resume when they stop — a second bot
// playing audio is a faithful stand-in for a human, and far more repeatable.
//
// Identity DOES matter for seeding and addressing: ranked ordering keys on the
// last utterance by someone outside the bot set, and name-mention handling needs
// the utterance attributed to a person. For those, `human()` posts a transcript
// entry with role='member' — the app treats a member-role post as a person, and
// `data.role === 'bot'` is what gates the speech path. That is the "join without
// registering and you look like a human" trick, done over HTTP.
//
// Rules declare which they need, so nothing silently tests the wrong thing.
//
// ── running it ───────────────────────────────────────────────────────────────
//
//   scripts/spawn-test-fleet.sh 2          # boots Alice:7901, Jimmy:7902
//   node scripts/etiquette-test.mjs --room <meet-code>
//
//   --subject Alice:7901 --voice Jimmy:7902   override the roles
//   --only no-talk-over,yield                 run a subset
//   --keep                                    leave the bots in the call
//
// Exit code is non-zero if any rule fails, so this can gate a release.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bot, sleep, report, record, TEST_SPEECH_PATH } from './meet-test-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIP_DIR = path.join(HERE, '..', '.test-clips');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes('--' + n);

// ── audio of known length ───────────────────────────────────────────────────
// Timing is the entire subject here, so the clips have to be exact. Built by
// looping the bundled 5s sample rather than committing more binaries, and cached
// so a re-run costs nothing.
function clip(seconds) {
  mkdirSync(CLIP_DIR, { recursive: true });
  const out = path.join(CLIP_DIR, `speech-${seconds}s.mp3`);
  if (!existsSync(out)) {
    execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y',
      '-stream_loop', '-1', '-i', TEST_SPEECH_PATH, '-t', String(seconds), out]);
  }
  return out;
}

// ── observing a decision ────────────────────────────────────────────────────
// Assertions read the SUBJECT's own session log. These are the same lines we
// read by hand all week; each MARKER records what the line proves, so a failure
// says which behaviour broke rather than which regex missed.
const MARKERS = {
  stashed:      { re: /\[barge-in\] Floor busy at audio-start — stashed/,   means: 'held its reply because someone else had the floor' },
  spoke:        { re: /\[local-server\] Bot speech:/,                       means: 'played TTS into the room' },
  armed:        { re: /\[barge-in\] armed/,                                 means: 'noticed it was being spoken over and started the yield clock' },
  // NOT `Bot state: yielding` — that fires when it stashes too, and matched 78
  // times in a call containing only 3 real back-offs. This is the line that
  // means it actually stopped mid-sentence for a person.
  backedOff:    { re: /\[barge-in\] .*interrupted — backing off/,           means: 'stopped talking for the interrupter' },
  endedEarly:   { re: /\[barge-in\] interruption already ended/,            means: 'decided the interruption was over and kept going' },
  resumed:      { re: /\[tts-resume\] resuming interrupted utterance/,      means: 'finished the sentence it was cut off in' },
  resumeStale:  { re: /\[tts-resume\] skip — too stale/,                    means: 'wanted to resume but the tail had aged out' },
  resumeMoved:  { re: /\[tts-resume\] skip — conversation moved on/,        means: 'dropped the tail because too much was said meanwhile' },
  replayed:     { re: /\[barge-in\] replaying stash/,                       means: 'said the thing it had been holding' },
  replayHeld:   { re: /\[barge-in\] not replaying — floor busy/,            means: 'kept holding rather than replaying over someone (#449 builds only)' },
  stashMoved:   { re: /\[barge-in\] discarding stash — conversation moved on/, means: 'threw the held reply away as overtaken' },
  stashStale:   { re: /\[barge-in\] discarding stash — too stale/,          means: 'threw the held reply away as too old' },
  floorOn:      { re: /\[floor-audio\] speech ON/,                          means: 'heard the other speaker via the analyser' },
};

// Everything the subject logged during one scenario.
async function window_(bot, fn) {
  const before = (await bot.sessionLog(4000)) || '';
  const mark = before.length;
  await fn();
  const after = (await bot.sessionLog(4000)) || '';
  return after.length >= mark ? after.slice(mark) : after;
}

const saw = (text, key) => MARKERS[key].re.test(text);

// Post a transcript entry as a PERSON. role='member' is what makes the app treat
// it as one — a bot-role post would go down the speech path instead.
async function human(bot, name, text) {
  const body = JSON.stringify({
    sender: name, role: 'member', ownerName: name,
    transcript: [{ text, isFinal: true, timestamp: Date.now() }],
  });
  await fetch(`http://127.0.0.1:${bot.port}/api/sync/${bot.room}`, {
    // Same control token as every other call to the app (#201). Without it this
    // 401s and the "human" simply never speaks — a silent no-op that would make
    // the rule pass or fail for the wrong reason.
    method: 'POST', headers: { 'Content-Type': 'application/json', ...bot._auth() }, body,
  });
}

// ── the rules ───────────────────────────────────────────────────────────────
//
// id      — for --only
// claim   — the etiquette rule in one line, as a person would state it
// needs   — 'audio' (a real speaker in the room) / 'human' (member-role post)
// run     — the scenario; returns the subject's log window
// verdict — reads the window, returns { ok, note }

const RULES = [
  {
    id: 'no-talk-over',
    claim: 'does not start talking while someone else already is',
    needs: ['audio'],
    async run({ subject, voice }) {
      // VOICE takes the floor and holds it well past the subject's whole
      // decision window, so there is no ambiguity about who was talking.
      await voice.playAudio({ path: clip(15), emoji: '🗣️' });
      await sleep(2500);                       // let the floor register
      return window_(subject, async () => {
        await subject.speak('I have a thought about the roadmap that I would like to share now.');
        await sleep(3000);
      });
    },
    verdict(w) {
      if (saw(w, 'stashed')) return { ok: true, note: 'held its reply' };
      if (saw(w, 'spoke')) return { ok: false, note: 'SPOKE OVER the other speaker' };
      return { ok: false, note: 'neither spoke nor stashed — did the floor register at all?' };
    },
  },

  {
    id: 'yield',
    claim: 'stops talking when someone starts talking over it',
    needs: ['audio'],
    async run({ subject, voice }) {
      return window_(subject, async () => {
        // A long utterance, so there is plenty of it left to interrupt.
        await subject.speak('Let me walk through the whole plan in some detail, because there are '
          + 'several parts to it and I want to make sure the sequencing is clear before we decide '
          + 'anything, starting with the first phase and how it depends on the second.');
        await sleep(1800);                     // subject is mid-sentence
        await voice.playAudio({ path: clip(8), emoji: '✋' });
        await sleep(5000);                     // longer than bargeInGraceMaxMs (2400)
      });
    },
    verdict(w) {
      if (!saw(w, 'armed')) {
        return { ok: false, note: 'barge-in never ARMED — the interruption was not noticed at all' };
      }
      if (saw(w, 'backedOff')) return { ok: true, note: 'armed and stopped talking' };
      if (saw(w, 'endedEarly')) {
        return { ok: false, note: 'armed, then decided the interruption had already ended and kept going' };
      }
      return { ok: false, note: 'armed but never backed off — the grace never fired' };
    },
  },

  {
    id: 'resume',
    claim: 'finishes its sentence when the interruption was brief',
    needs: ['audio'],
    async run({ subject, voice }) {
      return window_(subject, async () => {
        await subject.speak('The migration has three stages and the second one is the risky part, '
          + 'because it rewrites the index while the old readers are still attached.');
        await sleep(1800);
        await voice.playAudio({ path: clip(1), emoji: '💬' });   // a backchannel, not a turn
        await sleep(6000);                     // well inside ttsResumeMaxAgeMs (5s) after silence
      });
    },
    verdict(w) {
      if (saw(w, 'resumed')) return { ok: true, note: 'picked its sentence back up' };
      // Worth separating, because in a real 54-minute call every resume attempt
      // was rejected this way (8.9s / 39s / 239s against a 5s limit) and the
      // feature never once fired. "Tried and refused" is a different bug from
      // "never tried".
      if (saw(w, 'resumeStale')) return { ok: false, note: 'tried to resume but the tail had aged out (ttsResumeMaxAgeMs)' };
      if (saw(w, 'resumeMoved')) return { ok: false, note: 'tried to resume but judged the conversation had moved on' };
      if (saw(w, 'armed')) return { ok: false, note: 'yielded to a 1s backchannel and never attempted a resume' };
      return { ok: false, note: 'no resume attempt — was it interrupted at all?' };
    },
  },

  {
    id: 'stash-replay-waits',
    claim: 'a held reply waits for a real opening rather than barging in later',
    needs: ['audio'],
    async run({ subject, voice }) {
      await voice.playAudio({ path: clip(20), emoji: '🗣️' });
      await sleep(2500);
      return window_(subject, async () => {
        await subject.speak('Here is the point I wanted to make about the schedule.');
        await sleep(2000);                      // it should stash…
        await sleep(6000);                      // …and still be waiting, floor still busy
      });
    },
    verdict(w) {
      if (!saw(w, 'stashed')) return { ok: false, note: 'never stashed — cannot test the hold' };
      if (saw(w, 'spoke')) return { ok: false, note: 'stashed and then replayed OVER the speaker' };
      return { ok: true, note: 'stashed and held while the floor stayed busy' };
    },
  },

  {
    id: 'stash-replay-on-opening',
    claim: 'says the held reply once the room actually goes quiet',
    needs: ['audio'],
    async run({ subject, voice }) {
      await voice.playAudio({ path: clip(6), emoji: '🗣️' });
      await sleep(1500);
      return window_(subject, async () => {
        await subject.speak('The thing I was going to say when you started talking.');
        await sleep(9000);                      // voice finishes ~4.5s in; the floor opens
      });
    },
    verdict(w) {
      if (!saw(w, 'stashed')) return { ok: false, note: 'never stashed — the floor was not busy?' };
      if (saw(w, 'replayed') || saw(w, 'spoke')) return { ok: true, note: 'held, then said it at the opening' };
      return { ok: false, note: 'stashed and never came back — the reply was swallowed' };
    },
  },

  {
    id: 'held-reply-survives',
    claim: 'a reply held for one speaker is still said, not quietly binned',
    needs: ['audio'],
    // The most common failure in the field, and one nobody named: across a real
    // 54-minute call the bot stashed 36 replies, replayed 18, and DISCARDED 16
    // as "conversation moved on" plus 2 as "too stale". Nearly half of what it
    // decided to say was thrown away without anyone hearing it or being told
    // (#413). Politeness that loses the reply is not politeness.
    async run({ subject, voice }) {
      await voice.playAudio({ path: clip(4), emoji: '🗣️' });
      await sleep(1200);
      return window_(subject, async () => {
        await subject.speak('The one thing I wanted to add before we move on.');
        await sleep(10_000);            // voice ends ~3s in; plenty of opening after
      });
    },
    verdict(w) {
      if (!saw(w, 'stashed')) return { ok: false, note: 'never stashed — floor not busy, rule untested' };
      if (saw(w, 'replayed') || saw(w, 'spoke')) return { ok: true, note: 'held and then said' };
      if (saw(w, 'stashMoved')) return { ok: false, note: 'DISCARDED as "conversation moved on" — the reply was lost' };
      if (saw(w, 'stashStale')) return { ok: false, note: 'DISCARDED as too stale — the floor never reopened in time' };
      return { ok: false, note: 'held and never heard from again' };
    },
  },

  {
    id: 'name-mention-priority',
    claim: 'answers promptly when addressed by name',
    needs: ['audio', 'human'],
    async run({ subject, voice }) {
      await voice.playAudio({ path: clip(6), emoji: '🗣️' });
      await sleep(1500);
      return window_(subject, async () => {
        await subject.speak('I had something queued about the release.');
        await sleep(1500);
        // A PERSON addresses the subject by name. nameMentionSilenceSeconds (1s)
        // is meant to shorten the wait versus defaultSilenceSeconds (1.4s).
        await human(subject, 'Test Human', `So ${subject.name}, what do you think about that?`);
        await sleep(7000);
      });
    },
    verdict(w) {
      if (saw(w, 'replayed') || saw(w, 'spoke')) return { ok: true, note: 'responded after being named' };
      if (saw(w, 'stashed')) return { ok: false, note: 'still holding after being addressed by name' };
      return { ok: false, note: 'no response to being named' };
    },
  },
];

// ── runner ──────────────────────────────────────────────────────────────────

async function main() {
  const ROOM = arg('room');
  if (!ROOM) {
    console.error('need --room <meet-code>. Boot bots first: scripts/spawn-test-fleet.sh 2');
    process.exit(2);
  }
  const [sName, sPort] = arg('subject', 'Alice:7901').split(':');
  const [vName, vPort] = arg('voice', 'Jimmy:7902').split(':');
  const subject = new Bot(sName, Number(sPort), ROOM);
  const voice = new Bot(vName, Number(vPort), ROOM);

  for (const b of [subject, voice]) {
    if (!(await b.ping())) {
      console.error(`${b.name} is not answering on :${b.port} — boot the fleet first.`);
      process.exit(2);
    }
  }

  const only = arg('only') ? new Set(arg('only').split(',')) : null;
  const rules = RULES.filter((r) => !only || only.has(r.id));

  console.log(`room ${ROOM} — subject ${subject.name}:${sPort}, voice ${voice.name}:${vPort}`);
  console.log(`${rules.length} rule(s)\n`);

  await Promise.all([subject.join(), voice.join()]);
  await Promise.all([subject.warmUp(), voice.warmUp()]);

  // The floor rules are about DETECTION, so make sure the detector is on and
  // record what it was set to — a run against a machine with fastFloorDetection
  // pinned off measures that pin, not the code (#417).
  const st = await subject.status();
  console.log(`subject state before: callStatus=${st?.callStatus ?? '?'}\n`);

  const results = [];
  for (const rule of rules) {
    process.stdout.write(`── ${rule.id}: ${rule.claim}\n`);
    let w = '';
    let err = null;
    try {
      w = await rule.run({ subject, voice });
    } catch (e) { err = e; }
    const v = err ? { ok: false, note: `threw: ${err.message}` } : rule.verdict(w);
    results.push({ rule, ...v });
    record(subject.name, `etiquette:${rule.id}`, v.ok, v.note);
    console.log(`   ${v.ok ? '✅' : '❌'} ${v.note}\n`);
    await sleep(2500);                          // let the room settle between rules
  }

  if (!has('keep')) {
    await Promise.all([subject.leave(), voice.leave()]).catch(() => {});
  }

  console.log('─'.repeat(72));
  console.log('CONVERSATIONAL ETIQUETTE');
  for (const r of results) {
    console.log(`  ${r.ok ? 'pass' : 'FAIL'}  ${r.rule.id.padEnd(26)} ${r.rule.claim}`);
    if (!r.ok) console.log(`        ↳ ${r.note}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} rules held.`);
  report();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
