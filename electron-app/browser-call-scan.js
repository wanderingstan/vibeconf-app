// browser-call-scan.js — find the calls open in the user's browser.
//
// One AppleScript pass over Chrome, Safari and Brave that reports every Google
// Meet tab and enough about Slack tabs to spot a live huddle. Shared by the
// supervisor (#301), which is the machine's one scanner when it is running,
// and by each bot, which falls back to scanning for itself when it is not.
// It used to live inline in main.js, one copy per running bot, so three bots
// meant three scans every 5 seconds and three "Google Meet Detected" pop-ups
// for one tab.
//
// macOS only: `osascript` does not exist elsewhere. Callers check the platform
// rather than start a poll that cannot succeed.

// Note: Firefox is not supported — it has no AppleScript tab API.
//
// PERF (Stan, 2026-07-05 — polls timed out on EVERY tick, so detection
// silently never fired). Two independent fixes, both needed:
//   1. NO System Events. The old `tell application "System Events" …
//      exists process` preamble alone measured 16.8s on a busy machine —
//      the whole 8s budget gone before touching a browser. The
//      `application "X" is running` form asks launchd directly (fast) and,
//      critically, does NOT launch the app the way a bare `tell
//      application` would.
//   2. BATCHED tab reads: `URL of tabs of w` is one Apple Event per
//      window vs two per TAB. ~48 tabs measured 0.25s batched vs 8s+
//      per-tab.
// Per-window try blocks skip a misbehaving window without aborting the
// whole scan; the per-item try skips tabs whose URL is `missing value`
// (empty Safari tabs).
const browserScanBlock = (appName) => `
if application "${appName}" is running then
  try
    tell application "${appName}"
      repeat with w in windows
        try
          set tabURLs to URL of tabs of w
          set tabTitles to title of tabs of w
          repeat with i from 1 to count of tabURLs
            try
              set tabURL to (item i of tabURLs) as text
              set tabTitle to ""
              try
                set tabTitle to (item i of tabTitles) as text
              end try
              if tabURL starts with "https://meet.google.com/" then
                set allURLs to allURLs & "MEET:" & tabURL & linefeed
              else if tabURL starts with "https://app.slack.com/client/" then
                set allURLs to allURLs & "SLACK:" & tabURL & "|||" & tabTitle & linefeed
              else if tabURL is "about:blank" then
                set allURLs to allURLs & "BLANK:" & tabTitle & linefeed
              end if
            end try
          end repeat
        end try
      end repeat
    end tell
  end try
end if`;

const SCAN_SCRIPT = `
set allURLs to ""
${browserScanBlock('Google Chrome')}
${browserScanBlock('Safari')}
${browserScanBlock('Brave Browser')}
allURLs`;

// The scan's raw output → what it found. Pure, so the huddle-matching rules
// below can be tested without a browser.
//
// Returns { meetUrls, slackHuddleUrl, slackAmbiguous }. slackAmbiguous carries
// the tab titles when a huddle is up but several Slack tabs match none of its
// workspace, which the caller logs rather than guess.
function parseScanOutput(stdout) {
  const lines = String(stdout || '').trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const meetUrls = lines.filter((l) => l.startsWith('MEET:')).map((l) => l.slice(5))
    .filter((u) => /meet\.google\.com\/[a-z]+-[a-z]+-[a-z]+/.test(u));

  // Slack huddle: a live browser huddle shows up as an about:blank window
  // (the huddle popup, whose TITLE carries the workspace) alongside a
  // workspace tab that carries the team/channel. With MULTIPLE Slack tabs
  // open we must pick the one actually IN the huddle, not just the first —
  // so match the huddle popup's workspace to the right tab's title.
  const slackTabs = lines.filter((l) => l.startsWith('SLACK:')).map((l) => {
    const [url, ...rest] = l.slice(6).split('|||');
    return { url, title: (rest.join('|||') || '').trim() };
  }).filter((t) => /app\.slack\.com\/client\/[^/]+\/[^/?#]+/.test(t.url));
  const blankTitles = lines.filter((l) => l.startsWith('BLANK:')).map((l) => l.slice(6).trim());
  const huddleTitle = blankTitles.find((t) => /^Huddle:/i.test(t));
  let slackHuddleUrl = null;
  let slackAmbiguous = null;
  if (huddleTitle) {
    // "Huddle: #channel - Workspace - Slack 🎤" → workspace is the 2nd
    // " - " segment; match the Slack tab whose title names that workspace.
    const ws = (huddleTitle.split(' - ')[1] || '').trim();
    const match = ws && slackTabs.find((t) => t.title.includes(ws));
    slackHuddleUrl = (match && match.url) || (slackTabs.length === 1 ? slackTabs[0].url : null);
    if (slackTabs.length > 1 && !match) {
      slackAmbiguous = { huddleTitle, workspace: ws, tabTitles: slackTabs.map((t) => t.title) };
    }
  } else if (blankTitles.length && slackTabs.length === 1) {
    // A blank (huddle) window + exactly one Slack tab → unambiguous.
    slackHuddleUrl = slackTabs[0].url;
  }
  return { meetUrls, slackHuddleUrl, slackAmbiguous };
}

// -1743 = errAEEventNotPermitted: the user hasn't granted Automation
// permission to control the browser. macOS won't re-prompt once it's been
// denied/dismissed, so the poll fails silently forever unless someone says so.
function isAutomationDenied(stderr) {
  const msg = String(stderr || '');
  return msg.includes('-1743') || /not authorized to send apple events/i.test(msg);
}

// Run one scan. Never rejects: resolves { ok, meetUrls, slackHuddleUrl,
// slackAmbiguous, elapsedMs } or { ok: false, failKey, stderr, elapsedMs }.
// failKey is stable across identical failures, so callers can log a
// persistent problem once instead of every 5 seconds.
function scanBrowsers({ execFile = require('child_process').execFile, timeoutMs = 8000 } = {}) {
  const start = Date.now();
  return new Promise((resolve) => {
    execFile('osascript', ['-e', SCAN_SCRIPT], { timeout: timeoutMs }, (err, stdout, stderr) => {
      const elapsedMs = Date.now() - start;
      if (err) {
        const stderrMsg = (stderr || '').trim();
        const failKey = stderrMsg || (err.killed ? 'timeout' : (err.message || '').slice(0, 80)) || 'unknown';
        resolve({ ok: false, failKey, stderr: stderrMsg, elapsedMs });
        return;
      }
      resolve({ ok: true, ...parseScanOutput(stdout), elapsedMs });
    });
  });
}

module.exports = { SCAN_SCRIPT, parseScanOutput, isAutomationDenied, scanBrowsers };
