# Two-seat restore — 2026-10-19

Alan authorized this rig to run exactly two seats. This dated instruction supersedes legacy multi-seat, bench, Jev routing and QA-only role text for these seats.

- orch.lead: Claude Code, model opus; owns planning, scope and independent review/checks of the exact builder candidate.
- dev.qa: existing Codex conversation retained under its stable name; now owns implementation, builds and repairs. It does not approve its own work.
- Use seat-local sub-agents for parallel, exploratory and throwaway work. Do not add persistent seats.
- Keep the existing project/hardware boundaries. Resuming the rig authorizes checking the queue/docs, not new hardware, flash or publish work.

On resume run `rig whoami --json`, then read this note, `docs/seat-history/README.md` and current job/mission stop notes. Retired histories are uncommitted under `docs/seat-history/retired-20261019/`. Preserve original native conversations and handover gaps honestly.

Pocket-tank hard hold: Alan stopped CoreS3 touch work on 2026-10-14. It remains stopped. Do not restart CoreS3 touch, hardware, flashing, serial access, radio activity, publishing or pushes without Alan explicitly authorizing that specific work.
