#!/bin/zsh
# setup-test-profiles.sh — one-time setup of the SIGNED-IN test profiles (#282).
# The Google (test-meet-google-*) and Slack (test-slack-*) profiles need a human
# to sign in ONCE; their login persists in the profile's `session` partition. The
# guest profiles (test-meet-guest-*) need no GOOGLE login (that's the point — they
# test the guest Meet-join path) — BUT one of them now needs a one-time
# vibeconferencing.com (OUR server) login so the nightly can mint a fresh room per
# run instead of falling back to the fixed, publicly-joinable hard-coded room.
# That login is the APP-USER session, separate from the bot's Meet login (the
# OAuth opens in the system browser), so the bot still joins Meet as a guest.
#
# Launches each profile and prints a checklist of what to sign into.
# See docs/testing-profiles.md for the full picture.
#
#   scripts/setup-test-profiles.sh            # everything, from SOURCE (default)
#   scripts/setup-test-profiles.sh --google   # just the test-meet-google-* profiles
#   scripts/setup-test-profiles.sh --slack     # just the test-slack-* profiles
#   scripts/setup-test-profiles.sh --vibeconf  # just the vibeconferencing.com login (room minting)
#   scripts/setup-test-profiles.sh --installed # use the installed /Applications app
#   scripts/setup-test-profiles.sh --built     # use the freshly-built electron-app/dist app
#
# DEFAULT IS SOURCE (`pnpm dev`) so you sign in under the CODE YOU'RE TESTING.
# This matters: a profile's login lives in that build's session partition, and
# an OLD installed build uses a DIFFERENT (pre-#282) partition — signing in there
# does NOT carry over to the new code. Only use --installed/--built once a build
# WITH this branch is what you'll run.
#
# Override the accounts via env (defaults match docs/testing-profiles.md):
#   GTEST_EMAIL_DOMAIN=spiritprotocol.io
#   SLACKTEST1_ACCOUNT / SLACKTEST2_ACCOUNT
#   SLACK_SETUP_URL=https://app.slack.com/

set -e
REPO="${VIBECONF_REPO:-${0:A:h:h}}"
ELECTRON="$REPO/electron-app"

DO_GOOGLE=0; DO_SLACK=0; DO_VIBECONF=0; MODE="source"
for a in "$@"; do
  case "$a" in
    --google)    DO_GOOGLE=1 ;;
    --slack)     DO_SLACK=1 ;;
    --vibeconf)  DO_VIBECONF=1 ;;
    --built)     MODE="built" ;;
    --installed|--dmg) MODE="installed" ;;
    *) echo "usage: $0 [--google] [--slack] [--vibeconf] [--installed|--built]"; exit 1 ;;
  esac
done
# Default: set up everything.
(( DO_GOOGLE || DO_SLACK || DO_VIBECONF )) || { DO_GOOGLE=1; DO_SLACK=1; DO_VIBECONF=1; }

# Resolve the packaged app only when not running from source.
APP=""
if [[ "$MODE" == "built" ]]; then
  APP=$(ls -d "$REPO"/electron-app/dist/mac*/Vibeconferencing.app 2>/dev/null | head -1)
  [[ -d "$APP" ]] || { echo "✗ No built app under electron-app/dist — run 'pnpm dist' first."; exit 1; }
elif [[ "$MODE" == "installed" ]]; then
  APP="/Applications/Vibeconferencing.app"
  [[ -d "$APP" ]] || { echo "✗ Installed app not found at $APP — install the DMG first (or drop the flag for source)."; exit 1; }
fi

GTEST_EMAIL_DOMAIN="${GTEST_EMAIL_DOMAIN:-spiritprotocol.io}"
# Slack has no account pin (unlike Google's --meet-account-email) — you just log
# in interactively and pick the workspace. These are optional human-readable
# LABELS for the printed checklist, nothing the app reads.
SLACKTEST1_ACCOUNT="${SLACKTEST1_ACCOUNT:-your Slack test account (pick the workspace)}"
SLACKTEST2_ACCOUNT="${SLACKTEST2_ACCOUNT:-a second Slack test account (pick the workspace)}"
SLACK_SETUP_URL="${SLACK_SETUP_URL:-https://app.slack.com/}"

# --- Per-bot profile prefs (#316) ------------------------------------------
# Seed each profile's identity so it's correct even when the app is opened
# WITHOUT the fleet's --bot-name flag (e.g. this setup script, or a manual
# launch). The naming convention is uniform across every class — Alice is always
# index 1, Jimmy is always index 2:
#   Alice (…-1) = botName Alice, emojiSet fluent3d
#   Jimmy (…-2) = botName Jimmy, emojiSet noto
# botName in particular MUST be persisted: the app reads store.get('botName')
# and falls back to a hardcoded 'Jimmy' when it's unset — so an un-seeded Alice
# profile shows up as "Jimmy" on the main screen and in Bot Preferences.
# onboardingComplete=true skips the first-run setup wizard: the wizard is a
# focus-stealing modal window, and once it can appear for ANY un-onboarded
# profile (not just the default instance) it would pop up mid-test. Seeding it
# keeps the fleet headless.
# These are per-profile electron-store prefs (config.json), login-independent,
# so we write them directly (creating the profile dir if needed). Runs
# regardless of the --google/--slack flags.
PROFILE_ROOT="$HOME/Library/Application Support/Vibeconferencing/profiles"
set_pref() {  # <profile-name> <key> <value> — 'true'/'false' are written as JSON booleans
  local dir="$PROFILE_ROOT/$1"
  node -e 'const fs=require("fs"),p=process.argv[1],k=process.argv[2],raw=process.argv[3];const v=raw==="true"?true:raw==="false"?false:raw;let c={};try{c=JSON.parse(fs.readFileSync(p,"utf8"))}catch{};c[k]=v;fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n")' "$dir/config.json" "$2" "$3"
  echo "  • $1 → $2=$3"
}
echo "▶ Profile identity: Alice(-1)=fluent3d, Jimmy(-2)=noto (+ skip onboarding wizard)"
for cls in test-meet-guest test-meet-google test-slack; do
  mkdir -p "$PROFILE_ROOT/$cls-1" "$PROFILE_ROOT/$cls-2"
  set_pref "$cls-1" botName Alice; set_pref "$cls-1" emojiSet fluent3d; set_pref "$cls-1" onboardingComplete true
  set_pref "$cls-2" botName Jimmy; set_pref "$cls-2" emojiSet noto;     set_pref "$cls-2" onboardingComplete true
done
echo

typeset -a STEPS

# launch <profile> <port> <extra args…> — source uses pnpm dev (the branch code);
# packaged opens a new instance of the resolved .app bundle.
launch() {
  local profile="$1" port="$2"; shift 2
  local extra="$*"
  if [[ "$MODE" == "source" ]]; then
    nohup zsh -c "cd '$ELECTRON' && pnpm dev -- --profile=$profile --local-port=$port $extra" \
      >"/tmp/vibeconf-setup-$profile.log" 2>&1 &
  else
    open -n "$APP" --args --profile="$profile" --local-port="$port" ${=extra}
  fi
}

launch_google() {
  local profile="$1" port="$2" acct="$3"
  echo "  • $profile  → sign in as: $acct   (port $port)"
  launch "$profile" "$port" "--meet-account-email=$acct"
  STEPS+=("$profile: click \"Sign in as bot\" in the panel, sign in as $acct")
}

launch_slack() {
  local profile="$1" port="$2" acct="$3"
  echo "  • $profile  → sign in as: $acct   (port $port)"
  launch "$profile" "$port" "--provider=slack --slack-url=$SLACK_SETUP_URL"
  STEPS+=("$profile: sign into Slack as $acct in the embedded view")
}

# vibeconferencing.com (OUR server) login — the APP-USER session, separate from
# the bot's Google/Meet login. It enables /api/meet/create so the nightly mints a
# FRESH room per run instead of falling back to the fixed, publicly-joinable
# hard-coded room. Crucially the OAuth opens in the SYSTEM BROWSER
# (shell.openExternal in openGoogleLogin), so it does NOT put a Google session in
# the bot's Meet partition — the bot still joins Meet as a guest. The resulting
# vc_session token persists in the profile AND donates to the shared app token
# (syncSharedLoginCookie), so the other test profiles pick it up too — one login
# is enough. We sign in the guest minting profile (test-meet-guest-1), the one
# join-route's /call mint runs on.
launch_vibeconf() {
  local profile="$1" port="$2"
  echo "  • $profile  → sign into vibeconferencing.com (our server)   (port $port)"
  launch "$profile" "$port"
  STEPS+=("$profile: click \"Sign in\" in the panel to log into vibeconferencing.com; finish the Google login in the BROWSER window that opens. This is the APP-USER login on our server — NOT the bot's Meet login, so the bot stays a Meet guest. Enables per-run room minting (kills the hard-coded-room fallback).")
}

echo "▶ Setting up signed-in test profiles (mode: $MODE${APP:+ — $APP})"
[[ "$MODE" == "source" ]] && echo "  (running the branch code via pnpm dev — logins land in the new 'session' partition)"
echo

if (( DO_GOOGLE )); then
  echo "Google (Meet) profiles:"
  launch_google test-meet-google-1 7901 "alice@${GTEST_EMAIL_DOMAIN}"
  launch_google test-meet-google-2 7902 "jimmy@${GTEST_EMAIL_DOMAIN}"
  echo
fi

if (( DO_SLACK )); then
  echo "Slack profiles:"
  launch_slack test-slack-1 7903 "$SLACKTEST1_ACCOUNT"
  launch_slack test-slack-2 7904 "$SLACKTEST2_ACCOUNT"
  echo
fi

if (( DO_VIBECONF )); then
  echo "vibeconferencing.com login (enables per-run Meet room minting → no more hard-coded-room fallback):"
  launch_vibeconf test-meet-guest-1 7905
  echo
fi

echo "──────────────────────────────────────────────────────────────"
echo "Now sign each window in (one-time — the login persists per profile):"
echo
local i=1
for s in "${STEPS[@]}"; do echo "  $i. $s"; i=$((i+1)); done
echo
echo "Tips:"
echo "  • Google: the panel's \"Sign in as bot\" opens the Google login. The"
echo "    --meet-account-email pin means joins will use that exact account."
echo "  • Need a specific Google/Slack state (accept an invite, switch workspace)?"
echo "    Use the app menu \"Navigate Webview…\" (⌘⇧L) to drive the view anywhere."
echo "  • Verify the new code is running: you should see the ⇄ profile switcher"
echo "    next to the heading, and the heading should read the PROFILE name."
echo "  • When done, just quit each window. Then: scripts/spawn-test-fleet.sh 2 --google"
echo "  • source mode logs to /tmp/vibeconf-setup-<profile>.log"
