---
intent: OpenRig runs smoothly on this Linux (Omarchy) machine with Herdr, Claude Code and Codex, and the fork collects small, well-tested fixes that could be offered upstream.
---

# Project: OpenRig (fork)

This project is OpenRig itself: the user's fork, github.com/adampog/openrig, checked out at
`~/Projects/openrig`. Upstream is github.com/mvschwarz/openrig. The team improves OpenRig
from the friction that using it on this machine reveals.

## Where things are

- Code: `~/Projects/openrig`. Branch `main` tracks the fork's `origin/main`.
- Contributor maps: the repo's own `developing-openrig` skill (in `.claude/skills/` and
  `.agents/skills/`), `ARCHITECTURE.md`, `docs/as-built/arteries.md` (high-risk areas),
  `docs/as-built/test-layers.md` and `CONTRIBUTING.md`.
- Work tree: this folder. Missions and slices live under `missions/`. Finished work from the
  earlier practice project is archived under `archive/rig-sandbox/`.

## How changes are made

- One concern per branch. Each slice gets its own local branch from `main`, named
  `fix/<slice-slug>`, with focused commits.
- Run the repo's gates with Node 24, which the checkout's dependencies are built for:
  - `mise exec node@24 -- npm run build`
  - `mise exec node@24 -- npm run lint`
  - `mise exec node@24 -- npm test`
  - Also `mise exec node@24 -- npm run test:ui` when the UI package changes.
- Prove behavior with the repo's own tests and stub-agent scenarios, which run a private daemon
  and tmux server. A change to an artery in `docs/as-built/arteries.md` follows that file's
  rules.
- The mission's `NOTES.md` records a baseline run of the gates on `main`. Compare against it
  before blaming a slice for a failure.

## Hard boundaries

- Never stop, restart, reinstall or rebuild the installed OpenRig (`~/.local/share/openrig-cli`),
  and never start a daemon or launch seats from the checkout against `~/.openrig`. The team runs
  on the installed copy.
- Commit locally only. No pushes, no pull requests, and nothing sent upstream without the human's
  explicit go-ahead.
- Update a document's `last-verified-against-source` marker only after actually checking it
  against that commit.

## Out of scope

- Releases, npm publishing and changes to upstream's CI.
