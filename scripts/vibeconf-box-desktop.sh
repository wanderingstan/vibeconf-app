#!/bin/bash
# vibeconf-box-desktop.sh — give a cloud box a usable desktop: an always-visible
# launcher panel, a right-click menu, and a file manager.
#
#   scripts/vibeconf-box-desktop.sh cloud-ta
#   scripts/vibeconf-box-desktop.sh test
#
# WHAT WAS ALREADY THERE: openbox (as a systemd unit on :99), xterm,
# xfce4-terminal and google-chrome. Right-clicking the desktop ALREADY opened a
# menu with "Terminal emulator" and "Web browser" — the problem was never that
# you couldn't launch things, it was that nothing on screen said so, and there
# was no way to restart the app when it wedged.
#
# WHAT THIS ADDS:
#   * tint2 — a panel pinned to the bottom of the screen with four launchers.
#     A panel rather than only a menu because a menu you have to know about is
#     not a control anyone finds under pressure.
#   * an openbox root menu with the same entries, for when the panel is covered.
#   * thunar — an actual file manager, for poking at logs and config.
#   * "Restart Vibeconferencing" — the one people will need most. It runs in a
#     VISIBLE terminal and prints the resulting status, rather than firing
#     silently, because a restart that quietly failed is worse than no button.
#
# openbox.service runs bare `/usr/bin/openbox`, not `openbox-session`, so
# ~/.config/openbox/autostart is NEVER read. That is why tint2 gets its own
# systemd unit instead of an autostart line — the autostart file would look
# correct and do nothing.
#
# Idempotent: safe to re-run.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BOX="${1:-${VIBECONF_BOX:-vibeconf-cloud-ta}}"

read -r -d '' REMOTE <<'REMOTE_EOF'
set -e
echo "--- installing packages"
# xfce4-terminal is listed EXPLICITLY, not assumed. The first version of this
# script hardcoded it in every menu entry after finding it on one box — it was
# there only because earlier #329 work had installed it, and on the boxes that
# had never had that work every single menu item failed with
# 'Failed to execute child process "xfce4-terminal" (No such file or directory)'.
# The boxes are not identical; anything referenced below gets installed here.
sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q \
  tint2 thunar xfce4-terminal >/dev/null 2>&1

echo "--- checking every binary the menu will reference"
# Assert BEFORE writing any config. A menu that points at a missing binary
# looks perfectly fine until someone clicks it, which is the worst time to
# find out.
MISSING=""
for b in tint2 thunar xfce4-terminal google-chrome; do
  if command -v "$b" >/dev/null 2>&1; then
    printf '  %-16s %s\n' "$b" "$(command -v $b)"
  else
    printf '  %-16s MISSING\n' "$b"
    MISSING="$MISSING $b"
  fi
done
if [ -n "$MISSING" ]; then
  echo "  >> refusing to write a menu that references missing binaries:$MISSING"
  exit 1
fi

mkdir -p ~/.config/openbox ~/.config/tint2 ~/.local/bin ~/.local/share/applications

echo "--- restart helper (visible, with feedback)"
cat > ~/.local/bin/vibeconf-restart-app.sh <<'SH'
#!/bin/bash
# Restart the app and SHOW what happened. A GUI button that restarts silently
# is indistinguishable from one that did nothing.
echo "Restarting Vibeconferencing..."
sudo systemctl restart vibeconf-app
sleep 3
systemctl status vibeconf-app --no-pager | head -12
echo
echo "Press Enter to close."
read -r _
SH
chmod +x ~/.local/bin/vibeconf-restart-app.sh

echo "--- .desktop entries (used by both the panel and the menu)"
cat > ~/.local/share/applications/vibeconf-restart.desktop <<'D'
[Desktop Entry]
Type=Application
Name=Restart Vibeconferencing
Comment=Restart the bot app and show its status
Exec=xfce4-terminal --title="Restart Vibeconferencing" -e "/home/ubuntu/.local/bin/vibeconf-restart-app.sh"
Icon=view-refresh
Terminal=false
Categories=System;
D

cat > ~/.local/share/applications/vibeconf-terminal.desktop <<'D'
[Desktop Entry]
Type=Application
Name=Terminal
Exec=xfce4-terminal
Icon=utilities-terminal
Terminal=false
Categories=System;
D

cat > ~/.local/share/applications/vibeconf-chrome.desktop <<'D'
[Desktop Entry]
Type=Application
Name=Google Chrome
Exec=google-chrome
Icon=google-chrome
Terminal=false
Categories=Network;
D

cat > ~/.local/share/applications/vibeconf-files.desktop <<'D'
[Desktop Entry]
Type=Application
Name=Files
Exec=thunar
Icon=system-file-manager
Terminal=false
Categories=System;
D

echo "--- openbox: ONE desktop, not four"
# Openbox ships with 4 virtual desktops and binds scroll-on-the-desktop to
# switch between them. Over VNC that is a trap: an ordinary trackpad scroll
# lands on the desktop background and the whole screen appears to be replaced
# by an empty one, which reads as "the box crashed". Nobody here wants virtual
# desktops, so reduce it to one — then the scroll bindings have nowhere to go
# and become harmless, without having to unpick openbox's mouse config.
cp /etc/xdg/openbox/rc.xml ~/.config/openbox/rc.xml
python3 - <<'PY'
import re, os
p = os.path.expanduser('~/.config/openbox/rc.xml')
s = open(p).read()
# Only the <number> INSIDE <desktops> — there are other <number> elements.
s2 = re.sub(r'(<desktops>.*?<number>)\s*\d+\s*(</number>)',
            r'\g<1>1\g<2>', s, count=1, flags=re.S)
assert s2 != s, 'desktop count not found in rc.xml — openbox config changed shape?'
open(p, 'w').write(s2)
m = re.search(r'<desktops>.*?<number>\s*(\d+)\s*</number>', s2, re.S)
print(f'    rc.xml desktops: {m.group(1)}')
PY
# rc.xml alone is NOT enough for a session that is already running. Xvfb
# outlives openbox restarts, so the root window still advertises the old count
# and openbox defers to it, logging:
#   "Openbox is configured for 1 desktop, but the current session has 4.
#    Overriding the Openbox configuration."
# wmctrl -n sets the EWMH property directly, fixing the live session. On a
# fresh boot Xvfb starts clean and rc.xml wins, so both paths reach one desktop.
DISPLAY=:99 wmctrl -n 1 2>/dev/null || true
# Anything parked on a desktop that no longer exists would be stranded, and
# would look exactly like the app having vanished.
DISPLAY=:99 wmctrl -l 2>/dev/null | awk '{print $1}' | while read -r w; do
  DISPLAY=:99 wmctrl -i -r "$w" -t 0 2>/dev/null
done
DISPLAY=:99 wmctrl -s 0 2>/dev/null || true
printf '    live desktops  :%s\n' "$(DISPLAY=:99 xprop -root _NET_NUMBER_OF_DESKTOPS 2>/dev/null | sed 's/.*=//')"

echo "--- Chrome as the default browser"
# The app hands OAuth sign-in to the SYSTEM browser via xdg-open. With no
# default registered that call fails silently and the sign-in button looks dead.
DISPLAY=:99 xdg-settings set default-web-browser google-chrome.desktop 2>/dev/null || true
printf '    default browser: %s\n' "$(DISPLAY=:99 xdg-settings get default-web-browser 2>/dev/null)"

echo "--- clear any stale Chrome profile lock"
# Chrome records "hostname-pid" in SingletonLock to spot a profile opened from
# two machines. RENAMING THE HOST invalidates it: Chrome then refuses to start,
# silently, and every xdg-open does nothing. Cost an hour to find once.
CP=~/.config/google-chrome
LOCKPID=$(readlink "$CP/SingletonLock" 2>/dev/null | sed 's/.*-//')
if [ -n "${LOCKPID:-}" ] && ! kill -0 "$LOCKPID" 2>/dev/null; then
  rm -f "$CP/SingletonLock" "$CP/SingletonCookie" "$CP/SingletonSocket"
  echo "    cleared a stale lock (pid $LOCKPID not running)"
elif [ -n "${LOCKPID:-}" ]; then
  echo "    lock held by LIVE pid $LOCKPID — left alone"
else
  echo "    no stale lock"
fi

echo "--- openbox root menu (right-click anywhere on the desktop)"
cat > ~/.config/openbox/menu.xml <<'X'
<?xml version="1.0" encoding="UTF-8"?>
<openbox_menu xmlns="http://openbox.org/3.4/menu">
<menu id="root-menu" label="Vibeconferencing">
  <item label="Terminal">
    <action name="Execute"><command>xfce4-terminal</command></action>
  </item>
  <item label="Google Chrome">
    <action name="Execute"><command>google-chrome</command></action>
  </item>
  <item label="Files">
    <action name="Execute"><command>thunar</command></action>
  </item>
  <separator />
  <item label="Restart Vibeconferencing">
    <action name="Execute">
      <command>xfce4-terminal --title="Restart Vibeconferencing" -e "/home/ubuntu/.local/bin/vibeconf-restart-app.sh"</command>
    </action>
  </item>
  <item label="App log (follow)">
    <action name="Execute">
      <command>xfce4-terminal --title="vibeconf-app log" -e "bash -c 'journalctl -u vibeconf-app -f -n 100'"</command>
    </action>
  </item>
  <separator />
  <item label="Reconfigure openbox">
    <action name="Reconfigure" />
  </item>
</menu>
</openbox_menu>
X

echo "--- tint2 panel"
# Bottom strip, always on top, with the four launchers and a taskbar so a
# minimised or buried app window can be got back.
cat > ~/.config/tint2/tint2rc <<'T'
# Vibeconferencing box panel — launchers + taskbar.
#
# Backgrounds are declared FIRST and numbered by order of appearance: the first
# block is background_id 1, the second is 2, and so on. Referencing an id before
# its block exists is how the first version of this file segfaulted tint2.
#
# There is deliberately NO clock. The clock key names differ between tint2
# versions (clock_format1 vs time1_format) and a wrong one crashed the panel
# outright — an unnecessary crash vector for something nobody needs on a box
# they connect to from a machine that already has a clock.

# 1 — the panel itself
rounded = 0
border_width = 0
background_color = #1e1e1e 100
border_color = #000000 0

# 2 — an inactive task button
rounded = 3
border_width = 0
background_color = #333333 100
border_color = #000000 0

# 3 — the focused task button
rounded = 3
border_width = 0
background_color = #4a6fa5 100
border_color = #000000 0

panel_items = LT
panel_size = 100% 44
panel_position = bottom center horizontal
panel_background_id = 1
panel_layer = top
strut_policy = follow_size
autohide = 0

taskbar_mode = single_desktop
task_text = 1
task_maximum_size = 260 34
task_background_id = 2
task_active_background_id = 3
task_font_color = #ffffff 100

launcher_padding = 6 4 6
launcher_icon_size = 32
launcher_tooltip = 1
launcher_item_app = /home/ubuntu/.local/share/applications/vibeconf-terminal.desktop
launcher_item_app = /home/ubuntu/.local/share/applications/vibeconf-chrome.desktop
launcher_item_app = /home/ubuntu/.local/share/applications/vibeconf-files.desktop
launcher_item_app = /home/ubuntu/.local/share/applications/vibeconf-restart.desktop
T

echo "--- tint2 systemd unit"
# Its own unit, NOT an openbox autostart line: openbox.service runs bare
# `openbox`, which never reads ~/.config/openbox/autostart. An autostart entry
# would look right and silently do nothing.
sudo tee /etc/systemd/system/tint2.service >/dev/null <<'U'
[Unit]
Description=tint2 panel on :99 (launchers for terminal, browser, app restart)
After=openbox.service
Requires=openbox.service

[Service]
Type=simple
User=ubuntu
Group=ubuntu
Environment=DISPLAY=:99
# Wait for the display AND the window manager; tint2 started before openbox
# comes up gets no panel geometry and sits invisible.
ExecStartPre=/bin/sh -c "until /usr/bin/xdpyinfo -display :99 >/dev/null 2>&1; do sleep 0.5; done"
ExecStart=/usr/bin/tint2
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
U

sudo systemctl daemon-reload
sudo systemctl enable tint2.service >/dev/null 2>&1
sudo systemctl restart tint2.service

echo "--- reload openbox so it picks up the new menu"
DISPLAY=:99 openbox --reconfigure 2>/dev/null || true

echo "--- verifying"
# `systemctl is-active` says "active" during Restart= backoff even when the
# process has just core-dumped, so it alone is a false green. Wait, then check
# that a process actually EXISTS and has survived a few seconds.
sleep 8
RC=0
TINT_PID=$(pgrep -x tint2 | head -1)
if [ -z "$TINT_PID" ]; then
  echo "  tint2: NOT RUNNING"
  RC=1
else
  sleep 4
  if kill -0 "$TINT_PID" 2>/dev/null; then
    echo "  tint2: running (pid $TINT_PID, survived 4s — not crash-looping)"
  else
    echo "  tint2: started then DIED — crash loop"
    RC=1
  fi
fi
NRESTARTS=$(systemctl show tint2 -p NRestarts --value 2>/dev/null)
echo "  tint2 restarts since start: ${NRESTARTS:-?}  (a climbing number means it is crashing)"
if [ "${NRESTARTS:-0}" -gt 3 ] 2>/dev/null; then
  echo "  >> crash loop; last error:"
  sudo journalctl -u tint2 -n 5 --no-pager | tail -3 | sed 's/^/     /'
  RC=1
fi

echo
echo "--- result"
printf '  tint2:        %s / %s\n' "$(systemctl is-active tint2)" "$(systemctl is-enabled tint2 2>/dev/null)"
printf '  openbox:      %s\n' "$(systemctl is-active openbox)"
printf '  vibeconf-app: %s\n' "$(systemctl is-active vibeconf-app)"
echo "  windows on :99:"
DISPLAY=:99 wmctrl -l 2>/dev/null | sed 's/^/    /' || true
[ "$RC" -eq 0 ] && echo "  OK" || echo "  FAILED — see above"
exit $RC
REMOTE_EOF

echo "box: $BOX"
VIBECONF_BOX="$BOX" bash "$HERE/vibeconf-attach.sh" --run "$REMOTE"
