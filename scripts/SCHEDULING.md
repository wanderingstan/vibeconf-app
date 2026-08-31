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
- `scripts/bot-pr-pipeline.mjs` — phase-two readiness pulse (writes nothing; see below).

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

### Phase two — the write side (skeleton only)

Phase two picks up issues **a human tagged `good-for-bot`** and opens draft PRs for
them. It is not built. What exists is `scripts/bot-pr-pipeline.mjs`, a readiness
pulse that writes nothing:

```sh
node scripts/bot-pr-pipeline.mjs          # preflight + the pool + what it WOULD do
node scripts/bot-pr-pipeline.mjs --json   # same, machine-readable
node scripts/bot-pr-pipeline.mjs --execute  # refuses, exit 2
```

The morning survey runs it and folds the answer into the digest, so the readiness
check is something you see daily rather than something you remember to run. A
readiness check nobody reads is already broken.

It preflights the things that can genuinely be wrong *today*: `gh` authed with a
token that can actually write, a resolvable `claude` binary, and the `good-for-bot`
label present in **every** repo in the list. That last one matters more than it
looks — an empty pool and a missing label are indistinguishable from the outside,
so a rename (or a new repo added without the label) would read as "nothing to do"
forever.

`wanderingstan/vibeconf-app#565` is a deliberate **canary**: a `good-for-bot` issue
that explicitly asks an agent to do nothing and report back. It gives the pool a
non-zero member before any real issue is tagged, and when phase two goes live its
first run is a test of the property that matters most — whether an agent respects
the scope written in the issue instead of opening a PR anyway.

**It stays a separate file from the survey on purpose.** The survey is read-only by
construction, and that is its whole value in the first weeks. The moment read and
write live in one script, "read-only" is a flag someone can flip by accident.

**When it is built it runs as a Claude cloud routine** (`/schedule`), not a
LaunchAgent — sandboxed, parallel, doesn't need the mini awake, and a job that
writes branches has no business sharing a host with the test runner it reports on.

## Notes / caveats
- **Same machine as a real bot?** The fleet uses ports 7901+ and dedicated
  `test-meet-*` / `test-slack-*` profiles, distinct from the real Jimmy (7865) / Samantha (7866), so a
  scheduled run won't collide with those. But two app instances both grabbing the
  mic/camera can contend — don't schedule it to overlap a real call.
- **Display sleep:** if the Mac mini's display sleeps, Electron/WebRTC usually
  still runs, but if you see flaky captures, set `caffeinate` or disable display
  sleep. (The machine being always-on/awake is the assumption here.)
- The open test meet means no Google sign-in is needed for the test profiles.
