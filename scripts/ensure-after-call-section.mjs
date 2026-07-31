#!/usr/bin/env node
// ensure-after-call-section.mjs — give a test profile the current after-call
// instructions, so the fuzz test actually exercises them (#139).
//
// The problem this solves: a bot's CLAUDE.md is seeded ONCE, when its agent dir
// is first created, and never overwritten — deliberately, because it is the
// user's file. Every test profile predates the "After the call" section, so
// without this the real-agent mission would grade the handoff message alone and
// the template's instructions would go untested forever. The design puts the
// behaviour in CLAUDE.md; the test has to read the same file.
//
// INSERTS, never overwrites. A test profile still carries whatever else has been
// put in it, and re-running is a no-op.
//
// Only ever point this at test profiles. It edits a file the app treats as
// owned by whoever wrote it.
//
// Usage: node scripts/ensure-after-call-section.mjs test-meet-guest-1 test-meet-guest-2

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { defaultClaudeMd } = require('../electron-app/agent-workdir.js');

const HEADING = '## After the call';
// Where the template puts it, so an inserted section lands in the same place a
// freshly seeded one would.
const ANCHOR = '## Make it yours';

function profilesRoot() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Vibeconferencing', 'profiles');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Vibeconferencing', 'profiles');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Vibeconferencing', 'profiles');
}

// The section as the current template writes it — lifted rather than duplicated,
// so this can't drift from what a new profile would get.
function sectionFromTemplate() {
  const tpl = defaultClaudeMd();
  const start = tpl.indexOf(HEADING);
  const end = tpl.indexOf(ANCHOR);
  if (start < 0 || end < 0 || end < start) {
    throw new Error('template no longer has an "After the call" section before "Make it yours"');
  }
  return tpl.slice(start, end);
}

function ensure(profile) {
  const md = path.join(profilesRoot(), profile, 'agent', 'CLAUDE.md');
  if (!fs.existsSync(md)) return `${profile}: no CLAUDE.md yet (the app seeds it on first launch — it will include the section)`;

  const current = fs.readFileSync(md, 'utf8');
  if (current.includes(HEADING)) return `${profile}: already has it`;

  const section = sectionFromTemplate();
  // Prefer the template's own position; fall back to appending so a profile
  // whose file has been rewritten still gets the instructions.
  const out = current.includes(ANCHOR)
    ? current.replace(ANCHOR, section + ANCHOR)
    : `${current.trimEnd()}\n\n${section.trimEnd()}\n`;
  fs.writeFileSync(md, out);
  return `${profile}: inserted`;
}

const profiles = process.argv.slice(2);
if (profiles.length === 0) {
  console.error('usage: ensure-after-call-section.mjs <profile> [profile…]');
  process.exit(2);
}
for (const p of profiles) {
  try { console.log('  [after-call]', ensure(p)); }
  catch (err) { console.log('  [after-call]', `${p}: skipped — ${err.message}`); }
}
