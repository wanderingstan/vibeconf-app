// call-recorder.js — writes per-track call audio to disk, for debugging.
//
// WHY: when a bot "hears nothing" and the call goes red, we have caption
// timeouts but no record of what each mic actually carried. A time-aligned
// audio track per source turns "the bot went deaf, no idea why" into "here is
// the remote track — it was silent" or "it was full of audio the bot never
// captioned". That is the diagnostic the meet-test stalls have been missing.
//
// WHAT IT IS NOT: clean per-HUMAN separation. Google Meet mixes remote audio
// server-side (see page-inject.js AudioCaptureManager) — a "remote-*" track is
// often the whole room, not one person. We record whatever DISTINCT WebRTC
// tracks Meet delivers, plus the bot's own outgoing audio, and label them
// honestly in the manifest. Reliable split today is bot-vs-remote; per-person
// split happens only when Meet actually sends separate tracks.
//
// The renderer (page-inject.js) drives a MediaRecorder per track and streams
// base64 webm/opus chunks here via IPC. MediaRecorder timeslice chunks are NOT
// individually valid but CONCATENATE into a valid streamable webm — the first
// chunk carries the header, the rest are clusters — so each track is simply one
// file we append to in arrival order. `seq` lets us count dropped/out-of-order
// chunks rather than silently corrupt the file.

const fs = require('fs');
const path = require('path');

// A runaway guard, not a real limit: opus at ~24-32kbps is ~3-4 KB/s, so an
// hour is ~15 MB. If a single track blows past this something is wrong (a video
// track slipped in, a stuck recorder) — stop appending and note it rather than
// fill the disk.
const MAX_TRACK_BYTES = 250 * 1024 * 1024;

class CallRecordingSession {
  // dir: per-call output directory (created if missing).
  // meta: { room, botName, startedAt } — startedAt anchors every track's offset.
  constructor(dir, { room = null, botName = null, startedAt = Date.now() } = {}) {
    this.dir = dir;
    this.room = room;
    this.botName = botName;
    this.startedAt = startedAt;
    this.endedAt = null;
    this.closed = false;
    this.tracks = new Map(); // track name -> state
    fs.mkdirSync(dir, { recursive: true });
  }

  _track(name, mime) {
    let t = this.tracks.get(name);
    if (!t) {
      // Never let a track name reach the filesystem unsanitized.
      const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, '_') || 'track';
      const ext = /ogg/i.test(mime || '') ? 'ogg' : 'webm';
      const file = path.join(this.dir, `${safe}.${ext}`);
      t = {
        name, file, base: `${safe}.${ext}`,
        fd: fs.openSync(file, 'w'),
        mime: mime || 'audio/webm',
        bytes: 0, chunks: 0,
        startOffsetMs: Math.max(0, Date.now() - this.startedAt),
        lastSeq: -1, seqGaps: 0,
        capped: false,
      };
      this.tracks.set(name, t);
    }
    return t;
  }

  // Append one MediaRecorder chunk. `buffer` is a Buffer (decoded upstream).
  chunk(name, seq, buffer, mime) {
    if (this.closed || !buffer || !buffer.length) return;
    const t = this._track(name, mime);
    if (t.capped) return;
    if (Number.isInteger(seq)) {
      if (t.lastSeq >= 0 && seq !== t.lastSeq + 1) t.seqGaps++;
      t.lastSeq = seq;
    }
    if (t.bytes + buffer.length > MAX_TRACK_BYTES) {
      t.capped = true;
      return;
    }
    fs.writeSync(t.fd, buffer);
    t.bytes += buffer.length;
    t.chunks++;
  }

  // Finalize: close every file and write the manifest. Idempotent.
  stop() {
    if (this.closed) return this.manifest();
    this.closed = true;
    this.endedAt = Date.now();
    for (const t of this.tracks.values()) {
      try { fs.closeSync(t.fd); } catch { /* already closed */ }
    }
    const m = this.manifest();
    try {
      fs.writeFileSync(path.join(this.dir, 'manifest.json'), JSON.stringify(m, null, 2));
    } catch { /* dir may be gone in a teardown race — the audio files still exist */ }
    return m;
  }

  manifest() {
    return {
      room: this.room,
      botName: this.botName,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      durationMs: (this.endedAt || Date.now()) - this.startedAt,
      note: 'Google Meet mixes remote audio server-side — a "remote-*" track may '
        + 'carry the whole room, not one participant. Reliable split is bot vs remote.',
      tracks: [...this.tracks.values()].map((t) => ({
        track: t.name,
        file: t.base,
        mime: t.mime,
        bytes: t.bytes,
        chunks: t.chunks,
        startOffsetMs: t.startOffsetMs,
        seqGaps: t.seqGaps,
        capped: t.capped,
      })),
    };
  }
}

module.exports = { CallRecordingSession, MAX_TRACK_BYTES };
