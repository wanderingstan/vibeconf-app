// utterance.js — one record per audible thing the bot emits (#493).
//
// WHY THIS EXISTS. Five call sites emitted audio, and each re-implemented the
// same preamble by hand: set the urgency the barge-in grace scales from, set
// botState, call onBotSpeech. Two of the five forgot the urgency line, so a
// probe was graded with whatever urgency the PREVIOUS utterance had scored and
// _armBargeIn scaled its grace from that stale number. That is #367 — "fixed"
// once by adding the assignment to the paths someone remembered at the time.
//
// The bug is not the missing lines. It is that with N emit sites a fix is a fix
// PER SITE, and the bug count grows as gates × paths. Nothing anywhere even
// said how many paths existed.
//
// So: every emission becomes a record with DECLARED properties, and the gates
// read the declaration rather than inferring policy from which function the
// audio happened to come out of. Adding a gate is then one edit, not five.
//
// This module is deliberately pure — no server state, no clock of its own — so
// the policy it encodes can be tested without booting a call.

// Where an utterance came from. Provenance is for logs and the one-shot agent
// surfaces; it must NOT be what policy keys on. That is the whole point.
const SOURCES = ['speak', 'pending-flush', 'stash-replay', 'probe', 'auto-leave'];

// Resume is NOT universal, and the current split (freshly composed vs replayed)
// is arbitrary — it describes where the audio came from, not whether finishing
// it late is a good idea. An ack or a probe cut off mid-word should die: "Mm-hmm"
// delivered two seconds late is worse than silence. Composed speech is worth
// finishing. So resumability becomes a declared property whose DEFAULT happens
// to vary by source, and any caller may override it per record.
const RESUMABLE_BY_SOURCE = {
  'speak': true,
  'pending-flush': true,
  'stash-replay': true,
  'probe': false,
  'auto-leave': false,
};

// The floor gate does not apply to this audio: it starts regardless of who is
// talking. Today that idea exists as bargeInAckExempt (short acks) and, for the
// goodbye, as no gate at all — the auto-leave line simply never consulted the
// floor because it was written before the floor existed. One property, not two
// half-measures and an omission.
const EXEMPT_BY_SOURCE = {
  'auto-leave': true,
};

// #493 decision 5: the 0..1 scalar has not earned its keep, but the LINE AT 0.5
// has. Across 1000 barge-in arms, 92% of scores were 0.4 or 0.5 and the
// "urgency-scaled grace" resolved to exactly two numbers in practice — so the
// continuum is fiction. But 150 ack decisions were blocked by urgency < 0.5 and
// 15 played over live speech, which is a real distinction ("is this worth
// interrupting a person for?") wearing an over-engineered type.
//
// So the record carries BOTH: `interrupts`, the reduced boolean, for the gate
// that actually has the threshold; and `urgency`, the raw scalar, which the
// grace scaling still reads until an experiment shows it is droppable. The
// scalar survives at the MCP boundary either way, so speak(urgency:) and the
// prompt guidance are unaffected.
//
// Unscored → the 0.5 midpoint, the same convention _graceForCurrentUtterance
// uses, so an agent that never passes urgency keeps its acks.
function reduceUrgency(urgency, minUrgency) {
  const u = typeof urgency === 'number' ? urgency : 0.5;
  if (!Number.isFinite(minUrgency) || minUrgency <= 0) return true;
  return u >= minUrgency;
}

// Build one utterance record. Everything the gates need is on it; nothing the
// gates need is implied by the call site.
function makeUtterance({
  text,
  voice,
  emoji,
  urgency,
  source = 'speak',
  exempt,
  resumable,
  staleWhen,
  interrupts,
  at,
  deliveredWords,
} = {}) {
  if (!text) return null;
  const src = SOURCES.includes(source) ? source : 'speak';
  return {
    text,
    voice,
    emoji,
    // 0..1 or null. Null is meaningfully different from 0.5: it means UNSCORED,
    // and the midpoint convention is applied by the reader, not baked in here.
    urgency: typeof urgency === 'number' ? urgency : null,
    // Reduced at submission (decision 5). Callers that have already run the
    // richer ack-exemption arithmetic pass the answer in.
    interrupts: typeof interrupts === 'boolean' ? interrupts : reduceUrgency(urgency, NaN),
    exempt: typeof exempt === 'boolean' ? exempt : (EXEMPT_BY_SOURCE[src] || false),
    resumable: typeof resumable === 'boolean' ? resumable : RESUMABLE_BY_SOURCE[src],
    // A predicate, not a number — see defaultStaleWhen. Null means "never goes
    // stale", which is right for anything that plays immediately.
    staleWhen: typeof staleWhen === 'function' ? staleWhen : null,
    source: src,
    // When the thought was COMPOSED, not when it was last held. A re-hold that
    // restamped this would let a reply outlive the age guard indefinitely, one
    // hold at a time.
    at: typeof at === 'number' ? at : Date.now(),
    // #350: the room heard us START saying this. Affects the text that gets
    // re-queued; it is a field, not a separate code path.
    deliveredWords: typeof deliveredWords === 'number' ? deliveredWords : 0,
  };
}

// #493 decision 2: unify the MECHANISM, not the signal.
//
// The instinct is to collapse "how old is it" and "how much was said over it"
// into one number. That does not survive the data. Across 220 held replies
// carrying both signals the correlation was r = 0.61 — correlated, but nowhere
// near proxies, and the disagreements are the whole point:
//
//   • 10 replies waited 16-30s with ZERO new words. Time passed; nothing was
//     said; nothing went stale. (25.6s/0w, 29.5s/0w, 28.0s/0w)
//   • 6 replies waited <=5s while 15-40 words landed on top of them. Stale in
//     three seconds. (3.1s/17w, 4.2s/40w, 3.9s/31w)
//
// A single scalar cannot express both, and picking either alone throws away a
// real case. What unifies is the evaluation point: ONE predicate, consulted in
// ONE place, whose default implementation reads both signals.
//
// Returns null when fresh, or { reason, note, signal } describing the discard.
// `reason` is the agent-facing phrasing; `note` is the log line's tail, kept
// byte-identical to what the etiquette suite matches on.
function defaultStaleWhen({ maxAgeMs, maxNewWords }) {
  return (rec, room = {}) => {
    const ageMs = Math.max(0, (room.now || Date.now()) - rec.at);

    // Wall-clock staleness: the floor took too long to reopen. Runs first and
    // is never waived — a genuinely ancient thought is wrong to replay however
    // it was asked for.
    if (Number.isFinite(maxAgeMs) && ageMs > maxAgeMs) {
      return {
        signal: 'age',
        note: 'too stale (' + ageMs + 'ms old, max ' + maxAgeMs + 'ms)',
        reason: `the floor stayed busy for ${Math.round(ageMs / 1000)}s`,
      };
    }

    // Topical staleness (#239): even inside the age window, if a lot was SAID
    // while the reply was held, the queued thought answers a conversation that
    // has moved on. newWords === null means the signal was never baselined (the
    // mid-TTS back-off path) → age-only, as before.
    if (typeof room.newWords === 'number' && Number.isFinite(maxNewWords) && room.newWords > maxNewWords) {
      // Resolved lazily: the whole-held-window name scan is only worth running
      // once the word gate has actually tripped.
      const named = typeof room.addressedByName === 'function'
        ? room.addressedByName()
        : !!room.addressedByName;
      // Unless they asked for it by name. The guard's premise is that nobody
      // wants the held thought any more, and a direct "So <name>, what do you
      // think?" is that premise being contradicted out loud. Discarding there
      // answers a question with silence — the worst of both, since the bot
      // neither speaks nor is heard declining to.
      //
      // Only THIS guard is waived. The age gate above still ran, and the
      // floor-busy check at the audio-start instant still runs after us:
      // being named is not licence to talk over the person doing the naming.
      if (named) {
        return {
          signal: 'words',
          waived: true,
          note: 'keeping stash despite ' + room.newWords + ' new words — the bot was addressed by name',
        };
      }
      return {
        signal: 'words',
        note: 'conversation moved on (' + room.newWords + ' new words > ' + maxNewWords + ') — agent will re-derive',
        reason: `${room.newWords} words were said while it waited`,
      };
    }

    return null;
  };
}

// Evaluate the staleness of a held thing against the room, in one place.
//
// `held` may carry its own staleWhen (a record built by makeUtterance) or not
// (the plain { entries, at, wordsAtStash } stash shape, which is also what the
// tests construct). Either way the mechanism is the same call, so the
// name-mention exemption (#475) is a predicate rather than a special case
// bolted onto one gate.
function evaluateStaleness(held, room = {}, fallback) {
  if (!held) return null;
  const predicate = held.staleWhen || fallback;
  if (typeof predicate !== 'function') return null;
  return predicate(held, room) || null;
}

module.exports = {
  SOURCES,
  RESUMABLE_BY_SOURCE,
  EXEMPT_BY_SOURCE,
  makeUtterance,
  reduceUrgency,
  defaultStaleWhen,
  evaluateStaleness,
};
