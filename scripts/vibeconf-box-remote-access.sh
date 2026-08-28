#!/bin/bash
# vibeconf-box-remote-access.sh — make a box's screen reachable over Tailscale.
#
#   scripts/vibeconf-box-remote-access.sh cloud-ta
#   scripts/vibeconf-box-remote-access.sh stan
#
# Publishes two things on the tailnet, and NOTHING on the public internet:
#
#   http://<box>/vnc.html          noVNC in a browser  (nothing to install)
#   vnc://<box>.<tailnet>.ts.net   macOS Screen Sharing / any VNC client
#
# WHY tailscale serve RATHER THAN BINDING x11vnc WIDER: x11vnc stays on
# loopback and tailscaled proxies the tailnet connection inward. Binding x11vnc
# to 0.0.0.0 would put a VNC server on the EC2 public address behind nothing but
# an 8-character password (VNC truncates at 8 — that is the protocol, not a
# setting). This script asserts the public interface stays clear.
#
# WHY macOS SCREEN SHARING WORKS HERE BUT NOT OVER AN SSM TUNNEL: pointed at a
# forwarded localhost port, Apple's client refuses with "You cannot control your
# own screen". Over Tailscale the box is a genuine remote host, so it connects.
#
# NOT PERSISTENT ACROSS RE-REGISTRATION: `tailscale up --reset` wipes serve
# rules. If a box is ever re-registered (see the identity-collision note in
# docs/), re-run this afterwards — the node comes back, the serve rules do not.
#
# Idempotent: safe to re-run.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BOX="${1:-${VIBECONF_BOX:-vibeconf-cloud-ta}}"
case "$BOX" in vibeconf-*) ;; *) BOX="vibeconf-$BOX" ;; esac

read -r -d '' REMOTE <<'REMOTE_EOF'
set -u
echo "--- before"
sudo tailscale serve status 2>&1 | sed 's/^/    /'

echo
echo "--- clipboard: give the X selections an owner"
# x11vnc can sync the clipboard, but on a bare openbox desktop NOTHING OWNS the
# X selections — `xclip -o` returns "target STRING not available" — so there is
# nothing for it to sync and copy/paste silently does nothing in a VNC client.
# autocutsel holds both selections and keeps them in step, which is what makes
# copy/paste work in macOS Screen Sharing.
#
# Two units, one per selection: X has TWO clipboards (PRIMARY = select-to-copy,
# CLIPBOARD = Ctrl-C) and Mac clients speak to CLIPBOARD, while much of X speaks
# PRIMARY. Bridging only one leaves half the cases broken.
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q autocutsel >/dev/null 2>&1
for sel in CLIPBOARD PRIMARY; do
  low=$(echo "$sel" | tr 'A-Z' 'a-z')
  sudo tee /etc/systemd/system/autocutsel-$low.service >/dev/null <<UNIT
[Unit]
Description=autocutsel ($sel) on :99 — keeps the X selection owned and in sync
After=openbox.service
Requires=xvfb.service

[Service]
Type=simple
User=ubuntu
Environment=DISPLAY=:99
ExecStartPre=/bin/sh -c "until /usr/bin/xdpyinfo -display :99 >/dev/null 2>&1; do sleep 0.5; done"
ExecStart=/usr/bin/autocutsel -selection $sel -verbose
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
done
sudo systemctl daemon-reload
sudo systemctl enable autocutsel-clipboard autocutsel-primary >/dev/null 2>&1
sudo systemctl restart autocutsel-clipboard autocutsel-primary
sleep 3
for s in autocutsel-clipboard autocutsel-primary; do
  printf '    %-22s %s\n' "$s" "$(systemctl is-active $s)"
done

echo "    round-trip test:"
# `xclip -i` DAEMONISES to hold the selection and keeps its stdout open, which
# leaves the remote command hanging forever. setsid + full redirection detaches
# it so this returns. (Found the hard way: the first version of this script
# never returned, even though the setup itself had completed.)
printf 'clipboard-check-%s' "$$" | \
  DISPLAY=:99 setsid xclip -i -selection clipboard >/dev/null 2>&1 < /dev/stdin &
sleep 2
for s in clipboard primary; do
  V=$(DISPLAY=:99 timeout 3 xclip -o -selection $s 2>&1 | head -c 40)
  printf '      %-10s %s\n' "$s" "${V:-<empty>}"
done
echo "      (both showing the same value = CLIPBOARD<->PRIMARY bridge working)"

echo
echo "--- publishing noVNC on :80 and raw VNC on :5900 (tailnet only)"
sudo tailscale serve --bg --http 80 http://127.0.0.1:6080 >/dev/null 2>&1
sudo tailscale serve --bg --tcp 5900 tcp://127.0.0.1:5900 >/dev/null 2>&1
sudo tailscale serve status 2>&1 | sed 's/^/    /'

echo
echo "--- x11vnc must remain loopback-only"
BAD=$(sudo ss -ltn 2>/dev/null | awk '$4 ~ /:5900$/ {print $4}' | grep -E '^0\.0\.0\.0|^\*' || true)
sudo ss -ltn 2>/dev/null | awk '$4 ~ /:5900$/ {print "    " $4}'
if [ -n "$BAD" ]; then
  echo "    !! bound to a wildcard address — would be public. Refusing to call this done."
  exit 1
fi

echo
echo "--- local checks"
printf '    novnc page : %s\n' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:6080/vnc.html)"
B=$(timeout 4 bash -c 'exec 3<>/dev/tcp/127.0.0.1/5900; head -c 12 <&3' 2>/dev/null | tr -d '\r\n')
printf '    vnc banner : %s\n' "${B:-none}"
printf '    tailnet dns: %s\n' "$(tailscale status --json 2>/dev/null | python3 -c "import json,sys;print((json.load(sys.stdin).get('Self') or {}).get('DNSName','').rstrip('.'))" 2>/dev/null)"
REMOTE_EOF

echo "box: $BOX"
VIBECONF_BOX="$BOX" bash "$HERE/vibeconf-attach.sh" --run "$REMOTE"
