# Scheduling the automated Meet test (Mac mini)

Runs `pnpm test:meet:dmg` (spawn 2 test bots **from the installed packaged app** →
drive scripted scenarios against the open meet `paz-sqoa-npe` → teardown) on a
nightly schedule, capturing a log + a one-line JSON result per run for trend
tracking.

**Why `:dmg` (packaged) for the scheduled run:** the Mac mini is the always-on
machine, so it's our only automated-test host — but we want automated testing to
reflect the **average user**, who runs the packaged DMG, not from source. The
harness drives bots over HTTP regardless of how the app launched, so `--dmg` points
the fleet at `/Applications/Vibeconferencing.app` and tests the exact artifact
users get (catching packaging-only bugs like asar/build.files issues that never
show from source). **Keep the installed app up to date** with the build you want to
validate. Your manual testing also uses the DMG; from-source is for development.

**Why a LaunchAgent (not cron / not a Claude `/schedule` cloud agent):** the test
spawns real Electron apps that need a **logged-in GUI session** plus mic / camera /
screen-recording permissions. A LaunchAgent runs in the user's GUI session; cron
and LaunchDaemons don't, and a cloud agent can't reach the local apps at all. So
this must run on the Mac mini **while logged in** (it's always-on, so fine).

## Pieces
- `scripts/scheduled-meet-test.sh` — wrapper: runs the CI target, writes
  `~/vibeconf-test-results/run-<ts>.log` and appends to `results.jsonl`.
- `scripts/com.vibeconferencing.meet-test.plist` — the LaunchAgent (nightly 03:00).

## Install (one time, on the Mac mini)
```sh
# 1. Make sure the wrapper is executable
chmod +x scripts/scheduled-meet-test.sh

# 2. Copy the agent into place
cp scripts/com.vibeconferencing.meet-test.plist ~/Library/LaunchAgents/

# 3. Load it
launchctl load ~/Library/LaunchAgents/com.vibeconferencing.meet-test.plist

# 4. (Optional) run it once NOW to verify, instead of waiting for 03:00
launchctl start com.vibeconferencing.meet-test
```

First run will prompt for any missing mic/camera/screen permissions — **approve
them once at the Mac mini** (the apps can't be admitted to those prompts remotely).
After that it's unattended.

## Review results
```sh
# History (one line per run): exit code, stalls, fails, lockstep overlaps
cat ~/vibeconf-test-results/results.jsonl

# Full log of a specific run
ls -t ~/vibeconf-test-results/run-*.log | head -1 | xargs cat
```
`exit` is non-zero when the harness saw a failure or a stall — so a quick
`grep '"exit":[^0]' results.jsonl` surfaces bad nights.

## Change the schedule
Edit `StartCalendarInterval` in the plist (Hour/Minute), then reload:
```sh
launchctl unload ~/Library/LaunchAgents/com.vibeconferencing.meet-test.plist
cp scripts/com.vibeconferencing.meet-test.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.vibeconferencing.meet-test.plist
```
Add more `<dict>` Hour/Minute entries to the array to run several times a day.

## Uninstall
```sh
launchctl unload ~/Library/LaunchAgents/com.vibeconferencing.meet-test.plist
rm ~/Library/LaunchAgents/com.vibeconferencing.meet-test.plist
```

## Recording artifacts (set in the plist's `EnvironmentVariables`)
The wrapper can preserve two kinds of recording per run, both under
`~/vibeconf-test-results/` and both governed by the same keep/prune policy:

- **`VIBECONF_RECORD=1`** — screen-records each live-call lane to
  `recordings/<lane>-<ts>.mov` (what the machine displayed).
- **`VIBECONF_RECORD_CALLS=1`** — turns on the app's own **per-participant call
  recording** for every test bot (exported to the fleet as `VIBECONF_RECORD_CALL`).
  After each lane the wrapper harvests the bots' merged
  `call-recording*.mp4` out of the throwaway test profiles into
  `call-recordings/<lane>-<ts>/` (this exercises the real recording feature
  end-to-end, and gives us the actual call audio/video from a failing night).
- **`VIBECONF_RECORD_KEEP`** — retention policy, applies to both kinds:
  - `fails` — keep only FAILING lanes' artifacts (greens deleted immediately).
  - `all` — keep every lane's artifact.
  - `nightly` (**what the mini uses**) — keep EVERY lane's recording for the current
    run, then at the START of the next run reap the prior run's GREENS while keeping
    its FAILURES. So you can inspect any of last night's lanes for a day, and only
    failures persist beyond the next 3am run. Failures are tagged `.FAIL` in the name
    and capped to the newest `VIBECONF_RECORD_MAX`; greens are kept locally only.

  Newest **`VIBECONF_RECORD_MAX`** (default 5) kept per kind. A **failing** lane's
  artifact uploads to the shared Drive (`rclone`) when configured, so a red night's
  digest links straight to it; greens stay local (except in `all` mode, which uploads
  everything).

## Ecosystem preflight (first thing in the 03:00 run)

`scripts/ecosystem-preflight.mjs` asks whether the world the suite depends on is
standing up, before the suite runs. It writes `preflight-results.jsonl` and
`notify-nightly.mjs` renders the result **above** the lane list.

**Why above the lanes:** the same reason the on-screen-dialog warning is there —
*"if a dialog owned the screen, that reframes every red line below it, and reading
it after the fact is how a night gets misdiagnosed as a product regression."* A
dead dependency reframes the night identically. On 2026-09-01 two whiteboard lanes
went red and it took a screenshot, a version-counter comparison across three runs,
and a live API probe to establish that the product was fine and Upstash was not.
One HTTP request knew.

**It never gates.** Always exits 0; the run continues regardless. If Redis is down
the app-local lanes still carry real signal, and letting one flaky 3am DNS lookup
abort the night is the failure the global watchdog exists to prevent. The digest
carries the warning; the lanes carry on.

What it checks, and why each one earned its slot — every one has actually caused a
bad night in this repo's logs:

| Check | The night it would have saved |
|---|---|
| website | baseline; separates "site down" from "one subsystem down" |
| **redis (whiteboard state)** | 2026-09-01. Two requests, not one: a real room exercises Redis, an unknown room exercises only the Postgres lookup before it. The **contrast** is the diagnosis |
| **vibeconferencing.com session** | the three-night fallback-room run. When it dies, live lanes report GREEN against the shared public room — worse than red, because nothing looks wrong |
| github releases | unreachable = the DMG silently stays on yesterday's build while the digest reports a version it never installed |
| aws box | only reds on `terminated`/`shutting-down` — `stopped` is the box's **normal resting state**, since the Linux lane starts and stops it itself |
| **claude code auth** | #556 — bot joins fine, then sits mute because its Claude session was logged out. This is the pre-flight that issue asks for |
| disk space | a failing lane keeps a 144-256MB `.mov`; running out costs the recordings *and* the stills, i.e. the evidence for why it went red |
| telegram notifier | self-referential and worth it: if the token is dead, a catastrophic night and a night that never ran look identical |
| **archive volume** | recordings and `logs-archive` live on an external drive via symlinks; if it unmounts the writes fail and the only symptom is missing evidence on the night you most wanted it. Self-configuring — it watches whichever results paths are symlinks, so a machine without the drive skips it rather than warning |

```sh
node scripts/ecosystem-preflight.mjs          # human-readable
node scripts/ecosystem-preflight.mjs --json   # machine-readable
```

**`VIBECONF_EXPECT_ACCOUNT`** is set in the LaunchAgent to the rig's bot email
(`jimmy@spiritprotocol.io`). Without it the preflight only *reports* which account
the session belongs to; with it, a session for the wrong account is a red line. This is not hypothetical: on 2026-09-01
a re-mint produced a valid year-long token for the operator's personal Google
account, and every check passed — the rig would have minted rooms owned by a human,
landing in their room history, looking entirely healthy.

Knobs: `VIBECONF_PREFLIGHT_ROOM` (the canary room — must be a **permanent** one, or
a 404 on a cold Redis is indistinguishable from a real fault), `VIBECONF_DISK_MIN_GB`
(default 15), plus the AWS/Telegram/Claude vars documented in the script header.

**Adding a check:** the bar is that it has caused a real bad night. A preflight that
cries wolf gets ignored, and an ignored preflight is worse than none — the first
draft of this one flagged the EC2 box as DOWN for being `stopped`, which would have
fired every single night.

## Morning backlog survey (04:30, separate agent)

The last rung of the nightly ladder — 03:00 meet-test suite → 04:00 TTS guardrail →
04:10 corpus sweep → **04:30 this**. Keep it last: it reads what the others leave
behind, so moving it earlier would survey a night that hasn't finished.

A separate LaunchAgent: `scripts/nightly-issue-triage.mjs` reads the whole
open-issue backlog for **both** repos plus last night's lane results, and posts a
short Telegram digest + writes a full markdown report — so the day starts with "here
are the three things to do" instead of 349 open issues.

**Read-only.** It opens no PRs, closes no issues, and applies no labels unless you
run it by hand with `--apply-labels`. That's deliberate for the first few weeks: the
point is to find out whether its judgement is worth trusting *before* it writes
anything. Its `botReady` list is a set of **proposals** — you tag the ones you agree
with `good-for-bot`, and phase two only ever picks from that pool. It never
self-selects what it's allowed to work on.

**Why a separate agent, not a lane in `scheduled-meet-test.sh`:** that wrapper is
GUI-bound and runs under a hard global watchdog whose budget is eaten by *failing*
lanes. A lane appended to the end of it dies on exactly the nights worth triaging —
the same failure mode that hid the Linux lane for three nights. This job needs `gh`
and a network, nothing else. Same independence argument the wrapper already makes
for `nightly-call-digest.mjs`.

It still *reads* `~/vibeconf-test-results/*results*.jsonl` — a failing lane outranks
anything in the backlog, and the prompt says so explicitly. That's a read-only
dependency on the artifacts the 03:00 run leaves behind, not a dependency on it
having succeeded.

- `scripts/nightly-issue-triage.mjs` — the survey.
- `scripts/com.vibeconferencing.issue-triage.plist` — the LaunchAgent (04:30).
- `scripts/bot-pr-pipeline.mjs` — phase-two pulse *and* dispatcher (see below; the pulse writes nothing).

```sh
# Install
cp scripts/com.vibeconferencing.issue-triage.plist ~/Library/LaunchAgents/
launchctl unload ~/Library/LaunchAgents/com.vibeconferencing.issue-triage.plist 2>/dev/null
launchctl load  ~/Library/LaunchAgents/com.vibeconferencing.issue-triage.plist

# See what it would say, without sending or writing anything
VIBECONF_TRIAGE_DRYRUN=1 node scripts/nightly-issue-triage.mjs

# Run it for real now
launchctl start com.vibeconferencing.issue-triage
tail -f ~/vibeconf-test-results/issue-triage.log

# This morning's report
ls -t ~/vibeconf-test-results/issue-triage/survey-*.md | head -1 | xargs cat
```

Knobs live in the plist's `EnvironmentVariables` (chat id, model, repo list); the
script header documents the rest. Two worth knowing:

- `VIBECONF_TRIAGE_MODEL` — `opus` by default. This is one judgement call a day over
  the whole backlog, unlike the sonnet-powered failure RCA in `notify-nightly.mjs`.
- `VIBECONF_TRIAGE_DETAIL` — how many issues per repo get a body snippet (default
  120, most-recently-updated first). The rest contribute title + labels only, which
  is enough for clustering and dupe-spotting. This tiering is what keeps the prompt
  bounded as the backlog grows.

**Strategy context:** the survey reads the Obsidian vault named in `CLAUDE.md` if
it's there, and tells the model how stale it is so old notes get down-weighted. As
of 2026-08 that vault is six notes with nothing newer than July — the survey works
without it, but it prioritises much better with it. Filling it in is the highest-
leverage thing you can do to improve these digests.

### Phase two — the write side

Phase two picks up issues **a human tagged `good-for-bot`** and puts **one
independent Claude agent on each of them**. `scripts/bot-pr-pipeline.mjs` is both
the daily readiness pulse and the dispatcher; the flags keep those apart:

```sh
node scripts/bot-pr-pipeline.mjs          # PULSE — preflight + the pool. Writes nothing.
node scripts/bot-pr-pipeline.mjs --json   # same, machine-readable (what the digest reads)
node scripts/bot-pr-pipeline.mjs --execute --dry-run   # the exact commands, spawns nothing
node scripts/bot-pr-pipeline.mjs --execute             # dispatch
```

**One agent per issue, not one session working a list.** A single session walking
N issues reliably rabbit-holes on the first hard one and the rest never happen.
Independent sessions fix that structurally: separate context windows, so one agent
burning down cannot starve the others, and separate git worktrees, so they can
touch the same files without colliding. That is `claude --bg --worktree`, which is
first-party — it detaches, prints an id, and `claude agents` / `logs` / `attach` /
`stop` / `rm` manage the fleet. No orchestration framework is involved.

Three things keep a run from going wrong, and all three are in the dispatch argv:

- **A wall-clock deadline**, because there is no working spend cap here. Measured
  on 2.1.259: `--max-budget-usd` is **print-mode only**. Under `-p` it really does
  stop a run (the result JSON says `terminal_reason: "budget_exhausted"`); under
  `--bg` it is silently ignored — a session given `$0.0001` kept working for
  minutes. So dispatch arms a detached `claude stop <id>` at launch instead.
  Default 45 minutes, `--deadline N` / `VIBECONF_BOT_PR_DEADLINE` to change.
  **On a Max subscription this is the cap that matters anyway.** There is no
  dollar bill: the cost figures Claude Code prints are imputed client-side at API
  list prices and are not what you are charged. What a runaway fleet actually
  burns is the 5-hour and 7-day rate-limit windows, which are shared with the
  interactive session you are trying to work in. Wall clock defends those; a
  dollar ceiling would not have.
- **Denial instead of hanging.** A `--bg` session has nobody to answer a permission
  prompt, so an un-allowlisted tool would park that agent forever. The dispatch
  passes an explicit `--allowedTools` allowlist *and* `--permission-prompts none`,
  which turns "would prompt" into an immediate deny. An agent that hits the wall
  fails fast instead of squatting on a worktree until morning.
  Note the `--` before the prompt in the dispatch argv: `--allowedTools` is
  variadic, so a positional prompt after it is swallowed as one more tool name and
  the agent comes up `(idle — send a prompt to start)`, having been told nothing.
- **A claim.** An issue gets `bot-attempted` **before** its agent starts. `hasOpenPR`
  only catches the attempts that succeeded, and "skipped, and why" is a legitimate
  outcome that must not be retried nightly. `--retry` overrides it.

Knobs: `--max N` (default 3), `--deadline N`, `--model M`, and the env equivalents
`VIBECONF_BOT_PR_MAX` / `_BUDGET` / `_MODEL` / `_DEADLINE`. `VIBECONF_BOT_PR_CHECKOUTS` maps each
repo to its local checkout, because `--worktree` branches the repo it runs *in* —
an issue in the website repo has to be dispatched from the website checkout.

The morning survey runs it and folds the answer into the digest, so the readiness
check is something you see daily rather than something you remember to run. A
readiness check nobody reads is already broken.

It preflights the things that can genuinely be wrong: `gh` authed with a token that
can actually write, a resolvable `claude` binary, a local checkout per repo, and
the `good-for-bot` label present in **every** repo in the list. `--execute` refuses
outright unless preflight is green. That label check matters more than it looks — an empty pool and a missing label are indistinguishable from the outside,
so a rename (or a new repo added without the label) would read as "nothing to do"
forever.

`wanderingstan/vibeconf-app#565` is a deliberate **canary**: a `good-for-bot` issue
that explicitly asks an agent to do nothing and report back. It gives the pool a
non-zero member before any real issue is tagged, and it is what the **first real
dispatch should be pointed at** — it tests the property that matters most, whether
an agent respects the scope written in the issue instead of opening a PR anyway.
Run it alone (`--max 1`) and read the comment it leaves before letting a batch go.

**It stays a separate file from the survey on purpose.** The survey is read-only by
construction, and that is its whole value. The moment read and write live in one
script, "read-only" is a flag someone can flip by accident. Note that the survey
shells out to `--json`, which is on the pulse path: nothing reachable from there
may ever write.

**Dispatch is deliberately NOT scheduled yet.** It runs when you run it. Putting a
branch-writing job on a timer is a decision to make after you have watched a few
batches by hand, not before. When it does go on a timer it belongs in a Claude
cloud routine (`/schedule`), not a LaunchAgent — sandboxed, parallel, doesn't need
the mini awake, and a job that writes branches has no business sharing a host with
the test runner it reports on.

## Call archive sync to Drive (every 30 min, any machine with bots)

`scripts/sync-calls-to-drive.mjs` copies every finished call folder
(`profiles/<profile>/agent/calls/<call-id>/`, the whole thing) to the team's
Drive archive, `VIBECONF Shared Files/vibeconf-call-archives/`. It is the
fallback for the bot's own after-call upload, which runs inside an LLM session
through the Drive connector and quietly fails whenever that session loses its
authorisation or gets cut off. This one is a plain script on a launchd timer:
incremental, idempotent, and independent of any agent.

**Layout on Drive** matches the convention in the agent's CLAUDE.md, so both
paths land in the same place:

    vibeconf-call-archives/<room-code>-<YYYY-MM-DD>/<bot name>/…

Room code + local date as the top folder (call ids differ per bot, room + date
does not), the bot's name as the subfolder. Two people running this against the
archive line up their recordings of one call automatically. To keep one parent
folder per person instead, set `VIBECONF_SYNC_OWNER=stan` (layout becomes
`<owner>/<room-date>/<bot>/`).

**Backends** (picked automatically, in this order):

1. `VIBECONF_DRIVE_ARCHIVE_DIR` — a folder the Google Drive desktop app syncs.
   Plain `rsync` into it; Drive does the upload. The archive lives in a folder
   *shared with* you, and shared-with-me folders don't sync to disk until you
   add a shortcut in My Drive (Drive web → `vibeconf-call-archives` → ⋮ →
   Organise → Add shortcut → My Drive). Then:

       export VIBECONF_DRIVE_ARCHIVE_DIR="$HOME/Library/CloudStorage/GoogleDrive-<you>@gmail.com/My Drive/vibeconf-call-archives"

   Put that line in `~/.config/vibeconf/sync-calls.env` (the script reads it;
   launchd's login shell never sources `~/.zshrc`). No extra tooling — the
   right choice for a laptop.
2. `rclone` with the `Vibeconf Shared Files` remote (what the nightly suite
   already uses on the mini). `brew install rclone`, `rclone config` once,
   then nothing else to set. Override the remote/path with
   `VIBECONF_RCLONE_REMOTE` / `VIBECONF_RCLONE_ARCHIVE_PATH`. If the remote is
   rooted somewhere the archive isn't under (the mini's is rooted at the
   nightly-uploads folder), set `VIBECONF_RCLONE_ROOT_FOLDER_ID` to the
   archive folder's Drive id (`1G2Xgeo0ds0xb4ZWPxPa84YSycOUoKbHs` today):
   rclone is re-rooted there for the copy, nothing in its config changes.

With neither configured the run exits 2 and says so.

**What gets copied:** profiles listed in `VIBECONF_SYNC_PROFILES` (default
`Default`; `--all-profiles` for everything, test fleets included). A call is
only picked up once nothing in its folder has changed for
`VIBECONF_SYNC_MIN_AGE_MIN` minutes (default 10) — a merge still running or a
summary still being written holds it back. A folder that gains files later (the
agent's summary, session-log.txt) is re-synced incrementally; a
`.drive-sync.json` marker next to each call records what the last sync saw.
Nothing is ever deleted on Drive.

Install the timer (any machine whose bots' calls should be archived):

    cp scripts/com.vibeconf.sync-calls.plist ~/Library/LaunchAgents/
    launchctl load ~/Library/LaunchAgents/com.vibeconf.sync-calls.plist

Settings go in `~/.config/vibeconf/sync-calls.env` as `KEY=VALUE` lines
(environment variables already set take precedence). Files already on Drive
under the same path — the bot's own after-call upload got there first — are
never overwritten. Hand-run / inspect:

    node scripts/sync-calls-to-drive.mjs --status      # what would happen, per call
    node scripts/sync-calls-to-drive.mjs --dry-run -v  # the copy commands, not run
    node scripts/sync-calls-to-drive.mjs               # one real pass
    tail /tmp/vibeconf-sync-calls.out                  # the timer's log

## Notes / caveats
- **Same machine as a real bot?** The fleet uses ports 7901+ and dedicated
  `test-meet-*` / `test-slack-*` profiles, distinct from the real Jimmy (7865) / Samantha (7866), so a
  scheduled run won't collide with those. But two app instances both grabbing the
  mic/camera can contend — don't schedule it to overlap a real call.
- **Display sleep:** if the Mac mini's display sleeps, Electron/WebRTC usually
  still runs, but if you see flaky captures, set `caffeinate` or disable display
  sleep. (The machine being always-on/awake is the assumption here.)
- The open test meet means no Google sign-in is needed for the test profiles.
