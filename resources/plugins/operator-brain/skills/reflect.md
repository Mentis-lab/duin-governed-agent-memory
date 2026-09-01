---
name: reflect
description: Consolidate the corrections the brain has captured into propose-only binding-rule candidates for the user to promote or veto. Use on request ("what has my brain learned", "run the learning review") or as a periodic pass when corrections accumulate. Not for capturing a fresh correction (use capture) or testing a rule's value (use audit).
autoInvoke: false
allowedTools:
  - Read
  - shell_command
---

# reflect

The promotion step of the learn loop. **capture** records corrections; this skill turns recurring ones
into candidate rules the user can promote — and it stays strictly propose-only, because promoting a
rule changes future behavior and that decision is the user's.

## When this skill activates

On request, or as a periodic pass once corrections have accumulated (the brain clusters at ≥3 similar).

## How it works (wired)

Trigger the brain's native reflection, which clusters recurring corrections into binding candidates:

```
shell_command: curl -s -X POST http://127.0.0.1:8799/learn/reflect
```

Then read the results (via the Learning surface, or `GET /learn/taste` for what's already shifted
behavior) and present each candidate as a one-line **promote / veto** item: the proposed rule, how many
corrections back it, and one example. The user's choice promotes it to a binding rule or drops it.

## Hard rules
- **Propose only.** Never promote a rule yourself — surface candidates for the human gate.
- A candidate with an empty `why` across all its backing rows is weak evidence — flag it as
  "preference without reasoning", the signal **capture** should tighten.
- Don't invent candidates the brain didn't cluster; reflect on real recurrence, not single events.

## Hand-offs
- Where the corrections come from → **capture**.
- Testing whether a promoted rule actually beats the cold model → **audit**.
