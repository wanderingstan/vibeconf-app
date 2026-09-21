// caption-stall-excuse.js — may the bot's OWN speech explain a caption stall? (#265)
//
// The bot's captions are filtered out of what it hears, so while it talks no
// remote caption text arrives, and the stall detector (STALL_MS = 25s in the
// Meet provider) reads that gap as deafness. The excuse exists for exactly that
// case: a long bot monologue.
//
// The old test was "did the bot speak at ANY point since the last remote
// caption?" — `now - lastSpokeAloudAt < ageMs`. The stall age only grows, so a
// single sentence at minute 1 excused the stall at minute 44. Measured: 2084
// excuses across Stan's logs, swallowing 4 of the 5 real stalls where people
// were talking (incl. 2656s on 2026-08-28), and Taylor's 622s stall on Sep 18
// excused by "a handful of short sentences".
//
// The bot's speech can only account for the time it was speaking, plus however
// long captions reasonably take to resume after it stops. So: excuse while the
// bot is speaking, and for one detector window after it stops — beyond that,
// the silence is not the bot's.
//
// Pure: no electron, no clocks of its own — callers pass `now`.

const OWN_SPEECH_GRACE_MS = 25000; // matches the provider's STALL_MS

function stallExplainedByOwnSpeech({ speakingAloud, lastSpokeAloudAt, now, graceMs = OWN_SPEECH_GRACE_MS }) {
  if (speakingAloud) return true;
  if (!lastSpokeAloudAt) return false;
  return now - lastSpokeAloudAt < graceMs;
}

module.exports = { stallExplainedByOwnSpeech, OWN_SPEECH_GRACE_MS };
