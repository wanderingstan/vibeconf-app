// tts-chunking.js — sentence-chunked TTS split (#372).
//
// Splitting a reply lets speakText synthesize+play the first sentence while
// the rest synthesizes, so first-audio latency stops scaling with reply
// length (measured pre-fix: whole-reply synth 1.2s avg / 6.3s max — the
// long-answer dead air came entirely from this). Pure function, no deps.

// Returns [text] (no split) or [firstSentence, rest]. Conservative: only
// splits when both halves are substantial — short replies gain nothing, and
// a tiny fragment ("Okay.") costs an extra synth call for no win.
function splitForTts(text) {
  const t = String(text || '');
  if (t.length < 120) return [t];
  // First sentence end at/after char 25: . ! ? (optionally a closing quote/
  // paren) followed by whitespace. The 25-char floor skips abbreviation-ish
  // early periods ("Dr. Smith", "e.g. this") more often than not without a
  // dictionary; a wrong split just costs a slightly odd audio seam.
  const m = /[.!?]["')\]]?\s+/.exec(t.slice(25));
  if (!m) return [t];
  const cut = 25 + m.index + m[0].length;
  const first = t.slice(0, cut).trim();
  const rest = t.slice(cut).trim();
  if (!first || rest.length < 30) return [t];
  return [first, rest];
}

module.exports = { splitForTts };
