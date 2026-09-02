/**
 * time-format.js — render times the way the USER has asked for them.
 *
 * THE TRAP, and it is not the obvious one. The panel already asked for the
 * system locale correctly:
 *
 *     new Date(x).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
 *
 * and still printed "4:30 PM" to someone whose Mac is set to 24-hour time. The
 * reason is that macOS keeps the 24-hour choice in a preference SEPARATE from
 * the locale — `AppleICUForce24HourTime` in NSGlobalDomain — and Chromium's ICU
 * resolves the hour cycle from the LOCALE alone. Measured on Stan's MacBook
 * 2026-08-31:
 *
 *     AppleICUForce24HourTime = 1        the checkbox is ticked
 *     AppleLocale             = en_US
 *     Intl ... hourCycle      = h12      what Electron believes
 *
 * So no amount of passing `[]`, `undefined`, or `app.getLocale()` fixes it. The
 * preference has to be read directly and turned into an explicit `hour12`.
 *
 * Only macOS needs this. Linux takes the hour cycle from LC_TIME, which ICU does
 * honour, and Windows' short-time format likewise resolves through the locale —
 * on both, returning undefined and letting the locale decide is correct.
 */

const { execFileSync } = require('node:child_process');

let _cached;   // undefined = not resolved yet; null = no preference expressed

/**
 * true → force 12-hour, false → force 24-hour, undefined → let the locale decide.
 *
 * Read once and cached: it is a `defaults` subprocess, it is consulted on every
 * repaint, and a user changing it mid-session is not worth a spawn per render.
 */
function resolveHour12() {
  if (_cached !== undefined) return _cached === null ? undefined : _cached;
  _cached = null;
  if (process.platform === 'darwin') {
    // Both keys can be absent (the usual case — follow the locale), and only one
    // is ever set at a time. `defaults read` exits non-zero when a key does not
    // exist, so each is its own try.
    const read = (key) => {
      try {
        return execFileSync('defaults', ['read', 'NSGlobalDomain', key],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch { return null; }
    };
    if (read('AppleICUForce24HourTime') === '1') _cached = false;
    else if (read('AppleICUForce12HourTime') === '1') _cached = true;
  }
  return _cached === null ? undefined : _cached;
}

/**
 * A time of day, in the user's format. `hour12` may be passed in by a renderer
 * that was handed the resolved value over IPC (it cannot run `defaults` itself).
 *
 * `hour: 'numeric'` rather than '2-digit' on purpose — under h12 a leading zero
 * ("04:30 PM") is wrong, and under h23 ICU pads it for us anyway.
 */
function formatTime(date, { hour12 = resolveHour12(), seconds = false } = {}) {
  const opts = { hour: 'numeric', minute: '2-digit' };
  if (seconds) opts.second = '2-digit';
  // null as well as undefined means "let the locale decide". A destructuring
  // default only fires for undefined, so an explicit null arrives here intact —
  // and `hour12: null` is falsy to Intl, i.e. silently 24-hour. Callers plumbing
  // this through IPC or JSON get null far more easily than undefined.
  if (hour12 !== undefined && hour12 !== null) opts.hour12 = hour12;
  // [] — the SYSTEM locale. Never a hardcoded 'en-US': that pins the date order
  // and the separator as well as the hour cycle.
  return new Date(date).toLocaleTimeString([], opts);
}

/** A date, in the user's format. Locale-only; macOS has no analogous override. */
function formatDate(date, opts = { dateStyle: 'medium' }) {
  return new Date(date).toLocaleDateString([], opts);
}

module.exports = { resolveHour12, formatTime, formatDate };
