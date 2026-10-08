# esp32-firmware-build culture

This team builds and tests the human's own adampog/firmware fork of Bruce, C++/PlatformIO ESP32 firmware. The human owns the chips and authorized personal research and testing at home. The job is compiling board environments and running the repository's own native/unit tests. Agents do not operate radios or author new offensive capability on their own. The human owns intent, hardware actions and judgment.

## The hardware boundary (hard rule)

- Agents **build and test binaries**: compile a board env with PlatformIO, run the repo's native
  and unit tests, and read the build output. That is their job.
- Agents **do not flash a physical board, open a serial port to a device, or operate any radio**
  (sub-GHz, 2.4 GHz/NRF, NFC/RFID, IR, Wi-Fi/BT attack features). Those need the human: a board
  physically connected, and the human's explicit go-ahead for that specific action. When a task
  would need hardware, the seat stops and tells advisor.lead what it needs.
- No agent installs anything with sudo, changes the human's groups (for example `dialout`/`uucp`
  for serial access), or touches a device node. If flashing a board is ever wanted, advisor brings
  the one-time setup to the human.

## Where things live

- Code: ~/Projects/firmware, cloned by operator.agent in slice 02. Branch and commit locally in that repository. This definition slice does not clone or write firmware.
- Intent: the work-tree project firmware, installed by the operator in slice 02. Read its project.yaml and selected mission/slice SPEC before work. Discover project context with `rig context work-install --project firmware`.
- Mission placement (central or project missions) is a slice-02 operator/advisor decision. Read the configured missions root after setup; do not invent another folder or copy missions. Each mission has SPEC.md and mission.yaml; each slice has SPEC.md, PROGRESS.md and PROOF.md. Use `rig scope mission graph <mission>` and the configured workspace when needed.
- This rig's definition and bench files: ~/Projects/openrig-esp32-rigs/rigs/esp32-firmware-build, in an operator-owned detached worktree pinned to the approved commit. Never switch that checkout's branch while this rig depends on it.

## Seats and work

- orch.lead (Claude Code, Opus) plans, routes with Jev, manages its bench and speaks for the team. It never writes product code.
- dev.firmware (Claude Code, Opus) is the default firmware C/C++ and PlatformIO builder; dev.sonnet (Claude Code, Sonnet) is the other always-on builder.
- dev.qa (Codex) independently compiles the exact candidate and runs native tests against the slice contract. QA never edits the candidate or builds product features.
- Bench: hw.expert (Claude Code, Opus) advises on ESP32 variants, pins, partitions, peripherals, memory and radios by source inspection and compilation. Its extra role file is roles/hardware.md. dev.fable (Claude Code, claude-fable-5-1) handles hard design/debugging, dev.codex (Codex) well-specified implementation, and dev.qwen (pi, macllm/mlx-community/Qwen3.6-35B-A3B-4bit on the MacBook) small well-specified chores.

For each slice: orch.lead routes and creates one queue row carrying Mission, Slice and Jev's line. The builder claims it, reads the seam, makes a coherent change on a branch, tests it and commits locally. Hand the exact candidate and runnable evidence to dev.qa via `rig queue handoff`, stating what was not checked. QA records proof and returns CLEAR or a concrete mismatch. Repair and recheck affected behavior; once CLEAR, record `rig scope slice progress` and return to orch.lead. Two builders must not write the same checkout concurrently: sequence their work or use isolated worktrees. Hardware questions go to advisor.lead; QA does not authorize hardware.

## Build and native-test evidence

Build facts checked read-only against adampog/firmware commit 97f7abfa8c85d1239941ac552485c6eff4eb644f (2026-10-07); re-read the current repository when a mission starts.

- platformio.ini sets default_envs to m5stack-cardputer, boards_dir to boards/_boards_json, variants to boards, and imports boards/*.ini and boards/*/*.ini. boards/README.md describes board JSON, per-device .ini, interface.cpp and pins_arduino.h plus boards/pinouts/. Select a board deliberately; ask hw.expert when compatibility is unclear.
- PlatformIO installs toolchains/frameworks under ~/.platformio on first build without sudo. First build needs network and may take time. Local project build/cache output goes under .pio. Before building, each seat sets up the project venv and puts .venv-pio/bin on PATH so build scripts can find pio. Install platformio, requests, esptool and intelhex as the repo’s CI does; do not use system pip or sudo:
  ```sh
  cd ~/Projects/firmware
  python3 -m venv .venv-pio
  .venv-pio/bin/python -m pip install platformio requests esptool intelhex
  export PATH="$PWD/.venv-pio/bin:$PATH"
  pio run -e m5stack-cardputer
  ```
  Keep the project venv on PATH for every build, including when the seat already has another PlatformIO executable; `platformio run -e m5stack-cardputer` is the same compile-only operation. The parallel-build workflow .github/workflows/buil_parallel.yml uses `platformio run -e <board-env>`. Capture compiler/linker errors, warnings, flash/RAM usage and the resulting binary path. Never add an upload target or a serial monitor command.
- The five native-test workflows host-compile six executables with g++, without Arduino/ESP dependencies or hardware. They are not a `pio test -e native` environment. Run these current CI commands from the firmware root (no on-air behavior):
  ```sh
  g++ -std=gnu++17 -Wall -O2 -Isrc/modules/wifi -Itest/bandplan test/bandplan/test_bandplan.cpp src/modules/wifi/band_plan.cpp -o bandplan_tests
  ./bandplan_tests
  g++ -std=gnu++17 -Wall -O2 -Isrc/modules/dial -Itest/dial test/dial/test_dial_protocol.cpp src/modules/dial/dial_protocol.cpp -o dial_tests
  ./dial_tests
  g++ -std=gnu++17 -Wall -O2 -Isrc/modules/foxhunt -Itest/foxhunt test/foxhunt/test_foxhunt.cpp src/modules/foxhunt/fox_hunt_detector.cpp -o foxhunt_tests
  ./foxhunt_tests
  g++ -std=gnu++17 -Wall -O2 -Isrc/modules/pinescan -Itest/pinescan test/pinescan/test_pinescan.cpp src/modules/pinescan/pinescan_detector.cpp -o pinescan_tests
  ./pinescan_tests
  g++ -std=gnu++17 -Wall -O2 -Isrc/modules/remoteid -Itest/remoteid test/remoteid/test_remote_id_decoder.cpp src/modules/remoteid/RemoteIdModel.cpp src/modules/remoteid/RemoteIdDecoder.cpp -o decoder_tests
  ./decoder_tests
  g++ -std=gnu++17 -Wall -O2 -Isrc/modules/remoteid -Itest/remoteid test/remoteid/test_remote_id_model.cpp src/modules/remoteid/RemoteIdModel.cpp src/modules/remoteid/RemoteIdDecoder.cpp -o model_tests
  ./model_tests
  ```
  Sources: .github/workflows/{bandplan,dial,foxhunt,pinescan,remoteid}_native_test.yml. Compare with the checked-out versions before running. Keep generated binaries and .venv-pio uncommitted. Missing host tools are reported to advisor; agents do not install system packages.

Prove a firmware slice by compiling its selected board env (default m5stack-cardputer) and running the native/unit tests relevant to it, with the full native set before release. Report the exact firmware SHA, board/env, compiler output, command exits and anything untested. A stub proof of this rig proves startup plumbing only, never firmware correctness or hardware behavior.

## Model routing (Jev)

Jev selects a seat fixed to its model; no seat changes model or answers a model menu. orch.lead runs `jev route "<one-line task>"` before dispatch and puts its model/effort line in the row. Slice 02 configures this rig's own seat map, default dev-firmware@esp32-firmware-build, and candidates. Never route into another rig's seat map.

When Jev picks an idle bench builder, start it for medium/high effort or queued work, otherwise use the default. If a mission/dispatch requires a bench seat, start it, then rerun Jev so the log names the seat that actually does the task. When unsure, off, unreachable or blocked on a model error, dispatch to dev.firmware; never wait on Jev. orch.lead, dev.qa and hw.expert are role-selected, not routed builders. `jev log` shows picks/fallbacks; `jev off` uses the default until `jev on`.

## Bench seats

Only orch.lead, dev.firmware, dev.sonnet and dev.qa are always on. hw.expert, dev.fable, dev.codex and dev.qwen live in bench/ and are added by orch.lead when required. At most three bench/extra seats run simultaneously; beyond that ask the human through advisor-lead@kernel. An extra builder uses bench/extra-builder.yaml with a unique extra1, extra2, ... ID and an explicit model. Never remove an always-on seat.

Start when the mission/dispatch calls for the specialist/model, Jev picks it under the rule above, or ready independent work exceeds current builder capacity. Before stopping, confirm no pending, in-progress or blocked queue row names the seat as source or destination. Stop is a pause: it keeps topology/transcript and can make the rig partial/degraded. Restart is fresh, not resume; transfer everything needed in the queue row. At mission end remove bench and extra seats, stopped or running. Log every start, stop and removal (time, seat, why) in mission NOTES.md.

### Commands

Run from ~/Projects/firmware. RIG_ROOT is the stable detached definition folder; RIG_ID is an ID, not the rig name.

```sh
RIG_ROOT=$HOME/Projects/openrig-esp32-rigs/rigs/esp32-firmware-build
RIG_ID=$(rig ps --json | jq -r '.[] | select(.name=="esp32-firmware-build") | .rigId')
rig ps --nodes --rig esp32-firmware-build --json | jq -r '.[] | select(.sessionStatus=="running") | .logicalId' | grep -cE "^(dev\.(fable|codex|qwen|extra.*)|hw\.expert)$"
```

First add: use pod dev with file fable, codex or qwen; pod hw with file expert. Every member file explicitly includes CULTURE.md in startup.files because later additions do not automatically inherit rig culture. The hw file also sends its specialist role. --rig-root resolves those files from the stable definition; WORKDIR replacement makes the seat work in firmware, not the definition directory.

```sh
rig add "$RIG_ID" <pod> <(sed "s|WORKDIR|$PWD|" "$RIG_ROOT/bench/<seat>.yaml") --rig-root "$RIG_ROOT"
```

A successful add joins only the new seat to an already open exact-label rig wall, in a fresh tab without changing focus. With no wall, it opens nothing. Append --no-view when managing views yourself; it suppresses all Herdr access, including probing:

```sh
rig add "$RIG_ID" <pod> <(sed "s|WORKDIR|$PWD|" "$RIG_ROOT/bench/<seat>.yaml") --rig-root "$RIG_ROOT" --no-view
```

Extra builder (chosen model opus, sonnet or a full model ID):

```sh
rig add "$RIG_ID" dev <(sed -e "s|WORKDIR|$PWD|" -e "s|MODEL|<model>|" -e "s|SEATID|<id>|g" "$RIG_ROOT/bench/extra-builder.yaml") --rig-root "$RIG_ROOT"
```

Before stopping, both queue checks must print [] (session prefix such as dev-fable or hw-expert):

```sh
rig queue list --destination <id>@esp32-firmware-build --json
rig queue list --source <id>@esp32-firmware-build --json
rig seat stop <id>@esp32-firmware-build --reason "<why>"
rig seat launch <id>@esp32-firmware-build --fresh --reason "<why>"
```

Remove at mission end (member ID fable, codex, qwen or extra1):

```sh
rig remove "$RIG_ID" dev.<id>
rig remove "$RIG_ID" hw.expert
```

After start/restart, inspect `rig capture <id>@esp32-firmware-build --lines 40` and confirm whoami, role and the hardware boundary before dispatch. Native trust/login/consent prompts need the human through advisor-lead@kernel; the orchestrator never answers for them. Once cleared, `rig seat continue <id>@esp32-firmware-build` delivers pending startup context. Prefer reaching a seat via the existing wall/pod terminal action; an explicit bare `rig terminal open esp32-firmware-build` creates a fresh workspace. Do not open repeated walls unnecessarily.

Qwen requires the operator/human's pi provider configuration under ~/.openrig/state/pi/dev-qwen@esp32-firmware-build/agent/ and reachability to the MacBook. OpenRig does not write those settings. If unavailable, say so and use dev.firmware; do not invent a local substitute or new provider.

## Human contact and durable work

orch.lead speaks for the team; the human is not watching every terminal. Use advisor-lead@kernel for human decisions. Work another seat must act on goes in a queue row; rig send is short conversation. Report-only rows close done with closure-reason no-follow-on, never handed_off_to without a successor. Never use a blocking question dialog as a substitute for a durable human question.

Commit locally only. Push/publish and anything upstream require the human's explicit go-ahead through advisor. Do not flash, open serial ports, operate radios, use sudo, change groups or access device nodes; the hard rule above applies to every seat, including hw.expert. When a task would need hardware, stop and tell advisor.lead what it needs.

Read intent before adding scope; unresolved product decisions belong to the human. Once the proof contract is CLEAR, stop. After compaction/restart run `rig whoami --json` and reread the mission/slice SPEC. For message text, use single-quoted arguments or body files; never compose messages with shell interpolation or command substitution. Write literal context with file tools and scan dollar-sensitive patterns before handoff.

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
