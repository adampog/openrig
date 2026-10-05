#!/usr/bin/env bash
# Recreate the OpenRig workshop setup on an Omarchy machine:
#   herdr (pacman) + Node 24 (mise) + OpenRig CLI built from the adampog/openrig fork
#   + the herdr config + kernel rig + the workshop rig working ~/Projects/rig-sandbox.
#
# Run it from any Omarchy machine:
#   curl -fsSL https://raw.githubusercontent.com/adampog/openrig/main/rigs/workshop/omarchy/setup.sh | bash
# or from a checkout:
#   bash rigs/workshop/omarchy/setup.sh [options]
#
# Safe to re-run: every step checks before it changes anything, and files it
# replaces are backed up next to themselves with a .bak-<timestamp> suffix.
set -euo pipefail

REPO_URL="https://github.com/adampog/openrig.git"
REPO_REF="main"
REPO_DIR="$HOME/Projects/openrig"
PROJECT_DIR="$HOME/Projects/rig-sandbox"
PROJECT_FROM=""
CLI_PREFIX="$HOME/.local/share/openrig-cli"
LAUNCH_RIG=1
OPEN_TERMINALS=1

usage() {
  cat <<EOF
Usage: setup.sh [options]

  --project DIR          Repository the workshop works on (default: $PROJECT_DIR)
  --project-from SOURCE  Clone the project from SOURCE if DIR doesn't exist, e.g.
                         desktop:Projects/rig-sandbox (ssh) or a git URL.
                         Without it, a missing project starts as an empty git repo.
  --repo-dir DIR         Where to keep the OpenRig checkout (default: $REPO_DIR)
  --ref REF              Branch or tag of $REPO_URL to build (default: $REPO_REF)
  --no-up                Install everything but don't launch the workshop rig
  --no-terminals         Don't open the workshop seats as herdr tiles
  -h, --help             Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT_DIR="$2"; shift 2 ;;
    --project-from) PROJECT_FROM="$2"; shift 2 ;;
    --repo-dir) REPO_DIR="$2"; shift 2 ;;
    --ref) REPO_REF="$2"; shift 2 ;;
    --no-up) LAUNCH_RIG=0; shift ;;
    --no-terminals) OPEN_TERMINALS=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

STAMP="$(date +%Y%m%d-%H%M%S)"
step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# Copy SRC over DEST, backing DEST up first if it exists and differs.
install_file() {
  local src="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  if [ -f "$dest" ] && cmp -s "$src" "$dest"; then
    note "$dest is already up to date"
    return
  fi
  if [ -f "$dest" ]; then
    cp "$dest" "$dest.bak-$STAMP"
    note "backed up $dest -> $dest.bak-$STAMP"
  fi
  cp "$src" "$dest"
  note "installed $dest"
}

# ---------------------------------------------------------------------------
step "Checking this is an Omarchy machine"
[ -d /usr/share/omarchy ] || [ -n "${OMARCHY_PATH:-}" ] || die "Omarchy not found (no /usr/share/omarchy). This script targets Omarchy."
command -v pacman >/dev/null || die "pacman not found."
command -v mise >/dev/null || die "mise not found. Omarchy normally ships it; install it and re-run."
note "ok"

# ---------------------------------------------------------------------------
step "Installing system packages (herdr, tmux, git, build tools)"
missing=()
for pkg in herdr tmux git base-devel python; do
  pacman -Qi "$pkg" >/dev/null 2>&1 || pacman -Qg "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
done
if [ ${#missing[@]} -gt 0 ]; then
  note "installing: ${missing[*]}"
  sudo pacman -S --needed --noconfirm "${missing[@]}"
else
  note "all present"
fi

# ---------------------------------------------------------------------------
step "Installing Node 24, Claude Code and Codex through mise"
# OpenRig supports Node 22/24 only. Node 24 is installed alongside whatever
# Node is the mise default; only the rig shim uses it.
mise install node@24
NODE24_BIN="$HOME/.local/share/mise/installs/node/24/bin"
[ -x "$NODE24_BIN/node" ] || NODE24_BIN="$(mise where node@24)/bin"
[ -x "$NODE24_BIN/node" ] || die "Node 24 did not install under mise."
note "node $("$NODE24_BIN/node" --version) at $NODE24_BIN"
for tool in claude codex; do
  if ! command -v "$tool" >/dev/null && ! mise which "$tool" >/dev/null 2>&1; then
    note "installing $tool"
    mise use -g "$tool@latest"
  fi
done
eval "$(mise env -s bash)"

# ---------------------------------------------------------------------------
step "Fetching OpenRig ($REPO_URL @ $REPO_REF) into $REPO_DIR"
if [ -d "$REPO_DIR/.git" ]; then
  git -C "$REPO_DIR" fetch origin
  if [ -n "$(git -C "$REPO_DIR" status --porcelain --untracked-files=no)" ]; then
    note "local changes in $REPO_DIR; building it as it is, without pulling"
  else
    git -C "$REPO_DIR" checkout "$REPO_REF"
    git -C "$REPO_DIR" merge --ff-only "origin/$REPO_REF" || note "could not fast-forward; building the current checkout"
  fi
else
  mkdir -p "$(dirname "$REPO_DIR")"
  git clone --branch "$REPO_REF" "$REPO_URL" "$REPO_DIR"
  git -C "$REPO_DIR" remote add upstream https://github.com/mvschwarz/openrig.git 2>/dev/null || true
fi
HEAD_SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"

# ---------------------------------------------------------------------------
step "Building and installing the OpenRig CLI"
# The rig shim pins Node 24 for every rig call, whatever the default Node is.
mkdir -p "$HOME/.local/bin"
SHIM="$(mktemp)"
cat > "$SHIM" <<'EOF'
#!/bin/sh
# OpenRig CLI, built from ~/Projects/openrig and installed under ~/.local/share/openrig-cli.
# Pinned to Node 24: OpenRig supports Node 22/24 only, and mise's default node may be newer.
NODE24_BIN="$HOME/.local/share/mise/installs/node/24/bin"
PATH="$NODE24_BIN:$PATH" exec "$HOME/.local/share/openrig-cli/bin/rig" "$@"
EOF
install_file "$SHIM" "$HOME/.local/bin/rig"
chmod +x "$HOME/.local/bin/rig"
rm -f "$SHIM"
RIG="$HOME/.local/bin/rig"

INSTALLED_SHA=""
if [ -x "$CLI_PREFIX/bin/rig" ]; then
  INSTALLED_SHA="$("$RIG" --version 2>/dev/null | sed -n 's/.*(\([0-9a-f]*\)).*/\1/p')"
fi
UPGRADED=0
if [ -n "$INSTALLED_SHA" ] && [[ "$HEAD_SHA" == "$INSTALLED_SHA"* ]]; then
  note "rig $("$RIG" --version) already matches $REPO_REF; skipping build"
else
  (
    cd "$REPO_DIR"
    export PATH="$NODE24_BIN:$PATH"
    npm ci
    npm run build:package
    PACK_DIR="$(mktemp -d)"
    (cd packages/cli && npm pack --pack-destination "$PACK_DIR")
    npm install -g --prefix "$CLI_PREFIX" --allow-scripts=@openrig/cli "$PACK_DIR"/openrig-cli-*.tgz
    rm -rf "$PACK_DIR"
  )
  [ -n "$INSTALLED_SHA" ] && UPGRADED=1
  note "installed rig $("$RIG" --version)"
fi
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH"; note "add ~/.local/bin to your PATH (Omarchy normally does)" ;;
esac

# ---------------------------------------------------------------------------
step "Installing the herdr config"
install_file "$REPO_DIR/rigs/workshop/omarchy/herdr-config.toml" "$HOME/.config/herdr/config.toml"
herdr server reload-config >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
step "Checking Claude Code and Codex sign-in"
claude_ok=0; codex_ok=0
claude auth status >/dev/null 2>&1 && claude_ok=1
codex login status >/dev/null 2>&1 && codex_ok=1
if [ -t 0 ] || [ -e /dev/tty ]; then
  if [ $claude_ok = 0 ]; then note "Claude Code is not signed in; starting its login"; claude auth login </dev/tty && claude_ok=1 || true; fi
  if [ $codex_ok = 0 ];  then note "Codex is not signed in; starting its login";       codex login </dev/tty && codex_ok=1 || true; fi
fi
note "Claude Code: $([ $claude_ok = 1 ] && echo signed in || echo NOT signed in)"
note "Codex:       $([ $codex_ok = 1 ] && echo signed in || echo NOT signed in)"
[ $claude_ok = 1 ] || [ $codex_ok = 1 ] || die "Neither Claude Code nor Codex is signed in. Run 'claude auth login' and 'codex login', then re-run this script."
if [ $claude_ok = 0 ] || [ $codex_ok = 0 ]; then
  note "The workshop needs both (orch-lead and dev-builder run Claude Code; dev-qa runs Codex)."
  LAUNCH_RIG=0
fi

# ---------------------------------------------------------------------------
step "Starting the OpenRig daemon (boots the kernel rig on first start)"
if [ $UPGRADED = 1 ] && "$RIG" daemon status >/dev/null 2>&1; then
  note "The CLI was upgraded while the daemon is running. Restarting it is an upgrade step:"
  note "ask operator.agent in the kernel to run the openrig-upgrade procedure, or see"
  note "$REPO_DIR/skills/_canonical/core/openrig-upgrade/SKILL.md"
fi
"$RIG" daemon start || "$RIG" daemon status
WORKSPACE="$("$RIG" config get workspace.root 2>/dev/null || echo "$HOME/.openrig/workspace")"

# ---------------------------------------------------------------------------
step "Setting up the work tree at $WORKSPACE"
# The workshop's project profile: every mission is planned and released by orch-lead.
if [ -f "$WORKSPACE/project.yaml" ] && grep -q '^lifecycle:' "$WORKSPACE/project.yaml"; then
  note "project.yaml already has a mission lifecycle; leaving it alone"
else
  install_file "$REPO_DIR/rigs/workshop/omarchy/project.yaml" "$WORKSPACE/project.yaml"
  install_file "$REPO_DIR/rigs/workshop/omarchy/SPEC.md" "$WORKSPACE/SPEC.md"
fi
mkdir -p "$WORKSPACE/missions"

# ---------------------------------------------------------------------------
step "Preparing the project repository at $PROJECT_DIR"
if [ -d "$PROJECT_DIR/.git" ]; then
  note "already exists"
elif [ -n "$PROJECT_FROM" ]; then
  git clone "$PROJECT_FROM" "$PROJECT_DIR"
else
  mkdir -p "$PROJECT_DIR"
  git -C "$PROJECT_DIR" init -b main
  note "created an empty repository; pass --project-from to copy an existing one instead"
fi

# ---------------------------------------------------------------------------
if [ $LAUNCH_RIG = 1 ]; then
  step "Launching the workshop rig"
  if "$RIG" ps --json 2>/dev/null | grep -q '"name":"workshop"'; then
    note "a workshop rig already exists; check it with: rig ps --nodes --rig workshop"
  else
    "$RIG" spec validate "$REPO_DIR/rigs/workshop/rig.yaml"
    "$RIG" up "$REPO_DIR/rigs/workshop/rig.yaml" --cwd "$PROJECT_DIR" --yes
  fi
  if [ $OPEN_TERMINALS = 1 ]; then
    "$RIG" terminal open workshop --provider herdr \
      || note "herdr isn't running yet. Start 'herdr', then run: rig terminal open workshop --provider herdr"
  fi
else
  step "Skipping the workshop launch"
  note "When ready: rig up $REPO_DIR/rigs/workshop/rig.yaml --cwd $PROJECT_DIR"
fi

step "Done"
note "Kernel:   rig ps --nodes --rig kernel   (mission control: rig tui)"
note "Workshop: rig ps --nodes --rig workshop"
note "Give it work: rig send orch-lead@workshop 'Work mission <name>, one slice at a time.'"
