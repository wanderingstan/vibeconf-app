// slack-ua.js — single source of truth for the browser identity the Slack surface
// presents. Slack's sign-in page gates on browser version, and it checks BOTH the
// legacy UA string AND UA Client Hints (navigator.userAgentData + the Sec-CH-UA*
// request headers). Electron's session.setUserAgent() only spoofs the legacy STRING;
// the Client Hints keep leaking the real engine (Electron 33 = Chromium 130), so a
// too-old-Chromium gate ("We're very sorry, but your browser is not supported!")
// fires on the sign-in flow even though the string looks fine. We spoof a current
// Chrome CONSISTENTLY across the string, the request headers, and userAgentData.
//
// Bump CHROME when Slack raises its minimum again — that's the only knob.
const CHROME = '150';

const UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME}.0.0.0 Safari/537.36`;

// Sec-CH-UA* header values (must include a "Google Chrome" brand — real Chrome has
// it, Chromium/Electron doesn't, and that's a common tell sites check for).
const SEC_CH_UA = `"Not/A)Brand";v="8", "Chromium";v="${CHROME}", "Google Chrome";v="${CHROME}"`;
const SEC_CH_UA_FULL = `"Not/A)Brand";v="8.0.0.0", "Chromium";v="${CHROME}.0.0.0", "Google Chrome";v="${CHROME}.0.0.0"`;

// Rewrite the Sec-CH-UA* request headers on a session so they match the spoofed
// string. Dedupes any case-variant Chromium already added. Call once per session
// (main process). No-op-safe if webRequest is unavailable.
function installHeaderSpoof(sess) {
  const overrides = {
    'Sec-CH-UA': SEC_CH_UA,
    'Sec-CH-UA-Full-Version-List': SEC_CH_UA_FULL,
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"macOS"',
  };
  const lower = Object.keys(overrides).map((k) => k.toLowerCase());
  try {
    sess.webRequest.onBeforeSendHeaders((details, cb) => {
      const h = details.requestHeaders;
      for (const k of Object.keys(h)) { if (lower.includes(k.toLowerCase())) delete h[k]; }
      Object.assign(h, overrides);
      cb({ requestHeaders: h });
    });
  } catch { /* best effort */ }
}

// Shim navigator.userAgentData so CLIENT-SIDE checks (navigator.userAgentData.brands
// / getHighEntropyValues) agree with the spoofed string. Runs from a Slack preload
// (contextIsolation:false → same realm as the page, before its scripts).
function installClientHintsShim() {
  /* eslint-disable no-undef */
  if (typeof navigator === 'undefined') return; // main process — nothing to do
  const brands = [
    { brand: 'Not/A)Brand', version: '8' },
    { brand: 'Chromium', version: CHROME },
    { brand: 'Google Chrome', version: CHROME },
  ];
  const fullVersionList = [
    { brand: 'Not/A)Brand', version: '8.0.0.0' },
    { brand: 'Chromium', version: `${CHROME}.0.0.0` },
    { brand: 'Google Chrome', version: `${CHROME}.0.0.0` },
  ];
  const fake = {
    brands,
    mobile: false,
    platform: 'macOS',
    getHighEntropyValues(hints) {
      const all = {
        architecture: 'arm', bitness: '64', model: '', mobile: false,
        platform: 'macOS', platformVersion: '14.6.0', wow64: false,
        brands, fullVersionList, uaFullVersion: `${CHROME}.0.0.0`,
      };
      const out = {};
      (hints || []).forEach((k) => { if (k in all) out[k] = all[k]; });
      return Promise.resolve(out);
    },
    toJSON() { return { brands, mobile: false, platform: 'macOS' }; },
  };
  try { Object.defineProperty(navigator, 'userAgentData', { configurable: true, get: () => fake }); }
  catch { /* non-configurable on this build — best effort */ }
  /* eslint-enable no-undef */
}

module.exports = { CHROME, UA, SEC_CH_UA, SEC_CH_UA_FULL, installHeaderSpoof, installClientHintsShim };
