---
name: consolidate
description: Collapse a sprawling cluster of related notes into one canonical higher-order synthesis node, linked back to its sources — so a growing brain stays navigable instead of fragmenting into dozens of near-duplicate fragments. Use for "summarize everything on X into one note", periodic synthesis of a busy topic, or when a subject has scattered across many small notes. Not for answering a one-off question (use recall) or merging two identical nodes (use dedup).
autoInvoke: false
allowedTools:
  - Read
  - Write
  - shell_command
---

# consolidate

The failure mode of a *large* second brain isn't missing notes — it's fragmentation: a topic smeared
across twenty small notes captured over months, none of which is the canonical view. This skill
synthesizes the cluster into one higher-order node that *is* the current understanding, with the
fragments preserved as its sources. It's how a brain scales without becoming an unnavigable pile.

## When this skill activates

A subject has scattered across many related notes; "pull everything on X into one note"; a periodic
synthesis pass over a busy topic; or `surface`/`lint` flags a dense low-signal cluster.

## How it works (wired)

1. **Gather the cluster** — pull the related notes/nodes (`GET http://127.0.0.1:8799/state/graph`,
   `/state/resolve`). Confirm they're genuinely one topic, not several that merely co-occur.
2. **Synthesize** — write a canonical summary node capturing the *current* understanding: the through-
   line, the settled points, and the open questions. Keep the operator's voice; synthesize, don't
   flatten to generic prose.
3. **Persist + link back** — save the synthesis (`POST /state/doc/save`) and link it to every source
   fragment (via **relate**) so the summary is traceable, never a black box.
4. **Retire the subsumed** — fragments fully captured by the synthesis can go to **archive** (linked,
   reversible); fragments with unique detail stay live, linked to the summary.

## Hard rules
- The synthesis **links to its sources** — a summary you can't trace back is untrustworthy in a brain.
- Don't destroy source detail: archive-and-link the subsumed, never delete; keep anything with unique
  content live.
- Surface contradictions *within* the cluster in the synthesis rather than silently picking a side —
  an unresolved tension is information the operator needs.
- One synthesis per genuine topic; don't merge distinct topics that merely share vocabulary.

## Hand-offs
- Answering a specific question from the brain → **recall**.
- Merging two nodes that are literally the same thing → **dedup**.
- Retiring the fragments the synthesis subsumes → **archive**.
