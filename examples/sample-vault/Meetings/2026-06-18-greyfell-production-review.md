---
type: meeting
created: 2026-06-18
tags: [meeting, supplier, manufacturing]
attendees: [Tessa Varga, Rafael Nkemdi, Halvard Brenna]
---
# Greyfell production review — 2026-06-18

**Attendees:** [[Tessa Varga]], [[Rafael Nkemdi]], [[Halvard Brenna]] (Greyfell Assembly)
**Purpose:** review the rev C main board for manufacture and agree quantity, price and delivery.

## Summary
Greyfell will build **60 rev C boards** (40 for the beta, 20 spares and bring-up units) at $41 per assembled board. Lead time is six weeks from clean Gerbers, so delivery on **2026-07-30** if the files are resent by 2026-06-24. Halvard flagged four DFM issues; one of them, the antenna connector footprint, is a real error and must be fixed before release.

## DFM findings
1. Antenna connector footprint is mirrored; the part would not seat. Tessa will fix.
2. Two capacitors sit closer to the board edge than Greyfell's pick-and-place likes. Move if easy.
3. Solar input connector has no polarity marking on the silkscreen. Add.
4. Test points are unlabeled. Add labels so bring-up is not guesswork.

## Discussion
- Rafael asked about the LoRa radio module supply. Halvard said his distributor showed stock but he would confirm. (He confirmed on 2026-06-26; the shortage came later.)
- Tessa asked for a price on a 100-board second batch. Halvard estimated $37 per board at that volume, to be quoted properly if the studio goes ahead, see [[2026-07-02-beta-batch-size]].
- Halvard offered to build five boards first as a pilot run. Tessa accepted; it adds four days but catches assembly errors before 55 more boards exist.

## Decisions taken here
- 60 boards, pilot run of 5 first
- Delivery 2026-07-30 (since moved, see [[2026-08-06-supplier-delay-escalation]])

## Action items
- [ ] Tessa — fix the footprint, silkscreen and test point labels, resend Gerbers, by 2026-06-24 (done 2026-06-23)
- [ ] Halvard — confirm component stock including the LoRa module, by 2026-06-26
- [ ] Rafael — rev C bring-up plan and test firmware, by 2026-07-24
- [ ] Tessa — update [[Skyline v1 Hardware]] with the dates

## Follow-up
Rafael's [[Firmware Updates over LoRa]] idea came up over coffee afterwards. Parked until after launch.
