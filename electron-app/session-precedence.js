// session-precedence.js — when the profile's own vc_session cookie and the
// app-level shared token disagree, which one wins?
//
// #366 introduced the reconciliation (syncSharedLoginCookie) and answered this
// with "whichever one authenticates". That is right whenever exactly one of them
// is valid, and it is what makes a fresh sign-in in any profile propagate to all
// the others. It is wrong when BOTH are valid, because it then keeps the local
// one for no better reason than that it is local — silently discarding the other.
//
// That cost us a real fix on 2026-09-01. The nightly rig's session had been
// expiring every 30 days (MAX_AGE in the website's api/lib/auth.ts), so a
// year-long token was minted for the bot account and written to the shared
// config. Starting the app once put it straight back: the Default profile's
// cookie jar still held a valid 30-day token, it authenticated, and the app
// donated it up over the year-long one. Nothing looked wrong — same account,
// still signed in — and the whole point of the exercise was quietly undone.
//
// The rule here is lifetime, not locality: when both tokens authenticate, keep
// the one that lasts LONGER. That is strictly better for the thing this
// mechanism exists to do (keep the machine signed in), and it needs no notion of
// "special" tokens — a genuine fresh sign-in still wins the moment it outlives
// whatever it is replacing, which is the normal case since sign-ins are issued
// at a fixed MAX_AGE from now.
//
// Pure and dependency-free so the decision can be tested without an Electron
// session, a cookie jar, or a network.

/**
 * Read a JWT's `exp` claim (seconds since epoch) without verifying it.
 * Verification is the server's job and has already happened by the time we get
 * here — we only need to compare lifetimes. Returns null for anything we cannot
 * read, which callers must treat as "unknown", never as "expired".
 */
function tokenExp(token) {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const seg = parts[1];
    const json = Buffer.from(seg + '='.repeat((4 - (seg.length % 4)) % 4), 'base64url').toString('utf8');
    const exp = JSON.parse(json).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

/**
 * Decide what to do with the two tokens.
 *
 * @param {object} o
 * @param {string|null} o.local              vc_session cookie in THIS profile's jar
 * @param {string|null} o.shared             app-level vcSessionToken (all profiles)
 * @param {boolean} o.localAuthenticated     did the server accept `local`?
 * @param {number} [o.nowSec]                override for tests
 * @returns {{action: 'none'|'donate-up'|'seed-cookie', reason: string}}
 *   none        — they already agree, or there is nothing to do
 *   donate-up   — write `local` into the shared app-level store
 *   seed-cookie — replace this profile's cookie with `shared`
 */
function pickSharedSession({ local, shared, localAuthenticated, nowSec }) {
  const now = Number.isFinite(nowSec) ? nowSec : Math.floor(Date.now() / 1000);

  if (!local) {
    return shared
      ? { action: 'seed-cookie', reason: 'no local cookie; seeding from the shared app config' }
      : { action: 'none', reason: 'no local cookie and nothing shared' };
  }
  if (local === shared) return { action: 'none', reason: 'already in sync' };

  if (!localAuthenticated) {
    return shared
      ? { action: 'seed-cookie', reason: 'local cookie is stale; replacing it with the shared login' }
      : { action: 'none', reason: 'local cookie is stale and there is nothing to replace it with' };
  }

  // Local authenticates. Before donating it up, check we would not be trading
  // DOWN — this is the case #366 did not consider.
  if (!shared) return { action: 'donate-up', reason: 'local login verified; nothing shared yet' };

  const localExp = tokenExp(local);
  const sharedExp = tokenExp(shared);

  // Unknown lifetimes → fall back to the original behaviour. A token we cannot
  // parse is not evidence of anything, and guessing would be worse than the
  // bug this module fixes.
  if (localExp === null || sharedExp === null) {
    return { action: 'donate-up', reason: 'local login verified; lifetimes unknown, keeping the #366 behaviour' };
  }
  // A shared token that has already lapsed cannot win, however long its nominal
  // life was — the live cookie beats a dead certificate.
  if (sharedExp <= now) {
    return { action: 'donate-up', reason: 'local login verified; the shared token has expired' };
  }
  if (sharedExp > localExp) {
    const days = ((sharedExp - localExp) / 86400).toFixed(0);
    return {
      action: 'seed-cookie',
      reason: `both logins are valid, but the shared one lasts ${days} day(s) longer — keeping it rather than trading down`,
    };
  }
  return { action: 'donate-up', reason: 'local login verified and lasts at least as long as the shared one' };
}

module.exports = { tokenExp, pickSharedSession };
