#!/usr/bin/env node
// nightly-issue-triage.mjs — a morning survey of the open-issue backlog: cluster,
// dedupe, rank, and nominate the issues a bot could safely take. Posts a short
// Telegram digest and writes a full markdown report you can actually read over
// coffee (the digest is capped by Telegram's 4096 chars; the report is not).
//
// STRICTLY READ-ONLY by default. It never opens a PR, never closes an issue, and
// never applies a label unless you pass --apply-labels (off in the LaunchAgent).
// That's phase one on purpose: with ~170 unlabeled issues across two repos, the
// point of the first weeks is to find out whether its judgement is worth trusting
// BEFORE it starts writing anything. Phase two (bot-authored PRs) belongs in a
// Claude cloud routine, not here — see SCHEDULING.md.
//
// WHY ITS OWN LaunchAgent, not a lane in scheduled-meet-test.sh: that wrapper is
// GUI-session-bound (real Electron apps, mic/cam/screen perms) and runs under a
// hard global watchdog. A lane appended to the end of it gets killed on exactly
// the nights worth triaging — the same way the Linux lane went missing for three
// nights. This job needs GitHub and a network, nothing else, so it runs alone at
// 04:30 like check-tts-usage.ts does at 04:00. Same reasoning the wrapper already
// applies to nightly-call-digest.mjs: independent, so a broken test suite never
// blocks the digest and vice versa.
//
// It still READS last night's results (see lastNightFailures) — a failing lane
// outranks anything in the backlog, and a digest that buries it under issue #212
// is a digest nobody acts on. That's a read-only dependency on the artifacts the
// 3am run leaves behind, not an execution dependency on the run succeeding.
//
// Env:
//   VIBECONF_TRIAGE=0             disable entirely
//   VIBECONF_TRIAGE_DRYRUN=1      compose + print, don't send or write
//   VIBECONF_NOTIFY_CHAT=<id>     recipient chat_id (REQUIRED to send; unset = skip)
//   VIBECONF_TRIAGE_REPOS=a,b     owner/repo list, PRIMARY FIRST (default: app, then web)
//   VIBECONF_TRIAGE_MODEL=<m>     model for the survey (default opus — this is one
//                                 judgement call a day over the whole backlog, which
//                                 is worth more than the sonnet used for RCA)
//   VIBECONF_TRIAGE_DETAIL=<n>    how many issues/repo get a body snippet (default 120)
//   VIBECONF_VAULT=<path>         override the Obsidian strategy-vault path
//   VIBECONF_RESULTS_DIR=<path>   override results dir
//   VIBECONF_TELEGRAM_ENV=<path>  override the token .env location
//   CLAUDE_BIN=<path>             override the claude binary
//
// Flags:
//   --apply-labels   actually `gh issue edit --add-label` the proposed labels.
//                    OFF by default and NOT set in the LaunchAgent. Run it by hand
//                    once you trust the proposals; the report always prints the
//                    equivalent gh commands so you can eyeball them first.

import { readFileSync, readdirSync, writeFileSync, appendFileSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync, execFileSync } from 'child_process';

const RESULTS = process.env.VIBECONF_RESULTS_DIR || join(homedir(), 'vibeconf-test-results');
const OUT_DIR = join(RESULTS, 'issue-triage');
// Same no-fallback-chat_id rule as notify-nightly.mjs: an unset chat SKIPS the post
// rather than defaulting to the shared group, so ad-hoc runs can't spam anyone.
const CHAT = process.env.VIBECONF_NOTIFY_CHAT || '';
const ENV_FILE = process.env.VIBECONF_TELEGRAM_ENV || join(homedir(), '.claude/channels/telegram/.env');
const DRYRUN = process.env.VIBECONF_TRIAGE_DRYRUN === '1';
const APPLY_LABELS = process.argv.includes('--apply-labels');
// PRIMARY FIRST. The first repo is the one the survey is FOR (the app); the rest are
// pulled in so cross-repo duplicates and clusters are visible, but they don't get to
// dominate the ranking. The prompt is told which is which.
const REPOS = (process.env.VIBECONF_TRIAGE_REPOS
  || 'wanderingstan/vibeconf-app,wanderingstan/vibeconferencing').split(',').map((s) => s.trim()).filter(Boolean);
const DETAIL_N = Number(process.env.VIBECONF_TRIAGE_DETAIL || 120);
const MODEL = process.env.VIBECONF_TRIAGE_MODEL || 'opus';
const VAULT = process.env.VIBECONF_VAULT
  || join(homedir(), 'Library/Mobile Documents/iCloud~md~obsidian/Documents/Obsidian Vault/Vibeconferencing');

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const log = (m) => console.log(`[triage] ${m}`);

function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 }).trim(); }
  catch { return ''; }
}
// Telegram HTML parse_mode: only these three need escaping.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const days = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);

// ---------------------------------------------------------------------------
// 1. Last night's test results — the thing that outranks the backlog.
// ---------------------------------------------------------------------------
// Deliberately GENERIC rather than the explicit lane table notify-nightly.mjs
// keeps: every lane writes a `*results*.jsonl` whose last line carries an `exit`
// or an `ok`, so globbing the dir picks up lanes added after this file was
// written. A hand-maintained list here would silently go stale the first time
// someone adds a lane and forgets this script exists.
function lastNightFailures() {
  let files = [];
  try {
    files = readdirSync(RESULTS, { withFileTypes: true })
      .flatMap((d) => (d.isDirectory()
        ? (() => { try { return readdirSync(join(RESULTS, d.name)).map((n) => join(d.name, n)); } catch { return []; } })()
        : [d.name]))
      // Excluding our OWN results.jsonl is not hygiene, it's a correctness fix: it
      // lives under RESULTS too and matches the same glob, so the first run after a
      // failed one read its own `ok:false` back as a failing "issue-triage lane",
      // reported it above the real ones, and spent a top-5 slot telling Stan to go
      // investigate this script.
      .filter((n) => /results.*\.jsonl$/.test(n) && !n.startsWith('issue-triage/'));
  } catch { return { failures: [], digest: '', ran: false } }

  const failures = [];
  let ran = false;
  const cutoff = Date.now() - 30 * 60 * 60 * 1000; // last ~30h, i.e. tonight's run
  for (const f of files) {
    const p = join(RESULTS, f);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.mtimeMs < cutoff) continue;
    ran = true;
    let last;
    try {
      const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
      last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
    } catch { continue; }
    if (!last) continue;
    // `results.jsonl` → dmg-meet (the gating lane, which owns the unprefixed file);
    // `results-main.jsonl` → main; `join-route-results.jsonl` → join-route;
    // `agent-fuzz/results.jsonl` → agent-fuzz.
    const lane = f.replace(/\.jsonl$/, '').replace(/\/results$/, '')
      .replace(/^results-?/, '').replace(/-?results$/, '') || 'dmg-meet';
    const failed = last.ok === false || (last.exit !== undefined && String(last.exit) !== '0');
    if (failed) {
      failures.push({
        lane,
        exit: last.exit ?? (last.ok === false ? 'ok:false' : '?'),
        fails: last.fails, stalls: last.stalls, note: last.note, mission: last.mission,
      });
    }
  }
  return { failures, digest: failingDigest(), ran };
}

// The failing lines from tonight's run log — enough for the survey to say "issue
// #412 is probably tonight's whiteboard-e2e failure", not enough to be a full RCA.
// notify-nightly.mjs already did the root-cause read at 3am and sent it; repeating
// that here would be a second opinion nobody asked for.
function failingDigest() {
  let newest = null;
  try {
    const f = readdirSync(RESULTS).filter((n) => /^run-.*\.log$/.test(n)).sort();
    newest = f.length ? join(RESULTS, f[f.length - 1]) : null;
  } catch { return ''; }
  if (!newest) return '';
  let raw = '';
  try { raw = readFileSync(newest, 'utf8'); } catch { return ''; }
  const keep = /(^=== .* ===| ❌ |🔴|failed steps:|REAL STALL|real stall|not in-call|error|unauthorized|exit code: [1-9]|exit: [1-9])/i;
  return raw.split('\n').filter((l) => keep.test(l)).join('\n').slice(0, 4000);
}

// ---------------------------------------------------------------------------
// 2. The backlog.
// ---------------------------------------------------------------------------
function ghJson(args) {
  try {
    const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out);
  } catch (e) {
    log(`gh failed (${args.slice(0, 4).join(' ')}…): ${e.message?.split('\n')[0] || e}`);
    return [];
  }
}

function fetchIssues(repo) {
  const raw = ghJson(['issue', 'list', '-R', repo, '--state', 'open', '--limit', '500',
    '--json', 'number,title,labels,createdAt,updatedAt,body,comments,url']);
  return raw.map((i) => ({
    n: i.number,
    title: i.title,
    labels: (i.labels || []).map((l) => l.name),
    age: days(i.createdAt),
    idle: days(i.updatedAt),
    // gh returns `comments` as a count on some versions and an array on others.
    comments: Array.isArray(i.comments) ? i.comments.length : (Number(i.comments) || 0),
    body: (i.body || '').replace(/\r/g, ''),
    url: i.url,
  }));
}

function fetchPRs(repo) {
  const raw = ghJson(['pr', 'list', '-R', repo, '--state', 'open', '--limit', '100',
    '--json', 'number,title,createdAt,updatedAt,isDraft,url']);
  return raw.map((p) => ({
    n: p.number, title: p.title, age: days(p.createdAt), idle: days(p.updatedAt),
    draft: !!p.isDraft, url: p.url,
  })).sort((a, b) => b.age - a.age);
}

// Two tiers, so the payload stays bounded whatever the backlog does. The most
// recently-touched DETAIL_N issues per repo get a body snippet (enough to judge
// scope and whether a bot could take it); everything else contributes title +
// labels only, which is still plenty for spotting clusters and duplicates.
// Without this, 350 full issue bodies is a six-figure-token prompt that grows
// every week and eventually just fails.
function renderIssues(repo, issues, primary) {
  const sorted = [...issues].sort((a, b) => a.idle - b.idle);
  const detail = sorted.slice(0, DETAIL_N);
  const brief = sorted.slice(DETAIL_N);
  const lab = (i) => (i.labels.length ? ` [${i.labels.join(', ')}]` : ' [UNLABELED]');
  const out = [`### ${repo}${primary ? '  (PRIMARY — the survey is for this repo)' : '  (secondary — cross-repo context)'}`,
    `${issues.length} open, ${issues.filter((i) => !i.labels.length).length} unlabeled`, ''];
  out.push(`#### Detailed (${detail.length} most recently updated)`);
  for (const i of detail) {
    const snip = i.body.slice(0, 400).replace(/\n{2,}/g, '\n').trim();
    out.push(`- #${i.n}${lab(i)} ${i.title}  · ${i.age}d old, idle ${i.idle}d, ${i.comments} comments`);
    if (snip) out.push(`  > ${snip.split('\n').join('\n  > ')}`);
  }
  if (brief.length) {
    out.push('', `#### Titles only (${brief.length} older)`);
    for (const i of brief) out.push(`- #${i.n}${lab(i)} ${i.title} · idle ${i.idle}d`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// 3. Strategy context (optional).
// ---------------------------------------------------------------------------
// CLAUDE.md points at an Obsidian vault for "where is this going" context. As of
// 2026-08 it's six files and the newest is two months old, so this is wired in as
// OPTIONAL and self-dating: if it's stale the prompt says so and the model is told
// to weight it accordingly; if Stan fleshes it out, the survey gets sharper the
// next night with no code change. That's the whole reason it reads the vault at
// all — a prioritiser with no product context is just a label sorter.
function vaultContext() {
  let files = [];
  try { files = readdirSync(VAULT).filter((n) => n.endsWith('.md')); } catch { return null; }
  if (!files.length) return null;
  const withTime = files.map((n) => {
    try { return { n, m: statSync(join(VAULT, n)).mtimeMs }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.m - a.m);
  const newestDays = Math.floor((Date.now() - withTime[0].m) / 86400000);
  let budget = 20000;
  const parts = [];
  for (const { n, m } of withTime) {
    if (budget <= 0) break;
    let text = ''; try { text = readFileSync(join(VAULT, n), 'utf8'); } catch { continue; }
    const slice = text.slice(0, Math.min(budget, 6000));
    budget -= slice.length;
    parts.push(`--- ${n} (updated ${Math.floor((Date.now() - m) / 86400000)}d ago) ---\n${slice}`);
  }
  return { newestDays, count: withTime.length, text: parts.join('\n\n') };
}

// ---------------------------------------------------------------------------
// 4. The survey.
// ---------------------------------------------------------------------------
// Prefer the REAL CLI at ~/.local/bin/claude over whatever `command -v` finds.
// On this machine `claude` on PATH is a bash shim inside cmux.app, and a shim that
// re-execs is exactly the kind of thing that drops the child's stdin — see the
// argv note in runSurvey. notify-nightly.mjs's resolver predates that discovery;
// it gets away with it because its 12KB payload fits in the pipe buffer.
function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const candidates = [
    join(homedir(), '.local/bin/claude'),
    sh('command -v claude'),
    '/Applications/cmux.app/Contents/Resources/bin/claude',
  ].filter(Boolean);
  for (const c of candidates) {
    try { statSync(c); return c; } catch { /* next */ }
  }
  return null;
}

const SCHEMA = `{
  "headline": "one sentence: the single most important thing to do today",
  "top": [ { "rank": 1, "repo": "owner/repo", "issues": [123], "title": "short",
             "why": "1-2 sentences, concrete", "action": "the first concrete step" } ],
  "clusters": [ { "name": "short theme", "repo": "owner/repo", "issues": [1,2,3],
                  "note": "what ties them together and what to do about the group" } ],
  "duplicates": [ { "repo": "owner/repo", "keep": 123, "dupes": [456],
                    "note": "why they're the same" } ],
  "labels": [ { "repo": "owner/repo", "issue": 123, "add": ["bug"], "why": "short" } ],
  "botReady": [ { "repo": "owner/repo", "issue": 123, "scope": "what the change is",
                  "why": "why it needs no product decision", "risk": "low|medium" } ],
  "stale": [ { "repo": "owner/repo", "issue": 123, "why": "why it looks closable" } ]
}`;

function runSurvey(payload) {
  const bin = resolveClaudeBin();
  if (!bin) { log('no claude binary found — cannot run the survey'); return null; }
  const prompt = [
    'You are running the MORNING BACKLOG SURVEY for "Vibeconferencing" — an Electron',
    'app where AI bots join Google Meet and Slack calls (repo wanderingstan/vibeconf-app),',
    'plus a companion website at vibeconferencing.com (repo wanderingstan/vibeconferencing:',
    'shared whiteboard, auth, room URLs).',
    '',
    'Below the ===== INPUT ===== marker: last night\'s automated test results, the full',
    'open-issue backlog for both repos, the open PR list, and (maybe) strategy notes.',
    '',
    'RULES:',
    '1. A FAILING TEST LANE FROM LAST NIGHT OUTRANKS EVERYTHING IN THE BACKLOG. If any',
    '   lane failed, the top-ranked items must address it. If an existing issue already',
    '   covers it, cite that issue number; if none does, say so plainly in "title" and',
    '   set "issues" to [].',
    '2. Rank for the PRIMARY repo. Secondary-repo issues appear only when they are',
    '   genuinely more urgent or are duplicates/blockers of primary-repo work.',
    '3. "top" is at most 5 items. Fewer is better than padded. This is read on a phone',
    '   at breakfast; a list of 12 is a list of 0.',
    '4. "botReady" nominates issues an autonomous coding agent could finish with NO',
    '   product decision: a specific, reproducible bug with an obvious correct behaviour,',
    '   or a small mechanical enhancement. NOMINATE CONSERVATIVELY — 3 to 6 at most, and',
    '   none at all is a valid answer. Anything needing a taste, naming, UX, pricing or',
    '   architecture call is NOT bot-ready. These are proposals a human will approve;',
    '   over-nominating destroys their value.',
    '5. "labels" proposes labels for UNLABELED issues only, drawn strictly from the',
    '   existing set: bug, documentation, duplicate, enhancement, good first issue,',
    '   help wanted, invalid, question, wontfix. Propose at most 25 — the highest-',
    '   confidence ones. Never invent a new label.',
    '6. Ground every claim in an issue number you were actually shown. Do not invent',
    '   issue numbers, and do not describe issues that are not in the input.',
    '',
    `Reply with ONLY a JSON object matching this shape (no prose, no markdown fence):\n${SCHEMA}`,
  ].join('\n');
  // The payload goes in ARGV, not stdin. Piping it is the obvious choice and it is
  // what notify-nightly.mjs does, but it broke here: a 169KB write does not fit in
  // the 64KB pipe buffer, so the write BLOCKS until the child drains it, and if the
  // child exits first — which the cmux shim on PATH does — node raises EPIPE and a
  // 15-minute survey is lost. It failed under launchd while passing from an
  // interactive shell, which is the worst possible way to find out. argv has no such
  // race; macOS ARG_MAX here is 1MB and CAP keeps us well inside it.
  try {
    const out = execFileSync(bin, ['-p', `${prompt}\n\n===== INPUT =====\n${payload}`, '--model', MODEL], {
      encoding: 'utf8',
      timeout: 900000, // 15 min — a whole-backlog read is not the 3-minute RCA call
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return (out || '').trim() || null;
  } catch (e) {
    log(`survey failed: ${e.message?.split('\n')[0] || e}`);
    return null;
  }
}

// Models sometimes wrap JSON in a fence or a sentence despite instructions. Salvage
// the object rather than throwing away a 15-minute call over a stray backtick.
function parseSurvey(raw) {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], raw, raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    if (!c) continue;
    try { const o = JSON.parse(c.trim()); if (o && typeof o === 'object') return o; } catch { /* next */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 5. Gather + run.
// ---------------------------------------------------------------------------
const night = lastNightFailures();
const byRepo = REPOS.map((r) => ({ repo: r, issues: fetchIssues(r), prs: fetchPRs(r) }));
const totalIssues = byRepo.reduce((n, r) => n + r.issues.length, 0);
if (!totalIssues) { log('no issues fetched (gh auth? network?) — nothing to survey'); process.exit(0); }
const vault = vaultContext();
log(`${totalIssues} open issues across ${REPOS.length} repo(s), `
  + `${night.failures.length} failing lane(s) last night, vault ${vault ? `${vault.count} notes` : 'absent'}`);

const nightBlock = !night.ran
  ? 'The nightly test suite left no fresh results (it did not run, or the machine was off). Treat the backlog on its own merits.'
  : night.failures.length
    ? ['LANES THAT FAILED LAST NIGHT (these outrank the backlog):',
       ...night.failures.map((f) => {
         const bits = [
           f.fails !== undefined ? `${f.fails} fails` : '',
           f.stalls !== undefined ? `${f.stalls} stalls` : '',
           f.mission ? `mission ${f.mission}` : '',
           f.note || '',
         ].filter(Boolean);
         return `- ${f.lane}: exit ${f.exit}${bits.length ? ` (${bits.join(', ')})` : ''}`;
       }),
       '', 'Failing lines from the run log:', night.digest || '(none captured)'].join('\n')
    : 'All lanes passed last night. Rank the backlog on its own merits.';

const vaultBlock = vault
  ? [`## Strategy notes (Obsidian vault, ${vault.count} notes, newest ${vault.newestDays}d old)`,
     vault.newestDays > 45
       ? `NOTE: these notes are STALE (newest is ${vault.newestDays} days old). Use them for durable`
         + ' product direction only; do not treat anything time-sensitive in them as current.'
       : 'These are current. Weight them heavily when judging what matters.',
     '', vault.text].join('\n')
  : '## Strategy notes\n(none available — judge priority from the issues and test results alone)';

const prBlock = ['## Open PRs (awaiting review — factual list, oldest first)',
  ...byRepo.flatMap(({ repo, prs }) => (prs.length
    ? prs.map((p) => `- ${repo}#${p.n}${p.draft ? ' [draft]' : ''} ${p.title} · ${p.age}d old, idle ${p.idle}d`)
    : [`- ${repo}: none open`]))].join('\n');

let payload = ['## Last night\'s automated tests', nightBlock, '',
  vaultBlock, '', prBlock, '', '## Open issue backlog',
  ...byRepo.map(({ repo, issues }, i) => renderIssues(repo, issues, i === 0))].join('\n');
// Hard cap. The tiering above should keep us well under this; the slice is the
// backstop for the night the backlog doubles, so the job degrades instead of dying.
// Fits inside macOS ARG_MAX (1MB, shared with the environment) with room to spare,
// since the payload now travels as an argv string.
const CAP = 300000;
if (payload.length > CAP) { payload = payload.slice(0, CAP) + '\n\n[TRUNCATED]'; log(`payload capped at ${CAP} chars`); }
log(`payload ${Math.round(payload.length / 1024)}KB → ${MODEL}`);

const raw = runSurvey(payload);
const survey = parseSurvey(raw);
if (!survey && raw) log('survey returned unparseable output — falling back to raw text');

// ---------------------------------------------------------------------------
// 6. Report (full) + digest (short).
// ---------------------------------------------------------------------------
// --- phase-two pulse ---------------------------------------------------------
// bot-pr-pipeline.mjs is a skeleton that writes nothing; all it does is answer
// "would phase two work if an issue were tagged right now". Folding its answer
// into the digest is the whole point of having it: a readiness check nobody reads
// is a readiness check that is already broken. Best-effort — a pulse failure must
// never cost the survey, which is the message that actually matters.
function phaseTwoPulse() {
  try {
    const out = execFileSync(process.execPath, [join(import.meta.dirname, 'bot-pr-pipeline.mjs'), '--json'], {
      encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(out);
  } catch (e) {
    // Exit 1 means "not ready" and still prints valid JSON on stdout — that's a
    // result, not an error, so parse it before giving up.
    try { return JSON.parse(e.stdout || ''); } catch { /* fall through */ }
    log(`phase-two pulse skipped: ${e.message?.split('\n')[0] || e}`);
    return null;
  }
}
const pulse = phaseTwoPulse();
if (pulse) log(`phase two ${pulse.ready ? 'armed' : 'NOT READY'}, pool ${pulse.pool} (${pulse.claimable} claimable)`);

const A = (x) => (Array.isArray(x) ? x : []);
// The model is asked for "owner/repo" and reliably answers with the bare name
// ("vibeconf-app"), which yields github.com/vibeconf-app/issues/105 — a dead link —
// and `gh -R vibeconf-app`, which doesn't resolve. So never trust the returned
// string: match it back to one of the repos we actually fetched, by name part, and
// fall back to the primary repo. Every link and gh command downstream goes through
// this, so a sloppy repo field can't produce a broken artifact.
function normRepo(s) {
  const name = String(s || '').split('/').pop().trim().toLowerCase();
  return REPOS.find((r) => r.split('/')[1].toLowerCase() === name)
    || REPOS.find((r) => r.toLowerCase().includes(name) && name.length > 3)
    || REPOS[0];
}
const ref = (repo, n) => `${normRepo(repo).split('/')[1]}#${n}`;
const issueUrl = (repo, n) => `https://github.com/${normRepo(repo)}/issues/${n}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Rendered on BOTH report paths — including the one where the survey itself failed.
// The readiness of the write-side pipeline is exactly the thing you still want to
// know on a morning when the survey broke, and an early return that swallowed it
// would hide it on precisely those days.
function phaseTwoSection() {
  if (!pulse) return [];
  const bad = pulse.checks.filter((c) => !c.ok);
  const L = ['## Phase two (skeleton — writes nothing yet)',
    pulse.ready
      ? `💚 Armed. Pool: ${pulse.pool} tagged \`${pulse.label}\`, ${pulse.claimable} claimable.`
      : `💔 NOT READY — ${bad.map((c) => c.name).join('; ')}`];
  for (const i of pulse.issues) {
    const why = i.assigned ? 'assigned to a human' : i.hasOpenPR ? 'already has an open PR' : 'claimable';
    L.push(`- [${i.repo.split('/')[1]}#${i.number}](${i.url}) — ${i.title} (${why})`);
  }
  if (!pulse.issues.length) L.push('- _(pool empty — tag a nomination above to fill it)_');
  L.push('');
  return L;
}

function buildReport() {
  const L = [`# Backlog survey — ${stamp}`, ''];
  if (night.failures.length) {
    L.push('## 🔴 Failed last night', ...night.failures.map((f) => `- **${f.lane}** exit ${f.exit}`
      + (f.fails !== undefined ? ` (${f.fails} fails)` : '') + (f.note ? ` — ${f.note}` : '')), '');
  } else if (night.ran) L.push('## ✅ All lanes passed last night', '');
  else L.push('## ⚪️ No fresh nightly results', '');

  if (!survey) {
    L.push('## Survey', raw ? '```\n' + raw.slice(0, 20000) + '\n```' : '_(survey did not run)_', '');
    L.push(...phaseTwoSection());
    return L.join('\n');
  }
  if (survey.headline) L.push(`> **${survey.headline}**`, '');
  if (A(survey.top).length) {
    L.push('## Top of the list');
    for (const t of A(survey.top)) {
      const links = A(t.issues).map((n) => `[${ref(t.repo, n)}](${issueUrl(t.repo, n)})`).join(', ');
      L.push(`### ${t.rank}. ${t.title}${links ? `  ${links}` : '  _(no issue filed yet)_'}`);
      if (t.why) L.push(t.why);
      if (t.action) L.push(`**Next step:** ${t.action}`);
      L.push('');
    }
  }
  if (A(survey.clusters).length) {
    L.push('## Clusters');
    for (const c of A(survey.clusters)) {
      L.push(`- **${c.name}** (${A(c.issues).map((n) => ref(c.repo, n)).join(', ')}) — ${c.note || ''}`);
    }
    L.push('');
  }
  if (A(survey.duplicates).length) {
    L.push('## Probable duplicates');
    for (const d of A(survey.duplicates)) {
      L.push(`- keep ${ref(d.repo, d.keep)}, close ${A(d.dupes).map((n) => ref(d.repo, n)).join(', ')} — ${d.note || ''}`);
    }
    L.push('');
  }
  if (A(survey.botReady).length) {
    L.push('## Nominated for a bot (phase two)',
      'These are PROPOSALS. Tag the ones you agree with `good-for-bot` and the phase-two',
      'cloud routine will pick up only from that pool — it never self-selects.', '');
    for (const b of A(survey.botReady)) {
      L.push(`- [${ref(b.repo, b.issue)}](${issueUrl(b.repo, b.issue)}) (${b.risk || '?'} risk) — ${b.scope || ''}`);
      if (b.why) L.push(`  - ${b.why}`);
    }
    L.push('', '```sh', ...A(survey.botReady).map((b) =>
      `gh issue edit ${b.issue} -R ${normRepo(b.repo)} --add-label good-for-bot`), '```', '');
  }
  if (A(survey.labels).length) {
    L.push('## Proposed labels', '```sh', ...A(survey.labels).map((l) =>
      `gh issue edit ${l.issue} -R ${normRepo(l.repo)} ${A(l.add).map((n) => `--add-label ${JSON.stringify(n)}`).join(' ')}`
      + `  # ${l.why || ''}`), '```', '');
  }
  if (A(survey.stale).length) {
    L.push('## Looks closable', ...A(survey.stale).map((s) =>
      `- ${ref(s.repo, s.issue)} — ${s.why || ''}`), '');
  }
  L.push(...phaseTwoSection());
  L.push('## Open PRs', prBlock.split('\n').slice(1).join('\n'), '');
  L.push(`---`, `_${totalIssues} open issues surveyed · model ${MODEL} · vault `
    + (vault ? `${vault.count} notes, newest ${vault.newestDays}d old` : 'absent') + '_');
  return L.join('\n');
}

// The digest is an ALERT, not the report: headline, red lanes, top 3, and the counts.
// Everything else is a link away in the markdown. Telegram truncates at 4096 and a
// digest that hits the cap has already lost whatever mattered least — which is never
// the part at the top.
function buildDigest(reportPath) {
  const head = night.failures.length
    ? `🔴 <b>Backlog survey — ${esc(night.failures.length)} lane(s) failed last night</b>`
    : `☀️ <b>Backlog survey — ${esc(stamp.slice(0, 10))}</b>`;
  const L = [head];
  if (night.failures.length) {
    L.push(...night.failures.map((f) => `🔴 ${esc(f.lane)}: exit ${esc(f.exit)}`
      + (f.fails !== undefined ? ` (${esc(f.fails)} fails)` : '')));
  }
  if (survey?.headline) L.push('', `👉 ${esc(survey.headline)}`);
  const top = A(survey?.top).slice(0, 3);
  if (top.length) {
    L.push('', '<b>Top of the list</b>');
    for (const t of top) {
      const first = A(t.issues)[0];
      const link = first ? ` <a href="${esc(issueUrl(t.repo, first))}">${esc(ref(t.repo, first))}</a>` : '';
      L.push(`${t.rank}.${link} ${esc(t.title)}`);
      if (t.why) L.push(`   ${esc(String(t.why).slice(0, 220))}`);
    }
  }
  const counts = [];
  if (A(survey?.botReady).length) counts.push(`🤖 ${A(survey.botReady).length} bot-ready`);
  if (A(survey?.labels).length) counts.push(`🏷 ${plural(A(survey.labels).length, 'label proposal')}`);
  if (A(survey?.duplicates).length) counts.push(`♻️ ${plural(A(survey.duplicates).length, 'dupe')}`);
  const prCount = byRepo.reduce((n, r) => n + r.prs.length, 0);
  if (prCount) counts.push(`🔀 ${plural(prCount, 'PR')} open`);
  counts.push(`📋 ${plural(totalIssues, 'open issue')}`);
  if (pulse) {
    L.push('', pulse.ready
      ? esc(`💚 phase two armed · ${plural(pulse.claimable, 'issue')} tagged ${pulse.label} and claimable`)
      : esc(`💔 phase two NOT READY — ${pulse.checks.filter((c) => !c.ok).map((c) => c.name).join('; ')}`));
  }
  L.push('', esc(counts.join(' · ')));
  L.push('', `📄 <code>${esc(reportPath)}</code>`);
  let text = L.join('\n');
  if (text.length > 4090) text = text.slice(0, 4087) + '…';
  return text;
}

const reportPath = join(OUT_DIR, `survey-${stamp}.md`);
const report = buildReport();
const digest = buildDigest(reportPath);

if (DRYRUN) {
  console.log('--- REPORT ---\n' + report + '\n--- DIGEST ---\n' + digest);
  log('DRY-RUN — nothing written or sent');
  process.exit(0);
}

try {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(reportPath, report);
  appendFileSync(join(OUT_DIR, 'results.jsonl'), JSON.stringify({
    ts: stamp, issues: totalIssues, redLanes: night.failures.map((f) => f.lane),
    top: A(survey?.top).map((t) => ({ repo: normRepo(t.repo), issues: t.issues, title: t.title })),
    botReady: A(survey?.botReady).map((b) => ref(b.repo, b.issue)),
    labels: A(survey?.labels).length, model: MODEL, ok: !!survey,
    phaseTwo: pulse ? { ready: pulse.ready, pool: pulse.pool, claimable: pulse.claimable } : null,
  }) + '\n');
  log(`report → ${reportPath}`);
  // Keep the last 60 reports; results.jsonl stays forever (it's the trend line).
  const old = readdirSync(OUT_DIR).filter((n) => /^survey-.*\.md$/.test(n)).sort().slice(0, -60);
  for (const f of old) { try { execFileSync('rm', ['-f', join(OUT_DIR, f)]); } catch { /* best effort */ } }
} catch (e) {
  log(`could not write report: ${e.message}`);
}

// --apply-labels only. Off in the LaunchAgent by design: phase one is a read-only
// audition, and 25 wrong labels a night across a 350-issue backlog is a mess that
// takes longer to undo than to have done by hand.
if (APPLY_LABELS && A(survey?.labels).length) {
  let ok = 0;
  for (const l of A(survey.labels)) {
    const args = ['issue', 'edit', String(l.issue), '-R', normRepo(l.repo), ...A(l.add).flatMap((n) => ['--add-label', n])];
    try { execFileSync('gh', args, { stdio: 'ignore' }); ok++; }
    catch (e) { log(`label ${ref(l.repo, l.issue)} failed: ${e.message?.split('\n')[0]}`); }
  }
  log(`applied labels to ${ok}/${A(survey.labels).length} issues`);
}

// ---------------------------------------------------------------------------
// 7. Send.
// ---------------------------------------------------------------------------
if (process.env.VIBECONF_TRIAGE === '0') { log('disabled'); process.exit(0); }
if (!CHAT) {
  log('VIBECONF_NOTIFY_CHAT not set — skipping Telegram post (report still written). '
    + 'Set VIBECONF_NOTIFY_CHAT to a chat_id to enable.');
  process.exit(0);
}
function botToken() {
  try {
    const m = readFileSync(ENV_FILE, 'utf8').match(/^TELEGRAM_BOT_TOKEN=(.+)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch { return null; }
}
const tok = botToken();
if (!tok) { log(`no telegram token at ${ENV_FILE} — skipping`); process.exit(0); }
try {
  const resp = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT, text: digest, parse_mode: 'HTML', disable_web_page_preview: true,
      // Silent unless something actually failed — this lands at 04:30 and a
      // green morning survey is not worth a phone buzz.
      disable_notification: night.failures.length === 0,
    }),
    signal: AbortSignal.timeout(20000),
  });
  log(resp.ok ? 'telegram sent' : `telegram failed: ${resp.status} ${await resp.text().catch(() => '')}`);
} catch (e) {
  log(`telegram error: ${e.message}`);
}
process.exit(0);
