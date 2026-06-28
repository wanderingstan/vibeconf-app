#!/bin/zsh
# setup-test-profiles.sh — one-time setup of the SIGNED-IN test profiles on a
# fresh machine (#282). Guest profiles (test-meet-guest-*) need no setup — the
# fleet creates and reaps them. But the Google (test-meet-google-*) and Slack
# (test-slack-*) profiles need a human to sign in ONCE; their login then persists
# in the profile's single `session` partition across runs.
#
# This launches each signed-in profile (pinning its Google account via
# --meet-account-email) and prints a checklist of which account to sign into.
# See docs/testing-profiles.md for the full picture.
#
#   scripts/setup-test-profiles.sh            # set up Google + Slack profiles
#   scripts/setup-test-profiles.sh --google   # just the test-meet-google-* profiles
#   scripts/setup-test-profiles.sh --slack     # just the test-slack-* profiles
#
# Override the accounts via env (defaults match docs/testing-profiles.md):
#   GTEST_EMAIL_DOMAIN=spiritprotocol.io
#   SLACKTEST1_ACCOUNT / SLACKTEST2_ACCOUNT
#   SLACK_SETUP_URL=https://app.slack.com/   (where the Slack profiles open to log in)
#
# Uses the INSTALLED app (/Applications) by default — the artifact you actually
# test against. Pass --built to use electron-app/dist instead.

set -e
REPO="${0:A:h:h}"

DO_GOOGLE=0; DO_SLACK=0; BUILT=0
for a in "$@"; do
  case "$a" in
    --google) DO_GOOGLE=1 ;;
    --slack)  DO_SLACK=1 ;;
    --built)  BUILT=1 ;;
    *) echo "usage: $0 [--google] [--slack] [--built]"; exit 1 ;;
  esac
done
# Default: set up both classes.
(( DO_GOOGLE || DO_SLACK )) || { DO_GOOGLE=1; DO_SLACK=1; }

# Resolve the app bundle.
if (( BUILT )); then
  APP=$(ls -d "$REPO"/electron-app/dist/mac*/Vibeconferencing.app 2>/dev/null | head -1)
  [[ -d "$APP" ]] || { echo "✗ No built app under electron-app/dist — run 'pnpm dist' first."; exit 1; }
else
  APP="/Applications/Vibeconferencing.app"
  [[ -d "$APP" ]] || { echo "✗ Installed app not found at $APP — install the DMG first (or pass --built)."; exit 1; }
fi

GTEST_EMAIL_DOMAIN="${GTEST_EMAIL_DOMAIN:-spiritprotocol.io}"
SLACKTEST1_ACCOUNT="${SLACKTEST1_ACCOUNT:-<your Slack account 1>}"
SLACKTEST2_ACCOUNT="${SLACKTEST2_ACCOUNT:-<your Slack account 2>}"
SLACK_SETUP_URL="${SLACK_SETUP_URL:-https://app.slack.com/}"

# profile : port : account  (ports match the fleet's BASE_PORT range so a
# signed-in profile is reachable on the same port the fleet drives it on).
typeset -a STEPS

launch_google() {
  local profile="$1" port="$2" acct="$3"
  echo "  • $profile  → sign in as: $acct   (port $port)"
  open -n "$APP" --args --profile="$profile" --local-port="$port" --meet-account-email="$acct"
  STEPS+=("$profile: click \"Sign in as bot\" in the panel, sign in as $acct")
}

launch_slack() {
  local profile="$1" port="$2" acct="$3"
  echo "  • $profile  → sign in as: $acct   (port $port)"
  open -n "$APP" --args --profile="$profile" --local-port="$port" --provider=slack --slack-url="$SLACK_SETUP_URL"
  STEPS+=("$profile: sign into Slack as $acct in the embedded view")
}

echo "▶ Setting up signed-in test profiles using $APP"
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
echo "  • When done, just quit each window. Verify with: scripts/spawn-test-fleet.sh 2 --google"
echo "  • Reclaim old partition space anytime: node scripts/cleanup-orphaned-partitions.mjs"
