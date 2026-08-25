#!/bin/bash
# vibeconf-box-update.sh — update a cloud box to a released version, and make
# sure the app actually starts on boot.
#
#   scripts/vibeconf-box-update.sh                    # default box, latest release
#   scripts/vibeconf-box-update.sh cloud-ta           # a specific box
#   scripts/vibeconf-box-update.sh cloud-ta v0.8.42   # a specific version
#
# WHY A SCRIPT: updating a box by hand is three commands, two of which have a
# silent wrong answer.
#
#   * `dpkg -i` instead of `apt install ./x.deb` upgrades the app but SKIPS
#     Recommends, so the box gets the new build without espeak-ng and the bot
#     is mute with nothing in the output saying why (#482).
#   * The systemd unit is easy to forget entirely. The TA box ran for weeks
#     without it: every service EXCEPT the app came back on boot, so a rebooted
#     box showed a working VNC view of an empty desktop.
#
# The .deb comes straight from the GitHub release — the repo is public, so the
# box curls it directly rather than us shuttling 108MB through SSM (whose
# output cap is ~24KB).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BOX="${1:-${VIBECONF_BOX:-vibeconf-stan}}"
VERSION="${2:-}"
REPO="wanderingstan/vibeconf-app"

if [ -z "$VERSION" ]; then
  VERSION=$(gh release list --repo "$REPO" --limit 1 --json tagName --jq '.[0].tagName') \
    || { echo "could not read the latest release (is gh authenticated?)" >&2; exit 1; }
fi
NUM="${VERSION#v}"
URL="https://github.com/$REPO/releases/download/$VERSION/vibeconferencing-agent_${NUM}_amd64.deb"

echo "box     : $BOX"
echo "version : $VERSION"
echo "deb     : $URL"
echo

UNIT=$(cat "$HERE/systemd/vibeconf-app.service")

# Heredoc-free: the whole thing goes through --run, which base64s it, so quoting
# and newlines survive intact.
read -r -d '' SCRIPT <<REMOTE
set -e
echo "--- before"
dpkg-query -W -f='  installed: \${Version}\n' vibeconferencing-agent 2>/dev/null || echo "  installed: (none)"

echo "--- fetching \$(basename "$URL")"
cd /tmp
curl -fsSL -o vibeconf-update.deb "$URL"
ls -l vibeconf-update.deb | awk '{print "  " \$5 " bytes"}'

echo "--- stopping the app so the upgrade is not racing a live process"
sudo systemctl stop vibeconf-app 2>/dev/null || true
sudo pkill -f 'Vibeconferencing/vibeconferencing-agent' 2>/dev/null || true
sleep 2

echo "--- installing with apt (NOT dpkg -i — Recommends must be honoured)"
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q /tmp/vibeconf-update.deb 2>&1 | tail -3

echo "--- installing/refreshing the systemd unit"
cat <<'UNITEOF' | sudo tee /etc/systemd/system/vibeconf-app.service >/dev/null
$UNIT
UNITEOF
sudo systemctl daemon-reload
sudo systemctl enable vibeconf-app.service 2>&1 | tail -1
sudo systemctl restart vibeconf-app.service
sleep 12

echo "--- after"
dpkg-query -W -f='  installed: \${Version}\n' vibeconferencing-agent
printf '  espeak-ng: %s\n' "\$(command -v espeak-ng || echo ABSENT)"
for s in xvfb x11vnc novnc vibeconf-app; do
  printf '  %-13s %s / %s\n' "\$s" "\$(systemctl is-active \$s)" "\$(systemctl is-enabled \$s 2>/dev/null)"
done
rm -f /tmp/vibeconf-update.deb
REMOTE

VIBECONF_BOX="$BOX" bash "$HERE/vibeconf-attach.sh" --run "$SCRIPT"
