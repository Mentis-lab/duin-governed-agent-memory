---
name: capture
description: After a turn where the user corrected, overrode, or explicitly endorsed your output, record it into DUIN's learn loop — with the reasoning (the WHY) that the automatic verdict path can't capture. Use whenever the user pushes back ("no, do it this way", "you missed X", "always/never…"), reverses a choice you made, or confirms a non-obvious call was right. Not for factual fixes with no reusable principle; not for one-off task tweaks.
autoInvoke: true
allowedTools:
  - Read
  - shell_command
---

# capture

Turn the moments where the user *corrects or validates* you into a compounding record of **how this
specific user judges** — so future outputs fit them better than a cold model would. DUIN already
auto-captures human promote/veto verdicts, but that path leaves the **`why` field empty by design**.
This skill's whole reason to exist is to fill that gap: capture the correction *with the reasoning*,
in the moment, while the user has just told you why. The `why` is the scarce, valuable part.

## When this skill activates

A turn qualifies when the user's message **reacts to something you just produced** with a reusable
judgment signal:
- **Correction** — overrides your choice, points out what you missed, states a rule ("no—lead with
  the risk", "you always over-hedge", "never send before I see it").
- **Validation** — confirms a non-obvious call was right ("yes, that framing was the move").

## Precision gate (do this FIRST — the load-bearing part)

Most turns in a running app are **not** user judgment. Before recording, discard the turn if it is:
1. **Machine-injected** — a system/hook/engine prompt, a connectivity or role-priming message, a
   scheduled-task prompt, or any turn the app generated and fed in as if from the user.
2. **Loop-admin** — meta-instructions about the session itself ("approve all but #3", "rest is fine").
3. **Not reacting to your output** — a fresh request with no preceding assistant turn to react to.
4. **A bare factual fix** with no transferable principle (wrong date → corrected date).

Only a turn that survives all four is a real judgment signal. Without this gate, the ledger fills with
the app's own plumbing instead of the user's mind — the single most common way a judgment loop rots.

## How to record it (wired to DUIN's learn loop)

POST the correction to the in-process brain — this is the same native capture arrow the app uses, so
it flows into `corrections.jsonl` and downstream into `reflect()` + taste, not a parallel store:

```
shell_command:
  curl -s -X POST http://127.0.0.1:8799/learn/correction \
    -H 'content-type: application/json' \
    -d '{
      "ts":"<YYYY-MM-DD>",
      "session":"<session id or empty>",
      "skill":"capture",
      "artifact":"<what you were producing, optional>",
      "ai_output":"<the output the user reacted to, one line>",
      "correction":"<the correction — fill for a pushback>",
      "why":"<THE REASONING — the point of this skill; never leave empty>",
      "candidate_rule":"<the transferable \"when X do Y\"; for an endorsement put the rule here>",
      "polarity":"correction"
    }'
```

Rules for the payload:
- **Never send a `source` field.** The route rejects machine-authored rows (400) — this stream is
  operator-only. Sending `source` will fail the write.
- **`polarity`**: `"correction"` when the user overrode/flagged you; `"positive"` when they endorsed a
  non-obvious call (put the confirmed rule in `candidate_rule`).
- **`why` is mandatory in spirit** — if you can't infer the reasoning, ask exactly one focused question
  to recover it before posting. A row with an empty `why` is the shallow-capture failure this skill
  exists to prevent.

## The gate stays downstream

You are only writing the capture arrow (the row lands `status: new`). Promotion to a binding rule is
NOT automatic: the brain's `reflect()` clusters recurring signals (≥3 similar) into *propose-only*
candidates that a human promotes in the Learning panel. So recording here is safe — it feeds signal
without changing behavior until the human gate approves.

## Cost discipline

Runs after ordinary turns — keep it near-free. Don't spend a model call to *detect* a signal; detect it
from the turn you already have. Only spend tokens once you've found a real signal worth recording, or
need the one clarifying `why` question.

## Hand-offs
- Applying accumulated taste to new work → **frame**.
- Checking whether accumulated judgment earns its place → **audit**.
