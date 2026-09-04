---
type: reading
created: 2026-06-30
tags: [reading, data, community, calibration, resource]
source: report on volunteer weather networks
---
# Reading: Citizen Weather Network Data Quality

**Source:** a report evaluating the data quality of volunteer-run weather station networks against official observations, read by [[Anouk Ferreira]] and [[Ines Halloran]] while drafting the [[Community Data Commons]] idea · **Read:** 2026-06-30

## What it says
Volunteer networks produce far denser coverage than official ones and far noisier data. The noise is not random; it comes from a short list of causes that a kit designer can do something about:

- **Siting.** The largest error source. Stations too close to walls, over dark surfaces, or under trees. The report found siting errors of several degrees, dwarfing sensor error.
- **Radiation shielding.** The second largest, consistent with [[Passive Radiation Shields for Low-Cost Stations]].
- **Calibration drift.** Humidity sensors drift most; pressure sensors least. Uncalibrated stations diverge from each other within a year.
- **Metadata.** Networks that record height, surroundings and shield type can filter their own data; those that do not cannot use it.
- **Quality flags.** The useful networks flag readings rather than delete them, and let downstream users choose.

The report's conclusion is that a volunteer network's value depends less on the sensor than on whether the network can describe its own stations.

## What we took from it
- The assembly guide needs a siting page with pictures of good and bad placements. Anouk added it to the guide outline on 2026-07-02.
- The [[Skyline Companion App]] should ask for station metadata at pairing: height, surface, whether the shield is the stock rev 2 or user-printed. Ines put it in the v1.1 backlog.
- Per-sensor calibration offsets in the app, already in v1, are the right call. Humidity will need a re-calibration reminder.
- Any commons must carry metadata and quality flags, not just readings. This shaped the "coarse grid cell plus station description" design in [[Community Data Commons]].
- For [[Frost Alert for Orchards]], siting in the orchard matters more than the algorithm.

## Doubts
The report covers networks with thousands of stations. Whether 40 well-documented stations in one area are useful to anyone but their owners is not answered here. [[Yumi Castellane]] thinks the members would use it regardless.
