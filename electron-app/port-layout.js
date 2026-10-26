// port-layout.js: the app's whole local port block, derived from one number.
//
// Every port the app uses is on 127.0.0.1, and 127.0.0.1 is SHARED by every
// macOS user on the machine. A second user running the app (a dedicated bot
// account next to Stan's own) would otherwise fight over the same ports, and,
// worse, each side would discover and drive the other's bots: a port probe
// cannot tell whose process answered it.
//
// So the block moves as a unit. VIBECONF_PORT_BASE is the default bot's port,
// and everything else is a fixed offset from it:
//
//   supervisor (the app window's directory)  base - 1            7864
//   default bot                               base                7865
//   named profiles                            base+5 .. base+34   7870-7899
//   MCP discovery scan                        base   .. base+45   7865-7910
//   test fleet (scanned for, never assigned)  base+36 .. base+51  7901-7916
//
// Unset means 7865, the layout every installed config already names, so a
// machine with one user sees no change at all. The specific overrides
// (VIBECONF_LOCAL_PORT, --local-port, VIBECONF_SUPERVISOR_PORT/_URL,
// VIBECONF_PORT_RANGE, VIBECONF_BASE_URL) still win; they are read where they
// always were, and this only moves their defaults.
//
// The app is normally started from the Dock, which never sees a shell's env, so
// the base can also come from the app-level config.json (`portBase`). main.js
// resolves the two ONCE at the top (applyPortBase) and writes the answer back
// into process.env, so everything downstream (and every process this one
// spawns) reads one variable instead of re-deciding.
//
// mcp-server/port-layout.js is a COPY of the derivation, in ESM. The MCP server
// is packaged as extraResources and cannot import from electron-app/ (#708, see
// tests/mcp-server-has-no-electron-app-imports). tests/port-layout.test.mjs
// checks the two copies agree.

const DEFAULT_PORT_BASE = 7865;

// Offsets from the base. The fleet's are what spawn-test-fleet.sh uses today
// (7901-7916) expressed against the default base; nothing assigns them here.
const OFFSETS = {
  supervisor: -1,
  profileFirst: 5,
  profileLast: 34,
  scanLast: 45,
  fleetFirst: 36,
  fleetLast: 51,
};

// The lowest and highest bases whose whole block stays in unprivileged,
// valid port space: the supervisor (base - 1) above 1024, the top of the
// fleet range (base + 51) at most 65535.
const MIN_PORT_BASE = 1024 + 1 - OFFSETS.supervisor;   // 1026
const MAX_PORT_BASE = 65535 - OFFSETS.fleetLast;       // 65484

// { ok: true, base } or { ok: false, error }. Accepts a number or a string of
// digits (the config file and the env deliver one each).
function parsePortBase(raw) {
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return { ok: false, error: `'${raw}' is not a whole number` };
  const base = Number(text);
  if (base < MIN_PORT_BASE || base > MAX_PORT_BASE) {
    return { ok: false, error: `${base} is outside ${MIN_PORT_BASE}-${MAX_PORT_BASE} (the block runs from base-1 to base+${OFFSETS.fleetLast})` };
  }
  return { ok: true, base };
}

const isSet = (v) => v !== undefined && v !== null && String(v).trim() !== '';

// Which base applies, and why. Env first (a terminal launch is the deliberate,
// local override), then the config file, then the default.
//
// An INVALID value falls back to the default rather than to the next source:
// a broken override should land on the well-known block, the one a person
// debugging it will look at first, not on some other block. It is reported in
// `warning` so the caller can say so.
function resolvePortBase({ env = process.env, configValue } = {}) {
  if (isSet(env.VIBECONF_PORT_BASE)) {
    const r = parsePortBase(env.VIBECONF_PORT_BASE);
    if (r.ok) return { base: r.base, source: 'env', warning: null };
    return { base: DEFAULT_PORT_BASE, source: 'default', warning: `Ignoring VIBECONF_PORT_BASE: ${r.error}; using ${DEFAULT_PORT_BASE}` };
  }
  if (isSet(configValue)) {
    const r = parsePortBase(configValue);
    if (r.ok) return { base: r.base, source: 'config', warning: null };
    return { base: DEFAULT_PORT_BASE, source: 'default', warning: `Ignoring config portBase: ${r.error}; using ${DEFAULT_PORT_BASE}` };
  }
  return { base: DEFAULT_PORT_BASE, source: 'default', warning: null };
}

// Every port in the block for `base`. Pure.
function portLayout(base = DEFAULT_PORT_BASE) {
  return {
    base,
    supervisor: base + OFFSETS.supervisor,
    defaultBot: base,
    profileFirst: base + OFFSETS.profileFirst,
    profileLast: base + OFFSETS.profileLast,
    scanFirst: base,
    scanLast: base + OFFSETS.scanLast,
    fleetFirst: base + OFFSETS.fleetFirst,
    fleetLast: base + OFFSETS.fleetLast,
  };
}

// The layout in effect for this process. Reads env only: by the time anything
// calls this, applyPortBase has folded the config file into env.
function layoutFromEnv(env = process.env) {
  return portLayout(resolvePortBase({ env }).base);
}

// The env a config entry or a spawned process should carry so it lands on the
// same block. Empty for the default base, so configs written with it unset are
// exactly what they always were.
function portBaseEnv(base) {
  return base === DEFAULT_PORT_BASE ? {} : { VIBECONF_PORT_BASE: String(base) };
}

// Resolve once and write the answer back into `env` (process.env at the top of
// main.js). Normalised both ways: a valid non-default base is set, and anything
// else (unset, or invalid and already warned about) is removed, so a child
// process neither re-warns nor re-derives something different.
function applyPortBase({ env = process.env, configValue, log = console.warn } = {}) {
  const resolved = resolvePortBase({ env, configValue });
  if (resolved.warning) log(`[port-layout] ${resolved.warning}`);
  if (resolved.base === DEFAULT_PORT_BASE) delete env.VIBECONF_PORT_BASE;
  else env.VIBECONF_PORT_BASE = String(resolved.base);
  return resolved;
}

module.exports = {
  DEFAULT_PORT_BASE, MIN_PORT_BASE, MAX_PORT_BASE, OFFSETS,
  parsePortBase, resolvePortBase, portLayout, layoutFromEnv, portBaseEnv, applyPortBase,
};
