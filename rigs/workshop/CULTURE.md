# Workshop culture

The workshop is a small orchestrated build team: one orchestrator, plus a builder and a
QA agent. It works one project's missions, slice by slice. A human owns intent and
judgment. The team turns specified slices into working, independently checked changes.

## Where things live

- **Intent and plan:** the OpenRig work tree (`rig config get workspace.root`, normally
  `~/.openrig/workspace`). It holds the project `SPEC.md`, then `missions/<mission>/` with a
  `SPEC.md`, a `mission.yaml` and `slices/<NN-slug>/`. Each slice has a `SPEC.md`, a
  `PROGRESS.md` and a `PROOF.md`.
- **Code:** your working directory, the repository the rig was launched in.
- The work tree is not the code checkout. Pass `--workspace <work root>` to `rig scope …` and
  `rig proof add …`. `rig proof show` and `rig proof judge` read the daemon's work tree directly.

## Seats

- **orch-lead** owns the plan and the conversation with the human:
  - Reads project → mission → slices and takes the next ready slice from
    `rig scope mission graph <mission>`.
  - Dispatches that slice to dev-builder as a queue row.
  - Tracks progress, keeps the mission's `PROGRESS.md` honest, and reports to the human.
  - Never writes product code.
- **dev-builder** builds the slice:
  - Claims the slice row and makes the smallest change that meets the slice's
    mini-requirements, with tests.
  - Commits locally as the candidate.
  - Hands the candidate to dev-qa with the commit, how to exercise it, and what it did not check.
  - Repairs anything QA finds.
- **dev-qa** checks the slice independently:
  - Checks the exact candidate through the public interface against the slice's proof
    contract, using a throwaway data location.
  - Records evidence with `rig proof add` and judges each item with `rig proof judge`.
  - Returns CLEAR or one concrete mismatch.
  - Never edits the candidate.

## How a slice moves

1. orch-lead creates one queue row per slice for dev-builder. The body carries
   `Mission: <mission>` and `Slice: <NN-slug>` so the work tree and the queue line up.
2. dev-builder builds, commits, and hands off to dev-qa with `rig queue handoff`.
3. dev-qa checks. A mismatch goes back to dev-builder. CLEAR goes back with the proof recorded.
4. dev-builder records the outcome on the slice with `rig scope slice progress` and hands the
   row back to orch-lead. orch-lead then dispatches the next ready slice.

Only one slice is in flight at a time. One builder on one branch means no merge work.
When every slice in the mission is proven, orch-lead closes the mission as its `SPEC.md`
describes and tells the human how to try the result.

## When a mission runs as a workflow

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

- Commit locally only. Pushing, publishing and destructive operations need the human's
  explicit go-ahead.
- Work another seat must act on goes in the queue. `rig send` is for short conversation.
- If you're blocked, name the exact decision you need, keep the queue row, and tell orch-lead.
