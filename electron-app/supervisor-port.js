// supervisor-port.js — where the supervisor listens (#301).
//
// Its own port, deliberately NOT 7865. That one belongs to the default BOT: it
// is the seat the global Claude MCP config points at, and every installed
// config on every machine already names it. A supervisor squatting there would
// take the default bot's address and break every one of them at once.
//
// 7864 sits directly below the bot range (7865 default, 7870-7899 named
// profiles, 7901-7916 the test fleet), so the whole family reads as one block
// with the coordinator at its head.
//
// That block moves as a unit with VIBECONF_PORT_BASE (port-layout.js): the
// supervisor is always base - 1. SUPERVISOR_PORT is the unshifted default.
const { layoutFromEnv, portLayout } = require('./port-layout.js');

const SUPERVISOR_PORT = portLayout().supervisor; // 7864

// Overridable for the same reason every other port here is: two checkouts, or a
// test, must be able to run a supervisor without fighting the real one. An
// explicit VIBECONF_SUPERVISOR_PORT wins over the base.
function supervisorPort(env = process.env) {
  const fallback = layoutFromEnv(env).supervisor;
  const raw = env.VIBECONF_SUPERVISOR_PORT;
  if (!raw) return fallback;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

function supervisorUrl(env = process.env) {
  return env.VIBECONF_SUPERVISOR_URL || `http://127.0.0.1:${supervisorPort(env)}`;
}

module.exports = { SUPERVISOR_PORT, supervisorPort, supervisorUrl };
