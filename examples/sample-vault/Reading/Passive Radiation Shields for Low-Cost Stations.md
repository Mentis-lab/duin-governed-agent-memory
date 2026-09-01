---
type: reading
created: 2026-05-27
tags: [reading, hardware, enclosure, sensors, resource]
source: open-access conference paper
---
# Reading: Passive Radiation Shields for Low-Cost Stations

**Source:** an open-access conference paper comparing passive radiation shield designs for low-cost temperature sensors, read by [[Jonas Wexley]] during the enclosure failure analysis · **Read:** 2026-05-27

## What it says
The authors built six shield geometries around the same sensor, mounted them side by side for a summer, and compared each against a reference in an aspirated shield. The findings that matter to Skyline:

- A single louvered shell, the rev 1 design, showed a midday solar bias of +2 to +3 °C in calm conditions. This matches the +2.5 °C measured at the May field test ([[2026-05-09-field-test-debrief]]).
- Stacked-plate designs with an air gap between plates and a white, matte top plate came in under +0.5 °C in the same conditions.
- The top plate does most of the work. Adding plates below the third brought little improvement; a double top plate with an air gap did.
- Bias scales with wind: below 1 m/s every passive design gets worse. The paper recommends reporting wind speed alongside temperature so users can judge the reading, which the [[Skyline Companion App]] already does.
- Material matters less than colour and gap. White ASA and white PETG performed alike; grey anything performed worse.

## What we took from it
- The stacked-plate geometry in [[2026-06-04-enclosure-redesign]] is lifted from the best-performing design here, and Jonas's July prototype measured +0.4 °C, in line with the paper.
- Two top plates, not one. Jonas added this to rev 2.
- The [[Solar Shroud Radiation Shield]] idea has to answer the paper's finding about the top plate before it goes anywhere.
- A frost prediction ([[Frost Alert for Orchards]]) happens at night with low wind, exactly where passive shields are most reliable, so the daytime bias matters less for that use than it first seemed.

## Doubts
Summer only, one climate, and no rain. Nothing here says how a stacked shield behaves when the plates are wet. The beta will.
