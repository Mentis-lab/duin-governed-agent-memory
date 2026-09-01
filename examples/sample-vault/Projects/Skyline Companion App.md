---
type: project
created: 2026-04-23
tags: [project, app, skyline]
status: active
owner: Ines Halloran
---
# Skyline Companion App

**Owner:** [[Ines Halloran]] · **Status:** beta build with 10 testers since 2026-08-20, two bugs open.

The companion app is how a Skyline owner sees their station. It has two halves: a web dashboard served by the Bridge on the local network, and a phone app that talks to the same Bridge. Both are local-first. Readings live on the Bridge and on the phone, and nothing leaves the house unless the owner exports it or opts into the [[Community Data Commons]] later.

## Scope for v1 (agreed at [[2026-04-23-companion-app-kickoff]])
- Live readings and 7-day charts for every sensor on the mast, with gaps shown as gaps
- Station pairing and health (battery, signal, last seen)
- Export as CSV and as a documented JSON schema
- Calibration offsets per sensor, editable by the owner
- No accounts, no cloud, no telemetry

## What changed
The kickoff assumed the station itself would join the home Wi-Fi and push readings straight to the app. [[2026-05-14-switch-to-lora]] put the Bridge in between, so pairing became a two-step flow (phone finds Bridge, Bridge knows station). Ines argued at the time that this made the app harder to explain, and she was right: two of the three beta bugs were in pairing.

## Beta bugs (as of 2026-08-30)
1. Pairing times out when the Bridge is on a different subnet than the phone. Owner Ines, due 2026-09-10. **Launch blocker.**
2. Station shows "never seen" after a successful pairing until the app restarts. Owner Ines, fixed 2026-08-26.
3. Timestamps show a one-hour offset after a daylight-saving change. Owner [[Rafael Nkemdi]] (firmware side), fix in test, due 2026-09-10.

## Dependencies
- Packet format from firmware, frozen 2026-05-01 and revised for LoRa on 2026-06-10
- The full rev C batch to test pairing at scale, see [[Skyline v1 Hardware]]
- Beta testers from [[Yumi Castellane]]'s network, see [[Community Launch]]

## Later
[[Frost Alert for Orchards]] is the first post-launch feature. It needs real overnight data from the beta before anyone writes a rule. Station metadata at pairing (height, surface, shield type) is in the v1.1 backlog after [[Citizen Weather Network Data Quality]].
