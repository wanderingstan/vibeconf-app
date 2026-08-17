// speak-order.js — who speaks first when several bots want the floor.
//
// THE PROBLEM. Bots in one call share the same trigger: the same human stops
// talking, the same silence threshold fires, and every bot decides to answer at
// the same instant. #230 addressed this with random jitter — each bot waits
// 0-N ms before speaking — but jitter is a private coin flip, so separation is
// only probabilistic and is paid for in latency by everyone, every turn.
//
// The arithmetic (#100): two draws from U(0,N) separate by more than the
// detection time D with probability (1 - D/N)^2. With D measured at ~180ms p90
// (#422) and today's N=2000, ~17% of collisions survive AND every bot pays a
// mean 1000ms. Halving the collisions means doubling the delay. There is no
// setting of N that is both fast and reliable.
//
// THE FIX: STOP FLIPPING PRIVATE COINS. Every bot already knows the same
// things — the roster, and the utterance it is answering (Meet gives all
// participants the same captions). So let every bot compute the SAME ordering
// from that shared knowledge. No messages, no negotiation, no server:
//
//     rank = (mention bonus, hash(turnKey, botName))
//     delay = rank * GAP
//
// The winner speaks IMMEDIATELY — zero added latency, where jitter charged
// everyone ~1000ms — and the others wake one GAP apart and find the floor
// already busy, which the existing floorBusy check in _speakWithBotJitter
// handles exactly as it handles a human speaking. That also solves abstention
// for free: if the winner turns out to have nothing to say, the next bot finds
// the floor open and takes it a GAP later.
//
// WHAT MAY AND MAY NOT ENTER THE KEY. Only inputs every bot computes
// identically. The roster and the utterance qualify. URGENCY DOES NOT: a bot
// cannot know what the others are about to say or how urgent they think it is,
// so mixing its own urgency into the ordering desynchronises it and every bot
// computes a different winner. Urgency needs an actual exchange of intent
// (a server auction) and is deliberately absent here.
//
// WHEN BOTS DISAGREE — different caption text, a roster that has not converged —
// two may claim rank 0 and both start. They then detect each other within
// ~180ms and the yield rule is already common knowledge: higher rank stops.
// The failure is bounded and self-correcting, which is more than jitter offers.

// FNV-1a, 32-bit. Hand-rolled on purpose: every bot must compute the same value
// from the same string, so this cannot depend on a Node version, a locale, or a
// hash seed that varies per process (which is exactly what Object key order and
// some built-in hashes do).
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// The shared seed for one turn.
//
// Uses the FIRST few words, not the whole utterance: Meet refines caption text
// as its ASR settles and the TAIL moves most, so hashing everything would have
// bots keying on different strings depending on when they sampled. By the time
// the silence threshold fires (1.4s) the head has long stabilised.
function turnKey(speaker, text, { words = 8 } = {}) {
  const norm = String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')     // punctuation drifts with ASR revisions
    .split(/\s+/).filter(Boolean)
    .slice(0, words)
    .join(' ');
  return `${String(speaker || '').trim().toLowerCase()}|${norm}`;
}

// Whole-word name match. A substring test (what the mention check has used
// until now) fires on "array" for a bot called Ray — tolerable when a mention
// only woke a bot slightly early, not tolerable now that it decides who speaks.
function nameMentioned(text, name) {
  const n = String(name || '').trim();
  if (!n) return false;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu').test(String(text || ''));
}

function mentionedBots(text, botNames) {
  return (botNames || []).filter((n) => nameMentioned(text, n));
}

// Being named gets you priority IN LINE WITH the hash, not instead of it: a
// bonus, so several bots can be named at once and still order deterministically
// among themselves.
//
// Sole mention outranks one-of-several because it is an unambiguous direct
// address — "Alice, what do you think?" should not be answered by Jimmy.
function mentionBonus(bot, mentioned) {
  if (!mentioned.length || !mentioned.includes(bot)) return 0;
  return mentioned.length === 1 ? 2 : 1;
}

// The full ordering, computed identically by every bot.
//
// Ties on the bonus are broken by the hash, which varies per turn — so over a
// conversation the winner rotates uniformly rather than one bot always going
// first, which a static priority (by name, by join order) would produce.
function speakOrder({ botNames, speaker, utterance }) {
  const bots = [...new Set((botNames || []).filter(Boolean))];
  const mentioned = mentionedBots(utterance, bots);
  const key = turnKey(speaker, utterance);
  return bots
    .map((bot) => ({ bot, bonus: mentionBonus(bot, mentioned), tie: hash32(`${key}|${bot.toLowerCase()}`) }))
    .sort((a, b) => (b.bonus - a.bonus) || (a.tie - b.tie) || a.bot.localeCompare(b.bot))
    .map((e, i) => ({ ...e, rank: i }));
}

// What THIS bot should do. gapMs must exceed the time it takes a bot to SEE
// another bot start, or the loser will not have noticed the winner by the time
// its own delay expires and both will speak. Measured (#422): onset p90 is
// ~180ms with the meter signal and ~360-460ms with the mutation counter.
function speakDelay({ selfName, botNames, speaker, utterance, gapMs = 500 }) {
  const order = speakOrder({ botNames, speaker, utterance });
  const mine = order.find((e) => e.bot.toLowerCase() === String(selfName || '').toLowerCase());
  if (!mine) return null;              // not a known bot — caller falls back to jitter
  const mentioned = order.filter((e) => e.bonus > 0).map((e) => e.bot);
  return {
    rank: mine.rank,
    of: order.length,
    delayMs: mine.rank * gapMs,
    mentioned,
    why: `rank ${mine.rank + 1}/${order.length}`
      + (mine.bonus === 2 ? ' (named alone)' : mine.bonus === 1 ? ' (named)' : '')
      + (mentioned.length && !mine.bonus ? ` — ${mentioned.join(', ')} named` : ''),
  };
}

module.exports = { hash32, turnKey, nameMentioned, mentionedBots, mentionBonus, speakOrder, speakDelay };
