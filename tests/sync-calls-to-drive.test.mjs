// sync-calls-to-drive.test.mjs — the Drive archive fallback
// (scripts/sync-calls-to-drive.mjs): naming, "is this call finished",
// re-sync detection, backend selection, and an end-to-end run against a
// temp archive dir through the rsync backend.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const mod = await import('../scripts/sync-calls-to-drive.mjs');
const {
  parseCallId, destinationFor, botFolderName, isQuiescent, needsSync,
  botNameFor, pickBackend, listProfiles, main, DEFAULTS, loadConfigFile,
} = mod;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sync-calls-'));
const HAVE_RSYNC = (() => { try { execSync('command -v rsync', { stdio: 'ignore' }); return true; } catch { return false; } })();

// A fake profile with one call folder shaped like the app writes it.
function fakeCall(root, profile, callId, { botName = 'Jimmy', ageMin = 60, files = {} } = {}) {
  const callDir = path.join(root, profile, 'agent', 'calls', callId);
  fs.mkdirSync(path.join(callDir, 'call-recording-tracks'), { recursive: true });
  fs.writeFileSync(path.join(callDir, 'call-recording-tracks', 'manifest.json'), JSON.stringify({ botName, tracks: [] }));
  fs.writeFileSync(path.join(callDir, 'call-recording.mp4'), 'not really video');
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(callDir, name), body);
  const t = new Date(Date.now() - ageMin * 60000);
  for (const p of walk(callDir)) fs.utimesSync(p, t, t);
  return callDir;
}
function walk(d) {
  const out = [];
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, ent.name);
    if (ent.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

test('a call id parses into room code + UTC start; the Drive folder is room + LOCAL date + bot name', () => {
  const p = parseCallId('wcj-odpo-wrb-20260817T233159Z');
  assert.equal(p.room, 'wcj-odpo-wrb');
  assert.equal(p.startedAt.toISOString(), '2026-08-17T23:31:59.000Z');
  // 23:31Z is still the 17th in UTC, and the 17th at UTC-6 (Denver) — but the
  // 18th at UTC+2. The date is the LOCAL one, so the folder a human expects.
  assert.equal(destinationFor('wcj-odpo-wrb-20260817T233159Z', 'Jimmy', { tzOffsetMin: 0 }), 'wcj-odpo-wrb-2026-08-17/jimmy');
  assert.equal(destinationFor('wcj-odpo-wrb-20260817T233159Z', 'Jimmy', { tzOffsetMin: 360 }), 'wcj-odpo-wrb-2026-08-17/jimmy');
  assert.equal(destinationFor('wcj-odpo-wrb-20260817T233159Z', 'Jimmy', { tzOffsetMin: -120 }), 'wcj-odpo-wrb-2026-08-18/jimmy');
  assert.equal(destinationFor('summary-notes', 'Jimmy'), null, 'a non-call folder is left alone');
  // Optional per-person parent folder, for a team that prefers not to merge.
  assert.equal(destinationFor('wcj-odpo-wrb-20260817T233159Z', 'Jimmy', { tzOffsetMin: 0, owner: 'Stan' }), 'stan/wcj-odpo-wrb-2026-08-17/jimmy');
  assert.equal(parseCallId('abc-defg-hij'), null);
});

test('the bot subfolder is the lowercase name, filesystem-safe, never empty', () => {
  assert.equal(botFolderName('Jimmy'), 'jimmy');
  assert.equal(botFolderName('Dev Bot 2'), 'dev-bot-2');
  assert.equal(botFolderName('  Hedwig ✨ '), 'hedwig');
  assert.equal(botFolderName(''), 'bot');
  assert.equal(botFolderName(null), 'bot');
});

test('the bot name comes from the recording manifest, then the profile config, then the profile name', () => {
  const root = tmp();
  const withManifest = fakeCall(root, 'Default', 'aaa-bbbb-ccc-20260901T100000Z', { botName: 'Pepper' });
  assert.equal(botNameFor(withManifest, path.join(root, 'Default'), 'Default'), 'Pepper');

  const noManifest = path.join(root, 'bot8', 'agent', 'calls', 'aaa-bbbb-ccc-20260901T100000Z');
  fs.mkdirSync(noManifest, { recursive: true });
  fs.writeFileSync(path.join(root, 'bot8', 'agent', 'config.json'), JSON.stringify({ botName: 'Eight' }));
  assert.equal(botNameFor(noManifest, path.join(root, 'bot8'), 'bot8'), 'Eight');

  const bare = path.join(root, 'test-x', 'agent', 'calls', 'aaa-bbbb-ccc-20260901T100000Z');
  fs.mkdirSync(bare, { recursive: true });
  assert.equal(botNameFor(bare, path.join(root, 'test-x'), 'test-x'), 'test-x');
});

test('a call is finished only once nothing in it has changed for the quiet period', () => {
  const root = tmp();
  const old = fakeCall(root, 'Default', 'aaa-bbbb-ccc-20260901T100000Z', { ageMin: 60 });
  assert.equal(isQuiescent(old, 10), true);
  const busy = fakeCall(root, 'Default', 'aaa-bbbb-ccc-20260901T110000Z', { ageMin: 2 });
  assert.equal(isQuiescent(busy, 10), false, 'a merge or summary still being written must not be copied half-done');
  // One fresh file inside an otherwise old folder is enough to hold it back.
  fs.writeFileSync(path.join(old, 'summary.md'), 'late');
  assert.equal(isQuiescent(old, 10), false);
  const empty = path.join(root, 'Default', 'agent', 'calls', 'aaa-bbbb-ccc-20260901T120000Z');
  fs.mkdirSync(empty, { recursive: true });
  assert.equal(isQuiescent(empty, 10), false, 'an empty folder is not a finished call');
});

test('needsSync: never synced, or something newer than the last sync saw; the marker itself never counts', () => {
  const root = tmp();
  const dir = fakeCall(root, 'Default', 'aaa-bbbb-ccc-20260901T100000Z', { ageMin: 60 });
  assert.equal(needsSync(dir), true);
  fs.writeFileSync(path.join(dir, DEFAULTS.markerFile), JSON.stringify({ newestMtime: Date.now() - 60 * 60000 + 1 }));
  assert.equal(needsSync(dir), false, 'marker newer than every file → up to date');
  fs.writeFileSync(path.join(dir, 'summary.md'), 'the agent wrote this after the first sync');
  assert.equal(needsSync(dir), true, 'a file newer than the marker → sync again');
});

test('backend selection: a synced Drive dir wins, else a configured rclone remote, else a clear reason', () => {
  const dir = tmp();
  assert.equal(pickBackend({ dest: dir, remote: 'X', archivePath: 'a', haveRclone: true, rcloneRemotes: ['X'] }).kind, 'rsync');
  assert.match(pickBackend({ dest: path.join(dir, 'missing'), remote: 'X', archivePath: 'a', haveRclone: true, rcloneRemotes: ['X'] }).reason, /does not exist/);
  const rc = pickBackend({ dest: null, remote: 'Vibeconf Shared Files', archivePath: 'vibeconf-call-archives', haveRclone: true, rcloneRemotes: ['Vibeconf Shared Files', 'gdrive'] });
  assert.deepEqual(rc, { kind: 'rclone', remote: 'Vibeconf Shared Files', archivePath: 'vibeconf-call-archives' });
  assert.match(pickBackend({ dest: null, remote: 'Vibeconf Shared Files', archivePath: 'a', haveRclone: true, rcloneRemotes: ['other'] }).reason, /not configured/);
  assert.match(pickBackend({ dest: null, remote: 'Vibeconf Shared Files', archivePath: 'a', haveRclone: false, rcloneRemotes: [] }).reason, /rclone is not installed/);
});

test('only the requested profiles are walked unless --all-profiles', () => {
  const root = tmp();
  fakeCall(root, 'Default', 'aaa-bbbb-ccc-20260901T100000Z');
  fakeCall(root, 'test-record', 'aaa-bbbb-ccc-20260901T100000Z');
  fs.mkdirSync(path.join(root, 'no-calls-here'), { recursive: true });
  assert.deepEqual(listProfiles(root, { profiles: ['Default'], allProfiles: false }), ['Default']);
  assert.deepEqual(listProfiles(root, { profiles: ['Default'], allProfiles: true }).sort(), ['Default', 'test-record']);
});

test('end to end through the rsync backend: copies finished calls into <room-date>/<bot>/, skips busy ones, is idempotent, and re-syncs new files', { skip: !HAVE_RSYNC }, () => {
  const root = tmp();
  const archive = tmp();
  const done = fakeCall(root, 'Default', 'wcj-odpo-wrb-20260901T150000Z', { botName: 'Jimmy', ageMin: 30, files: { 'summary.md': 'hi' } });
  fakeCall(root, 'Default', 'wcj-odpo-wrb-20260901T160000Z', { botName: 'Jimmy', ageMin: 1 });
  fs.mkdirSync(path.join(root, 'Default', 'agent', 'calls', 'not-a-call'), { recursive: true });

  const logs = [];
  const origLog = console.log; const origErr = console.error;
  console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' '));
  try {
    assert.equal(main(['--profiles-root', root, '--dest', archive, '--profiles', 'Default']), 0);
  } finally { console.log = origLog; console.error = origErr; }
  const out = logs.join('\n');
  assert.match(out, /synced Default\/wcj-odpo-wrb-20260901T150000Z/);
  assert.match(out, /1 synced, 0 already up to date, 1 still busy, 0 failed, 1 ignored/);

  const rel = destinationFor('wcj-odpo-wrb-20260901T150000Z', 'Jimmy');
  const dest = path.join(archive, rel);
  assert.ok(fs.existsSync(path.join(dest, 'call-recording.mp4')));
  assert.ok(fs.existsSync(path.join(dest, 'call-recording-tracks', 'manifest.json')));
  assert.ok(fs.existsSync(path.join(dest, 'summary.md')));
  assert.ok(!fs.existsSync(path.join(dest, DEFAULTS.markerFile)), 'the marker stays local');
  assert.ok(fs.existsSync(path.join(done, DEFAULTS.markerFile)), 'the marker is written next to the call');
  assert.ok(!fs.existsSync(path.join(archive, 'wcj-odpo-wrb-2026-09-01', 'jimmy', 'call-recording-tracks', 'nope')));

  // Second run: nothing to do.
  logs.length = 0;
  console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' '));
  try { assert.equal(main(['--profiles-root', root, '--dest', archive, '--profiles', 'Default']), 0); }
  finally { console.log = origLog; console.error = origErr; }
  assert.match(logs.join('\n'), /0 synced, 1 already up to date, 1 still busy/);

  // The agent's summary lands later (old enough to count as quiet): synced again, incrementally.
  fs.writeFileSync(path.join(done, 'session-log.txt'), 'late file');
  const t = new Date(Date.now() - 20 * 60000);
  fs.utimesSync(path.join(done, 'session-log.txt'), t, t);
  logs.length = 0;
  console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' '));
  try { assert.equal(main(['--profiles-root', root, '--dest', archive, '--profiles', 'Default']), 0); }
  finally { console.log = origLog; console.error = origErr; }
  assert.match(logs.join('\n'), /1 synced/);
  assert.ok(fs.existsSync(path.join(dest, 'session-log.txt')));
});

test('with no backend configured the run exits 2 and says why, rather than silently doing nothing', () => {
  const root = tmp();
  fakeCall(root, 'Default', 'wcj-odpo-wrb-20260901T150000Z');
  const logs = [];
  const origLog = console.log; const origErr = console.error;
  console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' '));
  let code;
  try { code = main(['--profiles-root', root, '--dest', path.join(root, 'no-such-archive'), '--profiles', 'Default']); }
  finally { console.log = origLog; console.error = origErr; }
  assert.equal(code, 2);
  assert.match(logs.join('\n'), /cannot sync: archive dir does not exist/);
});

test('--status reports each call without copying anything', () => {
  const root = tmp();
  fakeCall(root, 'Default', 'wcj-odpo-wrb-20260901T150000Z', { ageMin: 30 });
  fakeCall(root, 'Default', 'wcj-odpo-wrb-20260901T160000Z', { ageMin: 1 });
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try { assert.equal(main(['--profiles-root', root, '--status', '--profiles', 'Default']), 0); }
  finally { console.log = origLog; }
  const out = logs.join('\n');
  assert.match(out, /150000Z → wcj-odpo-wrb-2026-09-01\/jimmy: never synced/);
  assert.match(out, /160000Z → wcj-odpo-wrb-2026-09-01\/jimmy: busy/);
});

test('the config file sets VIBECONF_* without overriding the environment, and expands $HOME', () => {
  const f = path.join(tmp(), 'sync-calls.env');
  fs.writeFileSync(f, '# comment\nVIBECONF_SYNC_OWNER=stan\nexport VIBECONF_DRIVE_ARCHIVE_DIR="$HOME/My Drive/archive"\nVIBECONF_SYNC_PROFILES=Default,dev\nnot a setting\n');
  const env = { VIBECONF_SYNC_PROFILES: 'already' };
  const loaded = loadConfigFile(f, env);
  assert.deepEqual(loaded.sort(), ['VIBECONF_DRIVE_ARCHIVE_DIR', 'VIBECONF_SYNC_OWNER']);
  assert.equal(env.VIBECONF_SYNC_OWNER, 'stan');
  assert.equal(env.VIBECONF_DRIVE_ARCHIVE_DIR, path.join(os.homedir(), 'My Drive', 'archive'));
  assert.equal(env.VIBECONF_SYNC_PROFILES, 'already', 'the environment wins');
  assert.deepEqual(loadConfigFile(path.join(tmp(), 'missing.env'), {}), []);
});

test('a file already on Drive under the same path is never overwritten (the agent got there first)', { skip: !HAVE_RSYNC }, () => {
  const root = tmp();
  const archive = tmp();
  fakeCall(root, 'Default', 'wcj-odpo-wrb-20260901T150000Z', { botName: 'Jimmy', ageMin: 30 });
  const rel = destinationFor('wcj-odpo-wrb-20260901T150000Z', 'Jimmy');
  fs.mkdirSync(path.join(archive, rel), { recursive: true });
  fs.writeFileSync(path.join(archive, rel, 'call-recording.mp4'), 'the agent uploaded this one');
  const origLog = console.log; const origErr = console.error; console.log = () => {}; console.error = () => {};
  try { assert.equal(main(['--profiles-root', root, '--dest', archive, '--profiles', 'Default']), 0); }
  finally { console.log = origLog; console.error = origErr; }
  assert.equal(fs.readFileSync(path.join(archive, rel, 'call-recording.mp4'), 'utf8'), 'the agent uploaded this one');
  assert.ok(fs.existsSync(path.join(archive, rel, 'call-recording-tracks', 'manifest.json')), 'the missing files are still filled in');
});
