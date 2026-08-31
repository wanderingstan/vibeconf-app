# Etiquette fixtures — real audio from real failures

## `interrupt-2026-08-30-30s.mp3`

**28 seconds of Stan being talked over, taken from the call where it happened.**

Extracted from `remote-participant-1.webm` of call `vph-sbmo-uic-20260830T203346Z`
(offset 2057.3s, i.e. 15:08:12 local — 34m26s into the call). Attribution for
that track: `Stan James`, 242 segments.

It is him saying, with rising volume: *"Jimmy, Jimmy stop… this is awkward…
AWKWARD. JIMMY. STOP… HOLY HELL! JIMMY YOU JUST TALKED OVER ME FOR LIKE 30
SECONDS."* The bot kept talking through all of it.

### Why a recording rather than a synthesised clip

**Because the synthesised clips pass.** The suite already had a `no-talk-over`
rule using looped `test-speech.mp3`, and it was green on the build that did this.
The failure is not "the bot ignores audio"; it is a specific interaction between
the analyser and *this shape* of speech.

From the session log, this is what the detector made of him:

```
15:08:13.401 speech ON      15:08:13.792 speech OFF     (391ms)
15:08:14.921 speech ON      15:08:15.614 speech OFF     (693ms)
15:08:17.089 speech ON      15:08:17.760 speech OFF     (671ms)
15:08:20.761 speech ON      15:08:21.113 speech OFF     (352ms)
15:08:21.364 speech ON      15:08:21.850 speech OFF     (486ms)
15:08:25.238 speech ON      15:08:25.829 speech OFF     (591ms)
15:08:28.201 speech ON      15:08:28.683 speech OFF     (482ms)
```

Continuous shouting, rendered as 350–700ms bursts with 200–660ms gaps — because
an angry person saying "Jimmy. STOP." leaves real silence between words, and a
falling edge is read as having stopped. **And `[barge-in] armed` appears zero
times in that entire window.** The monitor never armed, so nothing was ever
considering yielding. See #487 and Stan's own summary on it: *a falling edge is
evidence that the meter fell, nothing more.*

Measured on the clip itself: 53% voiced, peak −5.3dB, voiced runs separated by
gaps of 0.21–0.66s. That gap distribution is the fixture's whole point, and it is
why `silenceremove`-style gapless clips cannot substitute for it.

### On using a colleague's voice as a test fixture

Stan proposed this and it is his own voice, in a private repo, from a call he
hosted. Worth stating anyway: don't add recordings of other people without
asking, and don't move this one somewhere public.
