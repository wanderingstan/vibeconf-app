#!/usr/bin/env node
// screenshot-test.mjs — smoke test for get_call_screenshot (#267 step 2).
// Captures the bot's call view and validates a real, non-trivial PNG comes back.
// This is the building block for the vision-based share-verification test (#267
// step 3): screenshot → check a nonce is visible.
//
// PREREQ: a bot app must be running (it screenshots its embedded view — Meet
// homepage is fine, no call needed):
//   scripts/spawn-test-fleet.sh 1
//
// Run:
//   node scripts/screenshot-test.mjs --bots Jimmy:7901
//   pnpm test:screenshot -- --bots Jimmy:7901
//
// Exit non-zero if capture or PNG validation fails.

import { readFileSync, statSync } from 'fs';
import { Bot, report, record } from './meet-test-lib.mjs';

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def; };
const [name, port] = arg('bots', 'Jimmy:7901').split(',')[0].split(':');
const bot = new Bot(name, Number(port), 'no-room');

// PNG magic number — the first 8 bytes of every valid PNG.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function run() {
  const shot = await bot.screenshot();
  if (!shot.ok || !shot.path) {
    record(bot.name, 'screenshotCaptured', false, 'no path returned (is the bot app up?)');
    return;
  }
  record(bot.name, 'screenshotCaptured', true, shot.path.split('/').pop());

  // Validate it's a real PNG on disk, not an empty/truncated file. capturePage()
  // of a loaded view is comfortably > a few KB; a broken capture is tiny/missing.
  let buf, size;
  try { buf = readFileSync(shot.path); size = statSync(shot.path).size; }
  catch (e) { record(bot.name, 'screenshotValid', false, 'cannot read file: ' + e.message); return; }
  const isPng = buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG);
  const bigEnough = size > 1024;
  record(bot.name, 'screenshotValid', isPng && bigEnough,
    `${isPng ? 'PNG' : 'NOT a PNG'}, ${size} bytes${bigEnough ? '' : ' (too small — blank/broken capture?)'}`);
}

run()
  .catch((err) => { console.error('screenshot-test error:', err && err.message); })
  .finally(() => { const r = report(); process.exit(r.fails > 0 ? 1 : 0); });
