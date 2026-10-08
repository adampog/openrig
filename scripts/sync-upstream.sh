#!/usr/bin/env bash
# Fork habit: keep adampog/openrig current with mvschwarz/openrig without losing fork work.
#
#   scripts/sync-upstream.sh            # fetch upstream, branch upgrade-YYYYMMDD off main, merge
#   scripts/sync-upstream.sh --status   # only report how far main and upstream/main have drifted
#
# The habits this script encodes:
#   1. Merge, never rebase. main is published and worktrees/branches hang off it.
#   2. Merge weekly. Upstream moved ~200 commits in four days in October 2026;
#      small merges have small conflicts. Run --status whenever in doubt.
#   3. rerere is on (set below if missing), so a conflict resolved once in an
#      upgrade branch is replayed automatically the next time the same hunk appears.
#   4. Keep fork-only work in fork-only files (rigs/, scripts/jev*, scripts/rig-up.sh,
#      this file). Those never conflict.
#   5. Upstream generic fixes as PRs. Once accepted, prefer upstream's version of that
#      hunk on the next merge (`git cherry upstream/main main` shows which fork commits
#      upstream already has, marked with "-").
#
# After the merge: resolve conflicts, `npm ci && npm run lint && npm test`, push the
# branch, open a PR into main, merge it, then merge main into each live worktree.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
git config --get remote.upstream.url >/dev/null || git remote add upstream https://github.com/mvschwarz/openrig.git
[ "$(git config --get rerere.enabled || true)" = true ] || { git config rerere.enabled true; git config rerere.autoupdate true; echo "enabled rerere"; }

git fetch upstream --prune --tags --quiet
read -r behind ahead < <(git rev-list --left-right --count upstream/main...main)
echo "main is $ahead ahead of upstream/main and $behind behind (upstream at $(git describe --tags --always upstream/main))"
echo "fork commits upstream already has: $(git cherry upstream/main main | grep -c '^-' || true)"

if [ "${1:-}" = "--status" ]; then
  # merge-tree exits 1 on conflicts; capture its listing without tripping errexit/pipefail.
  conflicts=$(git merge-tree --write-tree --name-only upstream/main main 2>/dev/null | sed -n '2,$p' | sed '/^$/,$d' || true)
  if [ -z "$conflicts" ]; then echo "a merge would be conflict-free"
  else echo "a merge would conflict in:"; printf '  %s\n' $conflicts; fi
  exit 0
fi

[ "$behind" -gt 0 ] || { echo "nothing to merge"; exit 0; }
[ -z "$(git status --porcelain)" ] || { echo "working tree is not clean; commit or stash first" >&2; exit 1; }
[ "$(git branch --show-current)" = main ] || { echo "run from main" >&2; exit 1; }

branch="upgrade-$(date +%Y%m%d)"
git checkout -b "$branch"
if git merge --no-edit upstream/main; then
  echo "merged cleanly on $branch; now: npm ci && npm run lint && npm test, then push and open a PR into main"
else
  echo
  echo "conflicts on $branch (rerere may have resolved some already; check with: git status --short | grep ^UU)"
  echo "when resolved: git add -A && git commit, then npm ci && npm run lint && npm test, then push and open a PR into main"
fi
