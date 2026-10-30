#!/usr/bin/env node
// provider-test.mjs: runs the calls library's conformance suite
// (packages/calls/conformance/suite.js) against one platform on one host.
//
// The suite is the same for every provider and host: two bots join, then each
// capability the platform has is checked (roster, hear both ways, chat, share,
// leave), skipping what the platform or host lacks rather than failing it.
//
//   --host electron   (default) the app: a fleet of idle bots from
//                     spawn-test-fleet.sh, driven over the HTTP API
//   --host playwright the library's Playwright host, no app at all: each bot
//                     is a headed Chrome with its own profile
//
// PREREQ for --host electron: a fleet in this platform's profiles, and a
// standing meeting that lets the bots in unattended:
//   Meet:  the open-guest test room (meet-targets.mjs)
//   Zoom:  "join before host" on, captions allowed; test-zoom-1 signed in to
//          Zoom once (a signed-in bot skips the guest reCAPTCHA)
//   Teams: lobby set so everyone bypasses it
//   Slack: test-slack-N profiles signed in to Slack once; the fleet joins the
//          channel's huddle at launch (--slack --slack-url=<channel>)
//   scripts/spawn-test-fleet.sh 2 [--zoom | --teams | --slack --slack-url=<channel>]
//
// Run:
//   node scripts/provider-test.mjs --platform meet  --bots Alice:7901,Bob:7902
//   node scripts/provider-test.mjs --platform zoom  --url <zoom link>  --bots Alice:7901,Bob:7902
//   node scripts/provider-test.mjs --platform teams --url <teams link> --bots Alice:7901,Bob:7902
//   node scripts/provider-test.mjs --platform meet  --host playwright --bots Ada,Ben
//   node scripts/provider-test.mjs --platform slack --url <channel> --bots Alice:7901,Bob:7902
//   (--url falls back to the Meet test room / VIBECONF_ZOOM_URL / VIBECONF_TEAMS_URL / SLACK_TEST_URL)
//
// Exit code is non-zero if any step failed.

import { createRequire } from 'node:module';
import { resolveTarget } from './meet-targets.mjs';
import { ElectronConformanceBot } from './conformance-electron.mjs';

const require = createRequire(import.meta.url);
const { runConformance } = require('../packages/calls/conformance/suite.js');

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def; };

const PLATFORMS = {
  meet: () => `https://meet.google.com/${resolveTarget('default').room}`,
  zoom: () => process.env.VIBECONF_ZOOM_URL,
  teams: () => process.env.VIBECONF_TEAMS_URL,
  slack: () => process.env.SLACK_TEST_URL,
};

const PLATFORM = arg('platform', '');
if (!PLATFORMS[PLATFORM]) {
  console.error(`--platform must be one of: ${Object.keys(PLATFORMS).join(', ')}`);
  process.exit(2);
}
const URL_ = arg('url', PLATFORMS[PLATFORM]() || '');
if (!URL_) {
  console.error(`No meeting link: pass --url or set ${{ zoom: 'VIBECONF_ZOOM_URL', teams: 'VIBECONF_TEAMS_URL', slack: 'SLACK_TEST_URL' }[PLATFORM]}`);
  process.exit(2);
}
const HOST = arg('host', 'electron');

function makeBots() {
  const specs = arg('bots', HOST === 'playwright' ? 'Ada,Ben' : 'Alice:7901,Bob:7902').split(',');
  if (HOST === 'electron') {
    return specs.map((s) => { const [name, port] = s.split(':'); return new ElectronConformanceBot(name, Number(port)); });
  }
  if (HOST === 'playwright') {
    const { PlaywrightConformanceBot } = require('../packages/calls/conformance/playwright-bot.js');
    return specs.map((s) => new PlaywrightConformanceBot(s.split(':')[0]));
  }
  console.error('--host must be electron or playwright');
  process.exit(2);
}

const ICON = { pass: '✅', fail: '❌', skip: '⏭️ ', info: 'ℹ️ ' };
const bots = makeBots();
// The link can carry a passcode; print only the platform.
console.log(`conformance → platform=${PLATFORM}, host=${HOST}, bots: ${bots.map((b) => b.name).join(', ')}`);
runConformance({
  url: URL_,
  bots,
  onResult: (r) => console.log(`${ICON[r.status] || r.status} [${r.bot}] ${r.step}${r.note ? ' — ' + r.note : ''}`),
})
  .then(({ results, failed }) => {
    const n = (s) => results.filter((r) => r.status === s).length;
    console.log(`\n${failed ? '🔴 FAIL' : '🟢 PASS'} — ${n('pass')} passed, ${failed} failed, ${n('skip')} skipped (${PLATFORM} on ${HOST})`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => { console.error('conformance error:', err.message); process.exit(1); });
