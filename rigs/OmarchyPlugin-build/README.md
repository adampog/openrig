# OmarchyPlugin-build

The team that builds plugins for Omarchy's shell. It follows [openrig-build](../openrig-build/): an
orchestrator, implementation seats each fixed to one model, and an independent QA seat. It adds bench
seats that the orchestrator starts and stops itself, and Jev routing among its own seats.

It works in `~/Projects/omarchy-plugins` and reuses OpenRig's built-in orchestrator, implementer, QA,
independent-reviewer and analyst agents from `packages/daemon/specs/agents`. How the team works,
including the rules for the human's live shell and the exact bench commands, is in
[CULTURE.md](CULTURE.md).

## Seats

Always on (started by `rig up`):

| Seat | Role | Runtime and model |
| --- | --- | --- |
| `orch-lead@OmarchyPlugin-build` | Orchestrator: plans, routes with Jev, manages the bench | Claude Code, Opus |
| `dev-builder@OmarchyPlugin-build` | Builder, Jev's default seat | Claude Code, Opus |
| `dev-sonnet@OmarchyPlugin-build` | Builder | Claude Code, Sonnet |
| `dev-codex@OmarchyPlugin-build` | Builder | Codex |
| `dev-qa@OmarchyPlugin-build` | Independent QA | Codex |

Bench (not running after `rig up`; the orchestrator adds each from its file in [bench/](bench/)):

| Seat | Role | Runtime and model |
| --- | --- | --- |
| `review-reviewer` | Code and safety review before a plugin is offered to the human | Claude Code, Opus |
| `research-scout` | Reads Omarchy's shell sources and upstream docs when an API is unclear or Omarchy updates | Claude Code, Sonnet |
| `dev-fable` | Hardest design and debugging | Claude Code, Fable 5.1 (`claude-fable-5-1`) |
| `dev-qwen` | Small, well-specified chores | pi, Qwen on the MacBook |
| `dev-extra<N>` | One more builder on a chosen model, from `bench/extra-builder.yaml` | Claude Code, any model |

At most three bench or extra seats run at once. dev-qwen also needs its pi provider settings in
`~/.openrig/state/pi/dev-qwen@OmarchyPlugin-build/agent/`, which OpenRig does not write.

## Check it

From the root of this repository:

```sh
rig spec validate rigs/OmarchyPlugin-build/rig.yaml
rig spec audit rigs/OmarchyPlugin-build/rig.yaml
rig spec preflight rigs/OmarchyPlugin-build/rig.yaml
rig up rigs/OmarchyPlugin-build/rig.yaml --plan --cwd "$(mktemp -d)"
node --import tsx rigs/OmarchyPlugin-build/proof/bench-proof.mjs
```

The last command runs the rig on a private daemon with stub seats (`npm run build` first). It checks
that only the five always-on seats start, that each bench seat and an extra builder get the rig's culture
and their role guidance when started with the commands in CULTURE.md, and that stop and restart work.

## Launch it

Launch from a folder whose branch never changes, because the bench commands read `bench/` from it for
the life of the rig. Make one once, pinned to a commit:

```sh
git worktree add --detach ~/Projects/openrig-rigs <commit-or-branch>
rig up ~/Projects/openrig-rigs/rigs/OmarchyPlugin-build/rig.yaml --cwd ~/Projects/omarchy-plugins
rig terminal open OmarchyPlugin-build --provider herdr
```

Do not launch from a checkout where people switch branches. Then type the outcome you want into
`orch-lead`, or point it at a mission of the `omarchy-plugins` project.
