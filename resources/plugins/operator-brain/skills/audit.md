---
name: audit
description: Periodically test whether the user's accumulated judgment actually changes outputs versus a cold model — keep what adds value, flag what a strong model now supplies for free. Use on request ("audit my judgment", "is my brain learning anything real") or when corrections accumulate. Not an every-turn skill.
autoInvoke: false
allowedTools:
  - Read
  - shell_command
---

# audit

The honesty gate for the whole loop. A learn loop only has value if it makes outputs *better than the
model would be without it*. DUIN's built-in `reflect()` already clusters recurring corrections (≥3
similar) into propose-only binding candidates — this skill adds the stronger test it doesn't run:
does a captured signal actually change an output? Without it you get "novelty without value": a growing
ledger a capable model would have produced anyway. This scoreboard is the product's truth-teller.

## When this skill activates

On explicit request, or as a periodic pass when corrections have grown (e.g. every ~10 new rows). Not
on ordinary turns — this is a batch audit.

## Read the real ledger

The learn stream lives at `.duin/_state/corrections.jsonl` (the notes/vault dir DUIN is configured
with); computed taste is at `GET http://127.0.0.1:8799/learn/taste`. Audit the rows with a non-empty
`why`/`candidate_rule` first — an empty-`why` row carries no reasoning to test and is itself a
capture-quality flag.

## The flip test (the core method)

For each candidate rule (from a correction's `candidate_rule`, or a taste entry), replay a held-out
situation it claims to cover and compare two outputs:
- **Arm A (with judgment)** — produce with the rule's *intent* injected as framing. Never inject the
  `candidate_rule` text verbatim — that tests instruction-following, not judgment.
- **Arm B (naked)** — produce the same thing with no judgment injected.

Grade both against the user's own recorded `correction`/`why` (the gold). The verdict:
- **flip = Arm B fails AND Arm A passes** → the judgment *added value on a call the cold model got
  wrong*. Mark **KEEP**.
- **no flip over repeated probes** → the base model already supplies this for free. Mark
  **PRUNE-CANDIDATE**.

Skip rules already enforced by a deterministic gate elsewhere — they don't need to earn their place
through the model.

## What to do with verdicts

- **KEEP**: report as the user's real edge; these are what **frame** should lean on hardest.
- **PRUNE-CANDIDATE**: surface in a batched list for the user to confirm archiving. Never auto-delete
  — the user may keep one for reasons the test can't see, and pruning the learn stream is destructive.
  Archive/annotate, don't erase.

## Output

A short scoreboard: how many rules KEEP vs PRUNE-CANDIDATE, how many rows had an empty `why` (a capture
gap), and the single most valuable KEEP (the clearest example of the brain modeling this user). If
almost nothing flips, the loop is capturing noise and **capture** needs tightening, not more volume.

## Hand-offs
- Where the rows come from → **capture**.
- Where KEEP rules get used → **frame**.
