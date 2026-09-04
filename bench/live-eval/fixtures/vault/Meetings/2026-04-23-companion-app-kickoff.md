---
type: meeting
created: 2026-04-23
tags: [meeting, app, kickoff]
attendees: [Ines Halloran, Rafael Nkemdi, Anouk Ferreira, Tessa Varga]
---
# Companion app kickoff — 2026-04-23

**Attendees:** [[Ines Halloran]] (lead), [[Rafael Nkemdi]], [[Anouk Ferreira]], [[Tessa Varga]]
**Purpose:** agree the scope and the data model for the [[Skyline Companion App]].

## Summary
The app is local-first: readings live on the owner's own hardware and phone, there are no accounts and no server run by Kestrel. v1 shows live readings and 7-day charts, station health, per-sensor calibration offsets, and exports CSV and JSON. The station pushes readings straight to the app over the home Wi-Fi. (That last assumption did not survive the field test; see [[2026-05-14-switch-to-lora]].)

## Discussion
- Ines: "no accounts, no cloud, no telemetry" is a product rule, not a phase-one shortcut. Nobody objected. Tessa noted it removes a whole class of grant reporting questions.
- Rafael proposed a fixed packet format so the app and firmware can be built in parallel. He will freeze it by 2026-05-01. Any change after that needs both of them in a room.
- Anouk wants export formats documented on day one, because the Brightwater members will ask. The JSON schema goes in the repository with the firmware.
- Ines proposed five user interviews with Brightwater members before the first prototype. Tessa was skeptical of the time cost; Ines argued it is cheaper than redesigning pairing later. Approved.
- Time zones: Rafael wants the station to send UTC only and the app to convert. Agreed. (The beta later found a daylight-saving bug in exactly this path.)

## Decisions taken here
- Local-first, no accounts (product rule)
- UTC on the wire, conversion in the app
- CSV and documented JSON export in v1

## Action items
- [ ] Rafael — freeze the readings packet format, by 2026-05-01
- [ ] Ines — dashboard prototype on sample data, by 2026-05-15
- [ ] Ines — five user interviews with Brightwater members via [[Yumi Castellane]], by 2026-05-08
- [ ] Anouk — export format page in the repository, by 2026-05-22
