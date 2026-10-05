# workshop

A three-seat rig modeled on the small team in the OpenRig video "I Run an AI
Civilization in Herdr": an orchestrator in one pod, and a builder and QA agent
working together in another.

| Seat | Role | Runtime |
| --- | --- | --- |
| `orch-lead@workshop` | Orchestrator: plans, dispatches slices, talks to the human | Claude Code (auto mode) |
| `dev-builder@workshop` | Implementer: builds each slice and commits a candidate | Claude Code (auto mode) |
| `dev-qa@workshop` | QA: independently checks each candidate and records proof | Codex |

The team reuses OpenRig's built-in orchestrator, implementer and QA agents from
`packages/daemon/specs/agents`. How they work together is in [CULTURE.md](CULTURE.md).

## Run it

From the root of this repository:

```sh
rig spec validate rigs/workshop/rig.yaml
rig up rigs/workshop/rig.yaml --cwd ~/Projects/rig-sandbox --plan
rig up rigs/workshop/rig.yaml --cwd ~/Projects/rig-sandbox
rig terminal open workshop --provider herdr
```

The team takes its work from the missions and slices in the OpenRig work tree
(`rig config get workspace.root`). Give the orchestrator an outcome, or point it at
a mission:

```sh
rig send orch-lead@workshop 'Work mission release-0.2.0, one slice at a time.'
```
