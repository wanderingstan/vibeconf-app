# Recorded call corpora (not in git)

Audio corpora live outside the repo — they are hundreds of megabytes and some
are private. This file is the index, so the material is findable without
guessing at paths.

## echo-speakers-2026-08-17 — humans on SPEAKERS

`~/vibeconf-corpus/echo-speakers-2026-08-17/` · 167 MB · call
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
- Echo-driven false rises are RARE: one in 54 minutes on speakers. Three of the
  four rises during bot speech were people genuinely interrupting — which makes
  the blanket 700ms lookback in #421 a trade worth re-deciding on evidence.

## Adding to this index

Anything worth re-analysing later: keep the whole call directory (minus
`video.webm`), and write a README beside it saying what condition it captures
and what has already been measured from it. A corpus nobody can interpret is
just disk usage.
