---
type: idea
created: 2026-06-19
tags: [idea, firmware, lora, maintenance]
status: deferred
owner: Rafael Nkemdi
---
# Firmware Updates over LoRa

**Proposed by:** [[Rafael Nkemdi]] on 2026-06-18, after the Greyfell review · **Status:** deferred to after launch, by Rafael's own recommendation

## The idea
Let the Bridge push a firmware update to the station over the LoRa link, so an owner never has to climb to the mast, unscrew the enclosure and plug in a cable. After [[2026-05-14-switch-to-lora]], the station is designed to be left alone for years; the one maintenance task that breaks that promise is flashing.

## Why it matters
- The beta will surely find firmware bugs; forty members climbing forty ladders is a bad first experience for the [[Community Launch]].
- The daylight-saving timestamp bug found in August is exactly the kind of fix that should not need a ladder.

## Why it is hard
- LoRa bandwidth is tiny. A firmware image would take hours of air time at the interval and spreading factor the station uses, and every second of transmit costs battery that [[Skyline v1 Hardware]] budgets carefully.
- A failed update on a roof is a bricked station. It needs a dual-bank bootloader and a verified rollback, which the rev C board's flash layout can support but the firmware does not yet.
- Security: anyone with a LoRa radio in range could push an image unless updates are signed. Signing adds a key management story the studio does not have.

## Rafael's own position
Build it in v1.1, after the beta has shown which bugs actually need field fixes. For v1, ship a clear flashing guide ([[Anouk Ferreira]]) and design the enclosure so the cable port is reachable without full disassembly, which [[Jonas Wexley]] added to the rev 2 requirements on 2026-06-22.

## Next step
Nothing before 2026-11. Revisit with beta data. Related: [[LoRa Link Budget Primer]] for the air-time arithmetic.
