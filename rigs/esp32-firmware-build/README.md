# esp32-firmware-build

A build-and-test team for the human's [adampog/firmware](https://github.com/adampog/firmware)
fork of Bruce. It compiles ESP32 board environments and runs host-native tests. The
[culture](CULTURE.md) contains the mission's hardware boundary verbatim: no flashing,
serial-device access, radio operation, sudo, group changes or device-node access by agents.
Hardware work stops for advisor.lead and the human's specific authorization.

## Seats

| Logical ID | Role | Runtime / model | Starts |
| --- | --- | --- | --- |
| orch.lead | Plan, Jev routing, bench management | claude-code / opus | always |
| dev.firmware | Default firmware C/C++ and PlatformIO builder | claude-code / opus | always |
| dev.sonnet | Builder | claude-code / sonnet | always |
| dev.qa | Independent build/native-test QA | codex / runtime default | always |
| hw.expert | ESP32 variants, pins, partitions, peripherals, memory, radios | claude-code / opus | bench/expert.yaml |
| dev.fable | Hard design/debugging | claude-code / claude-fable-5-1 | bench/fable.yaml |
| dev.codex | Well-specified implementation | codex / runtime default | bench/codex.yaml |
| dev.qwen | Small chores, Qwen on the MacBook | pi / macllm/mlx-community/Qwen3.6-35B-A3B-4bit | bench/qwen.yaml |

Only four seats start with `rig up`. The empty hw pod permits later additions. Bench files
carry their own required CULTURE.md startup entry; hw.expert also gets
[roles/hardware.md](roles/hardware.md), alongside the built-in analyst role. All other
roles reuse OpenRig's orchestrator, implementer and QA agents. Extra builders use
bench/extra-builder.yaml with an explicit model and a unique extraN ID.

Fable is deliberately pinned to `claude-fable-5-1`, rather than a validator's suggested
alias or another Fable version. Validation advisories do not prove provider availability.
The human/operator must confirm native availability in slice 02. Codex uses its runtime
default; Qwen needs operator-managed pi settings and MacBook reachability. Jev's per-rig
seat map and default dev.firmware are configured in slice 02, not by this definition.

## Firmware facts checked read-only

Checked at firmware commit `97f7abfa8c85d1239941ac552485c6eff4eb644f` on 2026-10-07:

- [platformio.ini](https://github.com/adampog/firmware/blob/97f7abfa8c85d1239941ac552485c6eff4eb644f/platformio.ini)
  selects `m5stack-cardputer` by default and imports the per-device board configs.
- [boards/README.md](https://github.com/adampog/firmware/blob/97f7abfa8c85d1239941ac552485c6eff4eb644f/boards/README.md)
  documents JSON, pinouts, interface.cpp and board .ini files. The board tree includes
  ESP32, S3 and C5 devices; do not assume their pins or memory are interchangeable.
- [buil_parallel.yml](https://github.com/adampog/firmware/blob/97f7abfa8c85d1239941ac552485c6eff4eb644f/.github/workflows/buil_parallel.yml)
  installs PlatformIO and compiles with `platformio run -e <board-env>`.
- The [native workflows](https://github.com/adampog/firmware/tree/97f7abfa8c85d1239941ac552485c6eff4eb644f/.github/workflows)
  host-compile bandplan, dial, foxhunt, pinescan and remoteid tests with g++; remoteid
  has separate decoder and model executables. CULTURE.md gives the six exact commands.
  There is no assumption of a PlatformIO native test environment.

No firmware was cloned, compiled, modified, flashed or run by this definition slice.
Tool installation, actual compile/native-test results, credentials and hardware state
remain slice-02 observations. PlatformIO's first build installs toolchains under
~/.platformio without sudo; missing system tools go to the human through advisor.

## Check the definition

From this OpenRig checkout, after `npm run build`, under Node 24:

```sh
rig spec validate rigs/esp32-firmware-build/rig.yaml
rig spec audit rigs/esp32-firmware-build/rig.yaml
rig spec preflight rigs/esp32-firmware-build/rig.yaml
mkdir -p node_modules/.cache/fw/plan
rig up rigs/esp32-firmware-build/rig.yaml --plan --cwd "$PWD/node_modules/.cache/fw/plan"
node --import tsx rigs/esp32-firmware-build/proof/bench-proof.mjs
```

The last command uses the repo's hermetic harness: private daemon, private tmux socket,
scratch HOME and stub runtimes only. It stages an all-eight-seat spec for offline checks
and plans, then checks the real CLI bench commands, culture/role delivery, models,
stop/fresh restart and extra-builder removal. It respects the three-seat bench limit.
Scratch data and output stay under node_modules/.cache/fw in the fork; native runtime
behavior, actual Herdr and firmware build correctness are not proven by stubs.

## Slice-02 operator launch path

Use a dedicated detached worktree so branch changes here cannot remove future bench files:

```sh
git worktree add --detach ~/Projects/openrig-esp32-rigs <approved-commit>
rig up ~/Projects/openrig-esp32-rigs/rigs/esp32-firmware-build/rig.yaml --cwd ~/Projects/firmware
```

These are operator instructions, not actions in slice 01. The dedicated path avoids
repinning the existing Omarchy rigs' definition worktree. The operator clones firmware,
configures project firmware and Jev, chooses central versus project mission placement,
and proves actual build/native tests in slice 02. Do not launch from a switching checkout.
See CULTURE.md for start/stop/remove commands and `rig add --no-view`.

Local commits only; pushing requires the human's go-ahead through advisor.
