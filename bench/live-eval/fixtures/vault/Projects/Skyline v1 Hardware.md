---
type: project
created: 2026-03-12
tags: [project, hardware, skyline]
status: active
owner: Tessa Varga
risk: amber
---
# Skyline v1 Hardware

**Owner:** [[Tessa Varga]] · **Firmware:** [[Rafael Nkemdi]] · **Enclosure:** [[Jonas Wexley]] · **Status:** rev C boards on order, enclosure rev 2 in progress.

Skyline v1 is an open-source weather station kit: a sensor mast (temperature, humidity, pressure, tipping-bucket rain gauge, cup anemometer and wind vane), a custom main board, a solar panel with a single lithium cell, and a LoRa link to a small base station we call the Bridge. The Bridge sits indoors, receives readings every 15 minutes, and serves the [[Skyline Companion App]] over the local network. No cloud account is needed.

## Where we are
- **Main board.** Rev A (April) proved the sensor chain. Rev B (May) went to the field test with Wi-Fi and failed on range and power, see [[2026-05-09-field-test-debrief]]. Rev C adds the LoRa radio per [[2026-05-14-switch-to-lora]]. Gerbers went to Greyfell Assembly on 2026-06-23 after a DFM fix on the antenna connector footprint ([[2026-06-18-greyfell-production-review]]).
- **Rev C delivery.** Originally 2026-07-30. A pilot run of five boards arrived 2026-07-22 and works. [[Halvard Brenna]] reported a LoRa module shortage on 2026-07-28; the remaining 55 boards moved to 2026-09-05, then to 2026-09-19 ([[2026-08-06-supplier-delay-escalation]]). This is the single biggest risk to the [[Community Launch]].
- **Enclosure.** The printed PLA housing failed in the field (water ingress at the cable gland, +2.5 °C solar bias). [[2026-06-04-enclosure-redesign]] made Jonas the owner of rev 2: ASA two-part body, stacked-plate radiation shield, molded gland. Due 2026-08-29, slipped to 2026-09-12.
- **Power.** Target is 14 days of autonomy without sun. Rev B managed 3 days on Wi-Fi. Rafael's LoRa bench numbers project 19 days; unconfirmed until the full rev C batch arrives.
- **Bridge.** A Raspberry Pi Pico W on a small carrier board, deliberately not a custom design ([[2026-04-09-custom-main-board]]).

## Bill of materials
Kit BOM is $162 including the Bridge, up from $138 before the LoRa change. The August module price increase adds another $12 per board that is not yet in this number. Target retail is $249 for the full kit, see [[Kit Tiers]].

## Next
- 2026-09-03 — enclosure rev 2 water test (Jonas)
- 2026-09-12 — enclosure rev 2 prints in hand (Jonas)
- 2026-09-19 — remaining rev C boards arrive (Halvard)
- 2026-09-26 — 40 kits assembled and tested (Tessa, Rafael)
- 2026-09-30 — kits handed to [[Yumi Castellane]] for the beta
