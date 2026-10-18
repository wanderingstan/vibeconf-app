// new-bot.js: how a new bot is born, shared by a bot's own "New bot…" and the
// app window's sidebar (#301). Moved out of main.js's app-ready block, where
// only a bot process could reach it.

const fs = require('fs');
const path = require('path');

// Launch (or focus, if already running) the instance for a profile. Creating
// a new profile is just launching a never-seen name — the dir is created by
// that instance at startup.
// bot2, bot3, … — the first free one.
//
// Numbered rather than "Untitled": these are directory names, so they must
// survive [A-Za-z0-9._-] and be short enough to read in a window title. The
// default profile keeps its own name, so counting starts at 2 the way Chrome's
// "Person 2" does.
//
// Picks the first GAP, not max+1: deleting bot3 and adding a bot should reuse
// bot3 rather than creep to bot4 forever. Bounded so a pathological profile
// list cannot spin.
function nextBotProfileName(profilesRoot, { profileManager = require('./profile-manager.js') } = {}) {
  const taken = new Set(profileManager.listProfiles(profilesRoot).map((p) => String(p.name).toLowerCase()));
  for (let i = 2; i < 1000; i++) {
    const candidate = `bot${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `bot${Date.now()}`; // absurd, but never collides
}

// Give the new bot an actual NAME, not just a directory.
//
// "bot3" is a folder, and without this the bot would introduce itself as
// "Unnamed bot" — a worse first impression than any random name, and one the
// user then has to fix before the thing is usable. Drawn from the same pool
// the spinner uses, so a new bot arrives as Pepper or Twiki and can be renamed
// on the Settings page it opens on, or in the guided setup call.
//
// Written to the profile's config BEFORE launch rather than passed as
// --bot-name: a launch flag is an override with its own provenance tag
// ("Alice [launch name]") that does not persist, and this needs to be the
// bot's real, stored name.
//
// Names already in use are excluded, so two bots on one machine don't collide
// — which would make MCP routing by name ambiguous, not just confusing.
//
// `adopt` (optional) turns this into ADOPTING AN EXISTING SESSION rather than
// creating a blank bot: { workdir, session, botName }. A power user may have a
// Claude session with months of accumulated context, and the interesting move
// is to give THAT a face rather than start a bot from nothing. Seeding
// claudeWorkDir + agentSession here is what makes the new profile resume that
// session instead of opening a fresh one in its own agent dir.
//
// Seeded at creation for the same reason the name is: these have to be the
// bot's real stored settings before its first launch, not launch-time
// overrides. The bot's very first act is resuming the session, so there is no
// later moment to apply them.
function seedNewBot(profilesRoot, profileName, { adopt = null, log = console } = {}) {
  try {
    const { randomBotName } = require('./bot-names.js');
    const taken = (() => { try { return require('./profile-manager.js').takenBotNames(profilesRoot); } catch { return []; } })();
    // The AGENT dir, not the profile dir. The per-profile store has lived at
    // <profile>/agent/config.json since #305 (the agent's working directory
    // has to be a trusted Claude workspace, and the config moved in with it).
    // Seeding the pre-#305 loose path still WORKED — verified — but only
    // because the legacy migration copies it across on first launch, and that
    // migration exists to rescue old installs, not to be load-bearing for new
    // ones. Someone will delete it one day and new bots would quietly go back
    // to "Unnamed bot".
    //
    // It also left a second config.json that LOOKS authoritative and holds the
    // original name forever: bot8 read "Diego" long after being renamed
    // Taylor, which cost a real debugging detour.
    const dir = require('./agent-workdir.js').agentDirFor(path.join(profilesRoot, profileName));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'config.json');
    // Never clobber: a reused directory name (first-gap allocation) might
    // still hold a config the user cares about.
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { /* new */ }
    if (existing.botName) return;
    // An adopted session names itself where it can. The session's own name is
    // the user's word for this thing already, so it beats a random one — but
    // only if it can survive a call, which is a real constraint and not a
    // stylistic one: the bot has to notice its name through Meet's captions.
    // "pr-482-refactor" fails that badly (digits nobody says aloud), so it
    // falls back to the random pool rather than shipping a name that cannot
    // be addressed.
    const { isAddressableBotName } = require('./addressable-name.js');
    const adopted = adopt && isAddressableBotName(adopt.botName) ? adopt.botName.trim() : null;
    const botName = adopted || randomBotName({ taken });
    // onboardingCallComplete defaults to true (preferences-schema.js) so
    // pre-existing profiles read as already onboarded with no migration
    // needed — which means a genuinely NEW bot has to say otherwise
    // explicitly, right here, at the one moment it's actually created.
    const seeded = { ...existing, botName, onboardingCallComplete: false };
    // The new instance's startup sees this config.json and so does NOT treat
    // the profile as brand new; this marker is what tells it to seed a random
    // background preset (consumed on that first launch, see
    // new-bot-background.js).
    seeded[require('./new-bot-background.js').SEED_BACKGROUND_MARKER] = true;
    if (adopt && adopt.workdir) seeded.claudeWorkDir = adopt.workdir;
    if (adopt && adopt.session) {
      seeded.agentSession = adopt.session;
      // Adopting IS taking the session field over. Left on auto, the first
      // launch rewrites a name ref to the bot's own name (planAgentSession)
      // and starts a fresh session: Ravi came up blank that way. An id ref is
      // already safe, but a name ref from an older skill or a direct API
      // call is not.
      seeded.agentSessionAuto = false;
    }
    fs.writeFileSync(file, JSON.stringify(seeded, null, 2));
    log.log('[new-bot] New bot', profileName, 'named', botName,
      adopt ? `(adopting session ${JSON.stringify(adopt.session)} in ${adopt.workdir})` : '');
  } catch (err) {
    // Non-fatal: an unnamed bot is still a working bot, and the Settings page
    // it opens on is exactly where that gets fixed.
    log.warn('[new-bot] could not seed a name for', profileName, '—', err.message);
  }
}

module.exports = { nextBotProfileName, seedNewBot };
