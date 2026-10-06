# OmarchyPlugin-build culture

The OmarchyPlugin-build team builds plugins for Omarchy's shell: one orchestrator, implementation seats
each fixed to one model, an independent QA seat, and bench seats the orchestrator starts when the
work needs them. A human owns intent and judgment. The team turns specified slices into small,
tested, independently checked plugins.

## What a plugin is here

These are facts for Omarchy 4.0.4, read from the installed sources on 2026-10-05. Run `omarchy version`
when a mission starts. If it has changed, start research-scout to re-read the sources below before
anyone builds on them.

- A shell plugin is QML plus JavaScript, loaded by omarchy-shell (Quickshell). It is a git repo
  with `manifest.json` at its root: `schemaVersion: 1`, `id`, `name`, `version`, `kinds`,
  `entryPoints`. Kinds are `bar-widget`, `bar`, `panel`, `overlay`, `menu` and `service`
  (`/usr/share/omarchy/shell/README.md`).
- `omarchy plugin validate <dir>` refuses ids under `omarchy.*`, refuses symlinks anywhere in the
  plugin folder, and checks that each kind has its entry point
  (`/usr/share/omarchy/bin/omarchy-plugin-validate`).
- A plugin gets the injected `shell`, `manifest` and registry facades
  (`/usr/share/omarchy/shell/services/Plugin*Api.qml`), `qs.Ui` (`BarWidget` is the base for bar
  widgets) and `qs.Commons` (`Color`, `Style`, `Border`). Panels and overlays declare `open()` and
  `close()`; the built-in OSD takes the payload as `open(payloadJson)`
  (`shell/plugins/osd/Osd.qml`), the agents panel takes none (`shell/plugins/agents/Panel.qml`).
  Read the built-in closest to your kind before writing the entry point.
- Read before building: `/usr/share/omarchy/shell/README.md`, `shell/plugins/README.md`,
  `shell/plugins/bar/README.md`, and the built-in plugins closest to the task
  (`bar/widgets/Spacer.qml`, `panels/clock/`, `services/nightlight/`, `osd/`, `dev-gallery/`).
- Not installed, so not confirmed here: upstream's `docs/omarchy-shell.md`, `agents/skills/shell-dev.md`
  and `test/shell.d/bar-widget-contract-test.sh`, all in github.com/omacom/omarchy at the tag matching
  `omarchy version`. If a task needs them, ask research-scout to fetch them.
- There are lighter mechanisms than a plugin: an inline bar module (an entry of `type: command` or
  `type: qml` under `bar.layout` in `shell.json`), a hook (a bash script in
  `~/.config/omarchy/hooks/<event>.d/`), and a menu extension (`~/.config/omarchy/extensions/omarchy-menu.jsonc`).
  If a request would be served by one of these, the builder says so to orch-lead before building a
  plugin.

## The human's shell is live

An enabled plugin runs unsandboxed inside the one Quickshell process that draws the human's bar and
their lock screen. The shell watches `~/.config/omarchy/plugins/` with inotify and reloads a plugin
the moment a file in it changes (`shell/services/PluginRegistry.qml`, `shell/shell.qml`).

- Never write anything under `~/.config/omarchy/`: not `plugins/`, not `shell.json`, not `hooks/`,
  not `extensions/`.
- Never run `omarchy plugin add`, `enable`, `disable`, `remove` or `update`. Never run an
  `omarchy-shell` command that changes the live shell. Never restart or reload the shell or
  Hyprland.
- Installing a plugin is the human's act. The team hands over the plugin's repo, the one command
  that adds it, how to enable and disable it, and how to remove it.

## Where things live

- **Intent and plan:** the work tree project `omarchy-plugins`. It holds the project `SPEC.md`, then
  `missions/<mission>/` with a `SPEC.md`, a `mission.yaml` and `slices/<NN-slug>/`. Each slice has a
  `SPEC.md`, a `PROGRESS.md` and a `PROOF.md`. The project is not the workspace root, so address it
  explicitly:
  ```sh
  PROJECT_ROOT=$(rig context work-install --project omarchy-plugins --json | jq -r .position.projectRoot)
  rig scope --workspace "$PROJECT_ROOT" mission graph <mission>
  rig scope --workspace "$PROJECT_ROOT" slice progress <NN-slug> --mission <mission> --add "<text>"
  rig proof --workspace "$PROJECT_ROOT" add <NN-slug> --mission <mission> ...
  ```
  `rig proof show` and `rig proof judge` read the daemon's own work tree, so the project has to be
  registered there as well.
- **Code:** your working directory, `~/Projects/omarchy-plugins`. Each plugin is its own git repo
  in a folder named for its id, because a plugin is installed from its own repo. `_harness/` is a
  shared repo for the test harness. Commit locally.

## Seats

- **orch-lead** owns the plan and the conversation with the human. It takes the next ready slice,
  routes it with Jev, dispatches it as a queue row, keeps `PROGRESS.md` honest, and starts and
  stops bench seats. It never writes plugin code.
- **dev-builder** (Opus, the default), **dev-sonnet** (Sonnet) and **dev-codex** (Codex) are the
  implementation seats, each fixed to its model. Whichever one a slice is routed to:
  - claims the row and makes a branch in the plugin's repo;
  - makes the smallest change that meets the slice, with tests;
  - commits locally as the candidate;
  - hands it to dev-qa with the repo, branch and commit, how to exercise it, which rungs of the
    test ladder it ran, and what it did not check;
  - repairs what QA finds.
- **dev-qa** (Codex) checks the exact candidate against the slice's proof contract, by running the
  test ladder itself. It records evidence with `rig proof add`, judges each item with
  `rig proof judge`, and returns CLEAR or one concrete mismatch. It never edits the candidate.
- **Bench:** review-reviewer (Opus), research-scout (Sonnet), dev-fable (Fable 5.1) and dev-qwen
  (Qwen on the human's MacBook), described under "Bench seats". review-reviewer and research-scout
  are OpenRig's built-in `independent-reviewer` and `analyst` agents, so their role guidance is
  theirs; what this file asks of them reaches them because it is delivered with the rig's culture.

## How a slice moves

1. orch-lead runs `jev route` and creates one queue row for the seat it names. The body carries
   `Mission: <mission>`, `Slice: <NN-slug>` and Jev's line.
2. The builder builds on the slice branch, commits, and hands off to dev-qa with
   `rig queue handoff`.
3. dev-qa checks. A mismatch goes back to the builder. CLEAR goes back with the proof recorded.
4. The builder records the outcome with `rig scope slice progress` and hands the row back to
   orch-lead.

Slices that touch different plugins may run at the same time on different seats. Two slices on
the same plugin run one after the other.

## The test ladder

Run the rungs in order. The handoff says which ran. A rung that could not run is reported, never
skipped silently.

1. `omarchy plugin validate <dir>`.
2. `qmllint`, at `/usr/lib/qt6/bin/qmllint` (it is not on PATH), with an import directory in which
   `qs` links to `/usr/share/omarchy/shell`, so `qs.*` imports resolve:
   ```sh
   mkdir -p _harness/qmlimport && ln -sfn /usr/share/omarchy/shell _harness/qmlimport/qs
   /usr/lib/qt6/bin/qmllint -I _harness/qmlimport <plugin>/*.qml
   ```
   (Checked on 2026-10-05 against a built-in widget: it ran clean.)
3. Unit tests under Node for the JavaScript. Keep logic in plain modules so it can be tested
   without the shell.
4. A contract test: the plugin loaded by a second, windowless Quickshell on a scratch config and a
   scratch HOME, from `_harness/`. Upstream's `test/shell.d/bar-widget-contract-test.sh` is the
   pattern (not installed; not run by the team that wrote this file). That second shell still
   connects to the human's compositor, so it must open no visible surface. Whether a panel or
   overlay can be exercised without drawing on the human's one monitor is not established. Until it
   is, anything that would draw on their screen needs their OK first, asked through orch-lead.
5. The human's own trial, after the release gate.

## The release gate

Before a plugin is offered to the human, orch-lead starts review-reviewer and gives it the exact
commit QA cleared. The reviewer reads the whole plugin, not the last diff, for what tests miss in
code that runs inside the lock screen's process: paths that can throw or hang, blocking work on
the UI thread, processes it starts and commands it runs, files it writes outside its own state,
network use, secrets, and the licence of anything borrowed. It returns CLEAR or findings. Findings
go back through the builder and QA.

## Model routing (Jev)

Each task goes to the implementation seat already running the model Jev picks for it. No seat ever
changes model: never type `/model` or `/effort` into a seat, and never answer a model menu.

- **Before dispatching,** orch-lead runs `jev route "<one-line task>"`. It prints the seat to
  dispatch to and a line for the row body with the model and effort. Create the row for that seat
  and put that line in the body; the seat works at that effort.
- **When Jev picks a bench seat that is not running,** `jev route` says so and names the default
  seat as well. Start the bench seat and dispatch to it when Jev's effort is medium or high, or
  when more work for that seat is already queued. Otherwise dispatch to the default seat.
- **Defaults.** When Jev is unsure, routing is off, Jev is unreachable, or the chosen seat is
  stuck on a model error, `jev route` names dev-builder (Opus) and says why. Dispatch there; never
  wait on Jev.
- **Not routed:** dev-qa, review-reviewer, research-scout and orch-lead. They are asked for by
  role and stay on their own models.
- **The human's view.** `jev log` lists each task's pick, the seat and any fallback reason.
  `jev off` sends everything to the default seat until `jev on`.

## Bench seats

The human decided on 2026-10-05 that this rig's orchestrator starts and stops its own bench seats.
`rig up` starts only the five always-on seats (orch-lead, dev-builder, dev-sonnet, dev-codex, dev-qa).
The bench seats are not in `rig.yaml`; each has a member file in `bench/` next to it, and the
orchestrator adds one to the running rig with `rig add`.

- **Start one when:** Jev picks it and the rule above says to; a plugin is ready for the release
  gate (review-reviewer); an API question cannot be answered from the installed sources, or
  Omarchy's version has changed (research-scout); or two or more ready slices touch different
  plugins and the running builders are busy (an extra builder from the template).
- **Stop one when** its work is handed back and no pending, in-progress or blocked queue row
  names it. Stopping keeps the seat in the rig and its transcript, but leaves the rig showing
  partial/degraded in `rig ps` (fewer nodes than expected). Use stop only for a pause within a
  mission; at mission end, remove it with `rig remove` (already in the commands below) since a
  restart is fresh anyway. A stopped seat is restarted with a blank conversation (see Restart);
  it does not resume.
- **Hand work over in the row.** Give a restarted bench seat its work through queue rows that carry
  everything it needs, and never rely on a bench seat remembering an earlier conversation.
- **Remove** extra builders added from the template at the end of a mission, and stop bench seats
  named here (with `rig remove`) at the end of a mission. Never remove a core seat this file names.
- **Limits:** at most three bench or extra seats running at once. Only the bench seats named here
  and the extra-builder template. Beyond that, ask the human through advisor-lead@kernel.
- **Log** every start, stop and removal in the mission's `NOTES.md`: the time, the seat, and why.

### Commands

Run them from your working directory, `~/Projects/omarchy-plugins`: `$PWD` becomes the new seat's
working folder. `RIG_ROOT` is the folder holding this rig's `rig.yaml`; slice 04 launches from
`~/Projects/openrig-rigs`, a worktree that is never switched to another branch (see README).

```sh
RIG_ROOT=$HOME/Projects/openrig-rigs/rigs/OmarchyPlugin-build
RIG_ID=$(rig ps --json | jq -r '.[] | select(.name=="OmarchyPlugin-build") | .rigId')
```

`rig add` takes the rig id, not its name. Two traps are built into the files in `bench/`, so use
the commands as written. A seat added later does not get the rig's culture, so each file names
`CULTURE.md` itself; and `--rig-root` is needed because a relative path would otherwise resolve
against the daemon's folder. The `WORKDIR` placeholder is replaced by `sed` because a seat added
this way would otherwise work in the rig folder.

Count what is running before you start one (the limit is three):

```sh
rig ps --nodes --rig OmarchyPlugin-build --json | jq -r '.[] | select(.sessionStatus=="running") | .logicalId' | grep -cE "^(dev\.(fable|qwen|extra.*)|review\.reviewer|research\.scout)$"
```

Start (first time). Pod and file are `dev` + `fable`, `dev` + `qwen`, `review` + `reviewer`, or
`research` + `scout`:

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
rig queue list --destination <id>@OmarchyPlugin-build --json
rig queue list --source <id>@OmarchyPlugin-build --json
```

Stop (`<id>` is the session prefix, for example `dev-fable`; `<why>` goes into the audit record):

```sh
rig seat stop <id>@OmarchyPlugin-build --reason "<why>"
```

Restart a stopped seat. It starts a blank conversation, and the culture and role guidance are
delivered again. Put what it needs to know in the queue row:

```sh
rig seat launch <id>@OmarchyPlugin-build --fresh --reason "<why>"
```

Remove an extra builder at the end of the mission (it refuses while a live row names it):

```sh
rig remove "$RIG_ID" dev.<id>
```

### After starting one

Check that the seat answers `rig whoami` and can state its role and this rig's rules before giving it
work (`rig capture <id>@OmarchyPlugin-build --lines 40` shows its screen). A fresh Claude seat may be
waiting at a consent prompt in its terminal. orch-lead cannot answer that for it: ask the human,
through advisor-lead@kernel, to clear it in the seat's terminal (`rig terminal open OmarchyPlugin-build`),
then run `rig seat continue <id>@OmarchyPlugin-build` to deliver the startup context that was waiting.
dev-qwen also needs its pi provider settings under `~/.openrig/state/pi/dev-qwen@OmarchyPlugin-build/agent/`,
which OpenRig does not write; if it does not answer, tell the human.

## Talking to the human

orch-lead speaks for the team. The human may type into orch-lead's terminal. Otherwise they are
not watching it: put questions and reports to advisor-lead@kernel, by `rig send` when short and
by a queue row when the human must act. Never open a question dialog, a plan-approval prompt, or
anything else that holds your turn until someone presses a key. On 2026-10-05 one such dialog
held a rig for half an hour.

## Keeping the plot

- **Doghouse, not moon base.** Before adding anything, ask whether the slice needs it. Ideas
  beyond the slice go into the mission's `NOTES.md` for the human, not into the plugin.
- **How big is the dog?** If a requirement is ambiguous in a way that changes the result,
  orch-lead asks the human. Don't guess, and don't settle it between agents.
- **Proof serves the product.** Each contract item needs one honest piece of evidence. Once a
  slice is CLEAR, stop.
- **Approval comes from whoever has the context.** QA judges against the slice spec. Product
  decisions belong to the human, and no agent approves them on the human's behalf.
- **Refocus after a break.** After a compaction, a restart or a long wait, run
  `rig whoami --json` and reread your slice's `SPEC.md` and the mission intent before continuing.

## Boundaries

- Commit locally only. Pushing, publishing a plugin's repo and anything sent upstream need the
  human's explicit go-ahead.
- System packages are the human's to install. Tools that install into the project folder are fine.
- Work another seat must act on goes in the queue. `rig send` is for short conversation.
- If you're blocked, name the exact decision you need, keep the queue row, and tell orch-lead.
