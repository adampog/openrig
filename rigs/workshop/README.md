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

## Set it up on another Omarchy machine

`omarchy/setup.sh` installs herdr, Node 24, Claude Code, Codex and this OpenRig
fork, applies the herdr config, installs `jev` (Jev picks the model for each task),
starts the kernel, and launches the workshop on `~/Projects/rig-sandbox`. It is safe
to re-run.

```sh
curl -fsSL https://raw.githubusercontent.com/adampog/openrig/main/rigs/workshop/omarchy/setup.sh \
  | bash -s -- --project-from desktop:Projects/rig-sandbox
```

`--project-from` copies the sandbox project from another machine over ssh; leave
it out to start with an empty repository. The Jev API key never goes in the repo:
`--jev-key-from desktop:.openrig/secrets/jev.env` copies it over ssh, and without
it the script asks for the key (input hidden) or lets you skip it. `--help` lists the other options.

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
