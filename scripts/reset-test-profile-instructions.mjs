#!/usr/bin/env node
// reset-test-profile-instructions.mjs — put a TEST profile's CLAUDE.md back to
// the shipped default before a run.
//
// Why reset rather than patch: a bot's CLAUDE.md is seeded once and never
// overwritten, so a test profile accumulates whatever anyone left in it —
// a persona from debugging a mission last month, a half-finished experiment.
// Then a run's behaviour depends on history nobody remembers, and a red result
// sends someone hunting through the app instead of the profile. Tests should
// start from a state you can name.
//
// It also keeps the real-agent missions honest about the FEATURE: after-call
// work lives in CLAUDE.md by design (#139), so the test has to read the same
// file a fresh install would get — not one that happens to have been patched.
//
// DESTRUCTIVE, and therefore guarded: it refuses any profile whose name does not
// begin with "test-". Real bots' instructions belong to whoever wrote them, and
// this must never be pointed at one by a stray argument.
//
// Usage: node scripts/reset-test-profile-instructions.mjs test-meet-guest-1 […]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { defaultClaudeMd } = require('../electron-app/agent-workdir.js');

// The naming convention every test class shares (spawn-test-fleet.sh):
// test-meet-guest-N, test-meet-google-N, test-slack-N.
const TEST_PROFILE = /^test-/;

function profilesRoot() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Vibeconferencing', 'profiles');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Vibeconferencing', 'profiles');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Vibeconferencing', 'profiles');
}

function reset(profile) {
  if (!TEST_PROFILE.test(profile)) {
    // Loud, and non-zero below: silently skipping would let a typo'd fleet run
    // look like it reset when it didn't.
    throw new Error(`refusing "${profile}" — only test-* profiles may be reset`);
  }
  const dir = path.join(profilesRoot(), profile, 'agent');
  if (!fs.existsSync(dir)) return `${profile}: no agent dir yet (the app seeds it, with the current default, on first launch)`;

  const md = path.join(dir, 'CLAUDE.md');
  const want = defaultClaudeMd();
  const had = fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : null;
  if (had === want) return `${profile}: already at default`;
  fs.writeFileSync(md, want);
  return had === null ? `${profile}: written` : `${profile}: reset to default (${had.length} → ${want.length} bytes)`;
}

const profiles = process.argv.slice(2);
if (profiles.length === 0) {
  console.error('usage: reset-test-profile-instructions.mjs <test-profile> [test-profile…]');
  process.exit(2);
}
let failed = false;
for (const p of profiles) {
  try { console.log('  [instructions]', reset(p)); }
  catch (err) { failed = true; console.error('  [instructions]', err.message); }
}
process.exit(failed ? 1 : 0);
