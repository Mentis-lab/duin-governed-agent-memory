---
type: idea
created: 2026-06-25
tags: [idea, community, data, privacy]
status: proposed
owner: Anouk Ferreira
---
# Community Data Commons

**Proposed by:** [[Anouk Ferreira]] · **Status:** proposed, needs a privacy model before any code · Updated 2026-07-17 after the beta planning session

## The idea
An opt-in map where Skyline owners can share their station's readings with the community: a public layer of hyper-local weather built by the people who own the stations. The studio would host the aggregation, publish the data under an open license, and never require it.

## Why it matters
Three hundred Brightwater members within a few kilometres of each other would produce a denser weather picture than any official network in the area. It would also give outside contributors a reason to care about the project beyond their own roof, which the [[Community Launch]] needs.

## Constraints already agreed
- **Opt-in only.** [[Yumi Castellane]] asked for this at [[2026-07-16-beta-program-planning]] and Anouk agreed on the spot.
- **Local-first stays.** The [[Skyline Companion App]] rule of no accounts and no cloud does not change; sharing is a separate, explicit action on the Bridge.
- **Location fuzzing.** Stations report a coarse grid cell, not a coordinate. Ines wants this written down before design starts.
- **Metadata and quality flags travel with the readings**, per [[Citizen Weather Network Data Quality]].

## Open questions
- Who pays for hosting once tranche 2 is spent? A commons needs a steward.
- Data license: attribution-only, or share-alike to match the documentation license from [[2026-03-19-open-source-license]]?
- Does a station that shares also receive the neighbourhood picture in its own app? Ines thinks that is the incentive that makes opt-in work.
- What does "delete my data" mean for an aggregate that has already been published?

## What [[Tessa Varga]] said
Not before launch, and not without a privacy page she would be comfortable reading aloud to a Brightwater member. She is otherwise in favour.

## Next step
Anouk drafts a one-page privacy model in October. No engineering time before 2027.
