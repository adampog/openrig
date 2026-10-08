#!/usr/bin/env bash
# rig-up: bring the OpenRig fleet and its herdr walls back up.
#   1. start the daemon + last-running rigs if nothing is running
#   2. restore the kernel rig from its newest snapshot if it stayed stopped
#   3. replace stale herdr workspaces (bare shells) with live ones, kernel on top
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

# Rigs that get a wall: running, or partial (some seats up, e.g. one slow to start).
wall_rigs() { rigs | awk '$2 == "running" || $2 == "partial" { print $1 }'; }

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
    # `rig restore` returns as soon as the daemon accepts it and restores the seats in the
    # background. Wait for them, or step 3 runs before the kernel is up and opens no wall for it.
    say "Waiting for the kernel's seats to come up"
    for _ in $(seq 60); do
      down=$(rig ps --nodes --rig "$KERNEL" --json 2>/dev/null | python3 -c '
import json, sys
print(sum(1 for n in json.load(sys.stdin) if n.get("sessionStatus") != "running"))' 2>/dev/null)
      [[ "$down" == 0 ]] && break
      sleep 2
    done
    [[ "${down:-1}" == 0 ]] || warn "kernel seats still coming up after 120s; opening its wall anyway"
  else
    warn "kernel rig is $kstatus and has no complete snapshot to restore"
  fi
fi

mapfile -t RUNNING < <(wall_rigs)
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
  # --provider herdr: without it the daemon guesses the hosting terminal from the caller's
  # environment and refuses ("unknown") when rig-up runs from a plain shell or an agent.
  rig terminal open "$r" --provider herdr >/dev/null || warn "rig terminal open $r failed"
done

# --- 3b. wall order: kernel first, then the other rigs ---------------------
# herdr appends a new workspace at the end and has no CLI verb to reorder, so ask its
# socket API (workspace.move) to put the rig walls in order at the top of the list.
order_walls() {
  python3 - "$KERNEL" "$@" <<'PYEOF' 2>/dev/null
import json, os, socket, sys
kernel, rigs = sys.argv[1], sys.argv[2:]
want = [kernel] + [r for r in rigs if r != kernel]
path = os.path.expanduser("~/.config/herdr/herdr.sock")
def call(method, params):
    s = socket.socket(socket.AF_UNIX); s.settimeout(5); s.connect(path)
    s.sendall((json.dumps({"id": "rig-up", "method": method, "params": params}) + "\n").encode())
    buf = b""
    while not buf.endswith(b"\n"):
        chunk = s.recv(65536)
        if not chunk: break
        buf += chunk
    s.close()
    return json.loads(buf)
spaces = call("workspace.list", {})["result"]["workspaces"]
index = 0
for label in want:
    ids = [w["workspace_id"] for w in spaces if w.get("label") == label]
    if ids:
        call("workspace.move", {"workspace_id": ids[0], "insert_index": index})
        index += 1
PYEOF
}
order_walls "${RUNNING[@]}" || warn "could not order the herdr walls (kernel first)"

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
