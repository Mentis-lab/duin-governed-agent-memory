---
name: dedup
description: Find nodes in the brain graph that are really the same thing (a person, project, or concept recorded twice under different names) and merge them, preserving every link and source. Use when the graph feels cluttered, after bulk ingestion, or when the user spots a duplicate. Not for linking two genuinely-different related nodes (use relate).
autoInvoke: false
allowedTools:
  - Read
  - shell_command
---

# dedup

Duplicates are the slow poison of a knowledge graph: the same person under two spellings, one project
recorded twice, a concept split across near-identical nodes. Each duplicate fractures the graph —
retrieval misses half the context, foresight reasons over a partial picture. This skill consolidates
them without losing anything.

## When this skill activates

The graph feels cluttered; after bulk ingestion or channel comprehension; the user points at a duplicate.

## How it works (wired)

1. **Read the graph** — `GET http://127.0.0.1:8799/state/graph`.
2. **Find candidates** — nodes with near-identical labels, same entity under name variants (CJK/latin,
   nickname/full name, acronym/expansion), or concept nodes with heavy link overlap.
3. **Propose merges** — for each candidate pair, show both nodes, why they look like one, and which is the
   survivor. **Merging is destructive of node identity — get user confirmation** unless the match is
   exact-and-obvious.
4. **Merge, preserving everything** — repoint all edges and sources to the survivor (via the node
   resolution route, e.g. `POST /state/resolve-node`); never drop a link or a citation in the merge.

## Hard rules
- Confirm before merging anything non-obvious — a wrong merge is hard to unwind.
- Preserve every inbound/outbound edge and source on the survivor.
- Same-sounding is not same-thing — two people with one nickname must NOT be merged; flag, don't merge.

## Hand-offs
- Relating two genuinely-distinct nodes → **relate**.
- General graph hygiene (orphans, broken links) → **lint**.
