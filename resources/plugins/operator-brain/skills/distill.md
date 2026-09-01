---
name: distill
description: When the user dumps a thought, note, or brain-dump, reconcile it against what the brain already holds BEFORE creating anything new — merge into existing threads, surface contradictions, and only then create. Use for freeform notes, ideas, meeting takeaways, "remember this". Not for vetting external sources (use source-triage) or for capturing the user's judgment about your output (use capture).
autoInvoke: true
allowedTools:
  - Read
  - Write
  - shell_command
---

# distill

The default failure of a second brain is a pile of duplicate orphan notes: every dump becomes a new
node, nothing connects, and retrieval degrades as the vault grows. This skill inverts that — it
**reconciles before it creates.**

## When this skill activates

The user hands you an unstructured thought: a note, an idea, a takeaway, "jot this down", "remember
this", a paste of their own writing (not an external article).

## How it works (wired to DUIN's brain)

1. **Retrieve first** — search the brain for existing content on the same subject before writing
   anything (the app's retrieval, or read world-state via `GET http://127.0.0.1:8799/state/graph` and
   `/state/resolve`). Pull the closest existing notes/threads/nodes. A genuinely new note is persisted
   through the notes surface (e.g. `POST /state/doc/save`), linked to the nearest node.
2. **Reconcile against what exists:**
   - **Extends an existing thread?** → append/merge into it; don't spawn a duplicate.
   - **Contradicts something already stored?** → surface the contradiction explicitly and ask which holds
     (or record both as `contested`). Silent overwrite loses the user's earlier reasoning.
   - **Genuinely new?** → only now create a new note, and link it to the nearest existing nodes so it
     isn't born an orphan.
3. **Preserve provenance** — record where the dump came from and when, so a later reader can trace it.
4. **Keep the user's voice** — distill for structure, don't rewrite their meaning into model-speak.

## Hard rules
- Never create a new node before checking for an existing home for the content.
- Never resolve a contradiction silently — the contradiction is information.
- A new note always leaves with at least one link; orphans are a lint failure, not a valid state.

## Hand-offs
- Vetting/ingesting an external source → **source-triage** (research pack).
- Finding non-obvious cross-domain links after distilling → **surface**.
