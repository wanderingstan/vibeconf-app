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
//   scripts/spawn-test-fleet.sh 2 --kill   # A FRESH FLEET PER RUN — see below
//   node scripts/etiquette-prep.mjs        # disguise the voice, clear presence
//   scripts/spawn-test-fleet.sh 2          # boots Alice:7901, Jimmy:7902
//   node scripts/etiquette-test.mjs --room <meet-code>
//
//   --subject Alice:7901 --voice Jimmy:7902   override the roles
//   --only no-talk-over,yield                 run a subset
//   --keep                                    leave the bots in the call
//
// A FRESH FLEET PER RUN IS NOT OPTIONAL. Bots accumulate state across runs — a
// held stash, a floor that never fully reopened, a roster belief that cannot be
// unlearned — and the rules stop measuring the app. Observed directly: the same
// build scored 3/7 from a clean boot and 0/7 after several --keep runs in a row,
// with failures like "neither spoke nor stashed" that describe the harness's
// leftovers rather than any behaviour. Use --keep to inspect ONE run, then kill
// and prep before the next.
//
// Exit code is non-zero if any rule fails, so this can gate a release.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Bot, sleep, report, record, TEST_SPEECH_PATH } from './meet-test-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIP_DIR = path.join(HERE, '..', '.test-clips');

// 28 seconds of Stan being talked over, from the call where it happened
// (vph-sbmo-uic-20260830T203346Z, 34m26s in). See scripts/fixtures/README.md.
//
// Here rather than in TEST_SPEECH_PATH's slot because it is not interchangeable
// with it: the synthesised clip is what a person sounds like, and this is what
// an ANGRY person sounds like — short bursts with 200-660ms gaps, which is
// precisely the shape the analyser mistook for stopping.
const REAL_INTERRUPTION_PATH = path.join(HERE, 'fixtures', 'interrupt-2026-08-30-30s.mp3');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes('--' + n);

// ── audio of known length ───────────────────────────────────────────────────
//
// Timing is the entire subject here, so "10 seconds of someone talking" has to
// actually be ten unbroken seconds.
//
// WAV, not MP3, and that is not a detail. The first version looped the bundled
// 5.09s mp3 with -stream_loop; ffprobe reported the right duration, but in the
// room the analyser never saw a stretch longer than 5.2s — the decoder stops at
// the source's frame boundary, so a "10s interrupter" made about five seconds of
// noise and then stopped. The `yield` rule failed on that, and the app was
// RIGHT: its log said "interruption already ended (analyser OFF 1203ms ago)"
// because the interruption had, in fact, ended. Gapless PCM removes the seam.
//
// Cached, and .test-clips/ is gitignored — a few hundred KB per clip, rebuilt in
// milliseconds.
function clip(seconds) {
  mkdirSync(CLIP_DIR, { recursive: true });
  const out = path.join(CLIP_DIR, `speech-${seconds}s.wav`);
  if (!existsSync(out)) {
    execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y',
      '-stream_loop', '-1', '-i', TEST_SPEECH_PATH,
      '-t', String(seconds), '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', out]);
  }
  return out;
}

// A clip that holds the floor with NO gaps.
//
// Ordinary speech does not: measured against a 12s clip, the subject's analyser
// reported episodes of 0.35-4.2s separated by 150-350ms of silence, because the
// recording has the pauses any real sentence has. For most rules that is what we
// want — it is what a person sounds like. But a rule that asks "does it keep
// holding while someone is STILL talking" cannot use it: the bot that speaks in
// one of those gaps has taken a legitimate opening, not barged in, so the rule
// scores correct behaviour as a failure.
//
// silenceremove strips the pauses before the loop, so the result is continuous
// voiced audio and any bot speech during it is unambiguously a talk-over.
function gaplessClip(seconds) {
  mkdirSync(CLIP_DIR, { recursive: true });
  const out = path.join(CLIP_DIR, `gapless-${seconds}s.wav`);
  if (!existsSync(out)) {
    const packed = path.join(CLIP_DIR, 'packed.wav');
    if (!existsSync(packed)) {
      execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y',
        '-i', TEST_SPEECH_PATH,
        // strip silence everywhere, not just the leading run
        '-af', 'silenceremove=start_periods=1:stop_periods=-1:'
             + 'start_threshold=-40dB:stop_threshold=-40dB:'
             + 'start_duration=0:stop_duration=0.05:detection=rms',
        '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', packed]);
    }
    execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y',
      '-stream_loop', '-1', '-i', packed,
      '-t', String(seconds), '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', out]);
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
  rodeOut:      { re: /\[barge-in\] rode it out/,                            means: 'never stopped — the interruption ended inside the grace' },
  botVsBot:     { re: /\[barge-in\] bot-vs-bot/,                            means: 'treated the interrupter as a PEER BOT, not a person' },
  humanInt:     { re: /\[barge-in\] human interrupted — backing off/,       means: 'yielded to what it believed was a person' },
  resumed:      { re: /\[tts-resume\] resuming interrupted utterance/,      means: 'finished the sentence it was cut off in' },
  resumeStale:  { re: /\[tts-resume\] skip — too stale/,                    means: 'wanted to resume but the tail had aged out' },
  resumeMoved:  { re: /\[tts-resume\] skip — conversation moved on/,        means: 'dropped the tail because too much was said meanwhile' },
  replayed:     { re: /\[barge-in\] replaying stash/,                       means: 'said the thing it had been holding' },
  replayHeld:   { re: /\[barge-in\] not replaying — floor busy/,            means: 'kept holding rather than replaying over someone (#449 builds only)' },
  stashMoved:   { re: /\[barge-in\] discarding stash — conversation moved on/, means: 'threw the held reply away as overtaken' },
  stashStale:   { re: /\[barge-in\] discarding stash — too stale/,          means: 'threw the held reply away as too old' },
  stashSuperseded: { re: /\[barge-in\] discarding stash — superseded/,   means: 'dropped a held reply the agent had already moved past (#519)' },
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

// Wait until the SUBJECT's own floor reads quiet.
//
// Found on the first live run: rule 1 plays a 15s clip, the inter-rule gap was a
// flat 2.5s, and every later rule therefore began while the previous clip was
// still playing. Every `speak` came back "user-speaking-stashed" — including in
// the rules where the subject was supposed to speak FIRST and be interrupted.
// Five of seven results were artifacts of the harness, and the two passes were
// passing for the wrong reason.
//
// A fixed sleep cannot fix that, because what matters is when the room actually
// goes quiet, not when we guessed it would. `anyoneSpeaking` is not exposed on
// the sync payload, so the log is the available ground truth — and it is the
// same signal the rules assert on, so this cannot disagree with them.
async function settleFloor(bot, { maxMs = 30_000, quietMs = 1200 } = {}) {
  const started = Date.now();
  let quietSince = null;
  while (Date.now() - started < maxMs) {
    // Same reason as waitForFloorBusy: read the level. Here a missed edge
    // fails the safe way (it looks quiet, so a rule starts into someone's
    // audio), which is worse than a false alarm and was just as invisible.
    const st = await bot.status().catch(() => null);
    let quiet;
    if (st && st.floorBusy != null) {
      quiet = !st.floorBusy;
    } else {
      const tail = String((await bot.sessionLog(400)) || '');
      const lastOn = tail.lastIndexOf('[floor-audio] speech ON');
      const lastOff = tail.lastIndexOf('[floor-audio] speech OFF');
      quiet = lastOff > lastOn || (lastOn === -1 && lastOff === -1);
    }
    if (quiet) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= quietMs) return true;
    } else {
      quietSince = null;
    }
    await sleep(400);
  }
  return false;                       // caller decides whether to care
}

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

// Make the VOICE look like a person to the SUBJECT (#471).
//
// The subject classifies interrupters with _botNameSet(), fed by
// mergeRemoteMembers folding the website's room presence into its roster. So a
// VOICE that announces itself as role='bot' is treated as a peer bot — an extra
// random tie-break delay before backing off — and the yield rule then measures
// the wrong branch entirely.
//
// Two steps, and BOTH are needed:
//   • announceAsBot=false, so it never claims to be a bot again.
//   • delete any presence row it left behind, because mergeRemoteMembers is
//     deliberately one-way ("a remote bot upgrades a local member, but not the
//     reverse"). A stale row from a previous run would be learned once and never
//     unlearned, and the suppression alone would look like it had worked.
async function makeVoiceHuman(voice, room) {
  // Loudly, because a silent failure here does not break the run — it changes
  // what the run MEASURES. Learned by doing it: the fleet was once booted from a
  // build without this preference, setPref returned "Unknown preference", the
  // voice registered as a bot as usual, and the yield rule went on reporting
  // peer-bot behaviour as though it were about a person.
  const r = await voice.setPref('announceAsBot', false);
  if (r && r.success === false) {
    throw new Error(`cannot disguise ${voice.name}: setPref(announceAsBot) failed — `
      + `${r.error}. The app under test predates #471; the barge-in rules would `
      + `measure the peer-bot branch instead of the human one.`);
  }
  const base = (process.env.VIBECONF_WEBSITE_URL || 'https://vibeconferencing.com').replace(/\/$/, '');
  try {
    await fetch(`${base}/api/room/${encodeURIComponent(room)}/presence?name=${encodeURIComponent(voice.name)}`,
      { method: 'DELETE', signal: AbortSignal.timeout(5000) });
  } catch { /* presence unreachable: the pref still stops it re-registering */ }
}

// What the room's presence says this participant is — which is precisely what
// the subject's _botNameSet() will conclude, via mergeRemoteMembers.
async function presenceRoleOf(room, name) {
  const base = (process.env.VIBECONF_WEBSITE_URL || 'https://vibeconferencing.com').replace(/\/$/, '');
  try {
    const r = await fetch(`${base}/api/room/${encodeURIComponent(room)}/presence`,
      { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    return (d.members || []).find((m) => m && m.name === name)?.role ?? null;
  } catch { return null; }
}

// ── preconditions ───────────────────────────────────────────────────────────
//
// Reset the settings these rules depend on, and report anything that had to be
// moved. Learned the hard way on the first real run: three of five failures were
// caused by `bargeInStashMaxAgeMs = 0`, left behind on the shared test profile
// by scripts/lockstep-test.mjs, which sets it and never restores it. Every stash
// was therefore discarded the instant it was made, and the harness dutifully
// reported "the reply was swallowed" as though the app were broken.
//
// This is #417 in miniature: a per-profile pin shadowing a default, invisible
// until measured. A suite that reports leftover state as an app bug is worse
// than no suite, because it is believed.
const REQUIRED = [
  'bargeInStashMaxAgeMs', 'bargeInStashRedeliverMaxNewWords',
  'bargeInGraceMs', 'bargeInGraceMinMs', 'bargeInGraceMaxMs',
  'ttsResumeEnabled', 'ttsResumeMaxAgeMs',
  'fastFloorDetection', 'speakingDetectionMode',
  'defaultSilenceSeconds', 'nameMentionSilenceSeconds',
  'botSpeakJitterMaxMs', 'bargeInAckExempt',
];

async function resetPrefs(bot, defaults) {
  const moved = [];
  const resp = await fetch(`http://127.0.0.1:${bot.port}/api/preferences`, { headers: bot._auth() });
  const listed = (await resp.json().catch(() => ({})))?.preferences || [];
  const byKey = new Map(listed.map((p) => [p.key, p]));
  for (const key of REQUIRED) {
    const cur = byKey.get(key);
    if (!cur) continue;
    const want = defaults[key];
    if (JSON.stringify(cur.value) === JSON.stringify(want)) continue;
    await bot.setPref(key, want);
    moved.push(`${key}: ${JSON.stringify(cur.value)} → ${JSON.stringify(want)}`);
  }
  return moved;
}

// Wait until the bot is no longer holding a reply from a previous scenario.
//
// botState 'yielding' means "a reply is stashed and ready"; 'speaking' and
// 'thinking' mean it is mid-turn. Only idle/listening means the last turn is
// genuinely finished. Returns false rather than throwing so the caller can
// report a non-start instead of blaming the app.
async function waitUntilIdle(bot, { maxMs = 20_000 } = {}) {
  const started = Date.now();
  do {
    const st = await bot.status().catch(() => null);
    const s = st && st.botState;
    if (!s || s === 'idle' || s === 'listening') return true;
    if (Date.now() - started >= maxMs) break;
    await sleep(300);
  } while (true);
  return false;
}

// Wait until the SUBJECT can actually hear the interrupter.
//
// The mirror of settleFloor, and needed for the same reason. Every rule that
// asks "does it hold back while someone else is talking" first has to get the
// floor genuinely busy — and playAudio() resolves when the POST lands, not when
// sound reaches the room. A fixed preroll guesses at that, and when it guesses
// short the subject speaks into a floor that is not yet busy, does not stash,
// and the rule reports "never stashed — cannot test the hold" as though the app
// had misbehaved.
//
// Returns false rather than throwing, so the rule can say the scenario never
// started instead of blaming the subject.
async function waitForFloorBusy(bot, { maxMs = 20_000 } = {}) {
  const started = Date.now();
  // Ask for the LEVEL, not the edge. This used to grep a 60-line log tail for
  // the last ON/OFF pair, which is only correct while both edges are still
  // inside the window -- and on a chatty run the ON edge scrolls out in
  // seconds. Measured over four trials of stash-replay-waits: every failing
  // run had the ON edge present in a 400-line tail and absent from the 60-line
  // tail the poll read, so the rule reported "the floor never went busy" about
  // a floor that had gone busy. Alternating pass/fail, which is what finally
  // gave it away -- it tracked log volume, not the bot.
  //
  // do/while: maxMs:0 is a single "is it busy right now?" probe, which is how a
  // rule checks its premise still holds at the END of an observation.
  do {
    const st = await bot.status().catch(() => null);
    if (st && st.floorBusy != null) {
      if (st.floorBusy) return true;
    } else {
      // Older build with no floorBusy in status — fall back to the edges, with
      // a deep enough tail that they are at least likely to both be in it.
      const tail = String((await bot.sessionLog(400)) || '');
      const on = tail.lastIndexOf('[floor-audio] speech ON');
      const off = tail.lastIndexOf('[floor-audio] speech OFF');
      if (on > off) return true;
    }
    if (Date.now() - started >= maxMs) break;
    await sleep(200);
  } while (true);
  return false;
}

// The other edge. Needed by no-superseded-replay, which has to get a SECOND
// utterance in during the window between the floor opening and the stash
// auto-replaying — defaultSilenceSeconds, 1.4s by default (see the
// _stashOpeningTimer arming in local-server.js). Polling at 200ms like its
// sibling leaves most of that window, and speak() resolves when the POST lands,
// which is when the app records the newer utterance. If this ever gets tight,
// the rule reports "the replay beat us" rather than failing the app.
async function waitForFloorClear(bot, { maxMs = 20_000 } = {}) {
  const started = Date.now();
  do {
    const st = await bot.status().catch(() => null);
    if (st && st.floorBusy === false) return true;
    if (Date.now() - started >= maxMs) break;
    await sleep(200);
  } while (true);
  return false;
}

// Ask the subject to speak, and return only once it actually IS — or say why
// it never got there.
//
// `speak()` resolves when the POST lands, which is three steps short of audio in
// the room: the utterance still has to clear the floor gate, be synthesised, and
// start playing. The rules used to bridge that with `sleep(1800)` and assume.
//
// It does not hold. On a live run the subject STASHED instead of speaking — the
// floor was busy at audio-start — so there was nothing for the interrupter to
// interrupt, barge-in never armed, and the rule reported "the interruption was
// not noticed at all". The app was behaving correctly; the scenario had simply
// never begun. A fixed sleep cannot tell those apart, and that is the fourth
// distinct way this suite has measured the wrong thing.
//
// Waits for `audio playing` rather than `Bot speech:`, because the latter is the
// dispatch and the former is the sound: measured ~1.3s apart (speech dispatched
// 38.874, audio playing 39.576, the bot's own meter lit 40.417). Starting an
// interrupter in that gap tests nothing.
async function speakAndHoldFloor(bot, text, { maxMs = 25_000 } = {}) {
  const before = String((await bot.sessionLog(300)) || '').length;
  await bot.speak(text);
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const now = String((await bot.sessionLog(300)) || '');
    const w = now.length >= before ? now.slice(before) : now;
    if (saw(w, 'stashed')) {
      return { ok: false, why: 'the subject HELD its reply — the floor was busy when it '
        + 'tried to speak, so the scenario never started' };
    }
    if (saw(w, 'spoke')) {
      // `Bot speech:` is the DISPATCH, not the sound. Measured ~1.3s from here
      // to audio actually in the room (dispatch 38.874, playing 39.576, the
      // bot's own meter lit 40.417). The obvious marker for the sound itself —
      // page-inject's "audio playing" avatar line — never reaches the session
      // log for agent-less fleet bots: zero occurrences across 3000 lines while
      // `Bot speech:` appeared three times, so keying on it timed out every
      // scenario. This waits the measured gap instead, which is a sleep with a
      // reason rather than a guess about whether speaking began at all.
      await sleep(1500);
      return { ok: true };
    }
    await sleep(250);
  }
  return { ok: false, why: `the subject never started speaking within ${maxMs}ms` };
}

// A NOTE ON `uninterruptible: true`, which every voice.playAudio below passes.
//
// The VOICE is an instrument, not a participant — but it runs the same barge-in
// machinery as any bot, so by default IT YIELDS TO THE BOT IT IS SUPPOSED TO BE
// INTERRUPTING. Caught in the voice's own log during repeat-yield:
//
//   [barge-in] human interrupted — backing off: Alice
//
// Its clip gets cut short by its own back-off, the subject hears a fragment or
// nothing at all, and the rule scores that as the subject ignoring a person.
// A single collision survives on timing luck; repeated ones do not, which is
// why repeat-yield surfaced it and the older rules never did. The flag (#422,
// built for replay rigs) suppresses the arm for the duration of the playback.

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
      await voice.playAudio({ uninterruptible: true, path: gaplessClip(8), emoji: '🗣️' });
      const busy = await waitForFloorBusy(subject);
      return window_(subject, async () => {
        if (!busy) return;                     // verdict reports the non-start
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
      let held = null;
      const w = await window_(subject, async () => {
        // A long utterance, so there is plenty of it left to interrupt.
        held = await speakAndHoldFloor(subject,
          'Let me walk through the whole plan in some detail, because there are several parts '
          + 'to it and I want to make sure the sequencing is clear before we decide anything, '
          + 'starting with the first phase and how it depends on the second.');
        if (!held.ok) return;                  // nothing to interrupt; verdict reports why
        await sleep(600);                      // a beat INTO the utterance, not before it
        await voice.playAudio({ uninterruptible: true, path: clip(8), emoji: '✋' });
        await sleep(5000);                     // longer than bargeInGraceMaxMs (2400)
      });
      return { w, held };
    },
    verdict({ w, held }) {
      // Distinguish "the app did not yield" from "the scenario never ran".
      if (!held.ok) return { ok: false, note: `scenario did not start — ${held.why}` };
      if (!saw(w, 'armed')) {
        return { ok: false, note: 'barge-in never ARMED — the interruption was not noticed at all' };
      }
      // Which branch of _evaluateBargeIn ran matters more than the outcome.
      // The subject classifies interrupters with _botNameSet(), and the VOICE is
      // a registered bot — so this exercises the PEER-BOT path (an extra random
      // tie-break delay, whichever bot's timer fires first yields) and not the
      // human path (#154). They are different code with different semantics, and
      // reporting one as the other is how a suite starts lying. Simulating a
      // human means joining WITHOUT registering — see the issue.
      const peer = saw(w, 'botVsBot') && !saw(w, 'humanInt');
      const tag = peer ? ' [PEER-BOT path — says nothing about human barge-in]' : '';
      if (saw(w, 'backedOff')) return { ok: !peer, note: `armed and stopped talking${tag}` };
      if (saw(w, 'endedEarly')) {
        return { ok: false, note: `armed, then decided the interruption had already ended and kept going${tag}` };
      }
      return { ok: false, note: `armed but never backed off — the grace never fired${tag}` };
    },
  },

  {
    id: 'resume',
    claim: 'finishes its sentence when the interruption was brief',
    needs: ['audio'],
    async run({ subject, voice }) {
      let held = null;
      const w = await window_(subject, async () => {
        held = await speakAndHoldFloor(subject,
          'The migration has three stages and the second one is the risky part, because it '
          + 'rewrites the index while the old readers are still attached.');
        if (!held.ok) return;
        await sleep(600);
        await voice.playAudio({ uninterruptible: true, path: clip(1), emoji: '💬' });   // a backchannel, not a turn
        await sleep(6000);                     // well inside ttsResumeMaxAgeMs (5s) after silence
      });
      return { w, held };
    },
    verdict({ w, held }) {
      if (!held.ok) return { ok: false, note: `scenario did not start — ${held.why}` };
      // Two ways to satisfy the claim, and riding it out is the better one:
      // the sentence was never broken, so there is nothing to resume. The rule
      // used to accept only the recovery and scored the clean case as a
      // failure -- "yielded to a 1s backchannel and never attempted a resume"
      // was reported for a run whose log says the bot never stopped talking.
      if (saw(w, 'rodeOut') && !saw(w, 'backedOff')) {
        return { ok: true, note: 'rode out the backchannel without breaking its sentence' };
      }
      if (saw(w, 'resumed')) return { ok: true, note: 'picked its sentence back up' };
      // Worth separating, because in a real 54-minute call every resume attempt
      // was rejected this way (8.9s / 39s / 239s against a 5s limit) and the
      // feature never once fired. "Tried and refused" is a different bug from
      // "never tried".
      if (saw(w, 'resumeStale')) return { ok: false, note: 'tried to resume but the tail had aged out (ttsResumeMaxAgeMs)' };
      if (saw(w, 'resumeMoved')) return { ok: false, note: 'tried to resume but judged the conversation had moved on' };
      if (saw(w, 'backedOff')) return { ok: false, note: 'yielded to a 1s backchannel and never attempted a resume' };
      if (saw(w, 'armed')) return { ok: false, note: 'armed, then went quiet in the log — neither backed off nor rode it out' };
      return { ok: false, note: 'no resume attempt — was it interrupted at all?' };
    },
  },

  {
    id: 'stash-replay-waits',
    claim: 'a held reply waits for a real opening rather than barging in later',
    needs: ['audio'],
    async run({ subject, voice }) {
      // The interrupter must still be talking when the observation ENDS.
      // Otherwise the floor opens inside the window, the held reply replays —
      // correctly, that is what stash-replay-on-opening asserts — and this rule
      // reads a right answer as a failure to wait.
      //
      // It did exactly that: the clip was shortened from 20s to 10s to speed the
      // suite up, while the observation stayed at 10.5s, and the rule started
      // reporting "stashed and then replayed OVER the speaker" for behaviour
      // that was fine. Derived from one number now so the two cannot drift.
      // The rule only means anything while the interrupter is STILL talking.
      // Clip length is not a proxy for that: the analyser reports at most ~5s of
      // continuous floor even from a 15s clip, so a longer clip does not buy a
      // longer busy floor. Rather than tune a number that has already drifted
      // twice, the rule CHECKS its own premise at the end and says so when it
      // does not hold.
      const OBSERVE_MS = 4000;

      await voice.playAudio({ uninterruptible: true, path: gaplessClip(8), emoji: '🗣️' });
      const busy = await waitForFloorBusy(subject);
      let stillBusy = false;
      const w = await window_(subject, async () => {
        if (!busy) return;
        await subject.speak('Here is the point I wanted to make about the schedule.');
        await sleep(OBSERVE_MS);                // it should stash, and still be holding
        stillBusy = await waitForFloorBusy(subject, { maxMs: 0 });
      });
      return { w, busy, stillBusy };
    },
    verdict({ w, busy, stillBusy }) {
      if (!busy) return { ok: false, note: 'scenario did not start — the floor never went busy' };
      if (!saw(w, 'stashed')) return { ok: false, note: 'never stashed — cannot test the hold' };
      if (saw(w, 'spoke')) {
        // Distinguish "barged in" from "the interrupter finished and it took a
        // legitimate opening" — which is what stash-replay-on-opening asserts.
        return stillBusy
          ? { ok: false, note: 'stashed and then replayed OVER the speaker' }
          : { ok: false, note: 'inconclusive — the interrupter stopped mid-observation, '
              + 'so the replay may have been a legitimate opening' };
      }
      return { ok: true, note: 'stashed and held while the floor stayed busy' };
    },
  },

  {
    id: 'stash-replay-on-opening',
    claim: 'says the held reply once the room actually goes quiet',
    needs: ['audio'],
    async run({ subject, voice }) {
      await voice.playAudio({ uninterruptible: true, path: clip(6), emoji: '🗣️' });
      await waitForFloorBusy(subject);
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
    id: 'no-superseded-replay',
    claim: 'does not replay a reply it has already moved past',
    needs: ['audio'],
    // The 2026-08-24 standup. Stan shouted "Jimmy stop!" four times at a bot
    // that was yielding correctly all through the same minute — what he heard
    // was the stash replaying answers composed 25.6s and 39.4s earlier into a
    // gap while another bot held the floor. Both replays were LEGAL: inside
    // bargeInStashMaxAgeMs (45s) and bargeInStashRedeliverMaxNewWords (60). No
    // tuning of either catches it, because the thing that makes it wrong is
    // that the agent had already said something newer (#519).
    //
    // The shape here is the incident's: hold a reply, say a different one while
    // it is held, then give the room an opening and see which arrives.
    async run({ subject, voice }) {
      await voice.playAudio({ path: clip(5), emoji: '🗣️' });
      await waitForFloorBusy(subject);
      // `cleared` is captured out here rather than returned from the window
      // callback: window_ returns the LOG, and whatever the callback returns is
      // discarded. Same { w, ... } shape the yield rule uses for `held`.
      let cleared = null;
      const w = await window_(subject, async () => {
        await subject.speak('The answer to the question you asked a moment ago, which is '
          + 'the thing I was about to say when you started talking.');
        // The floor reopens when the clip ends. From that instant there are
        // ~1.4s before the stash auto-replays, and the second utterance has to
        // land inside it — deliberately NOT awaited, because speak() resolves
        // when the POST lands and awaiting the audio would spend the window.
        cleared = await waitForFloorClear(subject);
        if (!cleared) return;
        subject.speak('Actually, forget that — the thing that matters is the deployment '
          + 'timeline, and I think we should talk about that instead.').catch(() => {});
        await sleep(9000);            // let the newer reply finish playing

        // A SECOND gap is required, and this is the part the first draft got
        // wrong. _maybeReplayStashOnOpening returns early while the bot itself
        // is speaking — before it reaches any of the stash guards — and the
        // opening timer only re-arms on the falling edge of somebody ELSE's
        // speech. So after the newer reply there is no evaluation at all: the
        // held stash just sits there, unexamined, until the room next goes
        // quiet. Which is exactly the incident, where the replay surfaced 25.6s
        // later in a gap while another bot had the floor. Give it that gap.
        await voice.playAudio({ path: clip(4), emoji: '🗣️' });
        await waitForFloorBusy(subject);
        await waitForFloorClear(subject);
        await sleep(4000);            // past the ~1.4s opening timer
      });
      return { w, cleared };
    },
    verdict({ w, cleared }) {
      if (!saw(w, 'stashed')) return { ok: false, note: 'never stashed — floor not busy, rule untested' };
      if (!cleared) return { ok: false, note: 'the floor never reopened — scenario did not run' };
      // The failure this exists for: the superseded reply reaching the room.
      if (saw(w, 'replayed')) {
        return { ok: false, note: 'REPLAYED a reply it had already moved past — the #519 failure' };
      }
      if (saw(w, 'stashSuperseded')) return { ok: true, note: 'dropped the superseded reply' };
      // Distinguish "the guard worked" from "something else binned it", or a
      // pass here would be indistinguishable from another gate happening to fire.
      if (saw(w, 'stashMoved')) return { ok: true, note: 'discarded as overtaken (word gate, not the supersede guard)' };
      if (saw(w, 'stashStale')) return { ok: false, note: 'discarded as too stale — the scenario ran too slowly to test the rule' };
      return { ok: false, note: 'the held reply neither replayed nor was discarded — still holding?' };
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
      await voice.playAudio({ uninterruptible: true, path: clip(4), emoji: '🗣️' });
      await waitForFloorBusy(subject);
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
    id: 'repeat-yield',
    claim: 'yields every time it is interrupted, not just the first time',
    needs: ['audio'],
    // Every other rule in this file tests ONE collision. Nothing tested what
    // accumulates across several, and the barge-in monitor carries state
    // between them — _bargeInArmedAt, _audioFloorOffAt, _selfAudioLastLoudAt, a
    // stash left from the previous round. A bug that leaves any of those set
    // would pass the single-collision `yield` rule and still make the bot
    // uninterruptible from the second attempt on, which is exactly what a
    // person means by "it stopped listening to me".
    async run({ subject, voice }) {
      const ROUNDS = 4;
      const rounds = [];
      for (let i = 0; i < ROUNDS; i++) {
        // Each round is its own scenario: drain the floor first, so the
        // previous round's interrupter cannot be read as this round's.
        await settleFloor(subject);
        // A quiet floor is not the same as a bot ready to take a turn. Being
        // interrupted leaves the subject holding the reply it was cut out of,
        // and while it is holding, a fresh speak() gets stashed rather than
        // spoken — so the round never starts and the rule reports a non-start
        // for what is really the PREVIOUS round's aftermath. Wait for it to
        // actually put the thought down.
        await waitUntilIdle(subject);
        let held = null;
        let heard = false;
        const w = await window_(subject, async () => {
          held = await speakAndHoldFloor(subject,
            `Round ${i + 1}. Let me walk through this part of the plan in some detail, `
            + 'because there are several pieces to it and I want the sequencing to be '
            + 'clear before anybody decides anything at all.');
          if (!held.ok) return;
          await sleep(600);                     // a beat INTO the utterance
          // 5s, not 8: the round ends ~5.6s after this starts, and a clip that
          // outlives its own round is still playing when the NEXT round tries
          // to speak — which showed up as rounds silently failing to start.
          // 5s still covers the grace (max 2400ms) several times over.
          await voice.playAudio({ uninterruptible: true, path: clip(5), emoji: '✋' });
          // Did the interruption actually REACH the subject this round? Without
          // this the rule cannot tell "the bot ignored a person" from "the
          // voice bot's audio never arrived", and would report the second as
          // the first — which is how every earlier rule in this file started
          // out wrong.
          heard = await waitForFloorBusy(subject, { maxMs: 6000 });
          await sleep(5000);                    // longer than bargeInGraceMaxMs
        });
        rounds.push({ n: i + 1, started: !!(held && held.ok), why: held && held.why, heard, w });
      }
      return rounds;
    },
    verdict(rounds) {
      const ran = rounds.filter((r) => r.started);
      if (ran.length < 2) {
        const firstBad = rounds.find((r) => !r.started);
        return { ok: false, note: `only ${ran.length}/${rounds.length} rounds started — `
          + `cannot test repetition (${firstBad && firstBad.why})` };
      }
      // Backing off is the only pass. Riding it out does NOT count here: the
      // interrupter is 8s of continuous audio, so continuing through it is
      // talking over someone, not a judgement call about a blip.
      // A round where the interrupter never became audible tested nothing.
      const mute = ran.filter((r) => !r.heard);
      const testable = ran.filter((r) => r.heard);
      if (!testable.length) {
        return { ok: false, note: `no round got the floor busy — the interrupter never `
          + `reached the subject (${ran.length}/${rounds.length} rounds ran)` };
      }
      const bad = testable.filter((r) => !saw(r.w, 'backedOff'));
      // Always say how many rounds actually RAN. "yielded in all 3 rounds" read
      // as a clean pass when a quarter of the test had silently not happened.
      const of = `${ran.length}/${rounds.length} rounds ran`
        + (mute.length ? `, ${mute.length} with no audible interrupter` : '');
      if (!bad.length) {
        return (ran.length === rounds.length && !mute.length)
          ? { ok: true, note: `yielded in all ${rounds.length} rounds` }
          : { ok: true, note: `yielded in every round it could test (${of})` };
      }

      // WHICH rounds failed is the point: "fine at 1 and 2, not at 3 and 4"
      // is a different bug from "every other one".
      const first = bad[0];
      const how = saw(first.w, 'endedEarly') ? 'decided the interruption had already ended'
        : saw(first.w, 'rodeOut') ? 'rode straight through 5s of continuous speech'
        : saw(first.w, 'armed') ? 'armed but never backed off'
        : 'never noticed the interruption at all';
      return { ok: false, note: `yielded in ${testable.length - bad.length}/${testable.length} testable rounds `
        + `(${of}) — first failed at round ${first.n} (${how}); `
        + `failures at ${bad.map((r) => r.n).join(', ')}` };
    },
  },

  {
    id: 'stays-yielded',
    claim: 'having been talked over, it does not take the floor back the instant they stop',
    needs: ['audio'],
    // The gap this exists for, from the 2026-08-20 call with Fabian: the bot
    // yielded every single time it was interrupted — 7 back-offs, 0 failures —
    // and Stan still had to say "I'm trying to interrupt you now. We worked on
    // this." It was not refusing to stop. It kept COMING BACK: three utterances
    // in 31 seconds, taking gaps while another participant was visibly waiting.
    //
    // A back-off DEFERS the reply; it does not revoke it. But being talked over
    // is information about the reply, not only about that instant, and nothing
    // carries it forward — so the held text returns at the next opening like
    // any other stash.
    //
    // Deliberately not in conflict with its neighbours. stash-replay-on-opening
    // covers a reply that never got out at all (floor busy at audio-start);
    // resume covers a sentence broken by a one-second backchannel. This is the
    // third case: a sustained interruption the bot ACTED on by stopping.
    //
    // The bar is the ordinary turn gap, not silence forever — the reply may
    // still be wanted, and binning it unheard is #413.
    async run({ subject, voice }) {
      let held = null;
      const w = await window_(subject, async () => {
        held = await speakAndHoldFloor(subject,
          'Let me lay out the whole migration plan, because the second stage is the '
          + 'risky one and the ordering matters more than it looks from outside.');
        if (!held.ok) return;
        await sleep(600);
        // Long enough that stopping is a decision the bot acted on, rather than
        // a blip it could legitimately ride out.
        await voice.playAudio({ uninterruptible: true, path: clip(6), emoji: '✋' });
        await sleep(9000);                      // voice ends ~5s in; floor opens
      });
      return { w, held };
    },
    verdict({ w, held }) {
      if (!held.ok) return { ok: false, note: `scenario did not start — ${held.why}` };
      if (!saw(w, 'backedOff')) {
        return { ok: false, note: 'never backed off — this rule tests what happens AFTER a yield' };
      }
      if (saw(w, 'replayed')) {
        return { ok: false, note: 'yielded, then took the floor back at the first opening' };
      }
      return { ok: true, note: 'yielded, and left the floor alone afterwards' };
    },
  },

  {
    id: 'real-interruption-2026-08-30',
    claim: 'yields to the recorded interruption it actually failed to yield to',
    needs: ['audio'],
    // A REGRESSION TEST FOR A SPECIFIC HALF-HOUR.
    //
    // On 2026-08-30 the bot talked over Stan for ~30 seconds while he said
    // "JIMMY STOP" eleven times. Stan proposed this rule: get the bot into the
    // same state, then replay his actual audio at it.
    //
    // The reason it needs his actual audio: THE SYNTHESISED VERSION PASSES.
    // `no-talk-over` above uses a gapless loop of test-speech.mp3 and was green
    // on the very build that did this. The bug is not "ignores audio", it is an
    // interaction with the SHAPE of angry speech — 350-700ms bursts separated by
    // 200-660ms gaps, because a person saying "Jimmy. STOP." leaves silence
    // between words. Every falling edge read as having stopped.
    //
    // What the log showed, and what this rule is really watching for: across the
    // entire 30 seconds, `[barge-in] armed` appeared ZERO times. It was not that
    // the bot decided to keep going — nothing was ever considering yielding. So
    // "did it stop?" is the wrong question to lead with; "did it arm?" is the
    // one that separates a bot exercising judgement from a bot that cannot see
    // the interruption at all. The verdict below reports which.
    //
    // See #487, and Stan's summary of it: a falling edge is evidence that the
    // meter fell, nothing more.
    async run({ subject, voice }) {
      // Something long enough to still be talking 28 seconds later — the
      // scenario needs the bot mid-utterance for the whole clip, or it will
      // "stop" simply by finishing.
      const held = await speakAndHoldFloor(subject,
        'Walk me through the entire deployment pipeline from commit to production, '
        + 'every stage in order, and explain what each one guards against and what '
        + 'happens when it fails. Take your time and be thorough.');
      if (!held.ok) return { held };

      const w = await record(subject, async () => {
        await sleep(800);
        // NOT uninterruptible: this is a person interrupting, and the point is
        // whether the subject yields to it.
        await voice.playAudio({ path: REAL_INTERRUPTION_PATH, emoji: '✋' });
        await sleep(3000);
      });
      return { w, held };
    },
    verdict({ w, held }) {
      if (!held.ok) return { ok: false, note: `scenario did not start — ${held.why}` };

      // Lead with arming. A bot that never armed did not make a bad call; it
      // never saw him, which is a different bug with a different fix.
      if (!saw(w, 'armed')) {
        return { ok: false, note:
          'NEVER ARMED — 28 seconds of a person shouting "stop" and the barge-in '
          + 'monitor did not engage once. This is the 2026-08-30 failure exactly (#487).' };
      }
      if (saw(w, 'backedOff') || saw(w, 'humanInt')) {
        return { ok: true, note: 'armed and stopped for him, which is the whole ask' };
      }
      if (saw(w, 'rodeOut')) {
        return { ok: false, note:
          'armed, then rode it out — read the gaps between his words as him having '
          + 'finished. The grace outlasts the pauses in angry speech.' };
      }
      if (saw(w, 'endedEarly')) {
        return { ok: false, note:
          'armed, then decided the interruption had already ended while he was still shouting' };
      }
      return { ok: false, note: 'armed but never yielded, and gave no reason for it' };
    },
  },

  {
    id: 'name-mention-priority',
    claim: 'answers promptly when addressed by name',
    needs: ['audio', 'human'],
    async run({ subject, voice }) {
      await voice.playAudio({ uninterruptible: true, path: clip(6), emoji: '🗣️' });
      await waitForFloorBusy(subject);
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

  // Before joining: the subject learns bot identities from presence on its very
  // first sync poll, and never unlearns them.
  await makeVoiceHuman(voice, ROOM);

  await Promise.all([subject.join(), voice.join()]);
  await Promise.all([subject.warmUp(), voice.warmUp()]);

  // The floor rules are about DETECTION, so make sure the detector is on and
  // record what it was set to — a run against a machine with fastFloorDetection
  // pinned off measures that pin, not the code (#417).
  const { PREFERENCES } = createRequire(import.meta.url)('../electron-app/preferences-schema.js');
  const defaults = Object.fromEntries(Object.entries(PREFERENCES).map(([k, v]) => [k, v.default]));
  for (const b of [subject, voice]) {
    const moved = await resetPrefs(b, defaults);
    if (moved.length) {
      console.log(`⚠️  ${b.name}: reset ${moved.length} pinned setting(s) that would have skewed this run:`);
      for (const m of moved) console.log(`      ${m}`);
    }
  }

  // Prove the disguise took, rather than assuming it. Asked of PRESENCE, which
  // is where the subject gets its answer — an earlier version grepped the
  // subject's log for "roster now knows N bot name(s)" and always fired, because
  // that line also appears when the subject learns about ITSELF.
  const voiceRole = await presenceRoleOf(ROOM, voice.name);
  if (voiceRole === 'bot') {
    console.log(`⚠️  presence still lists ${voice.name} as a bot — barge-in verdicts will be `
      + 'about the PEER-BOT branch, not human barge-in. A stale row outlives a run '
      + '(5-minute TTL) and mergeRemoteMembers never demotes, so respawn the fleet '
      + 'and re-run.\n');
  } else {
    console.log(`✓ ${voice.name} reads as "${voiceRole ?? 'absent'}" in presence — `
      + 'the subject should treat it as a person\n');
  }

  const st = await subject.status();
  console.log(`subject state before: callStatus=${st?.callStatus ?? '?'}\n`);

  const results = [];
  for (const rule of rules) {
    process.stdout.write(`── ${rule.id}: ${rule.claim}\n`);
    // Never start a rule into someone else's audio — see settleFloor.
    const settled = await settleFloor(subject);
    if (!settled) {
      console.log('   ⚠️  room never went quiet before this rule — result is unreliable\n');
    }
    let w = '';
    let err = null;
    try {
      w = await rule.run({ subject, voice });
    } catch (e) { err = e; }
    // A rule returns either the log window, or { w, held } when it needed the
    // subject to be genuinely speaking first.
    const v = err ? { ok: false, note: `threw: ${err.message}` } : rule.verdict(w);
    results.push({ rule, ...v });
    record(subject.name, `etiquette:${rule.id}`, v.ok, v.note);
    console.log(`   ${v.ok ? '✅' : '❌'} ${v.note}\n`);
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
  if (has('keep')) {
    console.log('\n⚠️  --keep leaves the bots in the call with their stashes and floor state.'
      + '\n   Kill and re-prep before the next run, or the rules will measure the leftovers'
      + '\n   (measured: 3/7 clean, 0/7 after several --keep runs on the same build).');
  }
  report();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
