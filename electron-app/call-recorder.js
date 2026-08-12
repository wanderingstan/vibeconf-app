// call-recorder.js — writes per-track call audio (and, now, one video track)
// to disk, for debugging.
//
// WHY: when a bot "hears nothing" and the call goes red, we have caption
// timeouts but no record of what each mic actually carried. A time-aligned
// audio track per source turns "the bot went deaf, no idea why" into "here is
// the remote track — it was silent" or "it was full of audio the bot never
// captioned". That is the diagnostic the meet-test stalls have been missing.
//
// VIDEO: this class is deliberately format-agnostic — chunk() just appends
// MediaRecorder timeslice chunks to a named file, so the bot's own Meet-view
// video (captured separately by call-recording-window.js via getDisplayMedia)
// rides the exact same path as one more "track" named 'video', landing at
// video.webm alongside bot.webm/remote-*.webm. The optional `kind` param lets
// call-media-merge.js tell the video track apart from audio tracks without
// guessing from the name.
//
// SEPARATION: measured (#209), Meet DOES hand each remote participant its own
// WebRTC track — in a 3-party call the two remote tracks came out with near-zero
// energy cross-correlation (independent audio, not one shared mix). So this
// records the bot's own outgoing audio plus each distinct remote track, and you
// get real per-participant tracks. Caveats we do NOT paper over: tracks are
// labeled by arrival order, not participant NAME (attribution is future work),
// and Meet can emit extra or initially-silent tracks — in a 2-person call the
// lone remote may even appear duplicated. The manifest states this per session.
//
// The renderer (page-inject.js) drives a MediaRecorder per track and streams
// base64 webm/opus chunks here via IPC. MediaRecorder timeslice chunks are NOT
// individually valid but CONCATENATE into a valid streamable webm — the first
// chunk carries the header, the rest are clusters — so each track is simply one
// file we append to in arrival order. `seq` lets us count dropped/out-of-order
// chunks rather than silently corrupt the file.

const fs = require('fs');
const path = require('path');

// Runaway guards, not real limits, and entirely our own — nothing here comes
// from MediaRecorder, Electron, or the OS. One flat cap for every track used
// to bite video hard: at ~1600x900, the bot's own Meet-view capture runs
// roughly two orders of magnitude hotter than opus audio (~500KB/s vs
// ~3-4KB/s), so a single shared 250MB ceiling meant video capped out after
// under nine minutes on ANY call, silently, while audio sailed on for hours —
// observed for real: a 64-minute call recording that just went black at 8:45
// because video.webm quietly hit the cap and every later chunk was dropped.
// Split by kind so each gets a ceiling sized to its own bitrate.
const MAX_TRACK_BYTES_BY_KIND = {
  audio: 250 * 1024 * 1024, // opus at ~24-32kbps is ~3-4 KB/s — an hour is ~15MB, so this is hours of headroom
  video: 4 * 1024 * 1024 * 1024, // ~4GB — hours of headroom at the bitrate observed above, not minutes
};
const DEFAULT_MAX_TRACK_BYTES = MAX_TRACK_BYTES_BY_KIND.audio; // fallback for an unrecognized kind

// A track silently going quiet mid-call (like the video incident above) isn't
// discoverable until someone reads the manifest after the fact. Warn once,
// well before the cap actually bites, so there's a real window to notice and
// act (stop + start a fresh recording) instead of finding out afterward.
const CAP_WARN_RATIO = 0.9;

class CallRecordingSession {
  // dir: per-call output directory (created if missing).
  // meta: { room, botName, startedAt } — startedAt anchors every track's offset.
  // maxBytesByKind/capWarnRatio: override the module defaults above — real
  // callers never pass these (production always gets MAX_TRACK_BYTES_BY_KIND /
  // CAP_WARN_RATIO); this exists so tests can exercise capping/warning at a
  // few bytes instead of literal gigabytes.
  constructor(dir, {
    room = null, callId = null, botName = null, startedAt = Date.now(),
    maxBytesByKind = MAX_TRACK_BYTES_BY_KIND, capWarnRatio = CAP_WARN_RATIO,
  } = {}) {
    this.dir = dir;
    this.room = room;
    this.callId = callId;
    this.botName = botName;
    this.startedAt = startedAt;
    this.endedAt = null;
    this.closed = false;
    this.maxBytesByKind = maxBytesByKind;
    this.capWarnRatio = capWarnRatio;
    this.tracks = new Map(); // track name -> state
    this.names = new Map();  // track name -> attributed participant name (#209)
    fs.mkdirSync(dir, { recursive: true });
  }

  // Attribution: the renderer votes track -> participant name (via Meet's DOM
  // active-speaker events) and sends the current best guess as it firms up.
  // Stored live so the manifest has it even if stop() races the last vote.
  setName(track, name) {
    if (this.closed || !track || !name) return;
    this.names.set(String(track), String(name));
  }

  // Append one speaker start/stop to speaker-events.jsonl (wall-clock stamped),
  // the source for who-spoke-when annotations over the merged call audio (#209).
  // Meet mixes participants into shared audio slots, so this DOM-derived timeline
  // — not the tracks — is what says who was speaking at each moment.
  speakerEvent(name, speaking, at) {
    if (this.closed || !name) return;
    if (!this._speakerFd) {
      try { this._speakerFd = fs.openSync(path.join(this.dir, 'speaker-events.jsonl'), 'w'); }
      catch { this._speakerFd = null; return; }
    }
    try {
      fs.writeSync(this._speakerFd, JSON.stringify({ at: Number(at) || Date.now(), name: String(name), speaking: !!speaking }) + '\n');
    } catch { /* keep recording even if the sidecar write fails */ }
  }

  _track(name, mime, startWallClock, kind) {
    let t = this.tracks.get(name);
    if (!t) {
      // Never let a track name reach the filesystem unsanitized.
      const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, '_') || 'track';
      const ext = /ogg/i.test(mime || '') ? 'ogg' : 'webm';
      const file = path.join(this.dir, `${safe}.${ext}`);
      // kind is optional: callers that don't pass it get the obvious default
      // inferred from the track name, so existing audio callers (page-inject.js)
      // need no change.
      const resolvedKind = kind || (name === 'video' || /^video\//i.test(mime || '') ? 'video' : 'audio');
      t = {
        name, file, base: `${safe}.${ext}`,
        fd: fs.openSync(file, 'w'),
        mime: mime || 'audio/webm',
        kind: resolvedKind,
        maxBytes: this.maxBytesByKind[resolvedKind] ?? DEFAULT_MAX_TRACK_BYTES,
        bytes: 0, chunks: 0,
        // startWallClock (from the renderer, at MediaRecorder.start()) is the
        // PRECISE anchor: the webm's t=0 in absolute wall-clock ms, on the same
        // clock as the transcript. startOffsetMs (chunk arrival at main, relative
        // to startedAt) is kept as a coarse cross-check but lags by ~a timeslice.
        startWallClock: Number.isFinite(startWallClock) ? startWallClock : null,
        startOffsetMs: Math.max(0, Date.now() - this.startedAt),
        lastSeq: -1, seqGaps: 0,
        capped: false,
        warnedNearCap: false, // fires once, at CAP_WARN_RATIO — see chunk()
      };
      this.tracks.set(name, t);
    }
    return t;
  }

  // Append one MediaRecorder chunk. `buffer` is a Buffer (decoded upstream).
  // startWallClock: wall-clock ms at the track's MediaRecorder.start() (its t=0).
  // kind: optional 'audio'|'video' — inferred from the name/mime when omitted.
  chunk(name, seq, buffer, mime, startWallClock, kind) {
    if (this.closed || !buffer || !buffer.length) return;
    const t = this._track(name, mime, startWallClock, kind);
    if (t.capped) return;
    if (Number.isInteger(seq)) {
      if (t.lastSeq >= 0 && seq !== t.lastSeq + 1) t.seqGaps++;
      t.lastSeq = seq;
    }
    const nextBytes = t.bytes + buffer.length;
    if (nextBytes > t.maxBytes) {
      t.capped = true;
      console.warn(`[call-recorder] track "${t.name}" (${t.kind}) hit its `
        + `${Math.round(t.maxBytes / (1024 * 1024))}MB cap — recording stopped for `
        + 'this track only; every other track continues normally');
      return;
    }
    if (!t.warnedNearCap && nextBytes >= t.maxBytes * this.capWarnRatio) {
      t.warnedNearCap = true;
      const pct = Math.round((nextBytes / t.maxBytes) * 100);
      console.warn(`[call-recorder] track "${t.name}" (${t.kind}) is at ${pct}% of its `
        + `${Math.round(t.maxBytes / (1024 * 1024))}MB cap — it will stop recording soon; `
        + 'consider stopping and starting a new recording to avoid losing this track');
    }
    fs.writeSync(t.fd, buffer);
    t.bytes += buffer.length;
    t.chunks++;
  }

  // Bytes written across every track so far (#328). The per-track totals are
  // already maintained by chunk(); this just sums them, so it's cheap enough to
  // poll on a timer and — unlike stat()ing the directory — costs no filesystem
  // work and stays accurate while the fds are still open.
  totalBytes() {
    let n = 0;
    for (const t of this.tracks.values()) n += t.bytes;
    return n;
  }

  // Finalize: close every file and write the manifest. Idempotent.
  stop() {
    if (this.closed) return this.manifest();
    this.closed = true;
    this.endedAt = Date.now();
    for (const t of this.tracks.values()) {
      try { fs.closeSync(t.fd); } catch { /* already closed */ }
    }
    if (this._speakerFd) { try { fs.closeSync(this._speakerFd); } catch { /* already closed */ } this._speakerFd = null; }
    const m = this.manifest();
    try {
      fs.writeFileSync(path.join(this.dir, 'manifest.json'), JSON.stringify(m, null, 2));
    } catch { /* dir may be gone in a teardown race — the audio files still exist */ }
    return m;
  }

  manifest() {
    return {
      room: this.room,
      callId: this.callId,
      botName: this.botName,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      durationMs: (this.endedAt || Date.now()) - this.startedAt,
      note: 'Timeline: each track\'s startWallClock is its webm t=0 in absolute '
        + 'wall-clock ms (same Date.now() clock as the transcript), so sample-time '
        + 't maps to startWallClock + t — align audio with transcript/events by '
        + 'that. Each remote-* is a distinct WebRTC track from Meet (measured '
        + 'independent in a 3-party call — Meet separates participants, not one '
        + 'mix); tracks are labeled by arrival order and named when attributable, '
        + 'and Meet can emit extra or initially-silent tracks. A "share-audio" '
        + 'track, when present, is the shared tab/screen\'s own audio (raw, '
        + 'pre-mute) — distinct from the "share" track, which is that surface\'s '
        + 'VIDEO capture (kind: "share").',
      tracks: [...this.tracks.values()].map((t) => ({
        track: t.name,
        name: this.names.get(t.name) || null, // attributed participant, when known
        file: t.base,
        mime: t.mime,
        kind: t.kind, // 'audio' | 'video' — call-media-merge.js uses this, not the name
        bytes: t.bytes,
        maxBytes: t.maxBytes, // the cap that was actually applied — see MAX_TRACK_BYTES_BY_KIND
        chunks: t.chunks,
        startWallClock: t.startWallClock, // absolute wall-clock ms at the track's t=0
        startOffsetMs: t.startOffsetMs,   // coarse cross-check (chunk arrival at main)
        seqGaps: t.seqGaps,
        capped: t.capped,
      })),
    };
  }
}

module.exports = { CallRecordingSession, MAX_TRACK_BYTES_BY_KIND, DEFAULT_MAX_TRACK_BYTES, CAP_WARN_RATIO };
