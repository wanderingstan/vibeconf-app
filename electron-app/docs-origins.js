// Which browser origins may call the local servers cross-origin.
//
// The control API binds 127.0.0.1, and since #356 a web page gets no CORS
// headers unless its origin is allowlisted, so it can neither read bot state
// nor drive a bot. The API explorer (docs/api/explorer.html) is the one page
// that legitimately needs to: it is hosted at vibeconferencing.com/api and
// lets the user run requests against their own bot, after they paste the
// bot's token. Allowing the origin widens nothing on its own: every request
// still needs the bearer token, which a page cannot read off disk.
//
// VIBECONF_ALLOWED_ORIGINS (comma list) adds to these; it does not replace
// them. VIBECONF_WEBSITE_URL is included so a self-hosted site works too.

const DEFAULT_ALLOWED_ORIGINS = [
  'https://vibeconferencing.com',
  'https://www.vibeconferencing.com',
];

function allowedOrigins(extra = []) {
  const env = (process.env.VIBECONF_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const site = [];
  try { if (process.env.VIBECONF_WEBSITE_URL) site.push(new URL(process.env.VIBECONF_WEBSITE_URL).origin); } catch { /* not a URL */ }
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...site, ...env, ...extra]);
}

// Set the CORS headers for one request, if its origin is allowed. Returns
// true when the origin was allowed. Chrome's Private Network Access gate
// also needs the explicit opt-in on the preflight before it lets a public
// page reach 127.0.0.1, so that header rides along.
function applyCors(req, res, { extra = [], methods = 'GET, POST, OPTIONS' } = {}) {
  const origin = req.headers.origin;
  if (!origin || !allowedOrigins(extra).has(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  return true;
}

module.exports = { DEFAULT_ALLOWED_ORIGINS, allowedOrigins, applyCors };
