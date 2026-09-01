---
type: decision
created: 2026-06-04
tags: [decision, hardware, enclosure, mechanical]
status: accepted
owner: Jonas Wexley
---
# Decision: redesign the enclosure, owner Jonas Wexley

**Date:** 2026-06-04 · **Decided by:** [[Tessa Varga]], [[Jonas Wexley]], [[Rafael Nkemdi]] · **Status:** accepted · **Owner:** [[Jonas Wexley]]

## Context
The rev 1 housing was a single-piece FDM print in PLA with a flat lid and a simple louvered shield. Jonas's failure analysis after the May field test ([[2026-05-09-field-test-debrief]]) found three faults: water ingress at the cable gland after two days of rain, lid warping in sun, and a +2.5 °C temperature bias in direct sun because the louvers let radiated heat reach the sensor. The [[2026-05-14-switch-to-lora]] decision also added an antenna that the housing has no position for.

## Options
1. **Patch rev 1.** Better gland, thicker lid, more louvers. Cheap, but Jonas expects the bias to stay above 1.5 °C and PLA to keep warping.
2. **Two-part ASA body with a stacked-plate radiation shield and a molded gland.** ASA survives UV; the stacked plates copy the geometry that [[Passive Radiation Shields for Low-Cost Stations]] reports as best among passive designs; the molded gland is an off-the-shelf part.
3. **Injection-molded housing.** Best result, but tooling alone would consume most of the remaining v1 budget for a 40-kit run.

## Decision
Option 2. **Jonas Wexley owns the redesign end to end:** geometry, print settings, antenna position, water testing, and the print files that ship in the repository. Target: rev 2 prints in hand by 2026-08-29.

## Rationale
Option 1 leaves the temperature reading unfit for the [[Frost Alert for Orchards]] use case, where a degree matters. Option 3 does not fit the budget or a 40-kit batch. Option 2 is printable by members with their own printers, which supports the board-only tier in [[Kit Tiers]].

## Consequences
- Jonas's contract hours become the constraint; he works two days a week for Kestrel.
- The assembly guide cannot be finished until rev 2 exists to photograph ([[Anouk Ferreira]]).
- Enclosure reprints added about $2,000 to the v1 budget.
- The 2026-08-29 date was missed after ASA prints delaminated at the gland boss; new date 2026-09-12, water test 2026-09-03 ([[2026-08-27-launch-readiness-review]]).
