---
type: meeting
created: 2026-05-09
tags: [meeting, field-test, hardware]
attendees: [Tessa Varga, Rafael Nkemdi, Ines Halloran, Jonas Wexley, Anouk Ferreira]
---
# Field test debrief — 2026-05-09

**Attendees:** [[Tessa Varga]], [[Rafael Nkemdi]], [[Ines Halloran]], [[Jonas Wexley]], [[Anouk Ferreira]]
**Purpose:** review the 2026-05-02 to 2026-05-07 field test of rev B stations at the Brightwater rooftop and the Hollowmere orchard.

## Summary
Two rev B stations ran for six days. The sensor chain worked. Almost everything else did not. Wi-Fi range, battery life and the enclosure each failed in a way that changes the design. Two decisions come out of this meeting: the radio link ([[2026-05-14-switch-to-lora]]) and the enclosure ([[2026-06-04-enclosure-redesign]]).

## Findings
1. **Range.** On the rooftop the station held Wi-Fi at 25 m and dropped out at 40 m. At Hollowmere the nearest access point is 180 m from the mast site; the station never connected. Rafael's take: Wi-Fi is the wrong radio for where people actually want to put a weather station.
2. **Power.** The rooftop station, with Wi-Fi awake for 15-minute uploads, ran the cell flat in 3 days of overcast. Target is 14 days. Rafael measured the Wi-Fi radio at roughly 30 times the average draw of a LoRa transmit at the same interval.
3. **Enclosure.** Rain got in at the cable gland on day two. The PLA lid warped. Temperature read +2.5 °C high in direct sun compared with the reference sensor, which means the radiation shield is not doing its job.
4. **Data.** When the station lost the link, readings were lost. Ines wants buffering on the station and gap handling in the app.

## Discussion
Ines asked whether a bigger battery and a Wi-Fi extender would be cheaper than a new radio and a Bridge. Rafael thinks not, and had the numbers, but agreed to run a LoRa range test before anyone decides. Jonas will do a proper failure analysis on the housing.

## Action items
- [ ] Rafael — LoRa point-to-point range and power test at Hollowmere, by 2026-05-13
- [ ] Jonas — enclosure failure analysis and options, by 2026-05-28
- [ ] Ines — add offline buffering and gap rendering to the app scope
- [ ] Tessa — schedule the radio decision for 2026-05-14
