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
//   prefs            — { ackShortMin, ackLongMin, ackShortPhrases, ackLongPhrases }
//
// Returns: a phrase string to TTS, or null to skip the ack.

function decide({ wordCount, prefs }) {
  const { ackShortMin, ackLongMin, ackShortPhrases, ackLongPhrases } = prefs;
  if (wordCount >= ackLongMin) {
    return ackLongPhrases[Math.floor(Math.random() * ackLongPhrases.length)];
  }
  if (wordCount >= ackShortMin) {
    return ackShortPhrases[Math.floor(Math.random() * ackShortPhrases.length)];
  }
  return null;
}

module.exports = { decide };
