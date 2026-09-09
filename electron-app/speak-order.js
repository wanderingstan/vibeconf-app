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

// Mentioned bots, ORDERED BY WHERE THEY WERE MENTIONED — latest first.
//
// This used to return them in roster order, which threw away the one piece of
// information that decides the case it exists for. Stan, 2026-09-09:
//
//     "ok Jimmy that's enough about the PR. Alice, what were you saying?"
//
// Both bots are named, so both scored the same bonus and the hash broke the
// tie: measured on this module, Jimmy — who had just been told to stop —
// answered 55% of the time.
//
// A later mention supersedes an earlier one. That is how the sentence works:
// the first name is usually being closed off ("thanks Jimmy", "Jimmy, hold on")
// and the last is the one being handed the floor. Keyed on each bot's LAST
// mention, so "Alice, ... actually Jimmy, ... no, Alice" resolves to Alice.
function mentionedBots(text, botNames) {
  const hay = String(text || '');
  return (botNames || [])
    .map((n) => ({ n, at: lastMentionIndex(hay, n) }))
    .filter((e) => e.at >= 0)
    .sort((a, b) => b.at - a.at)          // latest mention first
    .map((e) => e.n);
}

// Index of the LAST whole-word occurrence of `name`, or -1. Whole-word for the
// same reason nameMentioned is: a substring test fires on "array" for a bot
// called Ray, which was tolerable when a mention only woke a bot slightly early
// and is not now that it decides who answers.
function lastMentionIndex(text, name) {
  const n = String(name || '').trim();
  if (!n) return -1;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'giu');
  let last = -1, m;
  while ((m = re.exec(text)) !== null) {
    last = m.index;
    if (re.lastIndex <= m.index) re.lastIndex = m.index + 1;   // never stall
  }
  return last;
}


// THE SEED: what all the bots agree on, without exchanging anything.
//
// The original seed was the utterance — speaker plus the first 8 words. That is
// CONTENT, and content has to MATCH across machines. It mostly does, but the
// ways it fails are real and platform-specific: Meet revises caption text as
// its ASR settles (hence hashing only the head, which is a mitigation and not a
// guarantee), and the two bots sample it at different instants — a collision is
// evaluated ~1.5s apart, because each bot's barge-in grace is scaled from its
// OWN urgency. Zoom and Teams have their own caption behaviour, so every one of
// those characterisations would have to be redone per platform.
//
// A clock needs no agreement about content at all. Machines with ordinary NTP
// sit within tens of milliseconds of each other, which is nothing against a
// bucket measured in seconds, and it behaves identically on every platform.
//
// ANCHORED TO THE SILENCE EDGE, NOT TO "NOW". This matters more than the bucket
// size. The moment a human stops talking is a physical event every bot observes
// within the speaking-detection spread (~180ms p90 on the meter); each bot's own
// decision time is not — the start decision runs at speak submission, the yield
// decision at grace expiry up to 1.5s later, and both differ per bot. Seeding
// from "now" would reintroduce precisely the divergence this exists to remove.
//
// THE RESIDUAL RISK IS A BOUNDARY STRADDLE, and it is quantifiable: two bots
// whose observations of the same edge differ by d disagree only when a bucket
// boundary falls between them, with probability d / bucketMs. At d = 180ms and
// a 6s bucket that is ~3%, against a caption seed whose divergence rate is
// unmeasured and platform-dependent — and a disagreement is now bounded by the
// bot-vs-bot safety net rather than running to the end of the utterance.
//
// Bigger buckets mean fewer straddles AND a slower rotation of who wins: the
// permutation is constant within a bucket, so in a rapid exchange the same bot
// can take several turns in a row. That trade is what the bucket size buys.
function clockKey(atMs, bucketMs) {
  const b = Number(bucketMs) > 0 ? Number(bucketMs) : 6000;
  return `t${Math.floor(Number(atMs) / b)}`;
}

// Being named gets you priority IN LINE WITH the hash, not instead of it: a
// bonus, so bots nobody named still order deterministically among themselves.
//
// `mentioned` arrives latest-mention-first, so the bonus falls off with
// position: the bot named LAST outranks one named earlier in the same sentence,
// and both outrank anyone not named at all. A sole mention is trivially also
// the last, so the old "unambiguous direct address wins" case is unchanged —
// it is now a consequence of the ordering rather than a separate rule.
//
// The hash still breaks ties between equally-placed bots, which now means only
// bots nobody named.
function mentionBonus(bot, mentioned) {
  const i = (mentioned || []).indexOf(bot);
  return i < 0 ? 0 : mentioned.length - i;
}

// The full ordering, computed identically by every bot.
//
// Ties on the bonus are broken by the hash, which varies per turn — so over a
// conversation the winner rotates uniformly rather than one bot always going
// first, which a static priority (by name, by join order) would produce.
// `seed` overrides the content-derived key (see clockKey above). The mention
// bonus still reads the utterance, deliberately: being addressed by name is the
// one piece of content worth the risk. It is a whole-word match on a short name
// rather than a hash over a text prefix, so it is far more robust to ASR
// revision — and a scheduler that cannot hear "Alice, what do you think?" is
// worse than one that occasionally disagrees.
function speakOrder({ botNames, speaker, utterance, seed }) {
  const bots = [...new Set((botNames || []).filter(Boolean))];
  const mentioned = mentionedBots(utterance, bots);
  const key = seed || turnKey(speaker, utterance);
  return bots
    .map((bot) => ({ bot, bonus: mentionBonus(bot, mentioned), tie: hash32(`${key}|${bot.toLowerCase()}`) }))
    .sort((a, b) => (b.bonus - a.bonus) || (a.tie - b.tie) || a.bot.localeCompare(b.bot))
    .map((e, i) => ({ ...e, rank: i }));
}

// What THIS bot should do. gapMs must exceed the time it takes a bot to SEE
// another bot start, or the loser will not have noticed the winner by the time
// its own delay expires and both will speak. Measured (#422): onset p90 is
// ~180ms with the meter signal and ~360-460ms with the mutation counter.
function speakDelay({ selfName, botNames, speaker, utterance, seed, gapMs = 500 }) {
  const order = speakOrder({ botNames, speaker, utterance, seed });
  const mine = order.find((e) => e.bot.toLowerCase() === String(selfName || '').toLowerCase());
  if (!mine) return null;              // not a known bot — caller falls back to jitter
  const mentioned = order.filter((e) => e.bonus > 0).map((e) => e.bot);
  return {
    rank: mine.rank,
    of: order.length,
    delayMs: mine.rank * gapMs,
    mentioned,
    why: `rank ${mine.rank + 1}/${order.length}`
      + (mine.bonus && mentioned.length === 1 ? ' (named alone)'
        : mine.bonus === mentioned.length ? ' (named last)'
        : mine.bonus ? ' (named, but not last)' : '')
      + (mentioned.length && !mine.bonus ? ` — ${mentioned.join(', ')} named` : ''),
  };
}


// WHO STOPS when two bots are already talking at once.
//
// The header above states the rule and then nothing implemented it: "they
// detect each other within ~180ms and the yield rule is already common
// knowledge: higher rank stops." In the app that branch instead drew a SECOND
// random delay and backed off if the collision outlasted it (#573) — so a
// collision the ordering could have resolved in one comparison was handed back
// to the coin flip the ordering exists to replace, and the cost was measured:
// 1500ms grace + up to 3000ms random is up to 4.5s of two bots talking BY
// DESIGN, against observed overlaps of 4.5s and 3.4s on 2026-08-26.
//
// The comparison uses the same order every bot already computed for the same
// turn, so both sides of a collision reach the complementary answer without
// exchanging anything: the lower rank keeps the floor, the higher rank stops
// immediately instead of after a random wait.
//
// Returns null when the question cannot be answered — self not in the set, or
// no interrupter recognised — which is the caller's signal to keep today's
// behaviour rather than guess.
function yieldsTo({ selfName, botNames, speaker, utterance, seed, interrupters }) {
  const order = speakOrder({ botNames, speaker, utterance, seed });
  const rankOf = (name) => {
    const e = order.find((x) => x.bot.toLowerCase() === String(name || '').trim().toLowerCase());
    return e ? e.rank : null;
  };
  const mine = rankOf(selfName);
  if (mine === null) return null;

  const others = [...new Set((interrupters || []).filter(Boolean))];
  if (!others.length) return null;

  // An interrupter we cannot place is NOT evidence that we outrank it. The
  // house rule everywhere else in barge-in is "unknown ⇒ treat as human ⇒
  // yield", and the same caution applies here: claiming the floor against a
  // participant whose rank we could not compute is exactly the case where both
  // bots think they won.
  const unplaced = others.filter((n) => rankOf(n) === null);
  if (unplaced.length) {
    return { yield: true, rank: mine, of: order.length, unplaced,
      why: `cannot rank ${unplaced.join(', ')} — yielding rather than assuming` };
  }

  const ranks = others.map((n) => ({ name: n, rank: rankOf(n) }));
  const ahead = ranks.filter((r) => r.rank < mine);
  if (ahead.length) {
    return { yield: true, rank: mine, of: order.length, ahead: ahead.map((r) => r.name),
      why: `rank ${mine + 1}/${order.length}, behind ${ahead.map((r) => `${r.name} (${r.rank + 1})`).join(', ')}` };
  }
  return { yield: false, rank: mine, of: order.length,
    why: `rank ${mine + 1}/${order.length}, ahead of ${ranks.map((r) => `${r.name} (${r.rank + 1})`).join(', ')}` };
}

module.exports = { hash32, turnKey, clockKey, lastMentionIndex, nameMentioned, mentionedBots, mentionBonus, speakOrder, speakDelay, yieldsTo };
