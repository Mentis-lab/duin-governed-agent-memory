---
type: decision
created: 2026-05-14
tags: [decision, hardware, lora, radio, firmware]
status: accepted
owner: Rafael Nkemdi
---
# Decision: switch the station radio from Wi-Fi to LoRa

**Date:** 2026-05-14 · **Decided by:** [[Tessa Varga]], [[Rafael Nkemdi]], [[Ines Halloran]] · **Status:** accepted

## Context
The rev B stations used the microcontroller's Wi-Fi to push readings to the app. The May field test ([[2026-05-09-field-test-debrief]]) showed two failures. Range: the rooftop station lost Wi-Fi at 40 m, and the Hollowmere orchard station, 180 m from the nearest access point, never connected. Power: the rooftop station ran its cell flat in 3 days of overcast against a 14-day target, with the Wi-Fi radio responsible for most of the draw. Rafael's follow-up test on 2026-05-13 ran a LoRa point-to-point link across 1.2 km at Hollowmere with line of sight, and measured the radio at roughly one thirtieth of the Wi-Fi average power at the same 15-minute interval. See [[LoRa Link Budget Primer]].

## Options
1. **Keep Wi-Fi, add a bigger cell and recommend a range extender.** No new hardware design. Does not fix the orchard case and shifts cost to the owner.
2. **LoRa point-to-point to a Bridge.** Station talks to a small indoor base station, which joins the home network. Solves range and power. Adds a second device and a pairing step.
3. **LoRaWAN on a public network.** No Bridge, but coverage is patchy and it adds a dependency on a network the studio does not control.
4. **Cellular.** Solves range, kills the power budget and adds a subscription.

## Decision
Option 2. The station uses a LoRa radio module, point-to-point, to a Bridge built on a Pico W. Rev C adds the module and antenna, in 868 and 915 MHz variants to cover both common bands.

## Disagreement
Ines argued for option 1: the Bridge makes the app harder to explain and adds a pairing flow. Rafael had the field data and Tessa backed it. Ines accepted the decision in the meeting and rewrote the pairing flow. Her concern was right in its own terms: two of the three beta bugs were in pairing.

## Consequences
- Five weeks of firmware rework by Rafael (delivered 2026-06-19).
- Rev C delayed about three weeks; the Bridge became part of the kit; BOM up by $24.
- The enclosure needs an antenna position, folded into [[2026-06-04-enclosure-redesign]].
- The LoRa module later became the supply problem in [[2026-08-06-supplier-delay-escalation]]. The decision still stands.
