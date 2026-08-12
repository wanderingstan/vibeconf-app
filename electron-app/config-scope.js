// config-scope.js — app-level vs per-profile preference scoping (#366).
//
// Profiles (#282) each get an isolated userData dir with their own
// config.json — correct for IDENTITY (who the bot is, how it behaves), but
// machine-wide auth and plumbing must not be trapped per-profile: a tester
// with 3 profiles shouldn't paste their ElevenLabs key 3 times or log into
// vibeconferencing.com 3 times.
//
// This module is the single source of truth for which keys are APP-LEVEL
// (shared across all profiles, stored in the BASE userData config.json).
// Everything not listed here defaults to per-profile — deliberately, so a new
// pref is profile-scoped unless someone consciously promotes it.
//
// Principle: app-level = machine auth + plumbing that must be identical no
// matter which bot is running; per-profile = who the bot is and how it
// behaves (identity, voice choice, behavior knobs — kept per-profile so
// profiles can be swapped to compare behavior during testing).

const APP_LEVEL_KEYS = new Set([
  'ttsApiKey', // ElevenLabs secret — one key per machine (#140 tracks storage security)
  'vcSessionToken', // vibeconferencing.com login (mirror of the vc_session cookie)
  'vcSessionLoggedOutToken', // logout tombstone — profiles must not re-donate this token
  'syncBaseUrl', // legacy website/sync host override
  'websiteUrl', // website host override (preview deploys etc.)
  'dangerousMode', // machine-level trust decision
  // Whether we've ever sent an Apple Event (which is what raises the Automation
  // prompt). macOS grants Automation to the app bundle, not the profile, so a
  // second profile asking again would be asking about a decision already made.
  'automationProbed',
  'claudeIntegrationRemoved', // "leave no trace" opt-out — ~/.claude is machine-global
  'codexIntegrationRemoved', // "leave no trace" opt-out — ~/.codex is machine-global
  // #231: which agent CLI is installed is a property of the MACHINE, like
  // dangerousMode. Every bot on a laptop is driven by the same one. Deliberately
  // NOT in MIGRATE_KEYS below: auto-promoting one profile's guess machine-wide is
  // the same hazard documented there for dangerousMode.
  'agentBackend',
  // #242: how that agent is hosted (Terminal window vs headless child). Scoped
  // app-level for the same reason as agentBackend, which it directly depends on
  // — it only applies when the backend is "claude", and a setting that qualifies
  // a machine-wide setting belongs in the same place.
  //
  // It was per-profile for one commit, which made it INVISIBLE: App Settings
  // renders app-level schema prefs only (get-app-settings-schema filters on
  // isAppLevel), so the toggle existed, worked via set_preference, and could not
  // be found by anyone using the app normally.
  //
  // Not in MIGRATE_KEYS, same hazard as dangerousMode: auto-promoting one
  // profile's experimental headless setting machine-wide would silently move
  // every bot off the Terminal path.
  'agentHosting',
  // The update CHANNEL is a property of the app BINARY, which every profile on
  // this machine shares — there is ONE updater, so "profile A on candidate,
  // profile B on release" is meaningless. Per-profile it would also be INVISIBLE
  // (App Settings renders app-level schema prefs only, via isAppLevel) — the exact
  // trap documented for agentHosting just above. Not in MIGRATE_KEYS: a fresh pref
  // defaulting to 'release', nothing to promote.
  'updateChannel',
  // Whether the quit dialog appears is about this MACHINE's window, not about
  // any one bot — every profile shares the same close button habit.
  'confirmQuit',
  // The setup wizard asks about this ONCE, in machine terms ("the app can send
  // its own diagnostic logs… which can include transcript text"), so it has to
  // BE machine-wide. Per-profile it silently was not: answering "no" bound the
  // choice to the Default profile, and every bot created afterwards started at
  // the default of true and shipped transcripts anyway. A privacy answer that
  // does not carry is worse than not asking.
  //
  // It also had nowhere to change it later — App Settings renders app-level
  // prefs only, so it was set once in the wizard and then unreachable.
  'remoteLogging',
  // #273: provenance of the current ttsApiKey — 'byo' (pasted by the user) or
  // 'gifted' (applied from a per-account grant). Lives at app level, same as
  // ttsApiKey itself, but is NOT in MIGRATE_KEYS: a gift is tied to the
  // logged-in account, not the machine, so it must not silently spread from
  // one profile's acceptance. It is cleared on logout/account-switch instead
  // (see clearGiftedTtsKey in main.js), unlike the BYO key it may sit beside.
  // No separate "has this account answered the offer" flag exists alongside
  // it — deliberately stateless, see the note above applyGrant in main.js.
  'ttsApiKeySource',
  // Whether call recordings' raw per-track files are kept after merging is a
  // disk-space/retention choice about this MACHINE, not any one bot's
  // personality — and, same trap as agentHosting/updateChannel/remoteLogging
  // above, App Settings renders app-level schema prefs only, so a per-profile
  // 'keepCallRecordingTracks' would have a real label and still be
  // unreachable from the UI. New pref, no per-profile legacy value to
  // migrate — not in MIGRATE_KEYS or MIGRATE_OPT_OUTS.
  'keepCallRecordingTracks',
]);

// The subset of app-level keys the launch migration may auto-promote from a
// per-profile config into the shared store. Deliberately ONLY the ElevenLabs
// key: it's the same secret no matter where it was entered, so promotion is
// pure convenience. The others must NOT inherit whatever one profile happened
// to have — promoting a test profile's dangerousMode would silently enable
// --dangerously-skip-permissions machine-wide, and promoting a profile's
// stale websiteUrl/syncBaseUrl preview override would point every profile at
// a dead host. Those start unset at app level and are set deliberately;
// old per-profile copies are simply ignored by the routing.
const MIGRATE_KEYS = ['ttsApiKey'];

// Keys promoted from a per-profile config ONLY when they are false.
//
// remoteLogging cannot use MIGRATE_KEYS: promoting whatever one profile happens
// to hold is the hazard documented above. But the asymmetry here is real rather
// than convenient — `true` is already the default, so promoting it changes
// nothing, while `false` is a deliberate opt-out someone chose. Losing that on
// an upgrade would silently resume shipping transcript text from a machine whose
// owner had said no.
//
// So: if ANY profile says false, the machine says false. Erring toward the more
// private answer is the only direction that cannot surprise someone unpleasantly.
const MIGRATE_OPT_OUTS = ['remoteLogging'];

const isAppLevel = (key) => APP_LEVEL_KEYS.has(key);

// Drop-in replacement for the single Store: same get/set/delete/getMultiple
// surface, but routes each key to the app-level or per-profile store by the
// scope map. The default (no --profile) instance passes the SAME store for
// both scopes — its config.json IS the app-level file — and routing becomes
// a no-op.
class ScopedStore {
  constructor(appStore, profileStore) {
    this.appStore = appStore;
    this.profileStore = profileStore;
  }

  _storeFor(key) {
    return isAppLevel(key) ? this.appStore : this.profileStore;
  }

  get(key) {
    if (key) return this._storeFor(key).get(key);
    // Whole-config read (Store-parity; no production caller today): merged
    // view from ONE snapshot of each store, app-level values winning over any
    // stale per-profile leftovers.
    const merged = { ...this.profileStore.get() };
    const app = this.appStore.get();
    for (const k of APP_LEVEL_KEYS) {
      if (app[k] !== undefined) merged[k] = app[k];
      else delete merged[k]; // stale per-profile copy of an app key: not real
    }
    return merged;
  }

  set(key, value) {
    this._storeFor(key).set(key, value);
  }

  delete(key) {
    this._storeFor(key).delete(key);
  }

  getMultiple(keys) {
    const appKeys = [];
    const profileKeys = [];
    for (const k of keys || []) (isAppLevel(k) ? appKeys : profileKeys).push(k);
    return {
      ...this.profileStore.getMultiple(profileKeys),
      ...this.appStore.getMultiple(appKeys),
    };
  }
}

// One-time heal for existing installs (#366): MIGRATE_KEYS found in a
// per-profile config.json are copied UP to the shared app store (so an
// already-entered ElevenLabs key starts working in every profile without
// re-entry). Conservative by design:
//   • only MIGRATE_KEYS are promoted (see the note above — promoting
//     dangerousMode or URL overrides from one profile would be an unasked-for
//     machine-wide behavior change);
//   • the app store is only written when it doesn't already have the key —
//     an existing app-level value is never clobbered by a profile's copy;
//   • the per-profile copy is deleted ONLY after reading the app store back
//     and confirming it now holds that exact value (otherwise the copy is
//     left in place — harmless, since reads route to the app store anyway).
// Runs on every launch; a healed profile has nothing left to migrate, so
// subsequent runs are no-ops.
function migrateAppLevelKeys(appStore, profileStore, log = console.log) {
  // Opt-outs first, and they run even for the default instance: the wizard wrote
  // remoteLogging=false through the SAME store there, so there is nothing to copy
  // — but a named profile carrying a false must still be able to set it
  // machine-wide.
  for (const key of MIGRATE_OPT_OUTS) {
    try {
      if (profileStore.get(key) === false && appStore.get(key) !== false) {
        appStore.set(key, false);
        log(`[config-scope] Honouring '${key}' opt-out machine-wide`);
      }
    } catch { /* non-fatal: the default (on) still applies */ }
  }
  if (appStore === profileStore) return; // default instance: nothing to split
  for (const key of MIGRATE_KEYS) {
    try {
      const profileValue = profileStore.get(key);
      if (profileValue === undefined) continue;
      if (appStore.get(key) === undefined) {
        appStore.set(key, profileValue);
        log(`[config-scope] Migrated '${key}' from profile config up to app-level`);
      }
      // Read back before discarding the profile copy.
      if (appStore.get(key) === profileValue) {
        profileStore.delete(key);
      } else {
        log(`[config-scope] App-level '${key}' already set (differs) — profile copy left in place, app value wins`);
      }
    } catch (err) {
      log(`[config-scope] Migration of '${key}' failed (non-fatal): ${err.message}`);
    }
  }
}

module.exports = { APP_LEVEL_KEYS, MIGRATE_KEYS, MIGRATE_OPT_OUTS, isAppLevel, ScopedStore, migrateAppLevelKeys };
