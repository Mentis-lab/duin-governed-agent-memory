---
name: relate
description: Map typed relations between existing nodes in the brain graph — causal, depends-on, part-of, embodies, contradicts — so knowledge is connected, not just stored. Use after new nodes land, when the user asks "how does X relate to Y", or to strengthen a sparse area of the graph. Not for finding surprising cross-domain links to surface (use surface) or merging duplicate nodes (use dedup).
autoInvoke: false
allowedTools:
  - Read
  - shell_command
---

# relate

A graph of unconnected nodes is a list. Value comes from **typed relations** — knowing that A *causes* B,
that C *depends on* D, that E *contradicts* F. This skill establishes those edges between nodes that
already exist, turning a pile into a reasoning surface the foresight and decision skills can traverse.

## When this skill activates

After new nodes are created; when the user asks how two things relate; or to strengthen a sparse cluster.

## How it works (wired)

1. **Read the graph** — `GET http://127.0.0.1:8799/state/graph` (and `/state/resolve` to pin node ids).
2. **Propose typed edges** between related nodes — each with a relation type and a one-line justification:
   - `causal` (A → B), `depends-on`, `part-of`, `embodies` (framework → value), `contradicts`, `informs`.
3. **Tag provenance** — mark whether the relation is stated in a source (**extracted**), a reasonable
   inference (**inferred**), or a guess to confirm (**ambiguous**). Never present an inference as fact.
4. **Persist** via the node/relation write route (e.g. `POST /state/resolve-node`), or surface for
   confirmation when the relation is `ambiguous`.

## Hard rules
- Only relate nodes that exist — don't invent a node to hang an edge on (that's **distill**'s job first).
- Every edge carries a type and a provenance tag; an untyped "related to" edge is noise.
- A `contradicts` edge is high-value — surface it rather than quietly picking a side.

## Hand-offs
- Creating the nodes to relate → **distill**.
- Merging two nodes that are actually the same thing → **dedup**.
- Finding non-obvious cross-domain links to surface → **surface**.
