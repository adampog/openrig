# OmarchyTheme-build

The team that makes Omarchy themes: palette, app colours, backgrounds and preview. It follows
[openrig-build](../openrig-build/): an orchestrator, implementation seats each fixed to one model, and an
independent QA seat. It adds an art director who owns how the themes look, bench seats that the orchestrator
starts and stops itself, and Jev routing among its own seats. Imaging is scripted 2D and 3D only, with no
image-generation models.

It works in `~/Projects/omarchy-themes` and reuses OpenRig's built-in orchestrator, implementer and QA agents
from `packages/daemon/specs/agents`. The art director is a custom agent in
[agents/art-director/](agents/art-director/), whose role guidance is delivered when the seat starts. How the team
works, including the rules for the human's live desktop and the exact bench commands, is in
[CULTURE.md](CULTURE.md).

## Seats

Always on (started by `rig up`):

| Seat | Role | Runtime and model |
| --- | --- | --- |
| `orch-lead@OmarchyTheme-build` | Orchestrator: plans, routes with Jev, manages the bench | Claude Code, Opus |
| `art-director@OmarchyTheme-build` | Owns the look; the only seat that shows the human images | Claude Code, Fable 5.1 (`claude-fable-5-1`) |
| `dev-builder@OmarchyTheme-build` | Scenes, renders, palette; Jev's default seat | Claude Code, Opus |
| `dev-sonnet@OmarchyTheme-build` | Builder | Claude Code, Sonnet |
| `dev-qa@OmarchyTheme-build` | Spec checks and visual QA | Claude Code, Sonnet |

Bench (not running after `rig up`; the orchestrator adds each from its file in [bench/](bench/)):

| Seat | Role | Runtime and model |
| --- | --- | --- |
| `dev-fable` | Hardest scenes | Claude Code, Fable 5.1 |
| `dev-codex` | Non-render work only (palette, app configs, scripts) | Codex |
| `dev-qwen` | Text-only chores; cannot look at images | pi, Qwen on the MacBook |
| `dev-extra<N>` | One more builder on a chosen model, from `bench/extra-builder.yaml` | Claude Code, any model |

QA is on Claude because Codex's sandbox could not use the GPU on 2026-10-05. At most three bench or extra seats
run at once. dev-qwen also needs its pi provider settings in
`~/.openrig/state/pi/dev-qwen@OmarchyTheme-build/agent/`, which OpenRig does not write.

## Check it

From the root of this repository:

```sh
rig spec validate rigs/OmarchyTheme-build/rig.yaml
rig spec audit rigs/OmarchyTheme-build/rig.yaml
rig spec preflight rigs/OmarchyTheme-build/rig.yaml
rig up rigs/OmarchyTheme-build/rig.yaml --plan --cwd "$(mktemp -d)"
node --import tsx rigs/OmarchyTheme-build/proof/bench-proof.mjs
```

The last command runs the rig on a private daemon with stub seats (`npm run build` first). It checks that only
the five always-on seats start, that the art director runs on the custom agent and gets its role guidance, that
each bench seat and an extra builder get the rig's culture and their role guidance when started with the commands
in CULTURE.md, and that stop, restart and removal work.

## Launch it

Launch from a folder whose branch never changes, because the bench commands read `bench/` from it for the life of
the rig. Make one once, pinned to a commit:

```sh
git worktree add --detach ~/Projects/openrig-rigs <commit-or-branch>
rig up ~/Projects/openrig-rigs/rigs/OmarchyTheme-build/rig.yaml --cwd ~/Projects/omarchy-themes
rig terminal open OmarchyTheme-build --provider herdr
```

Do not launch from a checkout where people switch branches. Then type the outcome you want into `orch-lead`, or
point it at a mission. For now missions live in `~/.openrig/workspace/missions/` as `omarchy-themes-<mission>`, not
under the `omarchy-themes` project (see "Where things live" in CULTURE.md).
