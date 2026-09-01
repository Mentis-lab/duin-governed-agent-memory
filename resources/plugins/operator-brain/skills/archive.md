---
name: archive
description: Retire stale, dead, or superseded notes to a reversible archived state so they stop cluttering retrieval and the graph — without losing them. Use for "clean up old notes", "archive this", closed projects, resolved forecasts, or acting on lint's stale/orphan findings. Never deletes. Not for merging duplicates (use dedup) or diagnosing decay (use lint).
autoInvoke: false
allowedTools:
  - Read
  - shell_command
---

# archive

The actor half of graph hygiene: `lint` finds decay, this retires it. Deleting knowledge is dangerous —
it destroys signal you can't recover or audit — so this skill only ever does the reversible thing:
**mark a note archived, never delete it.**

## When this skill activates

"Clean up / archive old notes"; a closed project, resolved forecast, or superseded note; or acting on
`lint`'s stale/orphan report.

## How it works (wired to what exists today)

1. **Identify candidates** — from `lint`'s findings or `GET http://127.0.0.1:8799/state/graph`
   (`/state/graph-diff` for what's gone quiet): stale nodes, closed decisions, resolved forecasts,
   fully-superseded notes.
2. **Mark archived (reversible)** — read the note (`GET /state/doc?path=…`), add
   `archived: true` + `archived-on: <date>` to its frontmatter, and write it back via
   `POST /state/doc/save` (`{path, content}`). Un-archiving is the same write with the flag removed.
3. **Report** — a short list of what was archived and why.

## Route status — a known gap, stated plainly

The brain has **no archive/delete/status route** today (verified against the live `:8799` server). So:
- The frontmatter mark above is a **forward-compatible marker**: it records intent and is reversible,
  but the brain does **not yet exclude** `archived` notes from retrieval or the graph. Full soft-archive
  (drop from live views, keep recoverable) needs a small brain capability — a route or a retrieval
  filter that honors the `archived` flag. **Propose that; don't pretend it's already happening.**
- There is **no delete route**, by design and by absence. This skill therefore *cannot* hard-delete —
  which is the correct behavior anyway. If a note is true junk, say so and leave the call to the user.

## Hard rules
- Reversible only. Mark, never delete; there is no undo for deletion and no route for it.
- **Never archive a node still referenced by active work** — check inbound edges first; retiring a live
  dependency breaks foresight and decisions downstream.
- Be explicit that an archived note is still retrievable until the brain honors the flag — don't imply
  it's hidden when it isn't yet.

## Hand-offs
- Diagnosing what's stale/orphaned → **lint**.
- Merging two nodes that are the same thing → **dedup**.
- Updating a note whose facts changed (rather than retiring it) → **revise**.
