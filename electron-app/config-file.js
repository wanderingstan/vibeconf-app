// config-file.js — apply a JSON file of settings at startup (`--config=<path>`).
//
// The headless problem (#805, part of #797's one-prompt Muse install): an agent
// setting the app up on a box with no screen can reach almost none of its
// configuration. App Settings is a window. set_preference needs a RUNNING MCP
// server, so it only works after a bot is already up — no use for anything that
// must be right BEFORE first launch. And the two API keys can't be set by an
// agent at all, because they are deliberately absent from preferences-schema.js.
// That is snag 10 in #797, hit live with Nova: it was handed an ElevenLabs key,
// set a "preference", and went on speaking through espeak.
//
// So: one flag, pointing at one JSON file, applied before anything reads a
// preference.
//
// Nothing here is a new config format or a new source of truth. The file is
// applied INTO the same stores every other writer uses, through the same
// schema validation set_preference uses, routed by the same scope map. It is a
// way to perform the writes, not a second place settings live.

const fs = require('fs');
const { PREFERENCES, validate } = require('./preferences-schema.js');
const { isAppLevel } = require('./config-scope.js');

// Keys an OPERATOR may set here that `set_preference` cannot reach.
//
// preferences-schema.js exists to keep API keys away from a BOT DECIDING THINGS
// MID-CALL. It was never meant to stop the person installing the app from
// configuring it, and whoever passes --config= already has the box and could
// write config.json by hand. Allowing these two is the whole point of the flag:
// without them a headless install still can't get a voice. Approved explicitly
// rather than assumed (#805).
const OPERATOR_KEYS = new Set([
  'ttsApiKey',      // ElevenLabs — without this a headless box is stuck on espeak
  'realtimeApiKey', // OpenAI realtime-voice experiment
]);

// Values that are never echoed to a log or a console, here or anywhere else.
// The KEY NAME is logged so an operator can confirm the file took effect; the
// value never is. Note the boxes this flag exists for often sit behind a
// TLS-intercepting proxy (#797 snag 4), so a leaked key is a real key leaked.
const SECRET_KEYS = OPERATOR_KEYS;

// App-level keys deliberately NOT settable from a config file, with the reason.
// These are the rest of APP_LEVEL_KEYS, and each is excluded on purpose rather
// than by omission — a future key added to that set should land here or in
// OPERATOR_KEYS as a decision, not silently become writable.
const REFUSED_KEYS = new Map([
  // A login, not a setting. Accepting it would make a pasted session token a
  // sign-in path — which is a real answer to #797's snag 8 (headless sign-in),
  // but a security decision of its own, not a side effect of a config flag.
  ['vcSessionToken', 'a login credential, not a setting — see #797 snag 8'],
  ['vcSessionLoggedOutToken', 'a logout tombstone the app maintains itself'],
  // A machine-level trust decision. It should take a human saying so, not a
  // line in a file an agent wrote.
  ['dangerousMode', 'a machine-level trust decision, not a per-launch setting'],
  ['automationProbed', "the app's own record of whether it has asked for macOS Automation"],
  ['claudeIntegrationRemoved', 'set by the "leave no trace" opt-out, not by hand'],
  ['codexIntegrationRemoved', 'set by the "leave no trace" opt-out, not by hand'],
  ['ttsApiKeySource', 'bookkeeping the app writes when a key is applied'],
]);

function describeKey(key) {
  if (REFUSED_KEYS.has(key)) return `'${key}' cannot be set from a config file: ${REFUSED_KEYS.get(key)}`;
  if (PREFERENCES[key] || OPERATOR_KEYS.has(key)) return null;
  return `Unknown setting '${key}'`;
}

// Check a parsed object WITHOUT touching any store. Returns
// { ok, entries: [{key, value, appLevel, secret}], errors: [string] }.
// Separated from applying so the whole file can be judged before a single write
// lands — a half-applied config is worse than a rejected one, because it starts
// the app in a state no file describes.
function checkConfigObject(raw) {
  const errors = [];
  const entries = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, entries, errors: ['Config must be a JSON object of key/value pairs'] };
  }

  for (const [key, value] of Object.entries(raw)) {
    const why = describeKey(key);
    if (why) {
      // A typo'd key is the #158 failure exactly: the launch looks fine, the
      // override does nothing, and nothing ever says so. Name it, and where a
      // close match exists, say so — an agent that wrote "ttsAPIKey" should not
      // have to diff the schema by hand.
      const near = nearestKey(key);
      errors.push(why + (near ? ` (did you mean '${near}'?)` : ''));
      continue;
    }
    if (OPERATOR_KEYS.has(key)) {
      if (typeof value !== 'string' || !value.trim()) {
        errors.push(`'${key}' must be a non-empty string`);
        continue;
      }
      entries.push({ key, value, appLevel: true, secret: true });
      continue;
    }
    const res = validate(key, value);
    if (!res.ok) { errors.push(`'${key}': ${res.error}`); continue; }
    entries.push({ key, value: res.value, appLevel: isAppLevel(key), secret: SECRET_KEYS.has(key) });
  }

  return { ok: errors.length === 0, entries, errors };
}

// Cheap edit-distance-ish suggestion: case-insensitive exact match first (the
// ttsAPIKey/ttsApiKey case), then a single-character-difference scan.
function nearestKey(key) {
  const all = [...Object.keys(PREFERENCES), ...OPERATOR_KEYS];
  const lower = key.toLowerCase();
  const ci = all.find((k) => k.toLowerCase() === lower);
  if (ci) return ci;
  return all.find((k) => Math.abs(k.length - key.length) <= 1 && withinOneEdit(k.toLowerCase(), lower)) || null;
}

function withinOneEdit(a, b) {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.length - short.length > 1) return false;
  let i = 0; let j = 0; let edits = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (short.length === long.length) { i++; j++; } else { j++; }
  }
  return edits + (long.length - j) + (short.length - i) <= 1;
}

// Read, validate and apply `configPath` into `store` (a ScopedStore, which
// routes each key to the app-level or per-profile file by itself).
//
// Throws on ANY problem rather than applying what it can. On an unattended box
// a partly-applied config is the worst outcome available: the app runs, looks
// healthy, and behaves according to no file anyone can inspect. The caller
// turns this into a non-zero exit, which is a signal a script can actually
// detect — unlike a warning scrolling past in a log nobody reads (#780).
function applyConfigFile(configPath, store, { log = console.log } = {}) {
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    throw new Error(`--config: cannot read ${configPath}: ${err.message}`);
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`--config: ${configPath} is not valid JSON: ${err.message}`);
  }

  const { ok, entries, errors } = checkConfigObject(raw);
  if (!ok) {
    throw new Error(
      `--config: ${configPath} was NOT applied (${errors.length} problem${errors.length === 1 ? '' : 's'}):\n`
      + errors.map((e) => `    - ${e}`).join('\n'),
    );
  }

  for (const { key, value, appLevel, secret } of entries) {
    store.set(key, value);
    log(`[config-file] set ${key} = ${secret ? '<redacted>' : JSON.stringify(value)}`
      + ` (${appLevel ? 'app-level' : 'this profile'})`);
  }
  log(`[config-file] applied ${entries.length} setting${entries.length === 1 ? '' : 's'} from ${configPath}`);
  return entries;
}

module.exports = { applyConfigFile, checkConfigObject, OPERATOR_KEYS, REFUSED_KEYS, nearestKey };
