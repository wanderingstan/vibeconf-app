# Recorded call corpora (not in git)

Audio corpora live outside the repo — they are hundreds of megabytes and some
are private. This file is the index, so the material is findable without
guessing at paths.

## echo-speakers-2026-08-17 — humans on SPEAKERS

`~/Developer/vibeconf-corpus/echo-speakers-2026-08-17/` · 247 MB · call
`wcj-odpo-wrb-20260817T223239Z`, 54 min, jimmy bot + Stan + Seth (+Pepper).

**The only corpus that can exercise #378.** Stan and Seth were on laptop
speakers, so the bot's own voice could return through their microphones. A
replay rig cannot produce this: replayed audio is injected into a virtual
microphone and never crosses a speaker-to-microphone path, so the failure is
structurally absent from every synthetic run.

Holds per-participant audio (one track per speaker plus the bot's own outgoing
audio — the echo source), 278k raw detector events from the #422 capture, the
session log, and `manifest.json` whose `startWallClock` aligns audio samples to
event timestamps.

Two findings already, written up in that folder's README:

- Meet's AEC removes the echo from what it transmits. Correlating the bot's
  audio against each remote track finds none (−0.09), and the remote tracks are
  5-6x quieter while the bot talks. Whatever lights up a speaking indicator
  during our TTS, it is not audible echo in the stream we receive.
- No indicator ever lit up in an audibly silent room. Of 838 verdict rises, four
  landed during our own TTS, and at every one a remote track was loud (−13 to
  −16 dB against a −89 dB floor). That removed the blanket echo guard (#432): it
  was withholding interruptions to prevent something the recording does not
  contain.

⚠️ **Do not make per-person claims from the tracks.** Meet reassigns
participants between WebRTC tracks mid-call, and the track→name attribution
(#209) votes using the DOM speaking signal — circular for the questions this
corpus answers. That call recorded four participants onto three tracks, labelled
Stan / Seth / Stan, with none for Pepper. An earlier "one echo-driven false rise
in 54 minutes" figure trusted those labels and has been **retracted**. The
corpus carries the same warning beside the audio, in
`call-recording-tracks/READ-THIS-FIRST.md`.

## Adding to this index

Anything worth re-analysing later: keep the whole call directory (minus
`video.webm`), and write a README beside it saying what condition it captures
and what has already been measured from it. A corpus nobody can interpret is
just disk usage.
