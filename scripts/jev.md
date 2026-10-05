# Jev routing config

`jev route "TASK"` asks Jev for a model and effort, then reports a dispatch seat.
It only reads seats with `rig whoami`, `rig ps` and `rig capture`; it never starts,
stops or types into one. `route --help`, `decide --help` and `-h` exit without
calling Jev or writing a record.

Config is `$OPENRIG_HOME/jev/config.json` (normally `~/.openrig/jev/config.json`).
Missing top-level keys use `jev.defaults.json`. The existing top-level `seats`,
`default_seat` and `candidates` remain supported unchanged. Add a `rigs` map for
additional rigs:

```json
{
  "rigs": {
    "plugin-build": {
      "seats": {
        "opus": "dev-builder@plugin-build",
        "sonnet": "dev-sonnet@plugin-build",
        "codex": "dev-codex@plugin-build"
      },
      "default_seat": "dev-builder@plugin-build"
    },
    "theme-build": {
      "seats": {
        "opus": "dev-builder@theme-build",
        "fable": "dev-fable@theme-build",
        "qwen": "dev-qwen@theme-build"
      },
      "default_seat": "dev-builder@theme-build",
      "candidates": {
        "opus": {
          "runtime": "claude-code",
          "description": "Scenes, renders and palette work."
        },
        "fable": {
          "runtime": "claude-code",
          "description": "Claude Fable 5.1: hardest scenes and visual design."
        },
        "qwen": {
          "runtime": "pi",
          "description": "Text-only chores; cannot look at images."
        }
      }
    }
  }
}
```

Each rig supplies its complete seat map and a default seat present in that map.
All its seat addresses must name that rig. Its optional candidates replace the
shared candidates; omitting them inherits the shared candidates. Routing only
offers models with a seat in the selected rig, including stopped bench seats.
Fable uses the candidate key `fable` and runtime `claude-code`; it is not added to
the shipped candidates automatically.

Rig selection is `--rig NAME`, then `rig whoami --json`'s `identity.rigName`, then
`OPENRIG_SESSION_NAME`'s rig suffix if identity is unavailable. The identity read
has a 1.5-second timeout. Without any identity or override, routing uses the
legacy top-level map. An identified rig without a profile can use the legacy map
only if its default seat names that rig. Otherwise Jev reports missing config
and exits 2 before asking for a model or recording a decision.

`seat`, `model` and `effort` still describe the recommended dispatch, with
`fallback` and `reason` explaining a fallback. JSON also includes `rig`,
`fallback_seat`, `picked_seat`, `picked_model` and `picked_running` (true, false,
or null when not checked). A stopped pick is retained in those fields and in
text output, while dispatch falls back as before. Low-confidence picks are
reported but not checked for running state.

`jev status [--rig NAME]` shows the selected rig. New decisions and routes record
it; `jev log` shows it for each route (older text entries derive it from the seat
address). `decide [--rig NAME]` uses that rig's candidates but still returns a
model and effort rather than a seat. Legacy `decide` keeps its shared candidates.

Run the isolated tests with Node 24:

```sh
mise exec node@24 -- node --test scripts/jev.test.mjs scripts/jev-route.test.mjs
```

Tests stub both Jev and `rig`. `fixtures/jev-legacy-config.json` is an unchanged
copy of the openrig-build config from 2026-10-05 (no secrets); its test redirects
HTTP in the test process, preserving the config bytes. `JEV_TEST_SCRIPT` can
point that test at a baseline script beside its baseline `jev.defaults.json`.
