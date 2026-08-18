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
// SEPARATION — AND WHAT IT IS NOT. The tracks are not one shared mix: measured
// (#209), remote tracks in a 3-party call came out with near-zero energy
// cross-correlation. That much holds.
//
// It was then written here that "Meet DOES hand each remote participant its own
// WebRTC track". THAT CLAIM IS WITHDRAWN — the correlation test cannot support
// it. Speaker SLOTS, where Meet forwards whoever is currently talking into a
// small fixed pool, are equally uncorrelated, because different people occupy
// them at different times. The evidence could never distinguish the two.
//
// The 2026-08-17 call (54 min, kept as a corpus — see tests/fixtures/CORPUS.md)
// points at slots:
//   - FOUR participants recorded onto THREE remote tracks, and the fourth
//     (Pepper) spoke throughout while having no track of her own.
//   - The three tracks are almost mutually exclusive: only 1.2-1.5% of their
//     combined active time overlaps, and all three are never active at once.
//     Three independent speakers should overlap MORE than a pair, yet real
//     two-person calls in the other corpus overlap 4.6% and 16.3%. This looks
//     like one conversation handed between three channels.
//
// Treat a track as "audio from somebody" and nothing more. Attribution by name
// (the manifest's `names`, from the #209 DOM voting) is a best guess that also
// votes on the DOM speaking signal, so it must never be used to validate that
// signal. Anything of the form "X was speaking" needs a source we do not have
// yet; "some remote track was loud" is sound and is usually enough.
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

// #343: how often chunk() may refresh manifest.json. The fields that make a
// recording RECOVERABLE (each track's startWallClock) are fixed the moment a
// track is created and are written then, unthrottled — this interval only keeps
// the running bytes/chunks counts roughly current, which nothing depends on for
// recovery. Slow on purpose: chunks arrive every second per track, and there is
// no reason to rewrite the file that often.
const MANIFEST_REFRESH_MS = 15000;

// Dropped in the recording directory at start, removed once every merge has
// succeeded. See _writeRecoveryNote().
const RECOVERY_NOTE = 'RECOVERY.md';

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
    this._lastManifestWrite = 0;
    fs.mkdirSync(dir, { recursive: true });
    this._writeRecoveryNote();
  }

  // Attribution: the renderer votes track -> participant name (via Meet's DOM
  // active-speaker events) and sends the current best guess as it firms up.
  // Stored live so the manifest has it even if stop() races the last vote.
  setName(track, name) {
    if (this.closed || !track || !name) return;
    const prev = this.names.get(String(track));
    this.names.set(String(track), String(name));
    // #343: attribution should survive a crash too. Only on an actual change,
    // and still throttled — the renderer re-sends its current best guess as the
    // vote firms up, so most calls here set the same name again.
    if (prev !== String(name) && Date.now() - this._lastManifestWrite >= MANIFEST_REFRESH_MS) {
      this._writeManifest();
    }
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
      // #343: unthrottled, because this is the moment startWallClock becomes
      // known and a crash one second later would otherwise lose it forever.
      this._writeManifest();
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
    // Keep the on-disk counts roughly current (#343). Throttled hard — see
    // MANIFEST_REFRESH_MS for why this one doesn't need to be prompt.
    if (Date.now() - this._lastManifestWrite >= MANIFEST_REFRESH_MS) this._writeManifest();
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

  // Write manifest.json NOW, rather than only at stop() (#343).
  //
  // The manifest is not just an index of filenames: each track's startWallClock
  // is the only thing that time-aligns the tracks to each other and to the
  // transcript, it lives in memory, and the webm files' own timestamps start at
  // t=0 rather than at wall clock. So if the process died before stop() ran, the
  // recording was not merely unmerged, it was UNRECOVERABLE — both recovery
  // paths (scripts/finish-call-recording.mjs, scripts/merge-call-audio.mjs)
  // require a manifest, and no offline tool could reconstruct one.
  //
  // Cheap enough to do repeatedly: a small JSON blob, and the values that matter
  // most for recovery are fixed when a track is created, which is exactly when
  // this is called (plus a slow throttle from chunk() to keep byte counts roughly
  // current). Best-effort by design: a recording must never stop because a
  // bookkeeping write failed.
  _writeManifest() {
    try {
      fs.writeFileSync(path.join(this.dir, 'manifest.json'), JSON.stringify(this.manifest(), null, 2));
      this._lastManifestWrite = Date.now();
    } catch { /* dir may be gone in a teardown race — the track files still exist */ }
  }

  // A plain-text note dropped in the recording directory saying what these files
  // are and how to finish them by hand (#343). Its PRESENCE is the signal: the
  // normal path removes it once every merge has succeeded, so a tracks directory
  // that still has one is a recording that never completed.
  //
  // This is what covers the exits no teardown handler can: a crash, a force
  // quit, power loss. Before it, those left a folder of orphan webm files with
  // nothing to explain them.
  _writeRecoveryNote() {
    const finalized = this.closed;
    const body = `# Unfinished call recording

This folder holds the raw per-track capture for a call${this.callId ? ` (\`${this.callId}\`)` : ''}${this.room ? ` in room \`${this.room}\`` : ''}, recorded ${new Date(this.startedAt).toISOString()}.

**This file existing means the recording never fully completed.** The app removes
it once the merge has succeeded, so if you are reading it, one of these happened:

- the app quit, crashed, or lost power mid-recording
- the merge into \`.mp4\` failed, was cancelled, or was skipped (no ffmpeg installed,
  or no video was captured)

The raw material is fine either way. Nothing here is corrupt, it just has not
been combined yet.

## Finishing it by hand

Needs \`ffmpeg\` on your PATH. From the repo root:

\`\`\`
node scripts/finish-call-recording.mjs "${this.dir}"
\`\`\`

That produces \`call-recording.mp4\` (and \`call-recording-share.mp4\` if this call
had a whiteboard share) in the parent folder, exactly as the app would have, and
deletes this note on success.

For audio only, plus a subtitle track naming who was speaking:

\`\`\`
node scripts/merge-call-audio.mjs "${this.dir}"
\`\`\`

## What is in here

- \`manifest.json\` — the track index. **Do not delete it**: each track's
  \`startWallClock\` is what aligns the tracks to each other and to the transcript,
  and it cannot be recovered from the media files, whose timestamps start at zero.
- \`*.webm\` — one file per audio track, plus \`video.webm\` (the bot's Meet view)
  and \`share.webm\` (a shared whiteboard) when those were captured.
- \`speaker-events.jsonl\` — who-spoke-when, wall-clock stamped.
${finalized
    ? '\nThe tracks were closed cleanly and the manifest is complete, so only the\nmerge is outstanding.\n'
    : '\nWritten when recording STARTED. If the app is still running and recording,\nthis is expected and the file will be removed when the call finishes.\n'}`;
    try {
      fs.writeFileSync(path.join(this.dir, RECOVERY_NOTE), body);
    } catch { /* best-effort — never block a recording on the note */ }
  }

  // Called once the recording is genuinely done: tracks finalized AND every
  // merge that was attempted succeeded. Only main.js knows that, hence a public
  // method rather than something stop() could decide on its own.
  removeRecoveryNote() {
    try { fs.rmSync(path.join(this.dir, RECOVERY_NOTE), { force: true }); }
    catch { /* nothing to clean up */ }
  }

  // Finalize: close every file and write the manifest. Idempotent.
  //
  // Everything here is SYNCHRONOUS on purpose (#343): closeSync + writeFileSync,
  // no merge, no awaits. That is what lets 'before-quit' finalize a recording
  // inline without holding up the quit. The expensive part, ffmpeg, is the
  // caller's problem and is what the recovery note exists to defer.
  stop() {
    if (this.closed) return this.manifest();
    this.closed = true;
    this.endedAt = Date.now();
    for (const t of this.tracks.values()) {
      try { fs.closeSync(t.fd); } catch { /* already closed */ }
    }
    if (this._speakerFd) { try { fs.closeSync(this._speakerFd); } catch { /* already closed */ } this._speakerFd = null; }
    const m = this.manifest();
    this._writeManifest();
    this._writeRecoveryNote(); // rewritten: tracks are closed, only the merge is left
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

module.exports = {
  CallRecordingSession, MAX_TRACK_BYTES_BY_KIND, DEFAULT_MAX_TRACK_BYTES, CAP_WARN_RATIO,
  MANIFEST_REFRESH_MS, RECOVERY_NOTE,
};
