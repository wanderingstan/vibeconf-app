// instance-routing.js — pick which running app instance (profile) a tool call drives.
//
// Split out of server.js so it can be unit-tested: server.js connects an MCP
// transport on import, so nothing in it is importable from a test.
//
// Multiple app instances (profiles) can run at once, each on its own local-server
// port. The agent's MCP config bakes ONE port, so join_call re-binds the session's
// BASE_URL to the instance the name targets. This module is the pure decision:
// given a name and the discovered instances, which one, and HOW it matched.
//
// The match kind matters to the caller: a name that matched a PROFILE was an
// address, not a label, and must never be typed into Meet as the display name
// (that would rename "Alice" to "alice2" the moment you address her by profile).

// Instances are [{ port, baseUrl, profile, botName, configuredBotName, callStatus, roomId }].
function describe(instances) {
  return instances
    .map((i) => `${i.profile} (:${i.port}${i.botName ? `, ${i.botName}` : ""})`)
    .join(", ");
}

/**
 * Resolve which running instance a name targets.
 *
 * Returns one of:
 *   { keep: true }                      nothing discovered — leave BASE_URL alone
 *   { instance, matchedBy }             drive this one
 *   { error }                           ambiguous or not found; message is user-facing
 *
 * matchedBy is one of:
 *   'profile'      the name IS the profile — an address, so it is NOT a display name
 *   'botName'      the name matched exactly one instance's display name
 *   'displayName'  no match, sole instance — the name is only a display name
 *   'sole'         no name given, sole instance
 *   'pinned'       no name given, several running, but this session is pinned to one
 *
 * @param {string|null} name
 * @param {Array} instances
 * @param {{pinnedPort?: number|null}} opts pinnedPort = the port this session's
 *   MCP config explicitly bound it to (VIBECONF_BASE_URL), or null when unset.
 */
export function resolveInstance(name, instances, { pinnedPort = null } = {}) {
  if (instances.length === 0) return { keep: true }; // nothing discovered → don't touch BASE_URL

  if (name) {
    const n = String(name).trim().toLowerCase();

    // Profile wins: it's the unambiguous address, and the only name that is
    // guaranteed unique across instances.
    const byProfile = instances.find((i) => (i.profile || "").toLowerCase() === n);
    if (byProfile) return { instance: byProfile, matchedBy: "profile" };

    // Then display name — but only when exactly one instance answers to it.
    // Several bots can share a display name on purpose (the same character in
    // several calls at once); picking the lowest port silently would send the
    // join to the wrong instance, which switches THAT instance's room and drops
    // the call it was already in.
    const byBot = instances.filter((i) => (i.botName || "").toLowerCase() === n);
    if (byBot.length === 1) return { instance: byBot[0], matchedBy: "botName" };
    if (byBot.length > 1) {
      return {
        error: `Several running instances are named "${name}": ${describe(byBot)}. Specify which by PROFILE name.`,
      };
    }

    if (instances.length === 1) return { instance: instances[0], matchedBy: "displayName" }; // sole instance; name is a display name
    return {
      error: `No running instance for profile "${name}". Running: ${describe(instances)}. Launch that profile, or use one of these names.`,
    };
  }

  if (instances.length === 1) return { instance: instances[0], matchedBy: "sole" };

  // No name, several running. If this session was explicitly pinned to a port
  // (the app writes VIBECONF_BASE_URL into each profile's own MCP config), that
  // IS the answer — don't make a profile's own terminal name itself just because
  // a sibling profile happens to be running.
  if (pinnedPort) {
    const pinned = instances.find((i) => i.port === pinnedPort);
    if (pinned) return { instance: pinned, matchedBy: "pinned" };
  }

  return { error: `Multiple app instances running — specify which by profile name: ${describe(instances)}.` };
}

/**
 * The Meet display name a join should use, given what the bot_name argument
 * turned out to mean. Returns null when the routing says nothing about the name
 * and the caller should fall back to its own configured/env default.
 *
 * The rule that matters: a name that matched a PROFILE was an address, and must
 * never overwrite a display name the profile has defined — `/join-call <code>
 * alice2` joins as "Alice", not "alice2". The argument becomes the name only
 * when the profile has none of its own to keep.
 *
 * @param {string|null} argName the bot_name argument as passed
 * @param {object} routed the routeToInstance result ({ instance?, matchedBy? })
 */
export function joinNameFromRouting(argName, routed = {}) {
  const arg = String(argName || "").trim();
  const configured = routed.instance?.configuredBotName || null;
  if (routed.matchedBy === "profile") return configured || arg || null;
  return arg || configured || null;
}

export default { resolveInstance, joinNameFromRouting };
