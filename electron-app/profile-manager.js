// profile-manager.js — enumerate + bookkeep app profiles for the Chrome-style
// profile switcher (#282 follow-up).
//
// A "profile" is a sibling dir under <baseUserData>/profiles/<name>, each its
// own isolated userData (preferences in config.json, and one persist:session
// partition = one Google/Slack identity). This module is the FILESYSTEM half:
// listing profiles, reading each one's bound account for display, and handing
// out a stable local-server port per profile. The launch/focus half lives in
// main.js (it needs the app + BrowserWindow).

const fs = require('fs');
const path = require('path');
const { layoutFromEnv, portLayout } = require('./port-layout.js');

// Manual-profile ports start here, above the default instance (7865) and clear
// of the test fleet (7901+). Each profile keeps its assigned port across
// launches via the registry so a profile is reliably reachable on one port.
//
// The range moves with VIBECONF_PORT_BASE (port-layout.js: base+5 .. base+34),
// so read it through profilePortRange(). These two are the UNSHIFTED defaults.
const PROFILE_PORT_BASE = portLayout().profileFirst; // 7870
const PROFILE_PORT_MAX = portLayout().profileLast;   // 7899, below the fleet's BASE_PORT (7901)

// The range new profile ports are handed out from ({ first, last }), plus the
// wider window an already-registered port is honoured in ({ keepFirst,
// keepLast }: the block's whole discovery scan). For the block in effect: env,
// already folded together with the config file by main.js.
function profilePortRange(env = process.env) {
  const l = layoutFromEnv(env);
  return { first: l.profileFirst, last: l.profileLast, keepFirst: l.scanFirst, keepLast: l.scanLast };
}

function safeReadJSON(file) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch { /* corrupt/partial — treat as absent */ }
  return null;
}

// Read the identity fields from a profile's config (read-only; safe even while
// that instance runs). Since #305 the per-profile config lives in the bot's
// agent dir (<dir>/agent/config.json); older profiles kept it loose at
// <dir>/config.json, so fall back to that.
function readConfigFields(dir) {
  const cfg = safeReadJSON(path.join(dir, 'agent', 'config.json'))
    || safeReadJSON(path.join(dir, 'config.json')) || {};
  return {
    botName: cfg.botName || null,
    meetAccountEmail: cfg.meetAccountEmail || null,
    lastMeetName: cfg.lastMeetName || null,   // remembered Meet display name (#282)
    lastSlackName: cfg.lastSlackName || null, // remembered Slack display name (#282)
    avatarThumb: cfg.avatarThumb || null,     // small PNG each bot renders of its own avatar, for the switcher thumbnail
    // Calendar auto-join (#299): read here (not just by that profile's own
    // running process) so a DIFFERENT already-running profile can notice a
    // calendar event belongs to this one and launch it — see
    // checkOtherProfilesForCalendarMatch in main.js.
    calendarIdentityEmail: cfg.calendarIdentityEmail || null,
    // #301: epoch ms this bot was last in a call; the app's bot list is
    // ordered by it. null for a bot that predates the stamp.
    lastCallAt: Number.isFinite(cfg.lastCallAt) ? cfg.lastCallAt : null,
  };
}

// A named profile's persisted identity fields for display.
function readProfileConfig(profilesRoot, name) {
  return { name, ...readConfigFields(path.join(profilesRoot, name)) };
}

// Every profile dir under profiles/ (each is a real, isolated identity).
function listProfileNames(profilesRoot) {
  try {
    return fs.readdirSync(profilesRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch {
    return []; // no profiles dir yet
  }
}

function listProfiles(profilesRoot) {
  return listProfileNames(profilesRoot).map((n) => readProfileConfig(profilesRoot, n));
}

// Bot names already spoken for on this machine, in profile order.
//
// Lives HERE, next to readConfigFields, because this is the module that knows
// where identity is stored — and that knowledge moved once already (#305, config
// into the agent dir). main.js used to re-read `<profile>/config.json` by hand
// instead, which meant collision detection silently went blind to every profile
// created after the move: the read threw, the throw was swallowed, and the name
// simply dropped out of the list. Not an error anyone could see — just a shorter
// list, and a second bot allowed to take a name already in use (#447).
//
// Two bots answering to one name is not merely confusing: MCP routes by name,
// and join_call REFUSES a display name shared by several running instances
// rather than guess, since guessing wrong yanks a bot out of a live call. So the
// user ends up with a bot they cannot drive, for an invisible reason.
//
// Returned verbatim (no case folding, no dedupe) — callers compare how they
// need to; randomBotName already lowercases what it is handed.
function takenBotNames(profilesRoot) {
  return listProfiles(profilesRoot).map((p) => p.botName).filter(Boolean);
}

// --- Port registry: name → local-server port, persisted in baseUserData so all
// instances agree. ---

function registryPath(baseUserData) {
  return path.join(baseUserData, 'profile-ports.json');
}

function loadPortRegistry(baseUserData) {
  return safeReadJSON(registryPath(baseUserData)) || {};
}

function savePortRegistry(baseUserData, reg) {
  try {
    fs.writeFileSync(registryPath(baseUserData), JSON.stringify(reg, null, 2));
  } catch (err) {
    console.warn('[profile-manager] Failed to save port registry:', err.message);
  }
}

// Return this profile's port, assigning + persisting the next free one on first
// use. Stable across launches. Throws if the manual-profile range is exhausted.
//
// A registered port outside this block's window (the port base was changed
// since it was handed out) is not honoured: it would put this bot in some other
// block, which is exactly what moving the base was for. It is reassigned once,
// in range, and the registry remembers the new one. The window is the whole
// discovery scan, not just the assignment range, so ports handed out before
// the range was 7870-7899 (7866+) keep working exactly as they did.
function portForProfile(baseUserData, name, range = profilePortRange()) {
  const reg = loadPortRegistry(baseUserData);
  const keepFirst = range.keepFirst ?? range.first;
  const keepLast = range.keepLast ?? range.last;
  const p0 = reg[name];
  if (p0 && (!Number.isInteger(p0) || (p0 >= keepFirst && p0 <= keepLast))) return p0;
  const taken = new Set(Object.entries(reg).filter(([n]) => n !== name).map(([, p]) => p));
  for (let p = range.first; p <= range.last; p++) {
    if (!taken.has(p)) {
      reg[name] = p;
      savePortRegistry(baseUserData, reg);
      return p;
    }
  }
  throw new Error(`No free profile port in ${range.first}-${range.last}`);
}

// A profile name we'll accept for creation (same charset as requestedProfileName
// in main.js, so the launched instance won't reject it).
function isValidProfileName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_.-]+$/.test(name);
}

// The default profile's on-disk name — the profile the app opens when launched
// with no --profile flag. `pointer` is the app-level `defaultProfile` config
// value; when unset it falls back to 'Default', matching Chromium's own
// convention (the primary profile dir is 'Default'; extras are 'Profile 1'…).
// Matched case-insensitively to an existing dir so a 'default'/'Default' dir is
// reused rather than shadowed by a colliding name on a case-insensitive
// filesystem (macOS).
function resolveDefaultProfileName(profilesRoot, pointer) {
  const want = (pointer && String(pointer).trim()) || 'Default';
  const existing = listProfileNames(profilesRoot)
    .find((n) => n.toLowerCase() === want.toLowerCase());
  return existing || want;
}

module.exports = {
  listProfiles,
  takenBotNames,
  listProfileNames,
  readProfileConfig,
  readConfigFields,
  portForProfile,
  loadPortRegistry,
  isValidProfileName,
  resolveDefaultProfileName,
  profilePortRange,
  PROFILE_PORT_BASE,
  PROFILE_PORT_MAX,
};
