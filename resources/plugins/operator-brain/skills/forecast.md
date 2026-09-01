---
name: forecast
description: From the brain's world-state, surface how the user's live threads are converging — what future drivers and milestones tie them together, and what present move that implies. Use when the user asks "what's coming", "what should I be getting ahead of", or after a batch of world-state updates. Leads with convergence, not just risk. Not for scoring past forecasts (use resolve).
autoInvoke: false
allowedTools:
  - Read
  - shell_command
---

# forecast

DUIN's north star is a **convergence engine**, not a risk alarm: surface how future threads connect and
converge, and let each present decision be instructed by that. Risk (what will slip) is a byproduct, not
the point.

## When this skill activates

The user asks what's coming / what to get ahead of; or after world-state has changed enough to re-read
the near future.

## How it works (wired)

Generate forecasts from the current world-model:

```
shell_command: curl -s -X POST http://127.0.0.1:8799/state/forecast
```

Then present them **leading with the generative kinds**:
- **driver** — a common cause tying several streams together.
- **convergence** — threads converging on a milestone.
These are *connections*, framed as "these futures converge toward X → so the present move is Y." Only
after them, and secondarily, the defensive kinds (**cascade**, and the demoted decision-window
reminders).

## Hard rules
- A forecast must **instruct a present decision**, not just flag a danger. If it doesn't change what to
  do now, it's noise.
- Lead with driver/convergence; don't bury the connective read under deadline warnings.
- Every forecast is a claim that will later be scored — phrase it falsifiably so **resolve** can close it.

## Hand-offs
- Scoring these forecasts once outcomes are known → **resolve**.
- Pressure-testing one specific decision → **decide**.
