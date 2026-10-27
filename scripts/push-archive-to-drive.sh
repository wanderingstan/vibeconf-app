#!/bin/zsh
# push-archive-to-drive.sh — upload the Mac mini's on-disk call archive to the
# team's shared Drive folder. Runs on the mini, on a timer
# (scripts/com.vibeconf.push-archive.plist).
#
# WHY: laptops send finished calls here over ssh (sync-calls-to-drive.mjs with
# VIBECONF_SYNC_SSH_DEST) and delete their local recordings once the copy here
# verifies. Uploading from the laptop through the Drive desktop app kept a
# local copy of every multi-GB video and stalled the app's other syncing; the
# mini is always on, has the disk, and already has the rclone remote.
#
# `rclone copy`, never `sync`: nothing on Drive is ever deleted, and
# --ignore-existing leaves files that are already there (the bot's own
# after-call upload) untouched. rclone checks each upload's MD5 against
# Drive's. The archive on this disk is kept: it is the backup.
#
# Settings (environment, or ~/.config/vibeconf/push-archive.env as KEY=VALUE):
#   VIBECONF_ARCHIVE_DIR             default /Volumes/Stan-Exos14-Archive/VibeArchive/vibeconf-call-archives-drive
#   VIBECONF_RCLONE_REMOTE           default "Vibeconf Shared Files"
#   VIBECONF_RCLONE_ROOT_FOLDER_ID   default 1G2Xgeo0ds0xb4ZWPxPa84YSycOUoKbHs (the archive folder)
# Extra arguments go to rclone (e.g. --dry-run, -v).
set -euo pipefail

CONF="$HOME/.config/vibeconf/push-archive.env"
[[ -f "$CONF" ]] && { set -a; source "$CONF"; set +a; }
ARCHIVE="${VIBECONF_ARCHIVE_DIR:-/Volumes/Stan-Exos14-Archive/VibeArchive/vibeconf-call-archives-drive}"
REMOTE="${VIBECONF_RCLONE_REMOTE:-Vibeconf Shared Files}"
ROOT_ID="${VIBECONF_RCLONE_ROOT_FOLDER_ID:-1G2Xgeo0ds0xb4ZWPxPa84YSycOUoKbHs}"
stamp() { date '+%Y-%m-%d %H:%M:%S'; }

# An unmounted external disk leaves an empty mount point behind; copying
# "nothing" would succeed and hide the problem.
if [[ ! -d "$ARCHIVE" ]]; then
  echo "[$(stamp)] archive dir missing (disk not mounted?): $ARCHIVE" >&2
  exit 2
fi

# One run at a time: a large upload can outlast the 30-minute interval.
# The lock holds the owner's pid, so one left by a killed run is taken over
# rather than blocking every run after it.
LOCK="${TMPDIR:-/tmp}/vibeconf-push-archive.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if kill -0 "$(cat "$LOCK/pid" 2>/dev/null)" 2>/dev/null; then
    echo "[$(stamp)] previous run still going (pid $(cat "$LOCK/pid")); skipping"
    exit 0
  fi
  echo "[$(stamp)] taking over a stale lock"
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

echo "[$(stamp)] $ARCHIVE → $REMOTE: (root $ROOT_ID)"
rclone copy --ignore-existing --drive-root-folder-id "$ROOT_ID" \
  --exclude .DS_Store --exclude .drive-sync.json \
  --transfers 2 --stats-one-line --stats 5m -v "$@" \
  "$ARCHIVE" "$REMOTE:"
echo "[$(stamp)] done"
