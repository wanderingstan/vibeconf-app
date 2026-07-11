// nav-url.js — normalize the URL typed into "Navigate Webview…" (⌘⇧L).
//
// The box feeds meetView.webContents.loadURL, so the result must be a real
// http(s) URL. Users type bare hosts ("example.com", "meet.google.com/abc"); we
// prepend https:// for them rather than rejecting. Any OTHER explicit scheme
// (ftp:, file:, javascript:, data:) is still refused — we only ever navigate the
// bot's webview to http(s).
//
// Pure and testable: the ipcMain handler in main.js is a thin wrapper.

const IS_HTTP = /^https?:\/\//i;
const SCHEME_WITH_SLASHES = /^[a-z][a-z0-9+.-]*:\/\//i; // ftp://, file://, …
// An "opaque" scheme — a leading `word:` NOT followed by a port digit — is a
// non-navigable scheme like javascript:, data:, mailto:, about:, blob:. The
// negative digit lookahead is what tells `about:blank` (refuse) apart from
// `localhost:3000` (a bare host:port we should prepend https:// to).
const OPAQUE_SCHEME = /^[a-z][a-z0-9+.-]*:(?![0-9])/i;

// Returns { ok: true, url } or { ok: false, error }.
function normalizeNavUrl(raw) {
  const trimmed = String(raw == null ? '' : raw).trim();
  if (!trimmed) return { ok: false, error: 'Enter a URL' };

  // Already an http(s) URL — leave it exactly as typed.
  if (IS_HTTP.test(trimmed)) return { ok: true, url: trimmed };

  // Any OTHER explicit scheme is refused rather than mangled — we only ever
  // navigate the bot's webview to http(s), and prefixing https:// onto
  // `javascript:…` / `file://…` would produce nonsense, not safety.
  if (SCHEME_WITH_SLASHES.test(trimmed) || OPAQUE_SCHEME.test(trimmed)) {
    return { ok: false, error: 'URL must be http(s)://' };
  }

  // A bare host (incl. host:port) — assume the user meant a web address.
  return { ok: true, url: `https://${trimmed}` };
}

module.exports = { normalizeNavUrl };
