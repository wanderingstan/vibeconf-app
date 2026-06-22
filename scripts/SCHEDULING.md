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

## Notes / caveats
- **Same machine as a real bot?** The fleet uses ports 7901+ and profiles
  `test1/2…`, distinct from the real Jimmy (7865) / Samantha (7866), so a
  scheduled run won't collide with those. But two app instances both grabbing the
  mic/camera can contend — don't schedule it to overlap a real call.
- **Display sleep:** if the Mac mini's display sleeps, Electron/WebRTC usually
  still runs, but if you see flaky captures, set `caffeinate` or disable display
  sleep. (The machine being always-on/awake is the assumption here.)
- The open test meet means no Google sign-in is needed for the test profiles.
