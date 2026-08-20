#!/usr/bin/env node
// etiquette-prep.mjs — put the VOICE's disguise in place BEFORE the fleet boots.
//
// WHY THIS CANNOT BE DONE FROM THE HARNESS. The barge-in rules need the voice to
// look like a person, which means it must never register itself in room presence
// as `role: 'bot'` (#471). But a bot registers on its first active call state,
// and a freshly spawned fleet app adopts its previous room at startup — so it has
// already announced itself before the harness gets a chance to say otherwise.
//
// Measured: the subject logged "roster now knows 2 bot name(s)" at 22:49:34,
// twenty-three seconds BEFORE it even registered itself at 22:49:57. The voice's
// row was already there.
//
// `set_preference` at runtime does persist — but only AFTER the harness has run,
// which is already too late: the app registers on its first active call state,
// at boot. So the value has to be on disk before the app starts.
//
// Write it to <profile>/agent/config.json, NOT <profile>/config.json. The latter
// is the LEGACY location: main.js migrates per-profile settings into the agent
// dir on first launch and leaves the old file behind as a safety net, so it sits
// there looking authoritative while nothing reads it. An earlier version of this
// script wrote the legacy file and the disguise silently did nothing — and the
// same stale file made set_preference look broken (#476) when it was working
// perfectly, just somewhere else.
//
// Usage:
//   scripts/spawn-test-fleet.sh 2 --kill
//   node scripts/etiquette-prep.mjs
//   scripts/spawn-test-fleet.sh 2
//   node scripts/etiquette-test.mjs --room paz-sqoa-npe

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };

const PROFILE = arg('profile', 'test-meet-guest-2');       // the VOICE
const NAME = arg('name', 'Jimmy');
const ROOM = arg('room', 'paz-sqoa-npe');
const SITE = (process.env.VIBECONF_WEBSITE_URL || 'https://vibeconferencing.com').replace(/\/$/, '');

// agentDirFor() is <userData>/agent — see electron-app/agent-workdir.js.
const profileDir = join(homedir(), 'Library', 'Application Support', 'Vibeconferencing',
  'profiles', PROFILE);
const cfgPath = join(profileDir, 'agent', 'config.json');
const legacyPath = join(profileDir, 'config.json');

if (!existsSync(cfgPath)) {
  console.error(`no agent config for profile "${PROFILE}" at ${cfgPath}`);
  if (existsSync(legacyPath)) {
    console.error(`(a LEGACY ${legacyPath} exists — the app migrates out of it on first`);
    console.error(' launch and then ignores it, so writing there has no effect)');
  }
  console.error('boot the fleet once so the profile exists, then kill it and re-run this.');
  process.exit(2);
}

const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const was = cfg.announceAsBot;
cfg.announceAsBot = false;
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
console.log(`${PROFILE}: announceAsBot ${JSON.stringify(was ?? '(unset)')} → false`);
console.log(`  (${cfgPath})`);

// Clear every presence row for the room. Both halves matter: the voice must not
// re-register (the config above), AND no stale row may survive, because
// mergeRemoteMembers lets a remote 'bot' upgrade a local 'member' and never the
// reverse — so one poll against a leftover row poisons the subject for its whole
// session, and no amount of later suppression undoes it.
const res = await fetch(`${SITE}/api/room/${encodeURIComponent(ROOM)}/presence`);
const members = (await res.json().catch(() => ({}))).members || [];
for (const m of members) {
  await fetch(`${SITE}/api/room/${encodeURIComponent(ROOM)}/presence?name=${encodeURIComponent(m.name)}`,
    { method: 'DELETE' }).catch(() => {});
}
console.log(`cleared ${members.length} presence row(s) in ${ROOM}`);

const after = await (await fetch(`${SITE}/api/room/${encodeURIComponent(ROOM)}/presence`)).json();
console.log('presence now:',
  (after.members || []).map((m) => `${m.name}=${m.role}`).join(' | ') || '(empty)');
console.log(`\nnow boot the fleet — ${NAME} will join without announcing itself as a bot.`);
