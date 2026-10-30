// slack-ua.js — single source of truth for the browser identity the app presents.
// Slack's sign-in page gates on browser version, and it checks BOTH the legacy UA
// string AND UA Client Hints (navigator.userAgentData + the Sec-CH-UA* request
// headers). Electron's session.setUserAgent() only spoofs the legacy STRING; the
// Client Hints keep leaking the real engine (Electron 33 = Chromium 130), so a
// too-old-Chromium gate ("We're very sorry, but your browser is not supported!")
// fires on the sign-in flow even though the string looks fine. We spoof Chrome
// CONSISTENTLY across the string, the request headers, and userAgentData.
//
// Two identities, one per kind of site:
//   UA:        current Chrome (CHROME). Slack, Teams, Zoom and the calling apps
//               gate on a minimum version. Bump CHROME when one raises it.
//   ENGINE_UA: Chrome at the version the engine really is. Google (Meet and its
//               sign-in) runs a bot check that compares the claimed version with
//               what the engine can do: claiming Chrome 150 on Chromium 130 gets
//               a signed-out guest "You can't join this video call" before the
//               name box appears (2026-10-29, after #914). Chrome/131 joined
//               fine, so it is the distance from the engine that trips it.
//
// The header spoof and the userAgentData shim read the version from the UA string
// each request / page actually carries, so the hints always agree with whichever
// identity that webContents was given, on a partition several surfaces share.
const CHROME = '150';
const ENGINE_FULL = process.versions.chrome || `${CHROME}.0.0.0`; // e.g. 130.0.6723.191
const ENGINE = ENGINE_FULL.split('.')[0];

const uaFor = (major) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
const UA = uaFor(CHROME);
const ENGINE_UA = uaFor(ENGINE);

// The Chrome major a UA string claims, else CHROME. An unspoofed Electron string
// ("Chrome/130.0.6723.191 Electron/33...") reads as the engine, which is true.
function majorOf(ua) {
  const m = /Chrome\/(\d+)/.exec(ua || '');
  return m ? m[1] : CHROME;
}
// Full version for a major: the real build number when it is the engine's own
// version, else the frozen-looking N.0.0.0.
const fullFor = (major) => (major === ENGINE ? ENGINE_FULL : `${major}.0.0.0`);

// Sec-CH-UA* header values (must include a "Google Chrome" brand — real Chrome has
// it, Chromium/Electron doesn't, and that's a common tell sites check for).
const secChUa = (major) => `"Not/A)Brand";v="8", "Chromium";v="${major}", "Google Chrome";v="${major}"`;
const secChUaFull = (major) => `"Not/A)Brand";v="8.0.0.0", "Chromium";v="${fullFor(major)}", "Google Chrome";v="${fullFor(major)}"`;
const SEC_CH_UA = secChUa(CHROME);
const SEC_CH_UA_FULL = secChUaFull(CHROME);

// Rewrite the Sec-CH-UA* request headers on a session so they match the string
// that request carries. Dedupes any case-variant Chromium already added. Call
// once per session (main process); a second call replaces the first, harmlessly,
// since both do the same thing. No-op-safe if webRequest is unavailable.
function installHeaderSpoof(sess) {
  const names = ['sec-ch-ua', 'sec-ch-ua-full-version-list', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'];
  try {
    sess.webRequest.onBeforeSendHeaders((details, cb) => {
      const h = details.requestHeaders;
      const uaKey = Object.keys(h).find((k) => k.toLowerCase() === 'user-agent');
      const major = majorOf(uaKey ? h[uaKey] : '');
      for (const k of Object.keys(h)) { if (names.includes(k.toLowerCase())) delete h[k]; }
      Object.assign(h, {
        'Sec-CH-UA': secChUa(major),
        'Sec-CH-UA-Full-Version-List': secChUaFull(major),
        'Sec-CH-UA-Mobile': '?0',
        'Sec-CH-UA-Platform': '"macOS"',
      });
      cb({ requestHeaders: h });
    });
  } catch { /* best effort */ }
}

// Shim navigator.userAgentData so CLIENT-SIDE checks (navigator.userAgentData.brands
// / getHighEntropyValues) agree with the spoofed string. Runs from a preload
// (contextIsolation:false → same realm as the page, before its scripts).
function installClientHintsShim() {
  /* eslint-disable no-undef */
  if (typeof navigator === 'undefined') return; // main process — nothing to do
  const major = majorOf(navigator.userAgent);
  const full = fullFor(major);
  const brands = [
    { brand: 'Not/A)Brand', version: '8' },
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major },
  ];
  const fullVersionList = [
    { brand: 'Not/A)Brand', version: '8.0.0.0' },
    { brand: 'Chromium', version: full },
    { brand: 'Google Chrome', version: full },
  ];
  const fake = {
    brands,
    mobile: false,
    platform: 'macOS',
    getHighEntropyValues(hints) {
      const all = {
        architecture: 'arm', bitness: '64', model: '', mobile: false,
        platform: 'macOS', platformVersion: '14.6.0', wow64: false,
        brands, fullVersionList, uaFullVersion: full,
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

module.exports = { CHROME, ENGINE, UA, ENGINE_UA, SEC_CH_UA, SEC_CH_UA_FULL, majorOf, installHeaderSpoof, installClientHintsShim };
