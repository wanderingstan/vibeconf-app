#!/bin/bash
# vibeconf-attach-run-check.sh — exercise `vibeconf-attach --run` against a real box.
#
#   scripts/vibeconf-attach-run-check.sh [box-name]     # default: vibeconf-test
#
# WHY THIS IS A SCRIPT AND NOT A UNIT TEST: it needs a running EC2 box and real
# AWS credentials, so CI cannot run it. That is exactly the category of code that
# has burned this repo before — `vibeconf-attach` once shipped with every
# interactive mode broken (`exec aws_` on a shell function) because the only
# modes anyone had exercised were the ones a non-interactive harness could reach.
# So: an explicit, runnable check, rather than nothing.
#
# Costs a few cents of instance time. Run it after touching --run, and after
# touching anything in the arg parser or the progress output.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
export VIBECONF_BOX="${1:-vibeconf-test}"
A() { bash "$HERE/vibeconf-attach.sh" "$@"; }

pass=0; fail=0
ck() { # ck <label> <expected> <got>
  if [ "$2" = "$3" ]; then echo "ok    $1"; pass=$((pass+1))
  else echo "FAIL  $1"; echo "        expected: [$2]"; echo "        got:      [$3]"; fail=$((fail+1)); fi
}

echo "box: $VIBECONF_BOX"
echo
echo "--- runs as the bot's user, not root or ssm-user ---"
# send-command runs as ROOT and start-session as ssm-user; neither owns the app.
# Getting this wrong is silent and nasty: it authenticates the wrong account.
O=$(A --run 'whoami' 2>/dev/null);          ck "whoami is ubuntu" 'ubuntu' "$O"
O=$(A --run 'echo $HOME' 2>/dev/null);      ck "HOME is the bot's" '/home/ubuntu' "$O"

echo
echo "--- exit codes (agents branch on these) ---"
A --run 'exit 0' >/dev/null 2>&1;                ck "exit 0 propagates" 0 $?
A --run 'exit 42' >/dev/null 2>&1;               ck "exit 42 propagates" 42 $?
A --run 'ls /definitely-not-here' >/dev/null 2>&1; ck "real failure is non-zero" 2 $?

echo
echo "--- stream separation (progress must not pollute captured output) ---"
O=$(A --run 'echo OUT; echo ERR >&2' 2>/dev/null);              ck "stdout has only stdout" 'OUT' "$O"
E=$(A --run 'echo OUT; echo ERR >&2' 2>&1 >/dev/null | grep ERR); ck "stderr carries stderr" 'ERR' "$E"

echo
echo "--- quoting: what breaks naive implementations ---"
O=$(A --run 'echo "double quotes"' 2>/dev/null);        ck "double quotes" 'double quotes' "$O"
O=$(A --run "echo 'single quotes'" 2>/dev/null);        ck "single quotes" 'single quotes' "$O"
O=$(A --run 'echo $((6*7))' 2>/dev/null);               ck "shell expansion" '42' "$O"
O=$(A --run 'printf "a\nb\n"' 2>/dev/null);             ck "embedded newline" 'a
b' "$O"
O=$(A --run 'echo "it'"'"'s got a quote"' 2>/dev/null); ck "apostrophe" "it's got a quote" "$O"
O=$(A --run 'echo "$USER at $(hostname -s)"' 2>/dev/null | cut -d' ' -f1); ck "command substitution" 'ubuntu' "$O"
O=$(A --run 'echo "back\\slash"' 2>/dev/null);          ck "backslash" 'back\slash' "$O"
O=$(A --run 'echo {a,b}; echo "100%"; echo "a|b"' 2>/dev/null | tr '\n' ' '); ck "braces, percent, pipe" 'a b 100% a|b ' "$O"

echo
echo "--- multi-line scripts (agents send these) ---"
O=$(A --run '
for i in 1 2 3; do
  echo "line $i"
done' 2>/dev/null | tr '\n' ',')
ck "multi-line loop" 'line 1,line 2,line 3,' "$O"

echo
echo "--- misuse ---"
A --run 2>/dev/null; ck "empty --run refuses" 1 $?

echo
echo "--- truncation is announced, not silent ---"
# SSM caps captured output at ~24KB and truncates without saying so, which reads
# exactly like a complete result. Worse than an error.
W=$(A --run 'seq 1 20000' 2>&1 >/dev/null | grep -c TRUNCATED)
ck "warns when truncated" 1 "$W"

echo
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ] || exit 1
