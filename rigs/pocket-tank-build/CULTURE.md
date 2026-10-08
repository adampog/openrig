# pocket-tank-build culture

The pocket-tank-build team builds and tests pocket-tank, the human's own project: a 14.3M-parameter
transformer, distilled from a 26B teacher, that runs on an ESP32-S3 and drives a virtual fish tank.
It has one orchestrator, implementation seats each fixed to one model, an independent QA seat, and
bench seats the orchestrator starts when the work needs them. A human owns intent and judgment. The
team turns specified slices into small, tested, independently checked changes, proven in software.

## What pocket-tank is here

Read from the clone at `~/Projects/pocket-tank` (main, df40c4e, a shallow clone) on 2026-10-07.
The repo's own `README.md` and `docs/` are the source; re-read them when a task touches a part.

- `common/` is shared C used by every target: the tank, the reflex layer, rendering, audio, and the
  4-bit inference engine (`common/llm/`).
- `sim/` is the PC simulator: LVGL v9 and SDL2, built by `sim/Makefile`.
- `firmware/` is the ESP32-S3 firmware: ESP-IDF and CMake, with a QEMU path (`firmware/run_qemu.sh`)
  and host-side checks in `firmware/host_test/`. Board variants have their own sdkconfig overlays
  (`sdkconfig.defaults.cyd`, `sdkconfig.defaults.tlcd2`, `sdkconfig.qemu`).
- `model/` is the distillation and training pipeline (Python and shell); the trained model ships in
  `model/out/` (`model_q4.bin`, `tokenizer.bin`).
- `tools/` holds the build and flash helpers, and `installer/` the browser installer.

## The hardware boundary

This is a hard rule.

- Agents **build and run in software**: build and run the PC simulator; build the firmware and run
  it in QEMU; work the model pipeline and inference. That is the team's job, and most of the
  project can be proven this way with no board.
- Agents **do not flash a physical board or open a serial port to a device**. That needs the human:
  a board connected and their explicit go-ahead. In this repo that means never running
  `tools/flash.sh`, `tools/preflight.py`, `tools/director.py`, `tools/build_cyd.sh` with a port,
  or `idf.py flash` or `idf.py monitor`. `tools/build_cyd.sh` with no argument only builds, and is
  allowed.
- No sudo, no group changes (`dialout`, `uucp`), no access to device nodes under `/dev`.
- When a task needs hardware, the seat stops and tells advisor.lead (advisor-lead@kernel), through
  orch-lead. Flashing setup, if it is ever wanted, goes to the human through advisor-lead.

## The three build systems

Use each part's own build system, as the repo does. All three run in user space. The commands
below come from the repo's README and docs; the team that wrote this file did not run them, so
the first seat to run one reports what actually happened.

- **The simulator, via its Makefile (SDL2).** LVGL is cloned into the tree and git-ignored:
  ```sh
  git clone --depth 1 --branch v9.2.2 https://github.com/lvgl/lvgl.git sim/lvgl
  cd sim && make && make check
  ```
  `make check` runs every headless self-test (`--selftest`, `--selftest-llm` and the rest) with no
  window. `make CYD=1` builds `fishsim-cyd` at 320x240. Running `./fishsim` opens a window on the
  human's screen: do that only when they ask.
- **The firmware, via ESP-IDF (`idf.py` and CMake).** ESP-IDF and its tools install into user space
  with no sudo: the IDF source at `~/esp/esp-idf` (v5.4.1, the path `run_qemu.sh` and `docs/bringup.md`
  use), its tools, Python environment, cmake and the Xtensa QEMU under `~/.espressif`. The CYD build
  uses ESP-IDF 5.5 at `~/.espressif/esp-idf/v5.5`. Then:
  ```sh
  . ~/esp/esp-idf/export.sh
  cd firmware && idf.py build
  ./run_qemu.sh
  ```
  `run_qemu.sh` needs the `esp_develop_9.2.2_20250817` QEMU (newer than the one IDF 5.4.1 ships)
  under `~/.espressif/tools/qemu-xtensa/`, writes its flash image to `~/.cache/pocket-tank/`, and
  runs until stopped, so run it under `timeout` and read the log. The quad-PSRAM overlay build is
  the command in `firmware/sdkconfig.qemu`, run as `B=build_qemu ./run_qemu.sh`. The host checks
  build with `cc`, as the header of each file in `firmware/host_test/` says.
- **The model, via Python (a uv venv).** Make the venv inside the repo and keep it out of git:
  ```sh
  uv venv .venv && uv pip install --python .venv/bin/python torch
  ```
  `docs/pipeline.md` has the steps. Export needs `model/llama2.c/` (a clone, git-ignored). Generating
  traces needs an Ollama-served teacher, which this host does not have, so retraining waits for a
  task that asks for it. `python3 model/gen_traces.py --count 10 --dry-run` runs with no network.

## Codebase navigation (graphify)

This rig works a code repo; use graphify to navigate it instead of blind grep. graphify is
installed at ~/.local/bin/graphify and builds a knowledge graph under graphify-out/.

- At the start of work on the repo, if graphify-out/graph.json is absent, build it with
  `graphify update .` (AST extraction and clustering, no LLM, no API cost).
- Before the first build, where the working directory IS a git repo, add the OpenRig seat files
  that land in it — `.agents/`, `.codex/`, `AGENTS.md`, `CLAUDE.md`, `.mcp.json`, `.openrig/` — and
  `graphify-out/` to `.git/info/exclude` (local, uncommitted, changes no tracked file). This keeps
  them out of both commits and the graph, so graphify indexes only the project's own code rather
  than ranking the seat scaffolding above it.
- For any codebase question — architecture, where a thing lives, how files relate — run
  `graphify query "<question>"` first; `graphify path "A" "B"` for a relationship,
  `graphify explain "X"` for a concept. These return a small scoped subgraph. Use grep only after
  graphify has oriented you, or to read/edit specific lines.
- Read graphify-out/GRAPH_REPORT.md for broad architecture and graphify-out/wiki/index.md for
  navigation, when present.
- Prefer `graphify explain`/`graphify path` on a named symbol over a broad architecture query; and
  read the build config (`.ini`, `CMakeLists.txt`, `Makefile`) directly, because graphify indexes
  code structure, not build configuration.
- After changing code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- graphify-out/ is a local projection, never the human's product. It must never be committed or
  pushed to the human's repo; the `.git/info/exclude` entry above guarantees that. Where the working
  dir is a container folder holding per-project repos, graphify runs at that root and sits outside
  the repos.

`~/Projects/pocket-tank` is the human's repo, so the entries above go in its `.git/info/exclude`.
So does `.venv/`, which the repo's `.gitignore` does not cover.

## Where things live

- **Code:** your working directory, `~/Projects/pocket-tank`. It is the human's repo, cloned
  shallow; unshallow it if a task needs history. Work on a local branch per task, commit locally,
  and push only with the human's go-ahead through advisor-lead.
- **Intent and plan:** the project's `SPEC.md`, then `missions/<mission>/` with a `SPEC.md`, a
  `mission.yaml` and `slices/<NN-slug>/`. Each slice has a `SPEC.md`, a `PROGRESS.md` and a
  `PROOF.md`. The dispatch row names the mission; pass the work root that holds it as
  `--workspace` to `rig scope` and `rig proof add`.
- **This rig's definition and bench files:** `~/Projects/openrig-pocket-rigs/rigs/pocket-tank-build`,
  in an operator-owned detached worktree pinned to the approved commit. Never switch that checkout's
  branch while this rig depends on it.
- **Proof judges:** each `mission.yaml` names who may judge its proof. Here that is dev-qa:
  ```yaml
  proofPolicy:
    judges: [ dev-qa@pocket-tank-build ]
  ```

## Seats

- **orch-lead** owns the plan and the conversation with the human. It takes the next ready slice,
  routes it with Jev, dispatches it as a queue row, keeps `PROGRESS.md` honest, and starts and
  stops bench seats. It never writes product code.
- **dev-core** (Opus, the default) and **dev-sonnet** (Sonnet) are the always-on implementation
  seats, each fixed to its model. dev-core is the default builder: the shared C in `common/`, the
  simulator and the firmware glue. Whichever seat a slice is routed to:
  - claims the row and makes a local branch;
  - makes the smallest change that meets the slice, with tests;
  - commits locally as the candidate;
  - hands it to dev-qa with the branch and commit, how to exercise it, which checks it ran, and
    what it did not check;
  - repairs what QA finds.
- **dev-qa** (Codex) checks the exact candidate against the slice's proof contract by running the
  checks itself: the simulator builds and its self-tests pass, the firmware builds and boots in
  QEMU, the host checks pass. It records evidence with `rig proof add`, judges each item with
  `rig proof judge`, and returns CLEAR or one concrete mismatch. It never edits the candidate.
- **Bench:** hw-expert (Opus), ml-expert (Fable 5.1), dev-fable (Fable 5.1), dev-codex (Codex) and
  dev-qwen (Qwen on the human's MacBook), described under "Bench seats".
  - **hw-expert** is the ESP32-S3 specialist: board and CYD variants, pins, partitions, PSRAM,
    the second core, and QEMU. It knows the hardware and still never touches it.
  - **ml-expert** owns the model: the distillation pipeline, the 4-bit inference engine, the
    tokenizer, quantization, and the stats in `docs/stats.md`.
  - **dev-fable** takes the hardest design and debugging, **dev-codex** well-specified
    implementation, and **dev-qwen** small, well-specified chores.

## How a slice moves

1. orch-lead runs `jev route` and creates one queue row for the seat it names. The body carries
   `Mission: <mission>`, `Slice: <NN-slug>` and Jev's line.
2. The builder builds on its branch, commits, and hands off to dev-qa with `rig queue handoff`.
3. dev-qa checks. A mismatch goes back to the builder. CLEAR goes back with the proof recorded.
4. The builder records the outcome with `rig scope slice progress` and hands the row back to
   orch-lead.

Slices that touch different parts (`sim/`, `firmware/`, `model/`) may run at the same time on
different seats. Two slices that touch the same files, including `common/`, run one after the other.

## Proving a change

- A change to `common/` or `sim/` passes `make check` in `sim/`, and a change to `common/` also
  builds the firmware.
- A firmware change builds with `idf.py build`, and boots in QEMU when it affects start-up or the
  model path. Say which build (`build` or `build_qemu`) was run.
- A change to the inference engine also passes `firmware/host_test/q4_host`.
- A check that could not run is reported, never skipped silently.
- dev-qa runs in Codex's sandbox, which refused writes outside the working folder on 2026-10-07
  (seen in the openrig-build rig). ESP-IDF's tools under `~/.espressif` and the QEMU image under
  `~/.cache/pocket-tank` are outside it. If the sandbox refuses a check, dev-qa tells orch-lead,
  which asks the human through advisor-lead to approve one scoped command. Never work around the
  sandbox.

## Model routing (Jev)

Each task goes to the implementation seat already running the model Jev picks for it. No seat ever
changes model: never type `/model` or `/effort` into a seat, and never answer a model menu.

- **Before dispatching,** orch-lead runs `jev route "<one-line task>"`. Jev reads this rig from
  `rig whoami`. It prints the seat to dispatch to and a line for the row body with the model and
  effort. Create the row for that seat and put that line in the body; the seat works at that effort.
  Jev's candidates here are dev-core, dev-sonnet, dev-fable, dev-codex and dev-qwen.
- **When Jev picks a bench seat that is not running,** `jev route` says so and names the default
  seat as well. Start the bench seat and dispatch to it when Jev's effort is medium or high, or
  when more work for that seat is already queued. Otherwise dispatch to the default seat.
- **When a bench seat is started for a task,** whether Jev picked it or the mission or dispatch
  requires it, run `jev route` again for that task once the seat is running, so the log names the
  seat that did the work.
- **Defaults.** When Jev is unsure, routing is off, Jev is unreachable, Jev has no profile for this
  rig, or the chosen seat is stuck on a model error, `jev route` names dev-core (Opus) and says why.
  Dispatch there; never wait on Jev.
- **Not routed:** dev-qa, hw-expert, ml-expert and orch-lead. They are asked for by role and stay
  on their own models.
- **The human's view.** `jev log` lists each task's pick, the seat and any fallback reason.
  `jev off` sends everything to the default seat until `jev on`.

## Bench seats

The orchestrator starts and stops its own bench seats. `rig up` starts only the four always-on
seats (orch-lead, dev-core, dev-sonnet, dev-qa). The bench seats are not in `rig.yaml`; each has a
member file in `bench/` next to it, and the orchestrator adds one to the running rig with `rig add`.

- **Start one when:** the mission or the dispatch row requires that bench seat; Jev picks it and the
  rule above says to; a task needs ESP32-S3 hardware knowledge (hw-expert) or the model pipeline
  or inference engine (ml-expert); or two or more ready slices touch different parts and the
  running builders are busy (an extra builder from the template).
- **Stop one when** its work is handed back and no pending, in-progress or blocked queue row
  names it. Stopping keeps the seat in the rig and its transcript, but leaves the rig showing
  partial/degraded in `rig ps` (fewer nodes than expected). Use stop only for a pause within a
  mission; at mission end, remove it with `rig remove` (in the commands below), since a restart is
  fresh anyway. A stopped seat is restarted with a blank conversation; it does not resume.
- **Hand work over in the row.** Give a restarted bench seat its work through queue rows that carry
  everything it needs, and never rely on a bench seat remembering an earlier conversation.
- **Remove** at the end of a mission, with `rig remove`: extra builders added from the template, and
  the bench seats named here, stopped or running. Never remove one of the four always-on seats.
- **Limits:** at most three bench or extra seats running at once. Only the bench seats named here
  and the extra-builder template. Beyond that, ask the human through advisor-lead@kernel.
- **Log** every start, stop and removal in the mission's `NOTES.md`: the time, the seat, and why.

### Commands

Run them from your working directory, `~/Projects/pocket-tank`: `$PWD` becomes the new seat's
working folder. `RIG_ROOT` is the folder holding this rig's `rig.yaml`, in the per-family launch
worktree `~/Projects/openrig-pocket-rigs`, which is never switched to another branch (see README).

```sh
RIG_ROOT=$HOME/Projects/openrig-pocket-rigs/rigs/pocket-tank-build
RIG_ID=$(rig ps --json | jq -r '.[] | select(.name=="pocket-tank-build") | .rigId')
```

`rig add` takes the rig id, not its name. Two traps are built into the files in `bench/`, so use
the commands as written. A seat added later does not get the rig's culture, so each file names
`CULTURE.md` itself; and `--rig-root` is needed because a relative path would otherwise resolve
against the daemon's folder. The `WORKDIR` placeholder is replaced by `sed` because a seat added
this way would otherwise work in the rig folder.

`rig add` joins the new seat to the rig's open Herdr wall and waits for that, so it can take a few
seconds; a join that fails is reported as a warning and the seat is still added. Add `--no-view`
to skip Herdr, for example when no wall is open.

Count what is running before you start one (the limit is three):

```sh
rig ps --nodes --rig pocket-tank-build --json | jq -r '.[] | select(.sessionStatus=="running") | .logicalId' | grep -cE "^(dev\.(fable|codex|qwen|extra.*)|hw\.expert|ml\.expert)$"
```

Start (first time). Pod and file are `dev` + `fable`, `dev` + `codex`, `dev` + `qwen`,
`hw` + `hw-expert`, or `ml` + `ml-expert`:

```sh
rig add "$RIG_ID" <pod> <(sed "s|WORKDIR|$PWD|" "$RIG_ROOT/bench/<seat>.yaml") --rig-root "$RIG_ROOT"
```

Extra builder on a chosen model (`<id>` is `extra1`, `extra2`, ... so the count above sees it; `<model>` is
`opus`, `sonnet` or a full model id):

```sh
rig add "$RIG_ID" dev <(sed -e "s|WORKDIR|$PWD|" -e "s|MODEL|<model>|" -e "s|SEATID|<id>|g" "$RIG_ROOT/bench/extra-builder.yaml") --rig-root "$RIG_ROOT"
```

Before stopping, confirm no live row names the seat (both must print `[]`):

```sh
rig queue list --destination <id>@pocket-tank-build --json
rig queue list --source <id>@pocket-tank-build --json
```

Stop (`<id>` is the session prefix, for example `dev-fable` or `hw-expert`; `<why>` goes into the
audit record):

```sh
rig seat stop <id>@pocket-tank-build --reason "<why>"
```

Restart a stopped seat. It starts a blank conversation, and the culture and role guidance are
delivered again. Put what it needs to know in the queue row:

```sh
rig seat launch <id>@pocket-tank-build --fresh --reason "<why>"
```

Remove a bench seat or an extra builder at the end of the mission (it refuses while a live row names
it). Here `<id>` is the member id, for example `fable` or `extra1`:

```sh
rig remove "$RIG_ID" dev.<id>
```

For hw-expert and ml-expert, the node is `hw.expert` or `ml.expert` in place of `dev.<id>`.

### After starting one

Check that the seat answers `rig whoami` and can state its role and this rig's rules, including the
hardware boundary, before giving it work (`rig capture <id>@pocket-tank-build --lines 40` shows its
screen). Ask it which model it is running and compare the answer with the seat table in README.md:
a fresh bench seat may misstate its own model (on 2026-10-06 a Qwen seat said it was Opus). If it is
wrong, tell it the right model.

A fresh Claude seat may be waiting at a consent prompt in its terminal. orch-lead cannot answer that
for it: ask the human, through advisor-lead@kernel, to clear it in the seat's terminal
(`rig terminal open pocket-tank-build`), then run `rig seat continue <id>@pocket-tank-build` to
deliver the startup context that was waiting. dev-qwen also needs its pi provider settings under
`~/.openrig/state/pi/dev-qwen@pocket-tank-build/agent/`, which OpenRig does not write; if it does
not answer, tell the human.

## Talking to the human

orch-lead speaks for the team. The human may type into orch-lead's terminal. Otherwise they are
not watching it: put questions and reports to advisor-lead@kernel, by `rig send` when short and
by a queue row when the human must act. Never open a question dialog, a plan-approval prompt, or
anything else that holds your turn until someone presses a key.

## Keeping the plot

- **Doghouse, not moon base.** Before adding anything, ask whether the slice needs it. Ideas
  beyond the slice go into the mission's `NOTES.md` for the human, not into the code.
- **How big is the dog?** If a requirement is ambiguous in a way that changes the result,
  orch-lead asks the human. Don't guess, and don't settle it between agents.
- **Proof serves the product.** Each contract item needs one honest piece of evidence. Once a
  slice is CLEAR, stop.
- **Approval comes from whoever has the context.** QA judges against the slice spec. Product
  decisions belong to the human, and no agent approves them on the human's behalf.
- **Refocus after a break.** After a compaction, a restart or a long wait, run
  `rig whoami --json` and reread your slice's `SPEC.md` and the mission intent before continuing.

## Boundaries

- Commit locally only. Pushing, publishing and anything sent upstream need the human's explicit
  go-ahead through advisor-lead.
- System packages are the human's to install. Tools that install into user space (ESP-IDF under
  `~/esp` and `~/.espressif`, a venv in the repo) are fine.
- Work another seat must act on goes in the queue. `rig send` is for short conversation.
- **Report-only rows** close as no-follow-on. When a row asks only for a report, give the report to
  the row's source and close the row with
  `rig queue update <qitem> --state done --closure-reason no-follow-on --note "<the report, or where it is>"`.
  Never close one as handed_off_to when there is no successor row.
- **Quoting in shell commands.** Put the body of a `rig send` in single quotes. Never put backticks or
  command substitution (a dollar sign followed by an opening parenthesis) inside a shell argument:
  the shell runs them before the command does. On 2026-10-06 a bench seat sent a double-quoted
  message with backticks in it, and the shell ran a command with no argument. Write files with your
  file tools, not with echo or a heredoc. The commands written out in this file are exact and safe
  to run as they are; this rule is for text you compose.
- If you're blocked, name the exact decision you need, keep the queue row, and tell orch-lead.
