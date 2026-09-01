---
type: meeting
created: 2026-08-06
tags: [meeting, supplier, risk, hardware]
attendees: [Tessa Varga, Rafael Nkemdi, Anouk Ferreira, Halvard Brenna]
---
# Supplier delay escalation — 2026-08-06

**Attendees:** [[Tessa Varga]], [[Rafael Nkemdi]], [[Anouk Ferreira]], [[Halvard Brenna]] (Greyfell Assembly, first half only)
**Purpose:** understand the rev C board delay and decide what to do about the launch date.

## Summary
Halvard's 2026-07-28 email moved delivery of the remaining 55 rev C boards from 2026-07-30 to 2026-09-05 because the LoRa radio module went on allocation. In this meeting he moved it again, to **2026-09-19**, with the module now costing $12 more per board. The pilot run of five boards exists and works; the other 55 are waiting on 55 modules. The original launch date of 2026-09-24 is no longer possible. A launch date decision is scheduled for 2026-08-13.

## What Halvard said
- His distributor has 20 modules promised for 2026-09-08 and 35 more "in the following two weeks", which he does not fully trust.
- He can build all 55 boards without modules now and hand-place modules later if Kestrel finds them elsewhere.
- He offered a 5% discount on the next batch and weekly stock updates every Friday.

## Options discussed (after Halvard left)
1. Wait for Greyfell, launch mid-October. Lowest effort, highest exposure to a third slip.
2. Second-source the module. Tessa has two candidate suppliers; Rafael needs to check whether either needs driver changes.
3. Ship the beta in two waves: 20 kits with the first modules, 20 later. Yumi would accept this; Anouk thinks it doubles the onboarding work.
4. Rev C without LoRa, back to Wi-Fi for the beta. Rejected in the room; it undoes [[2026-05-14-switch-to-lora]] for a supply problem.

## Decisions taken here
- Launch date decision deferred to 2026-08-13 with three concrete options from Anouk ([[2026-08-13-move-launch-to-october]])
- Pursue second sourcing in parallel, not instead

## Action items
- [ ] Tessa — alternate LoRa module source, samples in hand, by 2026-09-05
- [ ] Rafael — driver impact assessment for both candidate modules, by 2026-09-08
- [ ] Anouk — three launch-date options with consequences, by 2026-08-12
- [ ] Tessa — warn [[Corinne Abelard]] this week that the date is moving
- [ ] Halvard — firm delivery date confirmation by 2026-09-08

Budget impact: the module price increase plus a broker fee for second-sourcing adds about $2,200 to the v1 plan. See [[2026-W30]] and [[Community Launch]].
