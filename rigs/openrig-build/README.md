# openrig-build

The team that works on OpenRig itself, modeled on the "openrig-build" rig in the
OpenRig video "I Run an AI Civilization in Herdr".

| Seat | Role | Runtime |
| --- | --- | --- |
| `orch-lead@openrig-build` | Orchestrator: plans, dispatches slices, talks to the human | Claude Code (auto mode) |
| `dev-builder@openrig-build` | Implementer: builds each slice on its own branch | Claude Code (auto mode) |
| `dev-qa@openrig-build` | QA: independently checks each candidate and records proof | Codex |

It reuses OpenRig's built-in orchestrator, implementer and QA agents from
`packages/daemon/specs/agents`. How the team works, including the rules for changing
the OpenRig it runs on, is in [CULTURE.md](CULTURE.md).

## Run it

From the root of this repository:

```sh
rig spec validate rigs/openrig-build/rig.yaml
rig up rigs/openrig-build/rig.yaml --cwd "$PWD" --plan
rig up rigs/openrig-build/rig.yaml --cwd "$PWD"
rig terminal open openrig-build --provider herdr
```

The team takes its work from the missions in the OpenRig work tree
(`rig config get workspace.root`). Type the outcome you want into `orch-lead`, or point
it at a mission:

```sh
rig send orch-lead@openrig-build 'Run mission linux-first-run as a workflow.'
```
