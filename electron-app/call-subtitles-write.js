// call-subtitles-write.js — the fs half of subtitles.js: read a recording's
// captions.jsonl, work out the media's t=0, and drop .srt / .vtt beside the
// merged mp4.
//
// Split from subtitles.js so the cue logic stays pure and testable, and so
// scripts/build-subtitles.mjs can regenerate sidecars for an old recording
// (the tracks dir is kept when keepCallRecordingTracks is on) without pulling
// in any of main.js.
//
// THE ANCHOR. call-recording.mp4's t=0 is the VIDEO track's startWallClock,
// not the session's startedAt: the merge muxes audio straight onto video.webm
// with no delay alignment, so the picture's first frame is the output's zero.
// startedAt is when the session object was constructed, which is earlier by
// however long it took the capture window to open and MediaRecorder to start —
// a second or two, enough to visibly desync subtitles. Only fall back to
// startedAt when there is no video track at all.

'use strict';

const fs = require('fs');
const path = require('path');
const { buildCues, renderSrt, renderVtt, parseCaptionLog } = require('./subtitles.js');

// Returns the absolute wall-clock ms that the merged media's t=0 corresponds
// to, or null when the manifest can't say.
function resolveAnchorMs(manifest) {
  const tracks = Array.isArray(manifest?.tracks) ? manifest.tracks : [];
  const video = tracks.find((t) => t && t.track === 'video');
  if (video && Number.isFinite(video.startWallClock)) return video.startWallClock;
  // No video track means no merged mp4 either, so this is mostly for
  // audio-only reprocessing. startedAt is the best available zero.
  if (Number.isFinite(manifest?.startedAt)) return manifest.startedAt;
  return null;
}

// tracksDir: call-recording-tracks<suffix>/ — holds captions.jsonl + manifest.json
// outDir:    where the sidecars land (the call dir, beside the mp4)
// baseName:  output stem, e.g. 'call-recording-2' -> call-recording-2.srt/.vtt
// offsetMs:  shift applied to every cue (negative pulls them earlier)
//
// Best-effort by contract: every failure returns { ok:false, reason } rather
// than throwing. A subtitle file is a nicety; it must never be the reason a
// recording's cleanup path blows up.
function writeSubtitleSidecars({
  tracksDir,
  outDir,
  baseName = 'call-recording',
  manifest = null,
  offsetMs = 0,
  durationMs = null,
  title = null,
} = {}) {
  try {
    const captionFile = path.join(tracksDir, 'captions.jsonl');
    if (!fs.existsSync(captionFile)) {
      return { ok: false, reason: 'no captions.jsonl (captions off, or nobody spoke)' };
    }
    let man = manifest;
    if (!man) {
      try { man = JSON.parse(fs.readFileSync(path.join(tracksDir, 'manifest.json'), 'utf8')); }
      catch { man = null; }
    }
    const anchorMs = resolveAnchorMs(man);
    if (anchorMs == null) {
      return { ok: false, reason: 'no startWallClock in manifest — cannot place cues on the timeline' };
    }

    const entries = parseCaptionLog(fs.readFileSync(captionFile, 'utf8'));
    if (!entries.length) return { ok: false, reason: 'captions.jsonl is empty' };

    // Prefer the manifest's own duration over a caller's guess — it's measured.
    let dur = Number.isFinite(durationMs) ? durationMs : null;
    if (dur == null && Number.isFinite(man?.durationMs) && man.durationMs > 0) {
      dur = man.durationMs - Math.max(0, anchorMs - (man.startedAt ?? anchorMs));
    }

    const cues = buildCues(entries, { anchorMs, durationMs: dur, offsetMs });
    if (!cues.length) return { ok: false, reason: 'no captions fell inside the recording' };

    const srtPath = path.join(outDir, `${baseName}.srt`);
    const vttPath = path.join(outDir, `${baseName}.vtt`);
    fs.writeFileSync(srtPath, renderSrt(cues));
    fs.writeFileSync(vttPath, renderVtt(cues, { title }));
    return { ok: true, cues: cues.length, srt: srtPath, vtt: vttPath };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = { writeSubtitleSidecars, resolveAnchorMs };
