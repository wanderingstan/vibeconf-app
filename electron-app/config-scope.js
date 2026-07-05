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
  'syncBaseUrl', // legacy website/sync host override
  'websiteUrl', // website host override (preview deploys etc.)
  'dangerousMode', // machine-level trust decision
]);

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
    // Whole-config read: merged view, app-level values win over any stale
    // per-profile leftovers.
    const merged = { ...this.profileStore.get() };
    for (const k of APP_LEVEL_KEYS) {
      const v = this.appStore.get(k);
      if (v !== undefined) merged[k] = v;
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

// One-time heal for existing installs (#366): any app-level key found in a
// per-profile config.json is copied UP to the shared app store (so e.g. an
// already-entered ElevenLabs key starts working in every profile without
// re-entry). Conservative by design:
//   • the app store is only written when it doesn't already have the key —
//     an existing app-level value is never clobbered by a profile's copy;
//   • the per-profile copy is deleted ONLY after reading the app store back
//     and confirming it now holds that exact value (otherwise the copy is
//     left in place — harmless, since reads route to the app store anyway).
// Runs on every launch; a healed profile has nothing left to migrate, so
// subsequent runs are no-ops.
function migrateAppLevelKeys(appStore, profileStore, log = console.log) {
  if (appStore === profileStore) return; // default instance: nothing to split
  for (const key of APP_LEVEL_KEYS) {
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

module.exports = { APP_LEVEL_KEYS, isAppLevel, ScopedStore, migrateAppLevelKeys };
