#!/usr/bin/env node
// bot-pr-pipeline.mjs — PHASE TWO. Pick up issues a human has tagged
// `good-for-bot` and put ONE independent Claude agent on each of them.
//
// It has two jobs, and the flags keep them strictly apart:
//
//   node scripts/bot-pr-pipeline.mjs            # PULSE — read-only, writes nothing
//   node scripts/bot-pr-pipeline.mjs --json     # same, machine-readable (the digest reads this)
//   node scripts/bot-pr-pipeline.mjs --execute  # DISPATCH — labels issues, spawns agents
//   node scripts/bot-pr-pipeline.mjs --execute --dry-run   # prints the exact argv, spawns nothing
//   node scripts/bot-pr-pipeline.mjs --execute --only 565   # dispatch exactly this issue
//
// The pulse is unchanged from the skeleton days and stays the default, because
// nightly-issue-triage.mjs shells out to `--json` every morning and folds the
// answer into the digest. Nothing on that path may ever write.
//
// WHY ONE AGENT PER ISSUE, NOT ONE SESSION WORKING A LIST: a single session
// walking N issues reliably rabbit-holes on the first hard one and the rest never
// happen. Independent sessions fix that structurally — separate context windows,
// so one agent burning down cannot starve the others, and separate git worktrees,
// so they can touch the same files without colliding. That is `claude --bg
// --worktree`, which is first-party (CLI 2.1.x): it detaches, prints a short id,
// and `claude agents` / `logs` / `attach` / `stop` / `rm` manage the fleet.
// No orchestration framework is involved and none is wanted.
//
// WHY A SEPARATE FILE FROM nightly-issue-triage.mjs: that one is read-only by
// construction and its whole value is that it cannot touch the repos. The moment
// the two live in one file, "read-only" becomes a flag someone can flip by
// accident. Different file, different job, different blast radius.
//
// THE THREE THINGS THAT KEEP A RUN FROM GOING WRONG:
//   1. A watchdog, because the CLI has no working spend cap here. VERIFIED on
//      2.1.259: `--max-budget-usd` is print-mode only. Under `-p` it genuinely
//      stops a run (the JSON comes back with terminal_reason
//      "budget_exhausted"); under `--bg` it is silently ignored — a session
//      given $0.0001 kept working for minutes. It is still passed below, inert
//      and harmless, in case that changes. It is NOT the stop.
//      The stop is DEADLINE_MIN: a detached `claude stop <id>` armed at launch.
//      On a Max plan there is no dollar bill to protect anyway. What a runaway
//      fleet burns is the 5-hour and 7-day rate-limit windows, and those are
//      shared with the interactive session you are trying to work in. Wall
//      clock is the cap that actually defends that.
//   2. Not hanging on a prompt. A --bg session has nobody to answer one, and an
//      agent that raises one just sits in state "blocked", burning its deadline
//      without doing any work. `--permission-prompts none` does NOT prevent
//      this: it is a --print option and had no effect here, so do not trust it.
//      What works is `--permission-mode auto`, whose classifier answers
//      unattended. The --allowedTools allowlist stays as a fast path for the
//      obvious calls, but it cannot cover the compound shell commands workers
//      actually write. The watchdog also reaps a "blocked" agent early rather
//      than letting it idle all the way to its deadline.
//   3. A claim. An issue gets `bot-attempted` BEFORE its agent starts, so the
//      next run does not re-dispatch work that has already been tried and
//      skipped. `hasOpenPR` only catches the attempts that succeeded.
//
// Env:
//   VIBECONF_TRIAGE_REPOS      owner/repo list, PRIMARY FIRST (shared with the survey)
//   VIBECONF_BOT_PR_CHECKOUTS  repo=path,repo=path — where each repo lives on disk
//   VIBECONF_BOT_PR_MAX        max agents dispatched per run (default 3)
//   VIBECONF_BOT_PR_BUDGET     per-agent USD ceiling (default 5; inert under --bg)
//   VIBECONF_BOT_PR_DEADLINE   per-agent wall-clock minutes, then stopped (default 45)
//   VIBECONF_BOT_PR_MODEL      model for the workers (default opus)
//   CLAUDE_BIN                 override the claude binary

import { execFileSync, execSync, spawn, spawnSync } from 'child_process';
import { statSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const LABEL = 'good-for-bot';
// The claim label. Deliberately NOT a preflight check: it is created on demand by
// --execute, so a fresh repo does not read as "not ready" every morning until
// someone remembers to make it by hand.
const ATTEMPTED = 'bot-attempted';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPOS = (process.env.VIBECONF_TRIAGE_REPOS
  || 'wanderingstan/vibeconf-app,wanderingstan/vibeconferencing').split(',').map((s) => s.trim()).filter(Boolean);

const JSON_OUT = process.argv.includes('--json');
const EXECUTE = process.argv.includes('--execute');
const DRYRUN = process.argv.includes('--dry-run');
const RETRY = process.argv.includes('--retry');
const argOf = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

const MAX_AGENTS = Number(argOf('max', process.env.VIBECONF_BOT_PR_MAX || 3));
const BUDGET_USD = String(argOf('budget', process.env.VIBECONF_BOT_PR_BUDGET || 5));
const MODEL = argOf('model', process.env.VIBECONF_BOT_PR_MODEL || 'opus');
// The real hard stop; see the header. Generous enough that honest work finishes,
// short enough that a stuck agent is gone before it eats the rate-limit window
// you need for your own work tomorrow.
const DEADLINE_MIN = Number(argOf('deadline', process.env.VIBECONF_BOT_PR_DEADLINE || 45));
// --only 565[,566] — dispatch exactly these issues instead of the first N
// claimable. This is how you point the first run at the canary, and how you
// re-run one issue without disturbing the queue.
const ALLOW_ANY_BASE = process.argv.includes('--allow-any-base');
const ONLY = (argOf('only', '') || '').split(',').map((x) => Number(x.trim())).filter(Boolean);

// Where each repo lives on disk. `claude --worktree` branches the repo it is run
// IN, so an issue in the website repo has to be dispatched from the website
// checkout. Guessing this wrong is how an agent opens a PR against the wrong repo.
function checkouts() {
  const map = {
    'wanderingstan/vibeconf-app': REPO_ROOT,
    'wanderingstan/vibeconferencing': join(homedir(), 'Developer', 'vibeconferencing'),
  };
  for (const pair of (process.env.VIBECONF_BOT_PR_CHECKOUTS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf('=');
    if (eq > 0) map[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return map;
}
const CHECKOUTS = checkouts();
const isGitRepo = (p) => { try { return statSync(join(p, '.git')).isDirectory() || statSync(join(p, '.git')).isFile(); } catch { return false; } };

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
function ghJson(args) {
  try { return JSON.parse(gh(args)); } catch { return null; }
}

// --- preflight ---------------------------------------------------------------
// Each check is a fact the pipeline depends on. Every one of these is something
// that could genuinely be broken right now, which is the only kind of check worth
// running every morning.
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

// 4. A local checkout per repo. New in phase two, and load-bearing: without it an
//    issue in that repo can be listed but never worked.
for (const repo of REPOS) {
  const p = CHECKOUTS[repo];
  check(`local checkout for ${repo.split('/')[1]}`, p && isGitRepo(p), p || 'no path configured (set VIBECONF_BOT_PR_CHECKOUTS)');
}

// --- the pool ----------------------------------------------------------------
const pool = [];
for (const repo of REPOS) {
  if (!labelPresent[repo]) continue;
  const issues = ghJson(['issue', 'list', '-R', repo, '--state', 'open', '--label', LABEL,
    '--limit', '100', '--json', 'number,title,url,updatedAt,assignees,labels']) || [];
  for (const i of issues) {
    pool.push({
      repo,
      number: i.number,
      title: i.title,
      url: i.url,
      assigned: (i.assignees || []).length > 0,
      // A PR already referencing the issue means we would be duplicating work.
      hasOpenPR: ((ghJson(['pr', 'list', '-R', repo, '--state', 'open', '--search', `${i.number} in:body`,
        '--json', 'number']) || []).length > 0),
      // An agent has already had a go. It may have opened nothing on purpose —
      // "skipped, and why" is a legitimate outcome — so absence of a PR is not
      // permission to try again. Only --retry clears this.
      attempted: (i.labels || []).some((l) => l.name === ATTEMPTED),
    });
  }
}
const isClaimable = (p) => !p.assigned && !p.hasOpenPR && (RETRY || !p.attempted);
const claimable = pool.filter(isClaimable);

const ready = checks.every((c) => c.ok);
const result = {
  ready,
  phase: 'two',
  implemented: true,
  label: LABEL,
  repos: REPOS,
  checks,
  pool: pool.length,
  claimable: claimable.length,
  issues: pool,
};

// --- dispatch ----------------------------------------------------------------
// The prompt each worker gets. It is the four-step plan the skeleton used to only
// print, with the bail made explicit and first-class: a skipped issue with a good
// comment is a SUCCESS, and saying so in the prompt is the difference between an
// agent that respects scope and one that opens a PR to look busy.
function workerPrompt(issue) {
  const short = issue.repo.split('/')[1];
  return [
    `You are working on exactly one thing: ${issue.repo} issue #${issue.number}.`,
    `Ignore every other issue. Do not look for more work when you are done.`,
    ``,
    `1. Read it: \`gh issue view ${issue.number} -R ${issue.repo} --comments\`, then read the`,
    `   code it points at. Restate the scope in one paragraph before touching anything.`,
    `2. DECIDE WHETHER TO BAIL. If the issue asks for a judgement call, a design`,
    `   decision, or anything whose "right answer" is a matter of taste rather than`,
    `   a mechanical change, STOP HERE: run`,
    `   \`gh issue comment ${issue.number} -R ${issue.repo} --body "<what you found and why you did not act>"\``,
    `   and finish. That is a successful run. A skipped issue with a good comment is`,
    `   worth more than a PR nobody asked for.`,
    `3. Otherwise make the change on this worktree's branch and run the tests that`,
    `   cover it. You are in a dedicated git worktree of ${short}; commit here.`,
    `4. Open a DRAFT pull request that quotes the issue's own acceptance criteria and`,
    `   says "Closes #${issue.number}": \`gh pr create --draft --fill-first\`.`,
    `5. Comment the outcome on the issue either way, including "skipped, and why".`,
    ``,
    `If the change starts growing past what the issue actually asks for, stop and`,
    `comment what you learned instead of pressing on. Scope creep is the failure`,
    `mode this whole pipeline exists to avoid.`,
  ].join('\n');
}

// A fast path, not a fence. These are auto-approved without consulting auto
// mode's classifier. It cannot cover compound shell commands (`gh … > f; wc -c f`),
// which is most of what a worker actually writes, so auto mode does the real work.
const ALLOWED_TOOLS = [
  'Read', 'Edit', 'Write', 'Grep', 'Glob',
  'Bash(gh:*)', 'Bash(git:*)', 'Bash(node:*)', 'Bash(npm:*)', 'Bash(pnpm:*)',
];

function sessionName(issue) {
  return `issue-${issue.repo.split('/')[1]}-${issue.number}`;
}

// Sessions already running for these issues. Re-dispatching an issue whose agent
// is still working is the one duplicate the `bot-attempted` label cannot catch,
// because the label goes on before the work finishes.
function liveSessions() {
  if (!claudeBin) return new Set();
  const r = spawnSync(claudeBin, ['agents', '--json'], { encoding: 'utf8', timeout: 60000 });
  try {
    return new Set((JSON.parse(r.stdout || '[]') || []).map((s) => s?.name).filter(Boolean));
  } catch { return new Set(); }
}

// The wall-clock stop. Detached and fully unref'd so this script can exit right
// after dispatching — a nightly that had to sit and babysit its own children is a
// nightly that dies with the terminal. `claude stop` on a session that already
// finished is a no-op, so the timer never needs to check first.
// It polls rather than just sleeping, because the deadline is the SECOND thing it
// enforces. The first is state "blocked": an agent that raised a permission prompt
// nobody can answer is not slow, it is finished, and leaving it to idle out the
// full deadline wastes the whole window. Verified failure mode, not a hypothetical
// — it is what the first #668 run did.
// Written as a node child rather than a shell one-liner on purpose: parsing
// `agents --json` in sh means either jq (not guaranteed on PATH in a LaunchAgent)
// or grep -A<n> against a field order nobody promised. node is already here.
function armWatchdog(id) {
  const body = `
const { execFileSync } = require('child_process');
const CLAUDE = ${JSON.stringify(claudeBin)}, ID = ${JSON.stringify(id)};
const DEADLINE = ${DEADLINE_MIN};
const stop = () => { try { execFileSync(CLAUDE, ['stop', ID], { timeout: 60000, stdio: 'ignore' }); } catch {} };
const state = () => {
  try {
    const j = JSON.parse(execFileSync(CLAUDE, ['agents', '--json', '--all'], { encoding: 'utf8', timeout: 60000 }));
    return (j.find((s) => s && s.id === ID) || {}).state || '';
  } catch { return 'unknown'; }
};
let n = 0;
const tick = () => {
  const st = state();
  // "blocked" is a permission prompt nobody can answer: finished, not slow.
  if (st === 'blocked') return stop();
  if (st === 'done' || st === 'stopped' || st === '') return;
  if (++n >= DEADLINE) return stop();
  setTimeout(tick, 60000);
};
setTimeout(tick, 60000);
`;
  const child = spawn(process.execPath, ['-e', body], { detached: true, stdio: 'ignore' });
  child.unref();
}

// What branch will the agent's worktree be cut from? `claude --worktree` branches
// the CURRENT HEAD of the checkout it runs in, so dispatching from a feature
// branch quietly bases every PR on that branch's work. Nothing errors; the diffs
// are just wrong. Check it, name it, and make overriding it deliberate.
function baseBranchOf(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch { return ''; }
}
function defaultBranchOf(cwd) {
  try {
    const r = execFileSync('git', ['-C', cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { encoding: 'utf8' }).trim();
    return r.replace(/^origin\//, '') || 'main';
  } catch { return 'main'; }
}

function dispatch() {
  if (!ready) {
    console.error('REFUSED: preflight is not green. Fix these first:');
    for (const c of checks.filter((x) => !x.ok)) console.error(`  ❌ ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    process.exit(1);
  }

  const live = liveSessions();
  let selectable = claimable;
  if (ONLY.length) {
    selectable = pool.filter((i) => ONLY.includes(i.number));
    const missing = ONLY.filter((n) => !selectable.some((i) => i.number === n));
    for (const n of missing) console.log(`  ⚠️  #${n} is not in the ${LABEL} pool — skipping`);
    // --only is an explicit instruction, so it overrides assigned/hasOpenPR/
    // attempted. It does NOT override the label: an issue nobody tagged
    // good-for-bot is not something to dispatch by number.
  }
  const queue = selectable.filter((i) => !live.has(sessionName(i))).slice(0, MAX_AGENTS);
  const skippedLive = claimable.filter((i) => live.has(sessionName(i)));

  // Refuse a wrong base before writing anything. Every repo we would dispatch
  // into has to be sitting on its default branch, because that is what the
  // agents' worktrees get cut from. --allow-any-base is the deliberate override.
  const bases = [...new Set(queue.map((i) => i.repo))].map((repo) => {
    const cwd = CHECKOUTS[repo];
    return { repo, cwd, head: baseBranchOf(cwd), want: defaultBranchOf(cwd) };
  });
  const wrongBase = bases.filter((b) => b.head !== b.want);
  if (wrongBase.length && !ALLOW_ANY_BASE) {
    console.error('REFUSED: a checkout is not on its default branch, so agents would branch off it.');
    for (const b of wrongBase) console.error(`  ❌ ${b.repo} at ${b.cwd} is on "${b.head}", expected "${b.want}"`);
    console.error('');
    console.error('Fix by dispatching from a checkout (or worktree) on the default branch,');
    console.error('or pass --allow-any-base if basing the work here is what you actually want.');
    process.exit(1);
  }

  console.log(`${DRYRUN ? '🧪 DRY RUN — ' : ''}dispatching ${queue.length} of ${claimable.length} claimable (cap ${MAX_AGENTS})`);
  for (const b of bases) console.log(`  base: ${b.repo} → ${b.head}${b.head === b.want ? '' : ' ⚠️ NOT the default branch'}`);
  console.log(`  model ${MODEL} · hard stop ${DEADLINE_MIN} min/agent · attempts labelled ${ATTEMPTED}${RETRY ? ' · --retry: re-running attempted issues' : ''}`);
  for (const i of skippedLive) console.log(`  ⏭  ${i.repo.split('/')[1]}#${i.number} — an agent is already running for it`);
  if (!queue.length) { console.log('\nNothing to dispatch.'); return []; }

  const dispatched = [];
  for (const issue of queue) {
    const cwd = CHECKOUTS[issue.repo];
    const name = sessionName(issue);
    const args = [
      '--bg',
      '--worktree', name,
      '-n', name,
      '--model', MODEL,
      '--max-budget-usd', BUDGET_USD,
      // auto, NOT acceptEdits. MEASURED, and it cost a wasted run: the very
      // first thing a worker does is `gh issue view ... > file; echo; wc -c
      // file`, a COMPOUND command that no `Bash(gh:*)` pattern matches. It
      // raised an approval prompt, and in a --bg session there is nobody to
      // answer one, so the agent sat in state "blocked" doing nothing.
      // `--permission-prompts none` did NOT save it — that is a --print option
      // and had no effect here. Do not trust it as a guard. auto mode is what
      // the blocked prompt itself suggests, and a probe confirmed it runs
      // exactly that shape of command unattended.
      '--permission-mode', 'auto',
      '--allowedTools', ...ALLOWED_TOOLS,
      // `--` IS LOAD-BEARING. --allowedTools is variadic, so a positional prompt
      // placed after it is parsed as one more tool name: the agent launches
      // "(idle — send a prompt to start)" and sits there having been told
      // nothing. Cost a real debugging round; verified on 2.1.259.
      '--',
      workerPrompt(issue),
    ];

    if (DRYRUN) {
      console.log(`\n  ${issue.repo.split('/')[1]}#${issue.number} ${issue.title}`);
      console.log(`    cwd: ${cwd}`);
      console.log(`    would label: gh issue edit ${issue.number} -R ${issue.repo} --add-label ${ATTEMPTED}`);
      console.log(`    would run:   ${claudeBin} ${args.slice(0, -1).join(' ')} <prompt ${workerPrompt(issue).length} chars>`);
      console.log(`    watchdog:    claude stop <id> after ${DEADLINE_MIN} min`);
      dispatched.push({ ...issue, session: name, cwd, dryRun: true });
      continue;
    }

    // CLAIM BEFORE SPAWN, always in this order. If the label write fails we do not
    // start the agent: an unclaimed running agent is how the same issue gets two
    // PRs. Creating the label is idempotent and only ever happens under --execute.
    try {
      try { gh(['label', 'create', ATTEMPTED, '-R', issue.repo, '--description', 'An agent has taken a pass at this', '--color', 'BFD4F2']); }
      catch { /* already exists — that is the normal case */ }
      gh(['issue', 'edit', String(issue.number), '-R', issue.repo, '--add-label', ATTEMPTED]);
    } catch (e) {
      console.log(`  ❌ ${issue.repo.split('/')[1]}#${issue.number} — could not claim, not dispatching: ${e.message?.split('\n')[0]}`);
      continue;
    }

    const r = spawnSync(claudeBin, args, { cwd, encoding: 'utf8', timeout: 120000 });
    // `claude --bg` prints a banner, not a bare id. The id is on the
    // "backgrounded · <id> · <name>" line; the follow-on lines are usage hints
    // (`claude stop <id>  stop this session`), so taking the last line grabs help
    // text instead of the handle. Verified against CLI 2.1.259.
    const id = (r.stdout || '').match(/backgrounded\s*\u00b7\s*([0-9a-f]{6,})/)?.[1]
      || (r.stdout || '').match(/claude attach\s+([0-9a-f]{6,})/)?.[1] || '';
    if (r.status !== 0 || !id) {
      console.log(`  ❌ ${issue.repo.split('/')[1]}#${issue.number} — launch failed: ${(r.stderr || r.error?.message || 'no id printed').split('\n')[0]}`);
      continue;
    }
    armWatchdog(id);
    console.log(`  ✅ ${issue.repo.split('/')[1]}#${issue.number} → ${id} (${name}) · stops by ${new Date(Date.now() + DEADLINE_MIN * 60000).toLocaleTimeString()}`);
    dispatched.push({ ...issue, session: name, cwd, id, deadlineMin: DEADLINE_MIN });
  }
  return dispatched;
}

// --- output ------------------------------------------------------------------
if (EXECUTE) {
  const dispatched = dispatch();
  if (JSON_OUT) console.log(JSON.stringify({ ...result, dispatched }, null, 2));
  else if (dispatched.length && !DRYRUN) {
    console.log('');
    console.log('Watch them:');
    console.log(`  ${claudeBin} agents            # the board`);
    console.log(`  ${claudeBin} agents --json     # for scripts`);
    console.log(`  ${claudeBin} logs <id>         # tail one`);
    console.log(`  ${claudeBin} attach <id>       # take the wheel`);
    console.log(`  ${claudeBin} stop <id>         # stop it; then \`rm <id>\` to drop the worktree`);
  }
  process.exit(0);
}

if (JSON_OUT) { console.log(JSON.stringify(result, null, 2)); process.exit(ready ? 0 : 1); }

// --- human output ------------------------------------------------------------
const tick = (ok) => (ok ? '✅' : '❌');
console.log(`${ready ? '💚' : '💔'} phase-two pipeline: ${ready ? 'ARMED' : 'NOT READY'}`);
console.log('');
console.log('Preflight');
for (const c of checks) console.log(`  ${tick(c.ok)} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
console.log('');
console.log(`Pool (${LABEL}): ${pool.length} open, ${claimable.length} claimable`);
if (!pool.length) {
  console.log('  (empty — tag an issue `good-for-bot` from the morning survey\'s nominations)');
}
for (const p of pool) {
  const why = p.assigned ? 'assigned to a human'
    : p.hasOpenPR ? 'already has an open PR'
      : p.attempted ? `already ${ATTEMPTED} (use --retry to re-run)` : 'claimable';
  console.log(`  • ${p.repo.split('/')[1]}#${p.number} ${p.title}`);
  console.log(`    ${why} · ${p.url}`);
}
console.log('');
console.log(`Dispatch config: up to ${MAX_AGENTS} agents · ${MODEL} · hard stop ${DEADLINE_MIN} min each`);
console.log('  node scripts/bot-pr-pipeline.mjs --execute --dry-run   # see the exact commands');
console.log('  node scripts/bot-pr-pipeline.mjs --execute             # put an agent on each');
process.exit(ready ? 0 : 1);
