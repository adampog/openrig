#!/usr/bin/env bash
# rig-up: bring the OpenRig fleet and its herdr walls back up.
#   1. start the daemon + last-running rigs if nothing is running
#   2. restore the kernel rig from its newest snapshot if it stayed stopped
#   3. replace stale herdr workspaces (bare shells) with live ones
#   4. open a herdr window if none is attached
set -uo pipefail

KERNEL=kernel

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarn:\033[0m %s\n' "$*" >&2; }

# Prints "name status rigId" for every non-archived rig; fails if the daemon is down.
rigs() {
  rig ps --json 2>/dev/null | python3 -c '
import json, sys
for r in json.load(sys.stdin):
    if not r.get("isArchived"):
        print(r["name"], r["status"], r["rigId"])' 2>/dev/null
}

running_rigs() { rigs | awk '$2 == "running" { print $1 }'; }

# --- 1. fleet -------------------------------------------------------------
if [[ -z "$(running_rigs)" ]]; then
  say "No rigs running; starting daemon and last-running rigs"
  rig start --last || warn "rig start --last exited non-zero"
fi

# --- 2. kernel gotcha: --last can leave the kernel rig stopped ------------
read -r kstatus kid < <(rigs | awk -v k="$KERNEL" '$1 == k { print $2, $3 }')
if [[ -n "${kid:-}" && "$kstatus" != "running" ]]; then
  snap=$(rig snapshot list "$kid" 2>/dev/null | awk '$3 == "complete" { print $1; exit }')
  if [[ -n "$snap" ]]; then
    say "Kernel rig is $kstatus; restoring from snapshot $snap"
    rig restore "$snap" --rig "$kid" || warn "kernel restore exited non-zero"
  else
    warn "kernel rig is $kstatus and has no complete snapshot to restore"
  fi
fi

mapfile -t RUNNING < <(running_rigs)
if (( ${#RUNNING[@]} == 0 )); then
  warn "no rigs are running; nothing to open. Try: rig crash-cart"
  exit 1
fi

# --- 3. herdr walls -------------------------------------------------------
# Workspace ids whose label is the given rig name.
workspaces_for() {
  herdr workspace list 2>/dev/null | python3 -c '
import json, sys
for w in json.load(sys.stdin)["result"]["workspaces"]:
    if w.get("label") == sys.argv[1]:
        print(w["workspace_id"])' "$1" 2>/dev/null
}

# True when every tmux session of the rig has a client attached.
all_attached() {
  local out
  out=$(tmux list-sessions -F '#{session_name} #{session_attached}' 2>/dev/null |
    awk -v suffix="@$1" 'index($1, suffix) == length($1) - length(suffix) + 1') || return 1
  [[ -n "$out" ]] && ! awk '$2 == 0 { found = 1 } END { exit !found }' <<<"$out"
}

for r in "${RUNNING[@]}"; do
  mapfile -t ws < <(workspaces_for "$r")
  if (( ${#ws[@]} == 1 )) && all_attached "$r"; then
    say "$r: wall already live"
    continue
  fi
  for id in "${ws[@]}"; do
    say "$r: closing stale workspace $id"
    herdr workspace close "$id" >/dev/null
  done
  say "$r: opening wall"
  rig terminal open "$r" >/dev/null || warn "rig terminal open $r failed"
done

# --- 4. herdr window ------------------------------------------------------
if ! pgrep -x herdr -a | grep -qv ' server'; then
  if [[ -n "${WAYLAND_DISPLAY:-}" ]] && command -v uwsm >/dev/null; then
    say "Opening a herdr window"
    setsid uwsm app -- xdg-terminal-exec herdr >/dev/null 2>&1 &
  else
    say "No herdr window attached; run: herdr"
  fi
fi

echo
rig ps
