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
//      `brew install rclone` + `rclone config` once per machine. If the
//      remote is rooted somewhere the archive isn't under (the mini's is
//      rooted at the nightly-uploads folder), set
//      VIBECONF_RCLONE_ROOT_FOLDER_ID to the archive folder's Drive id: it is
//      passed as --drive-root-folder-id, which re-roots the remote at that
//      folder for this command only, and the archive path is then "" (the
//      root itself). No rclone reconfiguration needed.
//   3. ssh (VIBECONF_SYNC_SSH_DEST="host:/abs/path", or --ssh-dest): rsync
//      over ssh to another machine's disk — the Mac mini's 14 TB archive
//      drive — which then pushes to Drive with rclone on its own timer
//      (scripts/push-archive-to-drive.sh). Takes precedence over the other
//      two when set. The only backend that can PRUNE (below).
//   With none configured it exits 2 and says so; it never silently does
//   nothing.
//
// PRUNING (VIBECONF_SYNC_PRUNE_AFTER_VERIFY=1, or --prune; ssh backend only):
// WHY: a laptop recording a few calls a day fills its disk, and the Drive
// desktop app copying multi-GB videos into its own local cache made that
// worse, not better. After a call is copied, each recording file (mp4, webm,
// …: PRUNE_EXTENSIONS) is sha256-hashed here and on the remote; only a file
// whose hashes match is deleted locally. Transcripts, summaries and logs are
// kept, so the agent still has the call's history. A mismatch or a missing
// remote file keeps the local copy and fails the call loudly. Pruning is
// refused for the Drive-folder backend (a copy into the Drive app's folder
// proves nothing about Drive) and for rclone (not implemented — use ssh).
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
//        [--root-folder-id <Drive folder id>] [--ssh-dest host:/path] [--prune]
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

// What --prune deletes once verified: the recordings, which are nearly all of
// a call's bytes. Everything else (transcripts, summary, logs, manifests)
// stays on disk because the agent reads it.
export const PRUNE_EXTENSIONS = ['.mp4', '.webm', '.mkv', '.mov', '.m4a', '.wav', '.ogg', '.opus'];

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
//
// `suffix`: the same bot in the same room twice on one day (a rejoin, a
// second session) would map both calls to ONE folder, and with copies that
// never overwrite, the second call's call-recording.mp4 would silently never
// be archived (seen on the mini: dcw-goqf-ypa on 2026-08-28 at 18:00 and
// 19:11). The caller passes the later calls' local start time (HHMM) and
// they land in "<bot>-<HHMM>" beside the first, which keeps the plain name.
export function destinationFor(callId, botName, { tzOffsetMin, owner, suffix } = {}) {
  const p = parseCallId(callId);
  if (!p) return null;
  const date = localDateStamp(p.startedAt, tzOffsetMin);
  const bot = botFolderName(botName) + (suffix ? `-${suffix}` : '');
  const rel = `${p.room}-${date}/${bot}`;
  const o = owner ? botFolderName(owner) : '';
  return o ? `${o}/${rel}` : rel;
}

// For a profile's call ids: which ones need a disambiguating suffix (see
// destinationFor). The earliest call of a room-date keeps the bare bot
// folder; every later one gets its local HHMM. Returns Map<callId, suffix>.
export function collisionSuffixes(callIds, { tzOffsetMin } = {}) {
  const groups = new Map();
  for (const id of callIds) {
    const p = parseCallId(id);
    if (!p) continue;
    const key = `${p.room}-${localDateStamp(p.startedAt, tzOffsetMin)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id, t: p.startedAt });
  }
  const out = new Map();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.t - b.t);
    for (const { id, t } of list.slice(1)) {
      const off = tzOffsetMin === undefined ? t.getTimezoneOffset() : tzOffsetMin;
      const local = new Date(t.getTime() - off * 60000);
      out.set(id, local.toISOString().slice(11, 16).replace(':', ''));
    }
  }
  return out;
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

// Needs a (re)sync when never synced, when something in the folder is newer
// than what the last sync saw, or when the call's destination has CHANGED
// since (a same-day sibling call appeared or vanished, moving this one
// between "<bot>" and "<bot>-HHMM"; an owner prefix was added). The marker
// itself is excluded from the walk by being written AFTER newestMtime is
// taken, and by the exclude on copy.
//
// `root`: the backend's destination root (see destinationRoot). A call synced
// to the Drive folder has NOT been synced to the mini; without this, switching
// backends would leave every already-synced call behind. A marker with no
// `root` (older script) counts as a different root: one extra pass.
export function needsSync(callDir, markerFile = DEFAULTS.markerFile, rel = null, root = null) {
  const marker = readMarker(callDir, markerFile);
  const newest = newestMtimeExcluding(callDir, markerFile);
  if (!marker || !Number.isFinite(marker.newestMtime)) return true;
  // A marker with no `rel` predates this check: one extra pass (cheap — the
  // copies skip what's there) beats guessing where it went.
  if (rel && marker.rel !== rel) return true;
  if (root && marker.root !== root) return true;
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
export function pickBackend({ dest, remote, archivePath, haveRclone, rcloneRemotes, rootFolderId = null, sshDest = null }) {
  if (sshDest) {
    const m = /^([^:/\s]+):(\/.*)$/.exec(sshDest);
    if (!m) return { kind: 'none', reason: `ssh destination must be host:/absolute/path, got: ${sshDest}` };
    return { kind: 'ssh', host: m[1], dest: m[2].replace(/\/+$/, '') };
  }
  if (dest) {
    if (!fs.existsSync(dest)) return { kind: 'none', reason: `archive dir does not exist: ${dest}` };
    return { kind: 'rsync', dest };
  }
  if (!haveRclone) return { kind: 'none', reason: 'no VIBECONF_DRIVE_ARCHIVE_DIR/--dest, and rclone is not installed (brew install rclone; rclone config)' };
  const name = remote.replace(/:.*$/, '');
  if (!rcloneRemotes.includes(name)) {
    return { kind: 'none', reason: `rclone remote "${name}" is not configured (rclone listremotes shows: ${rcloneRemotes.join(', ') || 'none'})` };
  }
  // With a root folder id the remote IS the archive for this command, so the
  // archive path collapses to the root unless one was set explicitly.
  if (rootFolderId) return { kind: 'rclone', remote: name, archivePath: process.env.VIBECONF_RCLONE_ARCHIVE_PATH ? archivePath : '', rootFolderId };
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
    rootFolderId: process.env.VIBECONF_RCLONE_ROOT_FOLDER_ID || null,
    sshDest: process.env.VIBECONF_SYNC_SSH_DEST || null,
    prune: /^(1|true|yes)$/i.test(process.env.VIBECONF_SYNC_PRUNE_AFTER_VERIFY || ''),
    profilesRoot: defaultProfilesRoot(),
  };
  // "*" in the config file means every profile (test fleets come and go).
  if (o.profiles.includes('*')) o.allProfiles = true;
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
    else if (a === '--root-folder-id') o.rootFolderId = next();
    else if (a === '--ssh-dest') o.sshDest = next();
    else if (a === '--prune') o.prune = true;
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

// The ssh program, overridable so the tests can stand a local directory in
// for the remote host (see tests/sync-calls-to-drive.test.mjs).
const sshCmd = () => process.env.VIBECONF_SYNC_SSH_CMD || 'ssh';
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20'];
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function sshRun(host, script, verbose) {
  if (verbose) console.log(`  $ ${sshCmd()} ${host} ${script}`);
  const r = spawnSync(sshCmd(), [...SSH_OPTS, host, script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || '').trim().split('\n').slice(-5).join('\n');
    throw new Error(`${sshCmd()} ${host} exited ${r.status}${err ? `: ${err}` : ''}`);
  }
  return r.stdout;
}

function copyCall(backend, callDir, relDest, { dryRun, verbose }) {
  if (backend.kind === 'ssh') {
    const target = `${backend.dest}/${relDest}`;
    if (!dryRun) sshRun(backend.host, `mkdir -p ${shq(target)}`, verbose);
    // Same flags as the local rsync backend. -e: our ssh, non-interactive so
    // a launchd run with no agent fails fast instead of hanging on a prompt.
    const args = ['-rt', '--ignore-existing', '-e', [sshCmd(), ...SSH_OPTS].join(' '), '--exclude', '.DS_Store', '--exclude', DEFAULTS.markerFile, ...(dryRun ? ['-n'] : []), ...(verbose ? ['-v'] : []), callDir + path.sep, `${backend.host}:${target}/`];
    return run('rsync', args, verbose);
  }
  if (backend.kind === 'rsync') {
    const target = path.join(backend.dest, relDest);
    if (!dryRun) fs.mkdirSync(target, { recursive: true });
    // -rt: recurse, keep mtimes (so the newer-file comparison works next
    // time). No -a: ownership/perms mean nothing on Drive and make openrsync
    // (macOS's rsync) complain. Trailing slash on the source = contents.
    const args = ['-rt', '--ignore-existing', '--exclude', '.DS_Store', '--exclude', DEFAULTS.markerFile, ...(dryRun ? ['-n'] : []), ...(verbose ? ['-v'] : []), callDir + path.sep, target + path.sep];
    return run('rsync', args, verbose);
  }
  const target = `${backend.remote}:${[backend.archivePath, relDest].filter(Boolean).join('/')}`;
  // copy (not sync): never deletes anything on Drive. --ignore-existing: a
  // file already there (the agent's own upload) is never touched.
  const args = ['copy', '--ignore-existing', ...(backend.rootFolderId ? ['--drive-root-folder-id', backend.rootFolderId] : []), '--exclude', '.DS_Store', '--exclude', DEFAULTS.markerFile, ...(dryRun ? ['--dry-run'] : []), ...(verbose ? ['-v'] : []), callDir, target];
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

// Recording files under a call folder, as paths relative to it.
export function prunableFiles(callDir) {
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && PRUNE_EXTENSIONS.includes(path.extname(ent.name).toLowerCase())) out.push(path.relative(callDir, p));
    }
  };
  walk(callDir);
  return out.sort();
}

function sha256Local(file) {
  // shasum streams; reading a multi-GB video into node's heap would not.
  return execFileSync('shasum', ['-a', '256', file], { encoding: 'utf8' }).split(/\s/)[0];
}

// Hash every recording on both sides; delete the local copy of each one that
// matches. Returns what was deleted. Throws (after deleting the matches) if
// any file didn't match, so the call is reported FAILED and retried next run.
export function verifyAndPrune(backend, callDir, relDest, { verbose } = {}) {
  const files = prunableFiles(callDir);
  if (!files.length) return [];
  const target = `${backend.dest}/${relDest}`;
  // One round trip: `sync` so the hash is of what is on the platter, then a
  // hash per file; a missing file prints MISSING instead of failing the batch.
  const script = `cd ${shq(target)} && sync && for f in ${files.map(shq).join(' ')}; do if [ -f "$f" ]; then shasum -a 256 "$f"; else echo "MISSING  $f"; fi; done`;
  const remote = new Map();
  for (const line of sshRun(backend.host, script, verbose).split('\n')) {
    const m = /^(\S+)\s+\*?(.+)$/.exec(line);
    if (m) remote.set(m[2], m[1]);
  }
  const pruned = [], bad = [];
  for (const rel of files) {
    const p = path.join(callDir, rel);
    const bytes = fs.statSync(p).size;
    const local = sha256Local(p);
    if (remote.get(rel) === local) {
      fs.unlinkSync(p);
      pruned.push({ file: rel, bytes, sha256: local });
    } else {
      bad.push(`${rel} (${remote.get(rel) === 'MISSING' || !remote.has(rel) ? 'not on remote' : 'hash differs'})`);
    }
  }
  if (bad.length) {
    const err = new Error(`kept ${bad.length} file(s) that did not verify: ${bad.join(', ')}`);
    err.pruned = pruned;
    throw err;
  }
  return pruned;
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
    const rc = o.dest || o.sshDest ? { have: false, remotes: [] } : rcloneRemotesOnPath();
    backend = pickBackend({ dest: o.dest, remote: o.remote, archivePath: o.archivePath, haveRclone: rc.have, rcloneRemotes: rc.remotes, rootFolderId: o.rootFolderId, sshDest: o.sshDest });
    if (backend.kind === 'none') {
      console.error(`[${stamp()}] cannot sync: ${backend.reason}`);
      return 2;
    }
    if (o.prune && backend.kind !== 'ssh') {
      console.error(`[${stamp()}] cannot prune with the ${backend.kind} backend: only an ssh copy is verified before deleting (set VIBECONF_SYNC_SSH_DEST)`);
      return 2;
    }
  }
  const where = backend.kind === 'ssh' ? `${backend.host}:${backend.dest}`
    : backend.kind === 'rsync' ? backend.dest
    : backend.kind === 'rclone' ? `${backend.remote}:${backend.archivePath}${backend.rootFolderId ? ` (root folder ${backend.rootFolderId})` : ''}`
    : '(status only)';
  console.log(`[${stamp()}] ${o.dryRun ? 'DRY RUN — ' : ''}profiles: ${profiles.join(', ')} → ${where}${o.prune ? ' (prune after verify)' : ''}`);

  let synced = 0, skippedBusy = 0, upToDate = 0, failed = 0, ignored = 0, prunedBytes = 0;
  for (const profile of profiles) {
    const profileDir = path.join(o.profilesRoot, profile);
    const callsDir = path.join(profileDir, 'agent', 'calls');
    const callIds = safeReaddir(callsDir).sort();
    const suffixes = collisionSuffixes(callIds);
    for (const callId of callIds) {
      const callDir = path.join(callsDir, callId);
      if (!fs.statSync(callDir).isDirectory()) continue;
      const botName = botNameFor(callDir, profileDir, profile);
      const rel = destinationFor(callId, botName, { owner: o.owner, suffix: suffixes.get(callId) });
      if (!rel) { ignored++; if (o.verbose) console.log(`  ignore ${profile}/${callId} (not a call id)`); continue; }
      const marker = readMarker(callDir);
      if (o.status) {
        const state = !isQuiescent(callDir, o.minAgeMin) ? 'busy' : needsSync(callDir, DEFAULTS.markerFile, rel, o.status ? null : where) ? (marker ? (marker.rel && marker.rel !== rel ? `destination changed (was ${marker.rel})` : 'changed since last sync') : 'never synced') : `synced ${marker.at}`;
        console.log(`  ${profile}/${callId} → ${rel}: ${state}`);
        continue;
      }
      if (!isQuiescent(callDir, o.minAgeMin)) {
        skippedBusy++;
        if (o.verbose) console.log(`  busy  ${profile}/${callId} (modified in the last ${o.minAgeMin} min)`);
        continue;
      }
      // A call that already synced here can still have recordings left to
      // prune (pruning switched on later, or a file failed to verify).
      const leftToPrune = o.prune && prunableFiles(callDir).length > 0;
      if (!needsSync(callDir, DEFAULTS.markerFile, rel, where) && !leftToPrune) { upToDate++; continue; }
      const newest = newestMtimeExcluding(callDir, DEFAULTS.markerFile);
      const writeMarker = (pruned) => {
        const prev = readMarker(callDir) || {};
        fs.writeFileSync(path.join(callDir, DEFAULTS.markerFile), JSON.stringify({
          at: new Date().toISOString(), backend: backend.kind, destination: `${where}/${rel}`, root: where, rel, newestMtime: newest,
          ...((prev.pruned || pruned.length) ? { pruned: [...(prev.pruned || []), ...pruned] } : {}),
        }, null, 2) + '\n');
      };
      try {
        copyCall(backend, callDir, rel, o);
        let pruned = [];
        if (o.prune && !o.dryRun) {
          try { pruned = verifyAndPrune(backend, callDir, rel, o); } catch (err) { if (err.pruned) writeMarker(err.pruned); throw err; }
        }
        if (!o.dryRun) writeMarker(pruned);
        synced++;
        const freed = pruned.reduce((n, f) => n + f.bytes, 0);
        prunedBytes += freed;
        console.log(`  ${o.dryRun ? 'would sync' : 'synced'} ${profile}/${callId} → ${rel}${pruned.length ? ` (pruned ${pruned.length} recording(s), ${(freed / 1e9).toFixed(2)} GB)` : ''}`);
      } catch (err) {
        failed++;
        console.error(`  FAILED ${profile}/${callId} → ${rel}: ${err.message}`);
      }
    }
  }
  if (!o.status) {
    console.log(`[${stamp()}] done: ${synced} synced, ${upToDate} already up to date, ${skippedBusy} still busy, ${failed} failed${ignored ? `, ${ignored} ignored` : ''}${prunedBytes ? `, ${(prunedBytes / 1e9).toFixed(2)} GB pruned locally` : ''}`);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  process.exit(main());
}
