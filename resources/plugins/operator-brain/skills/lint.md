---
name: lint
description: Audit the brain graph for hygiene problems — orphan nodes with no links, broken/dangling references, and stale nodes that were never resolved — and propose fixes. Use for a periodic health pass or when the user asks "is my brain tidy". Read-only and propose-only; it never edits without approval. Not for merging duplicates (use dedup) or adding relations (use relate).
autoInvoke: false
allowedTools:
  - Read
  - shell_command
---

# lint

The maintenance pass that keeps the graph trustworthy. As a brain grows, entropy creeps in: notes born
without links, references pointing at nodes that moved or merged, decisions left open forever. This skill
finds that decay and proposes fixes — it diagnoses, the user (or a sibling skill) repairs.

## When this skill activates

A periodic health pass; before a review; or on "is my brain tidy / clean up the graph".

## How it works (wired, read-only)

Read the graph and its recent changes and report problems — never write from this skill:
`GET http://127.0.0.1:8799/state/graph`, `/state/graph-diff`.

Check for:
- **Orphans** — nodes with zero links. A note that connects to nothing is unreachable by retrieval.
- **Broken references** — wikilinks / edges pointing at a node id that no longer exists.
- **Stale** — nodes/decisions/forecasts left unresolved long past their moment.
- **Contradiction pairs** — two nodes asserting opposite things with no `contradicts` edge between them.

## Output

A short prioritized list: problem, the node(s) involved, and the recommended fix — routed to the skill
that performs it (`relate` for orphans, `dedup` for duplicate-driven breakage, `resolve` for stale
forecasts). Cap the list; a health report is a shortlist, not a dump.

## Hard rules
- Read-only. Propose fixes; never mutate the graph from this skill.
- Every finding names the specific node(s) and the concrete fix — an unactionable "graph is messy" is useless.

## Hand-offs
- Fix an orphan by adding relations → **relate**.
- Fix duplicate-driven breakage → **dedup**.
- Close a stale forecast → **resolve**.
