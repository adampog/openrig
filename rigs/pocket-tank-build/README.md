# pocket-tank-build

The team that builds and tests [pocket-tank](https://github.com/adampog/pocket-tank), the human's on-device LLM
fish tank: the PC simulator, the ESP32-S3 firmware in QEMU, and the model pipeline. It follows
[OmarchyPlugin-build](../OmarchyPlugin-build/): an orchestrator, implementation seats each fixed to one model, an
independent QA seat, bench seats that the orchestrator starts and stops itself, and Jev routing among its own seats.
Everything is proven in software. Flashing a real board, or opening a serial port to one, is the human's alone.

It works in `~/Projects/pocket-tank` (the human's repo) and reuses OpenRig's built-in orchestrator, implementer and
QA agents from `packages/daemon/specs/agents`. How the team works, including the hardware boundary, the three build
systems, graphify navigation and the exact bench commands, is in [CULTURE.md](CULTURE.md).

## Seats

Always on (started by `rig up`):

| Seat | Role | Runtime and model |
| --- | --- | --- |
| `orch-lead@pocket-tank-build` | Orchestrator: plans, routes with Jev, manages the bench | Claude Code, Opus |
| `dev-core@pocket-tank-build` | Builder, Jev's default seat: shared C (`common/`), the sim, firmware glue | Claude Code, Opus |
| `dev-sonnet@pocket-tank-build` | Builder | Claude Code, Sonnet |
| `dev-qa@pocket-tank-build` | Independent QA: the sim builds and runs, the firmware builds and boots in QEMU, tests pass | Codex |

Bench (not running after `rig up`; the orchestrator adds each from its file in [bench/](bench/)):

| Seat | File | Role | Runtime and model |
| --- | --- | --- | --- |
| `hw-expert` | `hw-expert.yaml` | ESP32-S3 specialist: board and CYD variants, pins, partitions, PSRAM, the second core, QEMU | Claude Code, Opus |
| `ml-expert` | `ml-expert.yaml` | The model: distillation pipeline, 4-bit inference engine, tokenizer, quantization, the stats | Claude Code, Fable 5.1 (`claude-fable-5-1`) |
| `dev-fable` | `fable.yaml` | Hardest design and debugging | Claude Code, Fable 5.1 (`claude-fable-5-1`) |
| `dev-codex` | `codex.yaml` | Well-specified implementation | Codex |
| `dev-qwen` | `qwen.yaml` | Small, well-specified chores | pi, Qwen on the MacBook |
| `dev-extra<N>` | `extra-builder.yaml` | One more builder on a chosen model | Claude Code, any model |

At most three bench or extra seats run at once. dev-qwen also needs its pi provider settings in
`~/.openrig/state/pi/dev-qwen@pocket-tank-build/agent/`, which OpenRig does not write.

## Check it

From the root of this repository:

```sh
rig spec validate rigs/pocket-tank-build/rig.yaml
rig spec audit rigs/pocket-tank-build/rig.yaml
rig spec preflight rigs/pocket-tank-build/rig.yaml
rig up rigs/pocket-tank-build/rig.yaml --plan --cwd "$(mktemp -d)"
node --import tsx rigs/pocket-tank-build/proof/bench-proof.mjs
```

The last command runs the rig on a private daemon with stub seats (`npm run build` first). It checks that only the
four always-on seats start, that each bench seat and an extra builder get the rig's culture and their role guidance
when started with the commands in CULTURE.md, that the recorded models and runtimes match the tables above, and that
stop, restart and removal work. It adds every seat with `--no-view`, so it never reaches Herdr.

## Launch it

Launch from a folder whose branch never changes, because the bench commands read `bench/` from it for the life of
the rig. This rig's family has its own detached worktree, `~/Projects/openrig-pocket-rigs`, pinned to the approved
commit:

```sh
git worktree add --detach ~/Projects/openrig-pocket-rigs <approved-commit>
rig up ~/Projects/openrig-pocket-rigs/rigs/pocket-tank-build/rig.yaml --cwd ~/Projects/pocket-tank
rig terminal open pocket-tank-build --provider herdr
```

Do not launch from a checkout where people switch branches. Before the first task, add the entries CULTURE.md's
"Codebase navigation" lists (the OpenRig seat files and `graphify-out/`), and `.venv/`, to
`~/Projects/pocket-tank/.git/info/exclude`. Then type the outcome you want into `orch-lead`, or point it at a mission.
