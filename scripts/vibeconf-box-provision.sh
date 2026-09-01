#!/bin/bash
# vibeconf-box-provision.sh — the whole formula for a cloud box, in one command.
#
#   scripts/vibeconf-box-provision.sh cloud-ta
#   scripts/vibeconf-box-provision.sh test v0.8.44
#
# Runs, in order:
#   1. vibeconf-box-update.sh          the app + the service that starts it on boot
#   2. vibeconf-box-desktop.sh         panel, menu, file manager, one desktop,
#                                      Chrome as default browser
#   3. vibeconf-box-remote-access.sh   noVNC + raw VNC over Tailscale, clipboard
#   4. vibeconf-box-agent-perms.sh     dontAsk, so an unattended agent denies
#                                      instead of hanging on a prompt
#
# Each step is idempotent, so re-running this is the repair path as well as the
# build path. Everything it does was previously typed by hand on some boxes and
# not others, which is how the fleet drifted — see the notes in each script.
#
# ─────────────────────────────────────────────────────────────────────────────
# BEFORE YOU MAKE AN AMI FROM A BOX, remove its identity or every clone will
# fight the original for it:
#
#     sudo systemctl stop tailscaled
#     sudo rm -f /var/lib/tailscale/tailscaled.state
#     sudo rm -f ~/.config/google-chrome/Singleton*
#     sudo hostnamectl set-hostname localhost
#
# Skipping the Tailscale line is what produced a day of phantom bugs: the test
# box carried cloud-ta's node key, so the tailnet name resolved to whichever
# box registered last. Screen Sharing "not working", a VNC password that
# "reset itself", and a browser that "did nothing" were all one cause.
#
# AFTER RE-REGISTERING A BOX (`tailscale up --reset`), re-run this script:
# the node identity comes back, but the serve rules do NOT.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BOX="${1:-${VIBECONF_BOX:-vibeconf-cloud-ta}}"
VERSION="${2:-}"
case "$BOX" in vibeconf-*) ;; *) BOX="vibeconf-$BOX" ;; esac

echo "############################################################"
echo "# provisioning $BOX"
echo "############################################################"

rc=0
run_step() {
  local title="$1"; shift
  echo
  echo "############ $title"
  if "$@"; then
    echo "############ $title: OK"
  else
    echo "############ $title: FAILED"
    rc=1
  fi
}

run_step "1/4 app + boot service" bash "$HERE/vibeconf-box-update.sh" "$BOX" $VERSION
run_step "2/4 desktop"            bash "$HERE/vibeconf-box-desktop.sh" "$BOX"
run_step "3/4 remote access"      bash "$HERE/vibeconf-box-remote-access.sh" "$BOX"
run_step "4/4 agent permissions"  bash "$HERE/vibeconf-box-agent-perms.sh" "$BOX"

echo
echo "############################################################"
if [ "$rc" -eq 0 ]; then
  echo "# $BOX provisioned."
  echo "#   screen  : http://$BOX/vnc.html   (browser, nothing to install)"
  echo "#   screen  : vnc://$BOX.<tailnet>.ts.net   (macOS Screen Sharing)"
  echo "#   shell   : VIBECONF_BOX=$BOX vibeconf-attach --shell"
  echo "#   password: VIBECONF_BOX=$BOX vibeconf-attach --run 'cat ~/.vnc/plain'"
else
  echo "# $BOX: one or more steps FAILED — see above"
fi
echo "############################################################"
exit $rc
