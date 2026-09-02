#!/bin/bash
# vibeconf-box-agent-perms.sh — stop an unattended agent hanging on a permission
# prompt.
#
#   scripts/vibeconf-box-agent-perms.sh cloud-ta
#
# THE PROBLEM: there is no human at a cloud box. When Claude Code asks for a
# permission, nothing answers, and the agent stops — mid-call, silently. From
# the room it looks like the bot is ignoring everyone.
#
# THE FIX: permission mode `dontAsk`, which never prompts and instead DENIES
# anything not pre-approved. The agent carries on and can say what it could not
# do, which is recoverable; a hang is not.
#
# WHY NOT bypassPermissions, WHICH WE WERE ALREADY USING: it does not close the
# hole. Per the permissions docs, a claude.ai connector tool that an
# organization has set to `ask` "prompts on every call, even in `auto` and
# `bypassPermissions` modes. In `dontAsk` mode, which never prompts, Claude Code
# denies the call instead." Our bots' allow lists are full of exactly those
# tools (mcp__claude_ai_Gmail__*, Google_Drive, Google_Calendar), so bypass left
# them able to hang.
#
# WHY BOTH LAYERS: on 2026-09-01 the TA box had the Default profile on
# bypassPermissions while devsrc and nightly-linux had NO mode at all and fell
# through to the interactive default. Project settings override user settings,
# so setting only the user level would have left Default prompting. This writes
# the user level (covers any profile without its own file) AND every profile
# that has one.
#
# THE ALLOW LIST MATTERS: dontAsk denies whatever is not listed, so an empty
# allow list swaps "hangs forever" for "can do nothing" — which in a live call
# reads worse, because the bot looks present but inert. A baseline is added and
# any existing rules are preserved.
#
# See wanderingstan/vibeconf-app#634 for making this a first-class app setting
# instead of hand-applied file state.
#
# Idempotent: safe to re-run.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BOX="${1:-${VIBECONF_BOX:-vibeconf-cloud-ta}}"
case "$BOX" in vibeconf-*) ;; *) BOX="vibeconf-$BOX" ;; esac

read -r -d '' REMOTE <<'REMOTE_EOF'
set -u
echo "--- claude build supports dontAsk?"
if claude --help 2>/dev/null | grep -q 'dontAsk'; then
  echo "    yes ($(claude --version 2>/dev/null))"
else
  echo "    NO — this build has no dontAsk mode; not changing anything"
  exit 1
fi

echo "--- applying"
python3 - <<'PY'
import json, os, shutil, datetime

STAMP = datetime.datetime.now().strftime('%Y%m%dT%H%M%SZ')

# What a bot legitimately needs. Without this, dontAsk denies everything and the
# bot is unblocked but useless.
BASELINE = [
    "mcp__vibeconferencing__*",
    "Read", "Write", "Edit", "Glob", "Grep",
    "Bash",
]

def load(p):
    try:
        with open(p) as f: return json.load(f)
    except FileNotFoundError:
        return {}
    except Exception as e:
        print(f"    !! {p} unreadable ({e}) — skipped"); return None

def save(p, d):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    if os.path.exists(p):
        shutil.copy2(p, f"{p}.bak-dontask-{STAMP}")
    with open(p, 'w') as f:
        json.dump(d, f, indent=2); f.write("\n")

def apply(p, label):
    d = load(p)
    if d is None: return
    perms = d.setdefault('permissions', {})
    before = perms.get('defaultMode')
    perms['defaultMode'] = 'dontAsk'
    allow = perms.setdefault('allow', [])
    added = [r for r in BASELINE if r not in allow]
    allow.extend(added)
    save(p, d)
    print(f"    {label}: {before!r} -> 'dontAsk', allow={len(allow)} (+{len(added)})")

apply(os.path.expanduser('~/.claude/settings.json'), 'user level')

base = os.path.expanduser('~/.config/Vibeconferencing/profiles')
if os.path.isdir(base):
    for prof in sorted(os.listdir(base)):
        for name in ('settings.json', 'settings.local.json'):
            p = os.path.join(base, prof, 'agent', '.claude', name)
            if os.path.exists(p):
                apply(p, f'{prof}/{name}')
PY

echo "--- verify"
python3 - <<'PY'
import json, os
bad = 0
def show(p, label):
    global bad
    try:
        d = json.load(open(p)); perm = d.get('permissions') or {}
        mode = perm.get('defaultMode')
        n = len(perm.get('allow') or [])
        flag = '' if mode == 'dontAsk' else '   <-- NOT dontAsk'
        if mode != 'dontAsk': bad += 1
        print(f"    {label:44} defaultMode={mode!r} allow={n}{flag}")
    except Exception as e:
        print(f"    {label:44} {e}"); bad += 1

show(os.path.expanduser('~/.claude/settings.json'), 'user ~/.claude/settings.json')
base = os.path.expanduser('~/.config/Vibeconferencing/profiles')
if os.path.isdir(base):
    for prof in sorted(os.listdir(base)):
        for name in ('settings.json', 'settings.local.json'):
            p = os.path.join(base, prof, 'agent', '.claude', name)
            if os.path.exists(p): show(p, f'{prof}/{name}')
raise SystemExit(1 if bad else 0)
PY
REMOTE_EOF

echo "box: $BOX"
VIBECONF_BOX="$BOX" bash "$HERE/vibeconf-attach.sh" --run "$REMOTE"
