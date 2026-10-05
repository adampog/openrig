---
intent: A small, dependable habit tracker that a person can use every day from the terminal.
---

# Project: rig-sandbox

A tiny habit tracker CLI. It is deliberately small so an OpenRig team can practice
the full spec → build → test loop on real, low-stakes work.

## Where things are

- Code: `~/Projects/rig-sandbox` (git, branch `main`, no remote). `npm test` runs the suite.
- Work tree: this folder. Missions and slices live under `missions/`.
- The user is one person at a terminal. Data lives in `habits.json`, or wherever `HABIT_FILE` points.

## What good looks like

- Every command works through the public CLI (`node bin/habit.js …`). Bad input fails with a clear message and exit code 1, and leaves the data unchanged.
- Node's standard library only, with no dependencies.
- Each change is small and readable, and tests cover every user-visible behavior.

## Out of scope

- Publishing to npm, pushing to any remote, or adding a server, UI or sync.
