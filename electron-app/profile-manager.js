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

// Manual-profile ports start here, above the default instance (7865) and clear
// of the test fleet (7901+). Each profile keeps its assigned port across
// launches via the registry so a profile is reliably reachable on one port.
const PROFILE_PORT_BASE = 7870;
const PROFILE_PORT_MAX = 7899; // stay below the fleet's BASE_PORT (7901)

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
    profileIcon: cfg.profileIcon || null,     // captured virtual-camera avatar snapshot, for the switcher thumbnail
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
function portForProfile(baseUserData, name) {
  const reg = loadPortRegistry(baseUserData);
  if (reg[name]) return reg[name];
  const taken = new Set(Object.values(reg));
  for (let p = PROFILE_PORT_BASE; p <= PROFILE_PORT_MAX; p++) {
    if (!taken.has(p)) {
      reg[name] = p;
      savePortRegistry(baseUserData, reg);
      return p;
    }
  }
  throw new Error(`No free profile port in ${PROFILE_PORT_BASE}-${PROFILE_PORT_MAX}`);
}

// A profile name we'll accept for creation (same charset as requestedProfileName
// in main.js, so the launched instance won't reject it).
function isValidProfileName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_.-]+$/.test(name);
}

// The default profile's on-disk name — the profile the app opens when launched
// with no --profile flag. `pointer` is the app-level `defaultProfile` config
// value; when unset it falls back to 'default'. Matched case-insensitively to an
// existing dir so a legacy 'Default' dir is reused rather than shadowed by a
// colliding 'default' on a case-insensitive filesystem (macOS).
function resolveDefaultProfileName(profilesRoot, pointer) {
  const want = (pointer && String(pointer).trim()) || 'default';
  const existing = listProfileNames(profilesRoot)
    .find((n) => n.toLowerCase() === want.toLowerCase());
  return existing || want;
}

module.exports = {
  listProfiles,
  listProfileNames,
  readProfileConfig,
  readConfigFields,
  portForProfile,
  loadPortRegistry,
  isValidProfileName,
  resolveDefaultProfileName,
  PROFILE_PORT_BASE,
  PROFILE_PORT_MAX,
};
