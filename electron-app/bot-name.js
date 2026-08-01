// bot-name.js — resolve a bot's effective display NAME, with fallbacks.
//
// The Meet display name (what Google transcribes, and how bots address each
// other in a room) comes from currentCallBotName first — the per-call /
// --bot-name override. This is the FALLBACK used when that isn't set: idle
// instances, the instance-discovery list, and the pre-join name field.
//
// A bare "Unnamed bot" there was wrong twice over: every test bot spawned with
// --bot-name and every named profile showed the same anonymous label, and a
// roomful of identically-labelled bots can't be addressed by name at all.
//
// Order, most to least authoritative:
//   1. stored botName   — the user's persistent panel preference.
//   2. --bot-name       — an explicit launch override; the operator named it.
//   3. named --profile  — humanized (test-meet-guest-1 -> "Test Meet Guest 1").
//                         NAMED profiles ONLY. The DEFAULT profile deliberately
//                         falls through so a genuinely unconfigured bot stays
//                         visibly "Unnamed bot" — that's what makes a stray
//                         instance obvious instead of impersonating the real bot
//                         (the 2026-07-29 "Call Jimmy" misroute; see
//                         bot-name-default.test.mjs). Pass null for the default.
//   4. DEFAULT_BOT_NAME — "Unnamed bot".

const { DEFAULT_BOT_NAME } = require('./preferences-schema.js');

// A profile dir name -> a Meet-friendly display name: separators become spaces
// so captions transcribe it as words, and it's title-cased so it reads as a
// name rather than a slug. 'test-meet-guest-1' -> 'Test Meet Guest 1'.
function humanizeProfileName(profile) {
  if (!profile || typeof profile !== 'string') return null;
  const words = profile.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!words) return null;
  return words.replace(/\b\w/g, (c) => c.toUpperCase());
}

const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// Full resolution with provenance. `source` is one of:
//   'stored'  — the user's persistent panel name (a "real" profile identity)
//   'cli'     — a launch --bot-name override
//   'profile' — humanized from a named --profile
//   'default' — the "Unnamed bot" last resort
// The app UI uses `source` to flag a non-'stored' name as not a real profile
// (e.g. "Alice [launch name]"); the Meet display name uses `name` verbatim so
// participants and other bots see the plain name.
function resolveBotNameWithSource({ storedName, cliName, profileName } = {}) {
  const s = clean(storedName);
  if (s) return { name: s, source: 'stored' };
  const c = clean(cliName);
  if (c) return { name: c, source: 'cli' };
  const p = humanizeProfileName(clean(profileName));
  if (p) return { name: p, source: 'profile' };
  return { name: DEFAULT_BOT_NAME, source: 'default' };
}

// storedName: store.get('botName'); cliName: the --bot-name launch flag;
// profileName: the EXPLICIT --profile (null for the default instance — pass null
// there on purpose, so the default falls through to "Unnamed bot").
function resolveBotName(inputs) {
  return resolveBotNameWithSource(inputs).name;
}

// How the app's OWN UI (window title) should show the name: the plain name for a
// real ('stored') identity or the already-obvious 'default', otherwise a short
// tag so the operator sees the name is a launch/profile fallback, not a saved
// profile — e.g. "Alice [launch name]", "Test Meet Guest 1 [profile]".
const SOURCE_TAGS = { cli: 'CLI name', profile: 'profile' };
function botNameForAppUI({ storedName, cliName, profileName } = {}) {
  const { name, source } = resolveBotNameWithSource({ storedName, cliName, profileName });
  const tag = SOURCE_TAGS[source];
  return tag ? `${name} [${tag}]` : name;
}

module.exports = { resolveBotName, resolveBotNameWithSource, botNameForAppUI, humanizeProfileName };
