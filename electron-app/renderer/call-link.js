// call-link.js — find the meeting link in whatever got pasted.
//
// The panel's "call link" box takes a pasted invite, and invites are mostly
// prose: Zoom wraps its link in "Stan is inviting you to a scheduled Zoom
// meeting… Meeting ID… Passcode…", Teams in "Join the meeting now… Meeting
// options… Learn more", Meet in phone numbers and PINs. So this scans the text
// for URLs, ignores everything else, and returns the first one that is
// actually a MEETING link for a provider the app can join — skipping the other
// links invites carry ("Meeting options", "Learn more", zoom.us/download, …).
//
// Also handled, because that's what real pastes look like:
//   • scheme-less links ("meet.google.com/abc-defg-hij", "zoom.us/j/123…")
//   • <angle-bracketed> links and trailing punctuation
//   • Outlook Safe Links and Google redirect wrappers (work email rewrites every
//     link through one: ...safelinks.protection.outlook.com/?url=<encoded>)
//
// Pure: no DOM, no requires. Loaded by panel.html as a plain script (exposes
// window.findCallLink) and by the unit tests via module.exports.

(function () {
  // Each provider: does this URL point at a joinable meeting?
  const PROVIDERS = [
    { id: 'meet', test: (u) => /(^|\.)meet\.google\.com$/i.test(u.hostname) && /^\/[a-z]+-[a-z]+-[a-z]+(\/|$)/i.test(u.pathname) },
    { id: 'slack', test: (u) => /^app\.slack\.com$/i.test(u.hostname) && /^\/client\/[^/]+\/[^/?#]+/.test(u.pathname) },
    { id: 'zoom', test: (u) => /(^|\.)zoom\.us$/i.test(u.hostname) && /\/(j|wc(\/join)?)\/\d{9,11}(\/|$)/.test(u.pathname) },
    {
      id: 'teams',
      test: (u) => /(^|\.)teams\.(live|microsoft)\.com$/i.test(u.hostname)
        && (/^\/meet\/\d{6,20}(\/|$)/.test(u.pathname) || /^\/l\/meetup-join\//i.test(u.pathname)),
    },
  ];

  // Candidate URL-ish tokens: with a scheme, or a bare host we know.
  const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+|\b(?:[a-z0-9-]+\.)*(?:meet\.google\.com|zoom\.us|teams\.live\.com|teams\.microsoft\.com|app\.slack\.com)\/[^\s<>"'`]+/gi;

  function clean(token) {
    // Trailing punctuation from prose ("…/j/123456789." or "(link)").
    let s = token.replace(/[.,;:!?)\]}>'"]+$/, '');
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    return s;
  }

  // Unwrap redirectors that wrap the real link in a query parameter.
  function unwrap(u) {
    for (let i = 0; i < 3; i++) {
      const host = u.hostname.toLowerCase();
      let inner = null;
      if (host.endsWith('safelinks.protection.outlook.com')) inner = u.searchParams.get('url');
      else if ((host === 'www.google.com' || host === 'google.com') && u.pathname === '/url') inner = u.searchParams.get('q') || u.searchParams.get('url');
      if (!inner) return u;
      try { u = new URL(inner); } catch { return u; }
    }
    return u;
  }

  // → { provider: 'meet'|'slack'|'zoom'|'teams', url } for the first meeting
  //   link in `text`, or null. `url` is the normalized link (scheme added,
  //   redirector removed), ready to hand to the join path.
  function findCallLink(text) {
    const s = String(text == null ? '' : text);
    for (const m of s.matchAll(URL_RE)) {
      let u;
      try { u = unwrap(new URL(clean(m[0]))); } catch { continue; }
      const p = PROVIDERS.find((x) => x.test(u));
      if (!p) continue;
      // One canonical Meet URL (drops "www.", a trailing slash, any query), as
      // the panel's old toMeetUrl did.
      if (p.id === 'meet') return { provider: 'meet', url: 'https://meet.google.com/' + u.pathname.split('/')[1].toLowerCase() };
      return { provider: p.id, url: u.href };
    }
    // A bare Meet code typed or pasted on its own ("wcj-odpo-wrb"). Whole input
    // only: a hyphenated word inside prose ("follow-up-call") is not a code.
    const bare = s.trim().match(/^([a-z]+-[a-z]+-[a-z]+)$/i);
    if (bare) return { provider: 'meet', url: 'https://meet.google.com/' + bare[1].toLowerCase() };
    return null;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { findCallLink };
  if (typeof window !== 'undefined') window.findCallLink = findCallLink;
})();
