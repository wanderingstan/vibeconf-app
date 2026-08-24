// addressable-name.js — can a bot actually be CALLED this?
//
// A bot's name is not decoration. Name-mention detection is how it knows it is
// being spoken to — in passive mode it is the ONLY thing that wakes it — and
// that detection runs over Google Meet's captions. So a name has to survive
// being said out loud and coming back as text.
//
// This exists for adopting an existing Claude session as a bot (its session
// name is the user's own word for the thing, so it beats a random one) — but
// session names are not chosen with speech in mind. "pr-482-refactor" is a
// perfectly good session name and a hopeless bot name: nobody says it aloud,
// and the captions would render the digits inconsistently anyway.
//
// Deliberately conservative. A false NO costs a random name from the pool,
// which is fine. A false YES ships a bot that never answers to itself, and the
// user has no way to tell why.

// Longer than any name someone shouts across a call, short enough to read on a
// Meet tile.
const MAX_WORDS = 2;
const MAX_LENGTH = 24;
const MIN_LENGTH = 2;

// Letters, plus the joiners that survive being spoken: an apostrophe or hyphen
// inside a name ("O'Brien", "Jean-Luc") is said, not spelled. Digits are not
// here on purpose — see above.
const WORD = /^[A-Za-z][A-Za-z'-]*$/;

// Words that are not a name even when they look like one. A bot called "Bot" or
// "Agent" cannot be distinguished from someone saying the ordinary word.
const NOT_A_NAME = new Set([
  'bot', 'agent', 'session', 'claude', 'assistant', 'ai', 'the', 'a', 'an',
  'test', 'temp', 'tmp', 'new', 'default', 'untitled', 'unnamed', 'main',
]);

function isAddressableBotName(raw) {
  const name = String(raw ?? '').trim();
  if (name.length < MIN_LENGTH || name.length > MAX_LENGTH) return false;
  const words = name.split(/\s+/);
  if (words.length > MAX_WORDS) return false;
  for (const w of words) {
    if (!WORD.test(w)) return false;
    if (NOT_A_NAME.has(w.toLowerCase())) return false;
  }
  return true;
}

module.exports = { isAddressableBotName, MAX_WORDS, MAX_LENGTH, MIN_LENGTH };
