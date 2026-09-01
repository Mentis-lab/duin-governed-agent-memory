---
name: decide
description: Pressure-test a specific decision the user is weighing by simulating it against the brain's predicted risks and world-state, with a consistency check against what's already known. Use when the user is choosing between options or asks "should I…", "what happens if I…". Not for open-ended foresight across all threads (use forecast).
autoInvoke: false
allowedTools:
  - Read
  - shell_command
---

# decide

Turn a decision from a gut call into one checked against the user's own world-model. This simulates the
decision against predicted risks and current state, and flags where a choice contradicts something the
brain already holds — so the user decides with their accumulated context in view, not despite it.

## When this skill activates

The user is weighing a specific choice: between options, a go/no-go, "should I…", "what happens if I…".

## How it works (wired)

1. **Read the relevant state** — the decision's neighborhood and predicted risks:
   `GET http://127.0.0.1:8799/state/decision-connections` and the world-state / predicted-risk reads.
2. **Simulate the decision:**
   ```
   shell_command: curl -s -X POST http://127.0.0.1:8799/state/decision \
     -H 'content-type: application/json' -d '{"decision":"<the choice>","options":[...]}'
   ```
3. **Run the consistency gate** — surface any way the leading option contradicts a known fact,
   commitment, or prior decision. A contradiction is the highest-value output; don't smooth it over.

## Hard rules
- Ground every claim in world-state; don't manufacture risks the brain doesn't hold.
- Surface contradictions loudly — the point is to catch the decision that fights the user's own context.
- Recommend, don't execute — the user makes the call.

## Hand-offs
- Broad "what's converging" foresight → **forecast**.
- Recording the decision's outcome later → **resolve**.
