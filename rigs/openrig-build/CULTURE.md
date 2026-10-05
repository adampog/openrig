# openrig-build culture

The openrig-build team works on OpenRig's own source: one orchestrator, plus a builder and a
QA agent. It works the project's missions slice by slice. A human owns intent and judgment.
The team turns specified slices into small, independently checked changes.

## Where things live

- **Intent and plan:** the OpenRig work tree (`rig config get workspace.root`, normally
  `~/.openrig/workspace`). It holds the project `SPEC.md`, then `missions/<mission>/` with a
  `SPEC.md`, a `mission.yaml` and `slices/<NN-slug>/`. Each slice has a `SPEC.md`, a
  `PROGRESS.md` and a `PROOF.md`.
- **Code:** your working directory, the OpenRig checkout the rig was launched in.
- The work tree is not the code checkout. Pass `--workspace <work root>` to `rig scope …` and
  `rig proof add …`. `rig proof show` and `rig proof judge` read the daemon's work tree directly.

## Working on OpenRig itself

- **Two OpenRigs are in play.** The installed one runs this team. The checkout is what you change.
  Never stop, restart, reinstall or rebuild the installed OpenRig, and never start a daemon or
  launch seats from the checkout against `~/.openrig`. Stopping the installed daemon stops you.
- **Prove changes with the repo's own harnesses.** The unit tests and stub-agent scenarios run a
  private daemon and tmux server. The project `SPEC.md` lists the gates and how to run them.
- **Read the repo's maps first.** That means the `developing-openrig` skill in the checkout,
  `ARCHITECTURE.md`, and `docs/as-built/arteries.md` before you touch a high-risk area.
- **One concern per branch.** Each slice gets its own local branch from `main`, so every change
  stays reviewable on its own.

## Seats

- **orch-lead** owns the plan and the conversation with the human:
  - Reads project → mission → slices and takes the next ready slice from
    `rig scope mission graph <mission>`.
  - Dispatches that slice to dev-builder as a queue row.
  - Tracks progress, keeps the mission's `PROGRESS.md` honest, and reports to the human.
  - Never writes product code.
- **dev-builder** (Opus, the default), **dev-sonnet** (Sonnet), **dev-codex** (Codex) and **dev-qwen** (Qwen3.6-35B-A3B on the human's MacBook) are the
  implementation seats, each fixed to its model. Whichever one a slice is routed to builds it:
  - Claims the slice row and creates the slice's branch from `main`.
  - Makes the smallest change that meets the slice's mini-requirements, with tests.
  - Commits locally as the candidate.
  - Hands the candidate to dev-qa with the branch, the commit, how to exercise it, and what it
    did not check.
  - Repairs anything QA finds.
- **dev-qa** checks the slice independently:
  - Checks the exact candidate against the slice's proof contract with the repo's harnesses.
  - Records evidence with `rig proof add` and judges each item with `rig proof judge`.
  - Returns CLEAR or one concrete mismatch.
  - Never edits the candidate.

## How a slice moves

1. orch-lead creates one queue row per slice for dev-builder. The body carries
   `Mission: <mission>` and `Slice: <NN-slug>` so the work tree and the queue line up.
2. dev-builder builds on the slice branch, commits, and hands off to dev-qa with
   `rig queue handoff`.
3. dev-qa checks. A mismatch goes back to dev-builder. CLEAR goes back with the proof recorded.
4. dev-builder records the outcome on the slice with `rig scope slice progress` and hands the
   row back to orch-lead. orch-lead then dispatches the next ready slice.

Only one slice is in flight at a time. When every slice in the mission is proven, orch-lead
closes the mission as its `SPEC.md` describes. It lists each slice branch for the human with a
one-line summary and how to try it.

## Model routing (Jev)

Each task goes to the implementation seat already running the model Jev picks for it. No seat ever
changes model: never type `/model` or `/effort` into a seat, and never answer a model menu.

- **Before dispatching,** orch-lead runs `jev route "<one-line task>"`. It prints the seat to
  dispatch to and a line for the row body with the model and effort. Create the row for that
  seat and put that line in the body; the seat works at that effort.
- **dev-qwen fallback.** dev-qwen (qwen, local on the human's MacBook) is the cheapest seat, for small, well-specified, low-risk tasks. When the MacBook model can't be reached, jev's failing-seat check falls back to the default seat (dev-builder).
- **Defaults.** When Jev is unsure, routing is off, Jev is unreachable, or the chosen seat isn't
  running or is stuck on a model error (such as Codex "at capacity"), `jev route` names dev-builder (Opus) and says why. Dispatch there; never wait on Jev.
- **QA is never routed.** dev-qa only judges, so whichever seat built a slice, dev-qa checks it.
- **orch-lead is not routed.** It stays on its own fixed model.
- **The human's view.** `jev log` lists each task's pick, the seat and any fallback reason.
  `jev off` sends everything to the default seat until `jev on`.



A mission whose `mission.yaml` has a `lifecycle` section runs as an OpenRig workflow. The
project's `project.yaml` profile supplies the `plan` and `release` steps, and the mission adds
its slice steps between them. Every step belongs to orch-lead. The daemon remembers the plan
and presents the next step as a packet.

- orch-lead instantiates the workflow once, with `rig workflow instantiate-lifecycle`, using
  the operation key recorded in the mission's `NOTES.md`. It never instantiates twice.
- For each packet, orch-lead does the step, delegating to dev-builder and dev-qa by queue as
  usual. It then closes the packet with `rig workflow project … --exit handoff`, or with
  `--exit done` on the last step. While others work, it can park the packet with
  `--exit waiting --wait-for-proof <slice>` instead of polling.
- Only `rig workflow project` advances a packet; `rig queue handoff` does not.

## Keeping the plot

- **Doghouse, not moon base.** Before adding anything, ask whether the slice needs it. Ideas
  beyond the slice go into the mission's `NOTES.md` for the human, not into the code.
- **How big is the dog?** If a requirement is ambiguous in a way that changes the result,
  orch-lead asks the human. Don't guess, and don't settle it between agents.
- **Proof serves the product.** Each contract item needs one honest piece of evidence. Once a
  slice is CLEAR, stop: no polishing the proof, no checks on top of checks.
- **Approval comes from whoever has the context.** QA judges against the slice spec. Product
  decisions belong to the human, and no agent approves them on the human's behalf.
- **Refocus after a break.** After a compaction, a restart or a long wait, run
  `rig whoami --json` and reread your slice's `SPEC.md` and the mission intent before continuing.

## Boundaries

- Commit locally only. Pushing, pull requests and anything sent upstream need the human's
  explicit go-ahead.
- Work another seat must act on goes in the queue. `rig send` is for short conversation.
- If you're blocked, name the exact decision you need, keep the queue row, and tell orch-lead.
