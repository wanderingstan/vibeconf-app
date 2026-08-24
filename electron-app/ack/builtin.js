// ack/builtin.js — current hardcoded acknowledgement logic, extracted as a
// pluggable provider. Wordcount thresholds + random pick from phrase pools.
//
// Inputs (from the dispatcher):
//   text             — the user's transcribed utterance
//   wordCount        — convenience, already computed
//   addressivity     — 'me' | 'me-1on1' | 'unspecified' (never 'other' here,
//                      the dispatcher filters that case)
//   mode             — bot mode (active | passive | silent)
//   recentTranscript — last few transcript entries, ignored here but part of
//                      the contract for future providers
//   complete         — does the utterance look like a FINISHED thought?
//                      (completeness.js; the dispatcher computes it)
//   prefs            — { ackShortMin, ackLongMin, ackShortPhrases, ackLongPhrases }
//
// Returns: a phrase string to TTS, or null to skip the ack.

// The two pools are not the same KIND of thing, which the word-count-only
// version missed.
//
// A short ack ("Mm.", "Right.") is backchannel: it claims nothing about whose
// turn it is, so it is safe at any moment. A long ack ("Let me think about
// that.", "Just a sec, processing.") asserts that the speaker has FINISHED and
// the bot is now going away to answer. Word count cannot support that claim —
// it only says how long someone has been talking, not whether they have
// stopped.
//
// Observed live 2026-08-24: a 65-word turn drew "Just a sec, processing." from
// the long pool while Stan was mid-sentence. Correct by the old rule, and it
// read as the bot interrupting to announce his turn was over.
//
// So the long pool now needs BOTH: long enough to warrant more than a murmur,
// AND an utterance that actually looks finished. Falling back to the short pool
// is the right failure — a murmur into a continuing sentence is what a person
// listening would do anyway.
function decide({ wordCount, complete, prefs }) {
  const { ackShortMin, ackLongMin, ackShortPhrases, ackLongPhrases } = prefs;
  if (wordCount >= ackLongMin && complete) {
    return ackLongPhrases[Math.floor(Math.random() * ackLongPhrases.length)];
  }
  if (wordCount >= ackShortMin) {
    return ackShortPhrases[Math.floor(Math.random() * ackShortPhrases.length)];
  }
  return null;
}

module.exports = { decide };
