// api/errors.js: the errors the public API promises, and how a failed join
// becomes a JoinError code.

class JoinError extends Error {
  /** @param {string} code  see JOIN_ERROR_CODES */
  constructor(code, message, { screenshot = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'JoinError';
    this.code = code;
    this.screenshot = screenshot;
  }
}

class UnsupportedError extends Error {
  constructor(message) { super(message); this.name = 'UnsupportedError'; }
}

class MutedError extends Error {
  constructor(message = 'The bot is muted: call mic.setMuted(false) before speak()') {
    super(message);
    this.name = 'MutedError';
  }
}

const JOIN_ERROR_CODES = ['lobby-timeout', 'denied', 'auth-required', 'blocked-by-admin', 'bot-check', 'already-running', 'ui-changed', 'timeout'];

const MESSAGES = {
  'lobby-timeout': 'Nobody admitted the bot in time.',
  denied: 'The call refused the bot.',
  'auth-required': 'This call needs a signed-in profile.',
  'blocked-by-admin': "The organization's policy doesn't allow this join.",
  'bot-check': 'The platform showed a CAPTCHA. This library never solves those; use a signed-in profile.',
  'already-running': 'This profile is already open in another browser. Close it, or use another profile.',
  'ui-changed': 'A control the bot needs is missing from the page, so the platform may have changed its UI.',
  timeout: "The bot didn't get into the call in time, and the cause couldn't be determined.",
};

// A status the provider reports that settles the join right away, without
// waiting out the timeout. "Denied — reloading to retry" is not one: Meet's
// provider is still trying.
function codeFromStatus(status) {
  const s = String(status || '');
  if (/recaptcha|captcha/i.test(s)) return 'bot-check';
  if (!/^Error:/.test(s)) return null;
  if (/join button not found/i.test(s)) return 'ui-changed';
  if (/can't join|couldn't enter|denied|removed/i.test(s)) return 'denied';
  return null;
}

// Playwright's error when another Chrome holds the profile.
function isProfileInUse(err) {
  return /ProcessSingleton|SingletonLock|profile is already in use|Opening in existing browser session/i.test(String(err && err.message));
}

/**
 * Why a join that reached its timeout failed, from what the page last showed.
 * @param {object} o
 * @param {string[]} [o.statuses]  the provider's status lines, oldest first
 * @param {string} [o.url]         where the page ended up
 * @param {string} [o.text]        the page's visible text
 * @returns {string} a JoinError code
 */
function classifyJoinFailure({ statuses = [], url = '', text = '' } = {}) {
  for (const s of [...statuses].reverse()) {
    const code = codeFromStatus(s);
    if (code) return code;
  }
  if (/captcha/i.test(text)) return 'bot-check';
  if (/accounts\.google\.com|slack\.com\/(?:signin|ssb\/signin)|zoom\.us\/signin|login\.(?:microsoftonline|live)\.com/i.test(url)) return 'auth-required';
  // No live sighting of these two words yet; 'timeout' is the fallback if they don't match.
  if (/(?:your|an) administrator\b|organization(?:'s)? polic/i.test(text)) return 'blocked-by-admin';
  if (/can't join this video call/i.test(text)) return 'denied';
  if (/^Waiting to be admitted/.test(statuses[statuses.length - 1] || '')) return 'lobby-timeout';
  return 'timeout';
}

function joinError(code, { detail, screenshot, cause } = {}) {
  return new JoinError(code, detail ? `${MESSAGES[code]} (${detail})` : MESSAGES[code], { screenshot, cause });
}

module.exports = { JoinError, UnsupportedError, MutedError, JOIN_ERROR_CODES, codeFromStatus, isProfileInUse, classifyJoinFailure, joinError };
