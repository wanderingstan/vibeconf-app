#!/usr/bin/env node
// sync-calls-to-drive.mjs — copy every finished call folder to the team's
// Google Drive archive, on a timer, with nothing that can get "interrupted".
//
// WHY: the bot's own after-call work already uploads a call's artifacts to
// Drive (see the agent's CLAUDE.md, "If the call was recorded, upload…"). That
// runs inside an LLM session through the Drive connector, and it is only as
// reliable as that session: the connector loses its authorisation, the agent
// gets cut off mid-upload, the after-call window expires, or the bot simply
// forgets. Each of those quietly leaves a call with no copy on Drive. This is
// the fallback that doesn't depend on any of it: a plain script run by launchd
// every half hour that walks the on-disk call folders and copies what isn't
// on Drive yet. It is idempotent and incremental (rclone/rsync only move what
// is missing or newer), so the agent's own upload and this one never fight —
// whichever gets there first, the other finds nothing to do.
//
// LAYOUT on Drive (matches the convention the agent's CLAUDE.md sets, so the
// two paths land in the same place):
//
//   <archive root>/<room-code>-<YYYY-MM-DD>/<bot name>/<everything in calls/<call-id>/>
//
// Room code + date, NOT the call id, as the top folder: the call id carries the
// second each bot joined, so two bots in the same call mint different ids and
// their artifacts would never line up. The bot's name is the subfolder, so two
// bots' views of the same call sit side by side. The date is the machine's
// LOCAL date of the call's start (the call id's timestamp is UTC).
//
// Two people running this against the same archive therefore line their
// recordings of one call up automatically, which is the thing that was awkward
// to do by hand. If you'd rather each person had their own parent folder
// instead, set VIBECONF_SYNC_OWNER (or --owner): the layout becomes
// <archive root>/<owner>/<room-code>-<date>/<bot name>/.
//
// TWO BACKENDS, picked automatically:
//   1. A local Google Drive sync folder (VIBECONF_DRIVE_ARCHIVE_DIR, or --dest):
//      plain rsync into it, the Drive desktop app does the upload. Note the
//      team archive lives in a folder SHARED WITH you ("VIBECONF Shared Files"),
//      and shared-with-me folders don't sync to disk until you add a shortcut
//      to them in My Drive — do that, then point this at the shortcut.
//   2. rclone (VIBECONF_RCLONE_REMOTE, default "Vibeconf Shared Files" — the
//      remote the nightly test suite already uploads through on the mini):
//      `rclone copy` straight to the archive path on that remote. Needs
//      `brew install rclone` + `rclone config` once per machine.
//   With neither configured it exits 2 and says so; it never silently does
//   nothing.
//
// CONFIGURATION lives in ~/.config/vibeconf/sync-calls.env (KEY=VALUE lines,
// read by this script itself), not in a shell profile: launchd runs a
// non-interactive login shell, which never sources ~/.zshrc, and the project's
// CLAUDE.md has a whole section on the hours that particular trap has cost.
// Environment variables already set still win over the file.
//
// FAIL-SAFE AGAINST THE AGENT'S OWN UPLOAD: copies use --ignore-existing on
// both backends. A file that is already on Drive under the same path — the
// bot's after-call work got there first — is left exactly as it is, never
// overwritten, however it compares. This script fills gaps; it is not the
// authority on what a file should contain.
//
// WHAT COUNTS AS FINISHED: a call folder is skipped while anything in it was
// modified in the last VIBECONF_SYNC_MIN_AGE_MIN minutes (default 10). A
// recording still being written, a merge still running, or the agent still
// writing its summary all show up as recent mtimes; ten quiet minutes means
// it's done. A folder that later gains a file (the agent's summary landing
// after the first sync) is picked up on the next run — the per-call marker
// file records the newest mtime synced, and anything newer triggers another
// pass.
//
// Usage:
//   node scripts/sync-calls-to-drive.mjs [--dry-run] [--status] [--verbose]
//        [--profiles Default,dev | --all-profiles] [--min-age-min N]
//        [--dest /path/to/synced/archive] [--remote "Name:path"] [--owner stan]
//   Config file: ~/.config/vibeconf/sync-calls.env (VIBECONF_* KEY=VALUE lines)
//
// Install the timer: see scripts/com.vibeconf.sync-calls.plist and
// scripts/SCHEDULING.md ("Call archive sync to Drive").

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

export const CONFIG_FILE = path.join(os.homedir(), '.config', 'vibeconf', 'sync-calls.env');

// KEY=VALUE lines → process.env, without overriding anything already set.
// Blank lines and # comments ignored; a value may be double-quoted.
export function loadConfigFile(file = CONFIG_FILE, env = process.env) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const loaded = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    v = v.replace(/\$HOME\b|~(?=\/|$)/g, os.homedir());
    if (env[m[1]] === undefined) { env[m[1]] = v; loaded.push(m[1]); }
  }
  return loaded;
}

export const DEFAULTS = {
  profiles: ['Default'],
  minAgeMin: 10,
  rcloneRemote: 'Vibeconf Shared Files',
  rcloneArchivePath: 'vibeconf-call-archives',
  markerFile: '.drive-sync.json',
};

// ---- pure helpers (unit-tested in tests/sync-calls-to-drive.test.mjs) ----

// "wcj-odpo-wrb-20260817T233159Z" -> { room: 'wcj-odpo-wrb', startedAt: Date }
export function parseCallId(callId) {
  const m = /^(.*)-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(callId || ''));
  if (!m) return null;
  const [, room, Y, M, D, h, mi, s] = m;
  return { room, startedAt: new Date(Date.UTC(+Y, +M - 1, +D, +h, +mi, +s)) };
}

function localDateStamp(d, tzOffsetMin = d.getTimezoneOffset()) {
  // Local calendar date, formatted without relying on locale.
  const local = new Date(d.getTime() - tzOffsetMin * 60000);
  return local.toISOString().slice(0, 10);
}

// A bot name as a folder name: lowercase, spaces to dashes, nothing that a
// filesystem or Drive would object to. The agent's own uploads use the
// lowercase name ("jimmy", "pepper"), so this lands beside them.
export function botFolderName(name) {
  const s = String(name || '').toLowerCase()
    .replace(/[^a-z0-9._\s-]/g, '') // drop emoji and punctuation first, so their spaces don't become dashes
    .trim().replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return s || 'bot';
}

// Where a call goes, relative to the archive root, or null for a folder whose
// name isn't a call id (nothing to do with it; leave it alone).
export function destinationFor(callId, botName, { tzOffsetMin, owner } = {}) {
  const p = parseCallId(callId);
  if (!p) return null;
  const date = localDateStamp(p.startedAt, tzOffsetMin);
  const rel = `${p.room}-${date}/${botFolderName(botName)}`;
  const o = owner ? botFolderName(owner) : '';
  return o ? `${o}/${rel}` : rel;
}

// Newest mtime (ms) of any file under dir, walking subfolders. 0 for empty.
export function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) {
        const t = fs.statSync(p).mtimeMs;
        if (t > newest) newest = t;
      }
    }
  };
  walk(dir);
  return newest;
}

// Finished = quiet for minAgeMin minutes. `now` injectable for tests. The
// sync marker this script writes is excluded, or every successful sync would
// make its own folder look busy for the next ten minutes.
export function isQuiescent(dir, minAgeMin, now = Date.now()) {
  const newest = newestMtimeExcluding(dir, DEFAULTS.markerFile);
  return newest > 0 && now - newest >= minAgeMin * 60000;
}

export function readMarker(callDir, markerFile = DEFAULTS.markerFile) {
  try { return JSON.parse(fs.readFileSync(path.join(callDir, markerFile), 'utf8')); } catch { return null; }
}

// Needs a (re)sync when never synced, or when something in the folder is newer
// than what the last sync saw. The marker itself is excluded from the walk by
// being written AFTER newestMtime is taken, and by the exclude on copy.
export function needsSync(callDir, markerFile = DEFAULTS.markerFile) {
  const marker = readMarker(callDir, markerFile);
  const newest = newestMtimeExcluding(callDir, markerFile);
  if (!marker || !Number.isFinite(marker.newestMtime)) return true;
  return newest > marker.newestMtime;
}

export function newestMtimeExcluding(dir, name) {
  let newest = 0;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.name === name || ent.name === '.DS_Store') continue;
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) {
        const t = fs.statSync(p).mtimeMs;
        if (t > newest) newest = t;
      }
    }
  };
  walk(dir);
  return newest;
}

// The bot's name for a call: the recording manifest knows it exactly (the name
// the bot joined under); otherwise the profile's configured botName; otherwise
// the profile folder's name.
export function botNameFor(callDir, profileDir, profileName) {
  for (const ent of safeReaddir(callDir)) {
    if (!/^call-recording-tracks/.test(ent)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(callDir, ent, 'manifest.json'), 'utf8'));
      if (m && m.botName) return m.botName;
    } catch { /* no manifest in this tracks dir */ }
  }
  for (const f of [path.join(profileDir, 'agent', 'config.json'), path.join(profileDir, 'config.json')]) {
    try {
      const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (cfg && cfg.botName) return cfg.botName;
    } catch { /* not there */ }
  }
  return profileName;
}

function safeReaddir(d) { try { return fs.readdirSync(d); } catch { return []; } }

// Which backend, given the environment. Returns { kind: 'rsync'|'rclone', ... }
// or { kind: 'none', reason }.
export function pickBackend({ dest, remote, archivePath, haveRclone, rcloneRemotes }) {
  if (dest) {
    if (!fs.existsSync(dest)) return { kind: 'none', reason: `archive dir does not exist: ${dest}` };
    return { kind: 'rsync', dest };
  }
  if (!haveRclone) return { kind: 'none', reason: 'no VIBECONF_DRIVE_ARCHIVE_DIR/--dest, and rclone is not installed (brew install rclone; rclone config)' };
  const name = remote.replace(/:.*$/, '');
  if (!rcloneRemotes.includes(name)) {
    return { kind: 'none', reason: `rclone remote "${name}" is not configured (rclone listremotes shows: ${rcloneRemotes.join(', ') || 'none'})` };
  }
  return { kind: 'rclone', remote: name, archivePath };
}

// ---- the run ----

export function defaultProfilesRoot() {
  if (process.env.VIBECONF_PROFILES_ROOT) return process.env.VIBECONF_PROFILES_ROOT;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Vibeconferencing', 'profiles');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Vibeconferencing', 'profiles');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Vibeconferencing', 'profiles');
}

function parseArgs(argv) {
  loadConfigFile();
  const o = {
    dryRun: false, status: false, verbose: false, allProfiles: false,
    profiles: (process.env.VIBECONF_SYNC_PROFILES || DEFAULTS.profiles.join(',')).split(',').map((s) => s.trim()).filter(Boolean),
    minAgeMin: Number(process.env.VIBECONF_SYNC_MIN_AGE_MIN || DEFAULTS.minAgeMin),
    dest: process.env.VIBECONF_DRIVE_ARCHIVE_DIR || null,
    remote: process.env.VIBECONF_RCLONE_REMOTE || DEFAULTS.rcloneRemote,
    archivePath: process.env.VIBECONF_RCLONE_ARCHIVE_PATH || DEFAULTS.rcloneArchivePath,
    owner: process.env.VIBECONF_SYNC_OWNER || null,
    profilesRoot: defaultProfilesRoot(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--status') o.status = true;
    else if (a === '--verbose' || a === '-v') o.verbose = true;
    else if (a === '--all-profiles') o.allProfiles = true;
    else if (a === '--profiles') o.profiles = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--min-age-min') o.minAgeMin = Number(next());
    else if (a === '--dest') o.dest = next();
    else if (a === '--remote') o.remote = next();
    else if (a === '--owner') o.owner = next();
    else if (a === '--profiles-root') o.profilesRoot = next();
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`unknown argument: ${a}`); printHelp(); process.exit(1); }
  }
  return o;
}

function printHelp() {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
}

function rcloneRemotesOnPath() {
  try {
    const out = execFileSync('rclone', ['listremotes'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { have: true, remotes: out.split('\n').map((s) => s.trim().replace(/:$/, '')).filter(Boolean) };
  } catch (err) {
    return { have: err && err.code !== 'ENOENT', remotes: [] };
  }
}

function copyCall(backend, callDir, relDest, { dryRun, verbose }) {
  if (backend.kind === 'rsync') {
    const target = path.join(backend.dest, relDest);
    if (!dryRun) fs.mkdirSync(target, { recursive: true });
    // -rt: recurse, keep mtimes (so the newer-file comparison works next
    // time). No -a: ownership/perms mean nothing on Drive and make openrsync
    // (macOS's rsync) complain. Trailing slash on the source = contents.
    const args = ['-rt', '--ignore-existing', '--exclude', '.DS_Store', '--exclude', DEFAULTS.markerFile, ...(dryRun ? ['-n'] : []), ...(verbose ? ['-v'] : []), callDir + path.sep, target + path.sep];
    return run('rsync', args, verbose);
  }
  const target = `${backend.remote}:${backend.archivePath}/${relDest}`;
  // copy (not sync): never deletes anything on Drive. --ignore-existing: a
  // file already there (the agent's own upload) is never touched.
  const args = ['copy', '--ignore-existing', '--exclude', '.DS_Store', '--exclude', DEFAULTS.markerFile, ...(dryRun ? ['--dry-run'] : []), ...(verbose ? ['-v'] : []), callDir, target];
  return run('rclone', args, verbose);
}

function run(cmd, args, verbose) {
  if (verbose) console.log(`  $ ${cmd} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (verbose && r.stdout) process.stdout.write(r.stdout);
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || '').trim().split('\n').slice(-5).join('\n');
    throw new Error(`${cmd} exited ${r.status}${err ? `: ${err}` : ''}`);
  }
}

export function listProfiles(root, { profiles, allProfiles }) {
  const all = safeReaddir(root).filter((n) => fs.existsSync(path.join(root, n, 'agent', 'calls')));
  return allProfiles ? all : all.filter((n) => profiles.includes(n));
}

export function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  const profiles = listProfiles(o.profilesRoot, o);
  if (!profiles.length) {
    console.log(`[${stamp()}] no profiles with calls under ${o.profilesRoot} (looked for: ${o.allProfiles ? 'all' : o.profiles.join(', ')})`);
    return 0;
  }

  let backend = { kind: 'status' };
  if (!o.status) {
    const rc = o.dest ? { have: false, remotes: [] } : rcloneRemotesOnPath();
    backend = pickBackend({ dest: o.dest, remote: o.remote, archivePath: o.archivePath, haveRclone: rc.have, rcloneRemotes: rc.remotes });
    if (backend.kind === 'none') {
      console.error(`[${stamp()}] cannot sync: ${backend.reason}`);
      return 2;
    }
  }
  const where = backend.kind === 'rsync' ? backend.dest : backend.kind === 'rclone' ? `${backend.remote}:${backend.archivePath}` : '(status only)';
  console.log(`[${stamp()}] ${o.dryRun ? 'DRY RUN — ' : ''}profiles: ${profiles.join(', ')} → ${where}`);

  let synced = 0, skippedBusy = 0, upToDate = 0, failed = 0, ignored = 0;
  for (const profile of profiles) {
    const profileDir = path.join(o.profilesRoot, profile);
    const callsDir = path.join(profileDir, 'agent', 'calls');
    for (const callId of safeReaddir(callsDir).sort()) {
      const callDir = path.join(callsDir, callId);
      if (!fs.statSync(callDir).isDirectory()) continue;
      const botName = botNameFor(callDir, profileDir, profile);
      const rel = destinationFor(callId, botName, { owner: o.owner });
      if (!rel) { ignored++; if (o.verbose) console.log(`  ignore ${profile}/${callId} (not a call id)`); continue; }
      const marker = readMarker(callDir);
      if (o.status) {
        const state = !isQuiescent(callDir, o.minAgeMin) ? 'busy' : needsSync(callDir) ? (marker ? 'changed since last sync' : 'never synced') : `synced ${marker.at}`;
        console.log(`  ${profile}/${callId} → ${rel}: ${state}`);
        continue;
      }
      if (!isQuiescent(callDir, o.minAgeMin)) {
        skippedBusy++;
        if (o.verbose) console.log(`  busy  ${profile}/${callId} (modified in the last ${o.minAgeMin} min)`);
        continue;
      }
      if (!needsSync(callDir)) { upToDate++; continue; }
      const newest = newestMtimeExcluding(callDir, DEFAULTS.markerFile);
      try {
        copyCall(backend, callDir, rel, o);
        if (!o.dryRun) {
          fs.writeFileSync(path.join(callDir, DEFAULTS.markerFile), JSON.stringify({
            at: new Date().toISOString(), backend: backend.kind, destination: `${where}/${rel}`, newestMtime: newest,
          }, null, 2) + '\n');
        }
        synced++;
        console.log(`  ${o.dryRun ? 'would sync' : 'synced'} ${profile}/${callId} → ${rel}`);
      } catch (err) {
        failed++;
        console.error(`  FAILED ${profile}/${callId} → ${rel}: ${err.message}`);
      }
    }
  }
  if (!o.status) {
    console.log(`[${stamp()}] done: ${synced} synced, ${upToDate} already up to date, ${skippedBusy} still busy, ${failed} failed${ignored ? `, ${ignored} ignored` : ''}`);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  process.exit(main());
}
