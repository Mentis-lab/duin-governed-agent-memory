---
type: idea
created: 2026-07-18
tags: [idea, app, feature, orchard]
status: proposed
owner: Ines Halloran
---
# Frost Alert for Orchards

**Proposed by:** the Hollowmere orchard members, via [[Yumi Castellane]] at [[2026-07-16-beta-program-planning]] · **Champion:** [[Ines Halloran]] · **Status:** proposed, post-launch

## The idea
A Skyline station in an orchard predicts an overnight frost from its own readings (falling temperature, rising humidity, dropping wind) and sends a phone notification early enough for the grower to act. The orchard members currently set an alarm for 3 a.m. and go outside with a thermometer.

## Why it matters
It is the first feature request that came from a real use rather than from the team, and it is the reason the enclosure's temperature bias had to be fixed properly ([[2026-06-04-enclosure-redesign]]): a +2.5 °C error makes a frost prediction useless. A working frost alert would also give the [[Community Launch]] a story that is not about the hardware.

## What it needs
- Reliable sub-degree temperature readings from the rev 2 enclosure
- Enough field data to fit a simple prediction rule; [[Rafael Nkemdi]] thinks a few weeks of overnight curves from the beta will do
- A notification path from the Bridge to the phone that works when the app is closed, which the [[Skyline Companion App]] does not have yet
- A clear statement that this is an aid, not a guarantee

## Open questions
- Rule-based or learned? Rafael wants a rule first, with the data to check it.
- Does the Bridge need a small local model, or is a threshold on the trend enough?
- Who owns the false-negative conversation with a grower who lost a crop?

## Next step
Nothing until the beta produces overnight data. Ines will pull the first four weeks of orchard readings in November and sketch the rule with Rafael. Related: [[Citizen Weather Network Data Quality]] on what station data can and cannot support, and the point there that siting in the orchard matters more than the algorithm.
