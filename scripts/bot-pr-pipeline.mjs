#!/usr/bin/env node
// bot-pr-pipeline.mjs — PHASE TWO, SKELETON ONLY.
//
// Phase two is the half of the nightly-triage idea that WRITES: pick up issues a
// human has tagged `good-for-bot` and open draft PRs for them. None of that is
// implemented here. What this file does today is answer one question — "is the
// pipeline ready to go the moment a real issue gets tagged?" — and answer it out
// loud, every morning, so the day phase two lands nobody is debugging plumbing.
//
// It is a PULSE, not a worker:
//   - it enumerates the pool (open issues labelled good-for-bot, both repos)
//   - it runs the preflight checks the real thing will need, and names what fails
//   - it prints the plan it WOULD execute, per issue
//   - `--execute` refuses, loudly, with an exit code
//
// WHY A SEPARATE FILE FROM nightly-issue-triage.mjs: that one is read-only by
// construction and its whole value in the first weeks is that it cannot touch the
// repos. The moment the two live in one file, "read-only" becomes a flag someone
// can flip by accident. Different file, different job, different blast radius.
//
// WHY THE REAL THING BELONGS IN THE CLOUD (see SCHEDULING.md): a job that writes
// branches has no business sharing a host with the test runner it reports on, and
// cloud routines are sandboxed, parallel, and don't need the mini awake. This
// skeleton runs locally because a pulse is cheap and the preflight it runs is
// mostly about local facts (is there a claude, is gh authed, is the label there).
//
// Usage:
//   node scripts/bot-pr-pipeline.mjs            # pulse — prints readiness + pool
//   node scripts/bot-pr-pipeline.mjs --json     # same, as JSON (for the digest)
//   node scripts/bot-pr-pipeline.mjs --execute  # refuses; phase two is not built
//
// Env: VIBECONF_TRIAGE_REPOS (shared with the triage script), CLAUDE_BIN.

import { execFileSync, execSync } from 'child_process';
import { statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const LABEL = 'good-for-bot';
const REPOS = (process.env.VIBECONF_TRIAGE_REPOS
  || 'wanderingstan/vibeconf-app,wanderingstan/vibeconferencing').split(',').map((s) => s.trim()).filter(Boolean);
const JSON_OUT = process.argv.includes('--json');
const EXECUTE = process.argv.includes('--execute');

// --- the refusal, first and unconditional -----------------------------------
// Before any network call, so `--execute` cannot half-run and leave something
// behind. When phase two is real this block is what gets deleted, and deleting it
// should feel like a decision.
if (EXECUTE) {
  console.error([
    'REFUSED: phase two is not implemented.',
    '',
    'This script is a readiness pulse. It does not create branches, write code, or',
    'open PRs, and --execute exists only so that trying it fails loudly instead of',
    'appearing to work.',
    '',
    'When phase two is built it runs as a Claude cloud routine, not from here —',
    'see the "Morning backlog survey" section of scripts/SCHEDULING.md.',
  ].join('\n'));
  process.exit(2);
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
function ghJson(args) {
  try { return JSON.parse(gh(args)); } catch { return null; }
}

// --- preflight ---------------------------------------------------------------
// Each check is a fact the real pipeline depends on. A check that cannot pass
// today (because phase two doesn't exist) is not listed — every one of these is
// something that could genuinely be broken right now, which is the only kind of
// check worth running every morning.
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });

// 1. gh present and authed, with a token that can actually write.
let scopes = '';
try {
  const status = execSync('gh auth status 2>&1', { encoding: 'utf8' });
  const m = status.match(/Token scopes:\s*(.+)/);
  scopes = m ? m[1].trim() : '';
  check('gh authenticated', /Logged in to github\.com/.test(status), scopes ? `scopes: ${scopes}` : '');
} catch (e) {
  check('gh authenticated', false, e.message?.split('\n')[0] || 'gh auth status failed');
}
// `repo` is what opening a PR needs. Checked separately from auth because a token
// that reads fine and cannot write is the failure that would only surface at the
// worst moment — halfway through the first real run.
check('gh token can write (repo scope)', /'repo'|\brepo\b/.test(scopes), scopes || 'no scopes reported');

// 2. A claude binary. Same resolution order as the triage script, and for the same
//    reason: `claude` on PATH here is a bash shim inside cmux.app.
function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const candidates = [
    join(homedir(), '.local/bin/claude'),
    (() => { try { return execSync('command -v claude', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } })(),
    '/Applications/cmux.app/Contents/Resources/bin/claude',
  ].filter(Boolean);
  for (const c of candidates) { try { statSync(c); return c; } catch { /* next */ } }
  return null;
}
const claudeBin = resolveClaudeBin();
check('claude CLI available', !!claudeBin, claudeBin || 'not found');

// 3. The label exists in every repo. This is the one that will actually fail one
//    day — someone renames it, or a new repo joins the list and nobody creates it
//    there, and the pool silently reads empty forever. An empty pool and a missing
//    label look identical from the outside, which is exactly why this is a check.
const labelPresent = {};
for (const repo of REPOS) {
  const found = ghJson(['label', 'list', '-R', repo, '--search', LABEL, '--json', 'name']) || [];
  labelPresent[repo] = found.some((l) => l.name === LABEL);
  check(`label ${LABEL} exists in ${repo.split('/')[1]}`, labelPresent[repo]);
}

// --- the pool ----------------------------------------------------------------
const pool = [];
for (const repo of REPOS) {
  if (!labelPresent[repo]) continue;
  const issues = ghJson(['issue', 'list', '-R', repo, '--state', 'open', '--label', LABEL,
    '--limit', '100', '--json', 'number,title,url,updatedAt,assignees']) || [];
  for (const i of issues) {
    pool.push({
      repo,
      number: i.number,
      title: i.title,
      url: i.url,
      assigned: (i.assignees || []).length > 0,
      // A PR already referencing the issue means phase two would be duplicating
      // work. Cheap to check now, and it's the check whose absence would produce
      // the most embarrassing first run.
      hasOpenPR: ((ghJson(['pr', 'list', '-R', repo, '--state', 'open', '--search', `${i.number} in:body`,
        '--json', 'number']) || []).length > 0),
    });
  }
}
const claimable = pool.filter((p) => !p.assigned && !p.hasOpenPR);

const ready = checks.every((c) => c.ok);
const result = {
  ready,
  phase: 'two-skeleton',
  implemented: false,
  label: LABEL,
  repos: REPOS,
  checks,
  pool: pool.length,
  claimable: claimable.length,
  issues: pool,
};

if (JSON_OUT) { console.log(JSON.stringify(result, null, 2)); process.exit(ready ? 0 : 1); }

// --- human output ------------------------------------------------------------
const tick = (ok) => (ok ? '✅' : '❌');
console.log(`${ready ? '💚' : '💔'} phase-two pipeline: ${ready ? 'ARMED (skeleton — writes nothing yet)' : 'NOT READY'}`);
console.log('');
console.log('Preflight');
for (const c of checks) console.log(`  ${tick(c.ok)} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
console.log('');
console.log(`Pool (${LABEL}): ${pool.length} open, ${claimable.length} claimable`);
if (!pool.length) {
  console.log('  (empty — tag an issue `good-for-bot` from the morning survey\'s nominations)');
}
for (const p of pool) {
  const why = p.assigned ? 'assigned to a human' : p.hasOpenPR ? 'already has an open PR' : 'claimable';
  console.log(`  • ${p.repo.split('/')[1]}#${p.number} ${p.title}`);
  console.log(`    ${why} · ${p.url}`);
}
console.log('');
console.log('Would do, per claimable issue (NOT IMPLEMENTED):');
console.log('  1. read the issue + linked code, restate the scope, and BAIL if the issue');
console.log('     asks for a judgement call rather than a mechanical change');
console.log('  2. branch, change, run the relevant tests');
console.log('  3. open a DRAFT PR that quotes the issue\'s own acceptance criteria');
console.log('  4. comment the outcome on the issue — including "skipped, and why"');
console.log('');
console.log('Phase two is not built. `--execute` refuses. See scripts/SCHEDULING.md.');
process.exit(ready ? 0 : 1);
