#!/usr/bin/env node
// profile-pref.mjs — write per-profile prefs where the APP actually reads them.
//
// #305 moved the per-profile store out of <profile>/config.json and into
// <profile>/agent/config.json, so the agent dir is the single home for
// everything that defines a bot. main.js migrates a legacy loose config ONCE —
// on the first launch that finds no agent config — and never reads the loose
// file again.
//
// That makes a script which keeps writing <profile>/config.json silently inert
// the moment the agent config exists: the write succeeds, the file on disk looks
// right, and the app loads none of it. Both fleet scripts did exactly that, so
// the per-bot voices and names were being written to a file nothing reads (found
// 2026-09-09 by booting a fleet and asking the running bots what they thought
// their names were — the on-disk config said Bob, the bot said "Unnamed bot").
//
// Resolution order matches the app's, deliberately reusing its own modules so
// the two cannot drift:
//   1. <profile>/agent/config.json            — the store, created if absent
//   2. seeded from <profile>/config.json      — same one-time, non-destructive
//      migration main.js does (app-level keys filtered out via config-scope),
//      so seeding a profile that predates #305 doesn't drop its prefs
//
// Usage: node scripts/profile-pref.mjs <profile-dir> key=value [key=value …]
//   'true'/'false' are written as JSON booleans; everything else as a string.
//   Idempotent: writes only when a value actually changes, and says what it did.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const { agentDirFor, perProfileSubset } = require(join(REPO, 'electron-app/agent-workdir.js'));
const { APP_LEVEL_KEYS } = require(join(REPO, 'electron-app/config-scope.js'));

const [profileDir, ...pairs] = process.argv.slice(2);
if (!profileDir || !pairs.length) {
  console.error('usage: profile-pref.mjs <profile-dir> key=value [key=value …]');
  process.exit(2);
}

const agentDir = agentDirFor(profileDir);
const target = join(agentDir, 'config.json');
const legacy = join(profileDir, 'config.json');

mkdirSync(agentDir, { recursive: true });

let cfg = {};
if (existsSync(target)) {
  try { cfg = JSON.parse(readFileSync(target, 'utf8')); } catch { cfg = {}; }
} else if (existsSync(legacy)) {
  // Same seed main.js performs, so a pre-#305 profile keeps its prefs instead of
  // starting empty the moment this script creates the agent config.
  try { cfg = perProfileSubset(JSON.parse(readFileSync(legacy, 'utf8')), APP_LEVEL_KEYS); } catch { cfg = {}; }
}

const changed = [];
for (const pair of pairs) {
  const i = pair.indexOf('=');
  if (i < 1) { console.error(`skipping malformed pair: ${pair}`); continue; }
  const key = pair.slice(0, i);
  const raw = pair.slice(i + 1);
  const value = raw === 'true' ? true : raw === 'false' ? false : raw;
  if (cfg[key] !== value) { cfg[key] = value; changed.push(`${key}=${raw}`); }
}

if (changed.length) {
  writeFileSync(target, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`  • ${profileDir.split('/').pop()} → ${changed.join(' ')}`);
}
