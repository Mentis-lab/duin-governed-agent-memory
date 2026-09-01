---
name: resolve
description: Close out past forecasts and surfaced insights by recording what actually happened, so the calibration ledger learns whether the brain's foresight is any good. Use when a predicted event's outcome is now known, on a periodic "score the open forecasts" pass, or when the user says a prediction did/didn't pan out. Not for making new forecasts (use forecast).
autoInvoke: false
allowedTools:
  - Read
  - shell_command
---

# resolve

A foresight engine only earns trust if its predictions get scored against reality. Today the ledger is
mostly empty — forecasts fire but almost none are ever resolved, so calibration can't happen. This skill
closes that loop: it records real outcomes on past forecasts/insights, which is the single most
load-bearing thing for the calibration litmus (is the foresight right often enough to beat a naive
baseline?).

## When this skill activates

An outcome is now known ("the venue did get confirmed", "that slip didn't happen"); a periodic pass over
open forecasts whose window has closed; or the user confirms/denies a prediction.

## How it works (wired)

Record the verdict against the specific forecast or insight:

```
shell_command: curl -s -X POST http://127.0.0.1:8799/state/forecast-verdict \
  -H 'content-type: application/json' -d '{"id":"<forecast id>","outcome":"hit|miss|partial","note":"<what happened>"}'
# for a surfaced insight instead of a forecast:
# curl -s -X POST http://127.0.0.1:8799/state/insight-verdict -H 'content-type: application/json' -d '{...}'
```

If unsure of the exact field names the deployment expects, read an open forecast first (the forecast/
state read routes) and mirror its id/shape rather than guessing.

## Hard rules
- Only resolve forecasts whose outcome is genuinely known — a guess pollutes calibration worse than an
  open forecast does.
- Record `partial`/`miss` honestly; a foresight engine that only logs its hits is calibration theater.
- Prefer resolving the *connective* forecasts (drivers, convergences) — near-noise reminders barely move
  calibration.

## Hand-offs
- Where forecasts are generated → **forecast**.
- The judgment analogue (scoring captured rules) → **audit**.
