#!/usr/bin/env node
// pre-test-check.mjs — 19:00 readiness check for the 03:00 nightly (#719).
//
// The nightly is unattended and reports at 03:00, which is exactly when nobody
// is awake to fix it. Everything checked here is a condition that makes the run
// WRONG or SKIPPED rather than merely red — and every one of them is silent at
// 03:00 and cheap to fix at 19:00, while there are still eight hours to do it.
//
// Alert-only by design: a clean host sends NOTHING. A 19:00 "all good" every day
// is exactly the message people stop reading, and this has to still be legible
// on the night it actually matters. Pass --always to force a post (for testing),
// --json for machine output.
//
// ALWAYS exits 0. A readiness check that fails its own run, or that a wrapper
// could mistake for a broken night, is worse than no check at all.
//
// Env:
//   VIBECONF_NOTIFY_CHAT   Telegram chat_id (REQUIRED to send; unset = report only)
//   VIBECONF_TELEGRAM_ENV  bot token .env (default ~/.claude/channels/telegram/.env)
//   VIBECONF_REPO          repo to inspect (default: this script's repo)
//   VIBECONF_EXPECT_BRANCH branch the nightly should run (default: main)
//   VIBECONF_RESULTS_DIR   where ecosystem-preflight writes (default: a pre-test
//                          subdir, so the 03:00 digest never reads a 19:00 row)
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir, loadavg, cpus } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = process.env.VIBECONF_REPO || join(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECT_BRANCH = process.env.VIBECONF_EXPECT_BRANCH || 'main';
const CHAT = process.env.VIBECONF_NOTIFY_CHAT || '';
const ENV_FILE = process.env.VIBECONF_TELEGRAM_ENV || join(homedir(), '.claude/channels/telegram/.env');
const RESULTS = process.env.VIBECONF_RESULTS_DIR || join(homedir(), 'vibeconf-test-results/pre-test');
const PROFILES = join(homedir(), 'Library/Application Support/Vibeconferencing/profiles');
const ALWAYS = process.argv.includes('--always');
const JSON_OUT = process.argv.includes('--json');

const findings = [];
const red  = (title, detail, fix) => findings.push({ level: 'red',  title, detail, fix });
const warn = (title, detail, fix) => findings.push({ level: 'warn', title, detail, fix });
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim();

// --- 1. Source lane -------------------------------------------------------
// The nightly runs the WORKING TREE, so whatever is checked out at 03:00 is what
// gets tested. A feature branch left checked out silently tests stale code and
// still reports green (found the hard way — a stray branch made three nights
// meaningless).
try {
  const branch = sh('git', ['-C', REPO, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== EXPECT_BRANCH) {
    red('Wrong branch checked out', `on "${branch}", expected "${EXPECT_BRANCH}" — tonight would test this branch's code`,
      `cd ${REPO} && git checkout ${EXPECT_BRANCH}`);
  }
  const dirty = sh('git', ['-C', REPO, 'status', '--porcelain']);
  if (dirty) {
    warn('Uncommitted changes', `${dirty.split('\n').length} file(s) modified — tonight tests them, committed or not`,
      `cd ${REPO} && git status`);
  }
  try {
    sh('git', ['-C', REPO, 'fetch', '--quiet'], { timeout: 30000 });
    const behind = sh('git', ['-C', REPO, 'rev-list', '--count', `HEAD..origin/${EXPECT_BRANCH}`]);
    if (Number(behind) > 0) {
      warn('Behind origin', `${behind} commit(s) behind origin/${EXPECT_BRANCH} — tonight tests older code than main`,
        `cd ${REPO} && git pull --ff-only`);
    }
  } catch { /* offline: the ecosystem preflight already covers connectivity */ }
} catch (e) {
  warn('Could not read git state', e.message, `check ${REPO} is a git repo`);
}

// --- 2. Leftover app instances -------------------------------------------
// The suite's teardown pkills `profile=test-meet-guest` and `profile=test-slack`
// ONLY. Anything else left running survives the whole night: it holds a port the
// fleet wants, can wander into the test room as a ghost participant, and eats CPU
// on a box where timeout-shaped failures have usually been starvation, not the diff.
try {
  const ps = sh('ps', ['-Ao', 'command']);
  const running = ps.split('\n')
    // MAIN processes only. Each app spawns several "… Helper (GPU|Renderer)"
    // children whose paths also start with MacOS/Electron, and counting those
    // reported one running bot as four nameless instances.
    .filter((l) => /MacOS\/(Vibeconferencing|Electron) /.test(l) && !/Helper/.test(l))
    .map((l) => (l.match(/--profile=([A-Za-z0-9._-]+)/) || [])[1] || '(default profile)');
  if (running.length) {
    const reaped = running.filter((p) => /^test-meet-guest|^test-slack/.test(p));
    const survives = running.filter((p) => !/^test-meet-guest|^test-slack/.test(p));
    if (survives.length) {
      red('App instance(s) left running', `${survives.join(', ')} — the suite's teardown does NOT reap these, so they run all night`,
        'quit them (SIGTERM, not -9, so buffered prefs flush)');
    }
    if (reaped.length) {
      warn('Fleet instance(s) still up', `${reaped.join(', ')} — reaped at run start, but they hold fleet ports until then`,
        `${REPO}/scripts/spawn-test-fleet.sh 3 --kill`);
    }
  }
} catch { /* ps is not worth failing over */ }

// --- 3. Fleet ports -------------------------------------------------------
// A port held by something that ISN'T an app instance (a stale node driver, a
// forgotten tunnel) fails the spawn with no obvious cause.
try {
  const busy = [];
  for (const port of [7901, 7902, 7903, 7911, 7912]) {
    try { if (sh('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'])) busy.push(port); } catch { /* free */ }
  }
  if (busy.length) warn('Fleet port(s) occupied', `${busy.join(', ')} already listening`, `lsof -ti tcp:${busy[0]} | xargs kill`);
} catch { /* noop */ }

// --- 4. A previous run still going ---------------------------------------
// One wedged run silently ate four consecutive nightlies (2026-07-21). If the
// wrapper is somehow still alive at 19:00, tonight is already lost.
try {
  const stuck = sh('pgrep', ['-f', 'scheduled-meet-test.sh']);
  if (stuck) red('A previous run is STILL RUNNING', `pid(s) ${stuck.split('\n').join(', ')} — tonight's run would overlap it`,
    `kill ${stuck.split('\n')[0]}`);
} catch { /* nothing running: good */ }

// --- 5. Host load ---------------------------------------------------------
// Timeout-shaped failures spread across unrelated lanes have repeatedly turned
// out to be the HOST, not the diff — orphaned load generators from earlier work.
const load = loadavg()[0], nproc = cpus().length;
if (load > nproc * 0.7) {
  warn('Host is busy', `1-min load ${load.toFixed(1)} on ${nproc} cores — lanes may time out on CPU, not on bugs`, 'top -o cpu');
}

// --- 6. Test-bot identity ------------------------------------------------
// The per-profile store is <profile>/agent/config.json (#305). A profile missing
// its identity boots as "Unnamed bot" on the system default voice — and, worse,
// with ttsProvider unset it falls through to ElevenLabs and bills a whole night
// of scripted speech. Checked by SHAPE, not by exact names, so it stays true when
// the cast changes; it is the shape that broke silently on 2026-09-09.
for (const profile of ['test-meet-guest-1', 'test-meet-guest-2', 'test-meet-guest-3', 'test-slack-1', 'test-slack-2']) {
  const cfgPath = join(PROFILES, profile, 'agent', 'config.json');
  if (!existsSync(cfgPath)) { warn('Test profile has no agent config', `${profile} — it will boot with no identity`, `${REPO}/scripts/setup-test-profiles.sh`); continue; }
  try {
    const c = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const missing = ['botName', 'macosVoice'].filter((k) => !String(c[k] || '').trim());
    if (missing.length) warn('Test bot missing identity', `${profile}: ${missing.join(', ')} unset`, `${REPO}/scripts/spawn-test-fleet.sh 3 && ${REPO}/scripts/spawn-test-fleet.sh 3 --kill`);
    if (c.ttsProvider !== 'macos-say') {
      red('Test bot would speak via ElevenLabs', `${profile}: ttsProvider=${JSON.stringify(c.ttsProvider ?? null)} — a full night of scripted lines billed to the API key`,
        `node ${REPO}/scripts/profile-pref.mjs "${join(PROFILES, profile)}" ttsProvider=macos-say`);
    }
  } catch (e) { warn('Unreadable profile config', `${profile}: ${e.message}`, `check ${cfgPath}`); }
}

// --- 7. Is the job even scheduled? ---------------------------------------
// If the LaunchAgent is not loaded, nothing runs and there is no failure to
// notice — the quietest way for the nightly to stop existing.
try {
  const list = sh('launchctl', ['list']);
  if (!/com\.vibeconferencing\.meet-test/.test(list)) {
    red('Nightly LaunchAgent NOT loaded', 'com.vibeconferencing.meet-test is not in launchctl — nothing will run at 03:00',
      'launchctl load ~/Library/LaunchAgents/com.vibeconferencing.meet-test.plist');
  }
} catch { /* noop */ }

// --- 8. Everything the 03:00 preflight already covers ---------------------
// Session validity/expiry, disk, redis, telegram token, the Linux-lane box,
// Claude auth. Reused rather than reimplemented so the two can't disagree; its
// results go to a pre-test dir so the 03:00 digest never reads a 19:00 row.
try {
  const out = sh('node', [join(REPO, 'scripts/ecosystem-preflight.mjs'), '--json'], {
    timeout: 120000,
    env: { ...process.env, VIBECONF_RESULTS_DIR: RESULTS },
  });
  const pre = JSON.parse(out);
  // Entries carry `status`, one of ok | warn | down (ecosystem-preflight.mjs:353).
  // NOT a boolean `ok` — reading it as one silently matched nothing, which is the
  // same shape of bug as the loose-config write this check exists to catch.
  for (const c of pre.checks || []) {
    if (c.status === 'down') red(`Preflight: ${c.name}`, c.detail || 'down', 'node scripts/ecosystem-preflight.mjs');
    else if (c.status === 'warn') warn(`Preflight: ${c.name}`, c.detail || 'warning', 'node scripts/ecosystem-preflight.mjs');
  }
} catch (e) {
  warn('Could not run ecosystem preflight', e.message, 'node scripts/ecosystem-preflight.mjs');
}

// --- Report ---------------------------------------------------------------
const reds = findings.filter((f) => f.level === 'red');
const warns = findings.filter((f) => f.level === 'warn');
const clean = findings.length === 0;

if (JSON_OUT) console.log(JSON.stringify({ ok: clean, reds: reds.length, warns: warns.length, findings }, null, 2));
else {
  console.log(clean ? '✅ pre-test: nothing blocking tonight\'s run'
    : `pre-test: ${reds.length} blocking, ${warns.length} worth a look`);
  for (const f of findings) console.log(`  ${f.level === 'red' ? '🔴' : '⚠️ '} ${f.title} — ${f.detail}\n      fix: ${f.fix}`);
}

if (clean && !ALWAYS) process.exit(0);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const lines = [`<b>Pre-test check</b> — ${reds.length} blocking, ${warns.length} advisory (nightly runs 03:00)`];
for (const f of findings) {
  lines.push('', `${f.level === 'red' ? '🔴' : '⚠️'} <b>${esc(f.title)}</b>`, esc(f.detail), `<code>${esc(f.fix)}</code>`);
}
if (clean) lines.push('', '✅ nothing blocking.');

// Same rule as notify-nightly: no chat, no send. Never fall back to a default
// chat — a misrouted alert to the shared group is worse than a missed one.
if (!CHAT) { console.error('[pre-test] VIBECONF_NOTIFY_CHAT unset — not sending'); process.exit(0); }
let tok = '';
try { tok = (readFileSync(ENV_FILE, 'utf8').match(/^TELEGRAM_BOT_TOKEN=(.+)$/m) || [])[1]?.trim() || ''; } catch { /* noop */ }
if (!tok) { console.error(`[pre-test] no telegram token at ${ENV_FILE} — not sending`); process.exit(0); }
try {
  const resp = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Silent for advisory-only; a real blocker should buzz the phone.
    body: JSON.stringify({ chat_id: CHAT, text: lines.join('\n'), parse_mode: 'HTML', disable_notification: reds.length === 0 }),
  });
  console.error(resp.ok ? '[pre-test] telegram sent' : `[pre-test] telegram failed: ${resp.status}`);
} catch (e) { console.error(`[pre-test] telegram error: ${e.message}`); }
process.exit(0);
