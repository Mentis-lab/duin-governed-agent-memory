---
name: surface
description: Proactively find non-obvious cross-domain links between things the brain holds, and rank what deserves the user's attention right now. Use when building a digest/home view, after a batch of new material lands, or when the user asks "what should I be looking at". Not for on-demand search of a known topic (that's ordinary retrieval).
autoInvoke: false
allowedTools:
  - Read
  - shell_command
---

# surface

A second brain that only answers what you ask is a filing cabinet. The value a person can't get by
searching is (1) **bridges** — links between things they didn't know were related — and (2) **salience**
— a ranked "look at this now" instead of an undifferentiated pile. Neither is something the user can
request by name, because they don't yet know it's there.

## When this skill activates

Building a digest or home view; after a batch of new notes/channel items lands; or on "what should I be
looking at", "what's connected", "anything I'm missing".

## Read the brain's state (wired)

Pull what the brain already holds — the graph and its cross-links — read-only:
`GET http://127.0.0.1:8799/state/graph`, `/state/decision-connections`, `/state/outputs`. Rank over
those; never write from this skill.

## Part 1 — Bridge discovery (serendipity)

Scan across *different* domains/clusters for latent connections:
- A person who appears in two unrelated threads.
- A driver — one underlying cause tying separate streams together.
- A note that would answer an open question filed elsewhere.
- Two items converging on the same milestone from different directions.

Surface each as a one-line "X relates to Y because Z". Prefer cross-domain links (within-cluster links are
usually already obvious). A handful of real bridges beats a wall of weak ones.

## Part 2 — Salience ranking (what now)

Rank candidate items by a simple, legible score — **base importance × affinity × recency-decay**:
- **Base** — intrinsic weight (an owed decision with a near deadline outranks an idle note).
- **Affinity** — how much this user has historically engaged with this kind of item (reuse whatever
  engagement signal the brain records; don't invent a new one).
- **Decay** — older, un-acted items fade unless something re-activates them.

Return a short ranked list, each with a one-line reason it's surfacing *now*. Legibility matters more than
a clever score — the user should see *why* something rose.

## Hard rules
- Cap the output — a digest is a shortlist, not an inbox. Ten strong items beat fifty.
- Every surfaced item carries its reason; an unexplained rank reads as noise.
- Surface, don't act — this skill proposes attention, it doesn't take actions on the items.

## Hand-offs
- Comprehending the raw channel items this ranks → **comprehend**.
- Filing/merging a new thought before it can be bridged → **distill**.
