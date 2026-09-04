---
type: person
created: 2026-03-12
tags: [person, team, firmware]
role: Firmware engineer
org: Kestrel Labs
---
# Rafael Nkemdi

Firmware engineer. Rafael writes everything that runs on the Skyline main board and on the Bridge: sensor drivers, the power manager, the LoRa link, and the packet format the [[Skyline Companion App]] consumes.

## Owns
- Station and Bridge firmware in [[Skyline v1 Hardware]]
- The readings packet format (frozen 2026-05-01, revised for LoRa on 2026-06-10, now 18 bytes)
- Power budget measurements; his bench numbers project 19 days of autonomy on rev C

## Track record this year
- Ran the range and power tests at the May field test and the LoRa range test of 2026-05-13, and wrote up the numbers that drove [[2026-05-14-switch-to-lora]]. He had the data, and the data won.
- Delivered the LoRa firmware rework in five weeks as promised, finishing 2026-06-19 on a rev B board with a bodge-wired radio.
- Brought up the five pilot rev C boards in two days after they arrived on 2026-07-22.
- Has the daylight-saving timestamp fix (beta bug 3) in test, due 2026-09-10.

## Current commitments
- Assess whether either alternate LoRa module Tessa is sourcing needs driver changes, by 2026-09-08
- Pre-build masts and sensor harnesses from 2026-09-08 so assembly can start the day boards land
- Assemble and test 40 kits with [[Tessa Varga]], 2026-09-19 to 2026-09-26

## Ideas he is carrying
- [[Firmware Updates over LoRa]], his own proposal, which he then argued should wait until after launch
- The prediction rule for [[Frost Alert for Orchards]]

## Working notes
Rafael is cautious in meetings and precise in writing. He does not commit to a date until he has measured something. When he says five weeks he means five weeks, which is why [[Ines Halloran]] trusts his estimates more than anyone else's. He is also the only person who can touch the radio code, which [[2026-W20]] flagged as a risk that has not gone away. Reference reading he recommends: [[LoRa Link Budget Primer]].
