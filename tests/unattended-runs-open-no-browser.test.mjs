// unattended-runs-open-no-browser.test.mjs — #611: no stray Safari windows.
//
// `start_call` opens a browser on the app's machine because that is how the
// HUMAN gets into the room they just made: the bot joins in an Electron
// webview, the person joins as themselves, in their own browser, with their own
// Google account. Right for the panel button, right for /call typed by someone
// sitting at the keyboard.
//
// Wrong for the nightly. The join-route lane minted a real Meet with the flag at
// its default, so every run opened a Safari window on the mini that no bot ever
// appeared in (they were in their webviews), that nobody ever joined (nobody was
// there), and that nothing ever closed. Worse, the lane retires the room at the
// end, so Meet bounced the orphan to its home page — the pile that accumulated
// on that desktop looked like an app bug rather than the tests' own litter.
// Stan found them by watching the machine during the 2026-08-30 suite.
//
// The flag is named for remote-vs-local, but what it really decides is "is a
// human going to join in that window?". An unattended run on the local machine
// answers no while looking entirely local, which is exactly how this slipped
// through. Until that proxy is replaced (option 2 in #611, deliberately left for
// later), each unattended caller has to remember to say so — so pin the ones
// that mint rooms, because a regression here is invisible on CI and only shows
// up as windows piling on a machine nobody is watching.
//
// These scripts drive a live app and a real Meet, so they can't be exercised
// here; what's pinned is the decision, at the source.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const joinRoute = readFileSync(join(root, 'scripts/join-route-test.mjs'), 'utf8');
const linuxCheck = readFileSync(join(root, 'scripts/linux-agent-terminal-check.sh'), 'utf8');
const mcp = readFileSync(join(root, 'mcp-server/server.js'), 'utf8');

// Comments here name the flag and the incident at length; strip them so prose
// can't satisfy a check that is meant to be about the call being made.
const codeOnly = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('the join-route lane mints its room WITHOUT opening a browser', () => {
  // The reported symptom, and the one call site that produced it: this lane is
  // the only thing in the nightly that mints a Meet (#122 — it hands the room to
  // every live lane below it via VIBECONF_MINTED_ROOM), so it was one orphaned
  // window per run of the whole suite.
  const at = codeOnly(joinRoute).indexOf("name: 'start_call'");
  assert.ok(at > 0, 'the /call check should still call start_call');
  const call = codeOnly(joinRoute).slice(at, at + 200);
  assert.match(call, /open_browser: false/,
    'an unattended lane must opt out, or it leaves a window nobody closes');
});

test('opting out does not cost the lane the room code it exists to publish', () => {
  // The whole point of running start_call in the nightly is the handoff: the
  // room code is scraped out of the tool's own reply text. If suppressing the
  // browser also suppressed the link, this "fix" would silently drop every live
  // lane back to the shared hard-coded fallback room — a far worse outcome than
  // the windows, and one that only shows up as a warning line in the digest.
  //
  // So: the link must be computed once, ABOVE the branch that varies the
  // wording, not inside the "browser opened" arm of it.
  const at = mcp.indexOf('const resp = await vfetch(`${BASE_URL}/api/call/start`');
  assert.ok(at > 0, 'start_call should still POST to /api/call/start');
  const body = codeOnly(mcp.slice(at, at + 1400));
  const linkAt = body.indexOf('const link =');
  const leadAt = body.indexOf('const lead =');
  assert.ok(linkAt > 0 && leadAt > linkAt,
    'the join link must be built before (and independently of) the remote/local wording');
  assert.match(body, /remote\s*\n?\s*\?/, 'only the wording is allowed to branch on remote');
});

test('open_browser:false is what actually reaches the app, not just the tool call', () => {
  // Threading matters more than the argument: a flag the MCP layer accepts and
  // drops looks identical at the call site and fixes nothing.
  const at = mcp.indexOf('const remote = open_browser === false;');
  assert.ok(at > 0, 'start_call should still derive `remote` from the argument');
  assert.match(codeOnly(mcp.slice(at, at + 400)), /JSON\.stringify\(\{ openBrowser: !remote \}\)/,
    'the flag must be posted to /api/call/start, or the argument is decorative');
});

test('the Linux agent-terminal check keeps its opt-out too', () => {
  // The other unattended script that starts a real call, and the precedent this
  // fix follows — it has passed openBrowser:false all along. Pinned so a later
  // edit to that curl can't quietly re-introduce the same litter on that host.
  assert.match(linuxCheck, /"openBrowser":false/,
    'an unattended check must not open a browser it will never use');
});

test('the human paths still get their browser', () => {
  // The failure mode of over-correcting: default the flag to false and the
  // panel button puts a bot in a room and leaves the user to find their own way
  // there. The default lives in main.js (pinned in agent-terminal-spawn.test),
  // so what matters here is that the MCP tool only suppresses on an EXPLICIT
  // false — undefined, the shape every ordinary /call sends, must still open.
  assert.match(mcp, /open_browser: z\.boolean\(\)\.optional\(\)/,
    'the argument stays optional — omitting it is the human case');
  assert.match(mcp, /const remote = open_browser === false;/,
    'strict false only: `!open_browser` would make every plain /call remote');
});
