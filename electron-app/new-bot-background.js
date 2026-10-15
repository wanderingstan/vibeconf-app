// new-bot-background.js: when a bot gets a random bundled background preset.
//
// A fresh bot used to ship with the plain animated gradient, the SAME one every
// other unconfigured bot has, which makes the switcher useless for telling
// several fresh bots apart. So a new bot gets a random preset on its first
// launch.
//
// "New" cannot be read off the filesystem alone. "New bot…" and /call-new-bot
// both run seedNewBotName BEFORE the new instance starts, and it writes
// <profile>/agent/config.json (the name). By the time the instance boots, the
// config exists and the profile no longer looks brand new, so a check on
// "no config.json yet" seeded only bare --profile launches and the very first
// default profile: every bot a user actually created got the gradient.
//
// Hence an explicit one-shot marker: seedNewBotName writes
// SEED_BACKGROUND_MARKER: true, and startup consumes it. Why a marker rather
// than inferring newness from, say, onboardingCallComplete === false plus an
// empty background: an empty background is ALSO what a user who deliberately
// reset to the default gradient has, and onboarding can stay incomplete
// across many launches. Inference would re-roll their choice on every restart.
// A marker that is cleared after one use can only ever fire once.

const SEED_BACKGROUND_MARKER = 'seedBackgroundOnFirstLaunch';

const BACKGROUND_EXTS = /\.(svg|png|jpe?g|webp|gif)$/i;

// Decide whether this launch should seed a random background.
//   isBrandNewProfile: no config.json existed for this profile at all
//                      (bare --profile launch, first default-profile launch)
//   marker:            the profile store's SEED_BACKGROUND_MARKER value
//                      (set by seedNewBotName for "New bot…" / /call-new-bot)
//   currentSvg:        the profile store's avatarBackgroundSvg
// Never overwrites a background that is already set.
function shouldSeedRandomBackground({ isBrandNewProfile, marker, currentSvg }) {
  if (currentSvg) return false;
  return Boolean(isBrandNewProfile) || marker === true;
}

// Pick one preset filename from a directory listing. `rand` is injectable for
// tests. Null when there is nothing usable.
function pickBackgroundPreset(files, rand = Math.random) {
  const usable = (files || []).filter((f) => BACKGROUND_EXTS.test(f));
  if (!usable.length) return null;
  return usable[Math.floor(rand() * usable.length)];
}

function presetCaption(filename) {
  return String(filename).replace(BACKGROUND_EXTS, '');
}

module.exports = {
  SEED_BACKGROUND_MARKER,
  BACKGROUND_EXTS,
  shouldSeedRandomBackground,
  pickBackgroundPreset,
  presetCaption,
};
