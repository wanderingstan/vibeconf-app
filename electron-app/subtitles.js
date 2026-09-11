// subtitles.js — turn the call's caption turns into .srt / .vtt sidecars for
// call-recording.mp4.
//
// WHY THIS IS EVEN POSSIBLE: the two clocks already agree. Caption turns carry
// `firstSeen`/`lastUpdated` as absolute `Date.now()` ms (local-server.js
// _newTurn), and every recorded track carries `startWallClock` — "the webm's
// t=0 in absolute wall-clock ms, on the same clock as the transcript"
// (call-recorder.js _track). So a cue's media time is simply
//
//     firstSeen - anchorMs        where anchorMs = the video track's startWallClock
//
// and nothing has to be estimated, correlated or guessed. The main merge does
// NOT delay-align the audio tracks (call-media-merge.js just amixes them onto
// video.webm), so the video track's startWallClock IS the mp4's t=0. The share
// merge pads its picture by exactly (shareStart - videoStart), which puts
// call-recording-share.mp4 on that same t=0 — one set of cues fits both files.
//
// WHY CAPTIONS AND NOT THE BOT'S OWN SPEECH RECORD: the bot's utterances live
// in localServer.transcripts with a single timestamp and no end time, and that
// timestamp is when the utterance was ACCEPTED, not when it played — barge-in
// can stash speech and replay it later. Meet captions the bot's TTS like any
// other participant, so the caption stream already covers it, with real
// timings. (That caption echo is what local-server's _turnsAsEntries drops as
// a "lossy duplicate" for the agent's benefit; for subtitles it is the good
// copy.) The text is whatever Meet's recognizer heard — lossy, thin on
// punctuation — but it is what was actually audible on the recording, which is
// the right thing for a subtitle to say.
//
// This module is deliberately pure: no fs, no electron, no clock. It takes
// caption entries and returns strings. That's what makes it testable without
// a call (tests/call-subtitles.test.mjs).

'use strict';

// A cue shorter than this is unreadable no matter how few words it holds — a
// one-word caption turn that settled in 200ms still needs a beat on screen.
const MIN_CUE_MS = 1200;
// Rough adult reading speed, used only to EXTEND a too-short cue, never to
// shorten a long one: the turn's real span is the truth about when the words
// were audible.
const CHARS_PER_SEC = 17;
// Past this, one cue becomes a wall of text. Long turns are split into several
// cues and the turn's span divided among them by character count.
const MAX_CHARS_PER_CUE = 84;
// Subtitle convention: two lines of ~42, so the text sits under the picture
// rather than over it.
const MAX_LINE_CHARS = 42;

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

function clampMs(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function timeParts(ms) {
  const total = clampMs(ms);
  const msPart = total % 1000;
  const totalSec = Math.floor(total / 1000);
  return {
    h: Math.floor(totalSec / 3600),
    m: Math.floor(totalSec / 60) % 60,
    s: totalSec % 60,
    ms: msPart,
  };
}

const pad = (n, width = 2) => String(n).padStart(width, '0');

// SRT uses a comma before the milliseconds; WebVTT uses a dot. That one
// character is very nearly the whole difference between the two formats.
function formatSrtTime(ms) {
  const t = timeParts(ms);
  return `${pad(t.h)}:${pad(t.m)}:${pad(t.s)},${pad(t.ms, 3)}`;
}

function formatVttTime(ms) {
  const t = timeParts(ms);
  return `${pad(t.h)}:${pad(t.m)}:${pad(t.s)}.${pad(t.ms, 3)}`;
}

// ---------------------------------------------------------------------------
// Text shaping
// ---------------------------------------------------------------------------

// Greedy wrap at word boundaries. A single word longer than the limit is left
// long rather than hyphenated — a broken URL reads worse than a wide line.
function wrapLines(text, maxChars = MAX_LINE_CHARS) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= maxChars) line += ' ' + word;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

// Split a long utterance into cue-sized chunks at word boundaries. Returns an
// array of strings; a short utterance comes back as a single-element array.
function chunkText(text, maxChars = MAX_CHARS_PER_CUE) {
  const clean = String(text).trim().replace(/\s+/g, ' ');
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];
  const words = clean.split(' ');
  const chunks = [];
  let chunk = '';
  for (const word of words) {
    if (!chunk) chunk = word;
    else if (chunk.length + 1 + word.length <= maxChars) chunk += ' ' + word;
    else { chunks.push(chunk); chunk = word; }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

// ---------------------------------------------------------------------------
// Cue building
// ---------------------------------------------------------------------------

// entries: caption turns, each { id, speaker, text, firstSeen, lastUpdated }
//   with firstSeen/lastUpdated in absolute Date.now() ms.
// opts:
//   anchorMs     absolute wall-clock ms of the media's t=0 (the video track's
//                startWallClock). Required — without it there is no timeline.
//   durationMs   media length; cues starting past it are dropped. Optional.
//   offsetMs     shift every cue by this much, for trimming recognizer lag.
//                Meet's captions appear a beat AFTER the words are audible, so
//                a small negative value nudges them earlier. Default 0.
//   includeSpeaker  prefix each cue with the speaker's name. Default true.
function buildCues(entries, {
  anchorMs,
  durationMs = null,
  offsetMs = 0,
  includeSpeaker = true,
} = {}) {
  if (!Number.isFinite(anchorMs)) return [];
  const shift = Number.isFinite(offsetMs) ? offsetMs : 0;

  // Last write wins per turn id: the caption log is append-only and a growing
  // turn is written repeatedly, so the final record holds the settled text and
  // the true lastUpdated.
  const byId = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e.text !== 'string') continue;
    const text = e.text.trim();
    if (!text) continue;
    if (!Number.isFinite(e.firstSeen)) continue;
    const id = e.id != null ? String(e.id) : `${e.speaker}|${e.firstSeen}`;
    const prev = byId.get(id);
    // Guard against a truncated replay overwriting the full text: keep
    // whichever record says more. (local-server fights the same battle on the
    // ingest side; the log can still contain both.)
    if (prev && prev.text.length > text.length) continue;
    byId.set(id, {
      id,
      speaker: e.speaker ? String(e.speaker) : '',
      text,
      firstSeen: e.firstSeen,
      lastUpdated: Number.isFinite(e.lastUpdated) ? e.lastUpdated : e.firstSeen,
    });
  }

  const turns = [...byId.values()].sort((a, b) => a.firstSeen - b.firstSeen);
  const cues = [];

  for (const turn of turns) {
    const rawStart = turn.firstSeen - anchorMs + shift;
    const rawEnd = Math.max(turn.lastUpdated - anchorMs + shift, rawStart);
    // Said before the recording rolled, or after it stopped — not on this tape.
    if (durationMs != null && rawStart >= durationMs) continue;
    if (rawEnd <= 0) continue;

    const chunks = chunkText(turn.text);
    if (!chunks.length) continue;
    const totalChars = chunks.reduce((n, c) => n + c.length, 0) || 1;
    // Divide the turn's real span among its chunks in proportion to their
    // length, so a long utterance's subtitles advance at roughly the pace the
    // speaker was going.
    const span = Math.max(rawEnd - rawStart, MIN_CUE_MS);
    let cursor = rawStart;
    chunks.forEach((chunk, i) => {
      const share = (chunk.length / totalChars) * span;
      let start = cursor;
      let end = i === chunks.length - 1 ? Math.max(rawEnd, start + share) : start + share;
      // A cue that flashes past faster than it can be read gets extended —
      // into the following cue's time if need be, which the overlap pass below
      // then resolves.
      const readable = Math.max(MIN_CUE_MS, (chunk.length / CHARS_PER_SEC) * 1000);
      if (end - start < readable) end = start + readable;
      cursor = end;
      cues.push({
        speaker: turn.speaker,
        text: chunk,
        startMs: Math.max(0, Math.round(start)),
        endMs: Math.max(0, Math.round(end)),
      });
    });
  }

  cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  // Resolve overlaps only between consecutive cues from the SAME speaker —
  // that overlap is always an artifact of the readability extension above.
  // Two PEOPLE talking over each other is a real thing that happened on the
  // call, and both formats can show it, so it is left alone.
  for (let i = 0; i < cues.length - 1; i++) {
    const cue = cues[i];
    const next = cues[i + 1];
    if (cue.speaker && cue.speaker === next.speaker && cue.endMs > next.startMs) {
      cue.endMs = Math.max(cue.startMs + 1, next.startMs);
    }
  }

  // Clip the tail to the media, and drop anything the clip emptied out.
  const out = [];
  for (const cue of cues) {
    if (durationMs != null) {
      if (cue.startMs >= durationMs) continue;
      cue.endMs = Math.min(cue.endMs, durationMs);
    }
    if (cue.endMs <= cue.startMs) cue.endMs = cue.startMs + 1;
    if (!includeSpeaker) cue.speaker = '';
    out.push(cue);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderSrt(cues) {
  const blocks = [];
  (cues || []).forEach((cue, i) => {
    // SRT has no speaker markup, so the name goes inline on its own line —
    // the convention every player and editor already understands.
    const body = cue.speaker
      ? [`${cue.speaker}:`, ...wrapLines(cue.text)].join('\n')
      : wrapLines(cue.text).join('\n');
    blocks.push(
      `${i + 1}\n${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}\n${body}`,
    );
  });
  // Trailing newline: some parsers won't emit the final cue without it.
  return blocks.length ? blocks.join('\n\n') + '\n' : '';
}

function renderVtt(cues, { title = null } = {}) {
  const head = title ? `WEBVTT - ${title}` : 'WEBVTT';
  const blocks = [head];
  (cues || []).forEach((cue) => {
    // WebVTT has a real speaker construct — <v Name> — which players can style
    // and screen readers can announce. This is the reason to ship .vtt rather
    // than only .srt.
    const wrapped = wrapLines(cue.text).join('\n');
    const body = cue.speaker ? `<v ${escapeVttName(cue.speaker)}>${wrapped}` : wrapped;
    blocks.push(`${formatVttTime(cue.startMs)} --> ${formatVttTime(cue.endMs)}\n${body}`);
  });
  return blocks.join('\n\n') + '\n';
}

// A '>' inside the name would close the <v> tag early and swallow the line.
function escapeVttName(name) {
  return String(name).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}

// Parse the append-only caption log written during the call. Tolerant by
// design: a truncated final line (the app was killed mid-write) costs one
// caption, never the whole file.
function parseCaptionLog(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* partial write — skip */ }
  }
  return out;
}

module.exports = {
  buildCues,
  renderSrt,
  renderVtt,
  parseCaptionLog,
  formatSrtTime,
  formatVttTime,
  wrapLines,
  chunkText,
  MIN_CUE_MS,
  MAX_CHARS_PER_CUE,
  MAX_LINE_CHARS,
};
