---
type: reading
created: 2026-05-12
tags: [reading, lora, radio, firmware, resource]
source: vendor-neutral technical primer
---
# Reading: LoRa Link Budget Primer

**Source:** a vendor-neutral primer on LoRa link budgets, spreading factors and air time, read by [[Rafael Nkemdi]] before the range test of 2026-05-13 · **Read:** 2026-05-12

## What it says
LoRa trades data rate for sensitivity. The receiver can pull a signal out from well below the noise floor, which is where the range comes from, at the cost of very slow transmissions. The variables the studio can control:

- **Spreading factor.** Higher factors reach further and last longer on air. Each step up roughly doubles air time and adds about 2.5 dB of link budget.
- **Bandwidth.** Narrower is more sensitive and slower.
- **Payload.** Air time grows with bytes. A 20-byte readings packet at a middle spreading factor is on air for well under a second; a firmware image is hours.
- **Antenna and placement.** A few metres of height and a clear line of sight are worth more than any firmware setting.
- **Duty cycle.** In some bands a device may only transmit for a small fraction of each hour. A 15-minute interval with a short packet is far inside that limit; anything chatty is not.

## What we took from it
- The range test plan: one middle spreading factor, a 20-byte packet, 15-minute interval, antenna at mast height. At Hollowmere it held across 1.2 km with line of sight and about 400 m through trees, which became the field evidence in [[2026-05-14-switch-to-lora]].
- Power: transmit time per reading is short enough that the radio is roughly one thirtieth of Wi-Fi's average draw at the same interval. This is the number behind the 19-day autonomy projection in [[Skyline v1 Hardware]].
- Packet format: keep it to 20 bytes. Rafael's revised format of 2026-06-10 is 18.
- Air-time arithmetic is why [[Firmware Updates over LoRa]] was deferred.

## Doubts
The primer assumes an outdoor antenna with a decent ground plane. The rev C antenna sits inside the enclosure; [[Jonas Wexley]]'s rev 2 antenna position will need its own measurement.
