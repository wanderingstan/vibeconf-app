// codex-install.test.mjs — unit tests for the Codex MCP installer (docs/codex.md).
// Codex support has no other automated coverage; this pins the config.toml
// contract so a refactor can't silently break the one integration path Codex
// has (issue: Codex testing support).
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installer = path.join(repoRoot, 'scripts', 'install-codex-mcp.mjs');

const run = (args, opts = {}) =>
  execFileSync('node', [installer, ...args], { encoding: 'utf-8', ...opts });

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));

test('dry-run prints the mcp_servers block without writing anything', () => {
  const home = tmpHome();
  const out = run(['--dry-run', `--codex-home=${home}`, '--base-url=http://127.0.0.1:7866', '--bot-name=Codex']);
  assert.match(out, /\[mcp_servers\.vibeconferencing\]/);
  assert.match(out, /command = "node"/);
  assert.match(out, /mcp-server\/server\.js/);
  assert.match(out, /VIBECONF_BASE_URL = "http:\/\/127\.0\.0\.1:7866"/);
  assert.match(out, /VIBECONF_BOT_NAME = "Codex"/);
  assert.match(out, /startup_timeout_sec = 120/);
  assert.equal(fs.existsSync(path.join(home, 'config.toml')), false);
});

test('install writes config.toml with the server block', () => {
  const home = tmpHome();
  run([`--codex-home=${home}`, '--base-url=http://127.0.0.1:7866', '--bot-name=Codex']);
  const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf-8');
  assert.match(toml, /\[mcp_servers\.vibeconferencing\]/);
  assert.match(toml, /VIBECONF_BASE_URL = "http:\/\/127\.0\.0\.1:7866"/);
});

test('re-install updates in place (idempotent: one block, new values, backup kept)', () => {
  const home = tmpHome();
  run([`--codex-home=${home}`, '--base-url=http://127.0.0.1:7866', '--bot-name=Codex']);
  run([`--codex-home=${home}`, '--base-url=http://127.0.0.1:7877', '--bot-name=Codex2']);
  const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf-8');
  const blocks = toml.match(/\[mcp_servers\.vibeconferencing\]/g) || [];
  assert.equal(blocks.length, 1, 'must not duplicate the block on re-install');
  assert.match(toml, /VIBECONF_BASE_URL = "http:\/\/127\.0\.0\.1:7877"/);
  assert.match(toml, /VIBECONF_BOT_NAME = "Codex2"/);
  const backups = fs.readdirSync(home).filter((f) => f.includes('.bak.'));
  assert.ok(backups.length >= 1, 'expected a .bak.<ts> backup of the previous config');
});

test('preserves unrelated user config around our block', () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, 'config.toml'), '# user stuff\nmodel = "o4"\n\n[other_section]\nkey = "value"\n');
  run([`--codex-home=${home}`, '--base-url=http://127.0.0.1:7866', '--bot-name=Codex']);
  const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf-8');
  assert.match(toml, /model = "o4"/);
  assert.match(toml, /\[other_section\]/);
  assert.match(toml, /\[mcp_servers\.vibeconferencing\]/);
});
