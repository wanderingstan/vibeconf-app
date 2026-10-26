// port-layout.js: the MCP server's copy of the app's port block derivation.
//
// A COPY of electron-app/port-layout.js, on purpose. This directory is packaged
// as extraResources and cannot import from electron-app/ (#708; see
// tests/mcp-server-has-no-electron-app-imports), and the app cannot import from
// here either. tests/port-layout.test.mjs runs both over the same inputs and
// fails if they ever disagree, so change them together. See the Electron copy
// for the reasoning; only what the MCP server needs is here.
//
//   supervisor = base - 1, default bot = base, scan = base .. base + 45
//
// VIBECONF_PORT_BASE unset means 7865, and this server's defaults are exactly
// what they always were. The app writes VIBECONF_PORT_BASE into the MCP config
// it installs (only when it is not the default), so a server started by Claude
// Code or Codex for a second macOS user scans that user's block, not the
// primary user's.

export const DEFAULT_PORT_BASE = 7865;

export const OFFSETS = {
  supervisor: -1,
  profileFirst: 5,
  profileLast: 34,
  scanLast: 45,
  fleetFirst: 36,
  fleetLast: 51,
};

export const MIN_PORT_BASE = 1024 + 1 - OFFSETS.supervisor;
export const MAX_PORT_BASE = 65535 - OFFSETS.fleetLast;

export function parsePortBase(raw) {
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return { ok: false, error: `'${raw}' is not a whole number` };
  const base = Number(text);
  if (base < MIN_PORT_BASE || base > MAX_PORT_BASE) {
    return { ok: false, error: `${base} is outside ${MIN_PORT_BASE}-${MAX_PORT_BASE} (the block runs from base-1 to base+${OFFSETS.fleetLast})` };
  }
  return { ok: true, base };
}

const isSet = (v) => v !== undefined && v !== null && String(v).trim() !== '';

// The MCP server has no config file of its own: env is its only source. The
// configValue parameter is kept so the parity test can call both copies alike.
export function resolvePortBase({ env = process.env, configValue } = {}) {
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

export function portLayout(base = DEFAULT_PORT_BASE) {
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

export function layoutFromEnv(env = process.env) {
  return portLayout(resolvePortBase({ env }).base);
}
