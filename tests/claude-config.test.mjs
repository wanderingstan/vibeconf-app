// claude-config.test.mjs — regression tests for the ~/.claude.json data-loss bug.
// A present-but-unreadable/malformed config must NEVER be reported readable (so the
// caller won't rewrite it from {} and erase every other MCP server), and writes must
// be atomic (temp file + rename) so a crash can't truncate the real config.
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { readClaudeConfigSafe, atomicWriteJson } = require('../electron-app/claude-config.js');

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vibeconf-claude-'));

test('missing file (ENOENT): safe to create — readable, empty config', () => {
  const p = path.join(tmpHome(), '.claude.json');
  const { config, readable } = readClaudeConfigSafe(p);
  assert.equal(readable, true);
  assert.deepEqual(config, {});
});

test('malformed JSON: NOT readable, and the read leaves the file untouched', () => {
  const p = path.join(tmpHome(), '.claude.json');
  const truncated = '{ "mcpServers": { "other": {  ';
  fs.writeFileSync(p, truncated);
  const { config, readable } = readClaudeConfigSafe(p);
  assert.equal(readable, false, 'malformed config must report unreadable so the caller skips the write');
  assert.deepEqual(config, {});
  assert.equal(fs.readFileSync(p, 'utf-8'), truncated, 'reading never mutates the file');
});

test('valid object: readable, parsed, all keys intact', () => {
  const p = path.join(tmpHome(), '.claude.json');
  const original = { mcpServers: { other: { command: 'x' }, another: { command: 'y' } }, unrelated: 1 };
  fs.writeFileSync(p, JSON.stringify(original));
  const { config, readable } = readClaudeConfigSafe(p);
  assert.equal(readable, true);
  assert.deepEqual(config, original);
});

test('valid JSON but not an object (array): NOT readable — do not trust it', () => {
  const p = path.join(tmpHome(), '.claude.json');
  fs.writeFileSync(p, '[1,2,3]');
  assert.equal(readClaudeConfigSafe(p).readable, false);
});

test('REGRESSION: adding our server preserves every other MCP server', () => {
  const p = path.join(tmpHome(), '.claude.json');
  atomicWriteJson(p, { mcpServers: { theirServerA: { command: 'a' }, theirServerB: { command: 'b' } } });
  // simulate ensureClaudeIntegration: read safely, add ours, write atomically.
  const { config, readable } = readClaudeConfigSafe(p);
  assert.equal(readable, true);
  config.mcpServers.vibeconferencing = { command: 'node', args: ['/x/server.js'] };
  atomicWriteJson(p, config);
  const after = JSON.parse(fs.readFileSync(p, 'utf-8'));
  assert.ok(after.mcpServers.theirServerA, 'other server A survives');
  assert.ok(after.mcpServers.theirServerB, 'other server B survives');
  assert.ok(after.mcpServers.vibeconferencing, 'ours is added');
});

test('atomicWriteJson writes valid JSON and leaves no temp file behind', () => {
  const home = tmpHome();
  const p = path.join(home, '.claude.json');
  atomicWriteJson(p, { a: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf-8')), { a: 1 });
  assert.deepEqual(fs.readdirSync(home).filter((f) => f.includes('.tmp-')), [], 'no temp file left behind');
});

test('atomicWriteJson PRESERVES 0600 (never widens a tokens file to 0644)', () => {
  const p = path.join(tmpHome(), '.claude.json');
  fs.writeFileSync(p, '{}');
  fs.chmodSync(p, 0o600);
  atomicWriteJson(p, { a: 1 });
  assert.equal(fs.statSync(p).mode & 0o777, 0o600, 'existing 0600 mode is preserved through the rename');
});

test('atomicWriteJson defaults a NEW file to 0600, not 0644', () => {
  const p = path.join(tmpHome(), '.claude.json');
  atomicWriteJson(p, { a: 1 });
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
});

test('concurrency guard: aborts (no clobber) if the file changed since it was read', () => {
  const p = path.join(tmpHome(), '.claude.json');
  fs.writeFileSync(p, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  const { mtimeMs } = readClaudeConfigSafe(p);
  fs.utimesSync(p, new Date(), new Date(Date.now() + 10_000)); // simulate a concurrent writer bumping mtime
  assert.throws(() => atomicWriteJson(p, { clobbered: true }, { expectedMtimeMs: mtimeMs }), /changed since read/);
  assert.ok(JSON.parse(fs.readFileSync(p, 'utf-8')).mcpServers.other, 'the concurrent state is not clobbered');
});

test('concurrency guard: proceeds when the file is unchanged since read', () => {
  const p = path.join(tmpHome(), '.claude.json');
  atomicWriteJson(p, { mcpServers: { a: {} } });
  const { config, mtimeMs } = readClaudeConfigSafe(p);
  config.mcpServers.b = {};
  atomicWriteJson(p, config, { expectedMtimeMs: mtimeMs });
  assert.ok(JSON.parse(fs.readFileSync(p, 'utf-8')).mcpServers.b, 'unchanged file → write proceeds');
});
