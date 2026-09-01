---
type: decision
created: 2026-04-09
tags: [decision, hardware, pcb]
status: accepted
owner: Tessa Varga
---
# Decision: custom main board instead of a dev-kit carrier

**Date:** 2026-04-09 · **Decided by:** [[Tessa Varga]], [[Rafael Nkemdi]] · **Status:** accepted

## Context
The v0 prototype ran on a Raspberry Pi Pico W plugged into a hand-wired carrier. For a kit that outsiders will build and leave on a roof for years, the question was whether to ship that arrangement (a dev board on a carrier PCB) or design a single custom main board with the microcontroller, sensor interfaces, power path and radio on one board.

## Options
1. **Dev board on a carrier.** Cheapest engineering, fastest to first kit. Two boards to assemble, pin headers as the weak point, and the carrier still needs a PCB run.
2. **Custom main board.** One assembled PCB, proper power path for solar and a lithium cell, sealed connectors. More engineering, one more revision cycle, and a contract manufacturer relationship.
3. **Custom board later, carrier for the beta.** Ship the carrier to the 40 beta members, then redesign. Two designs to document and support.

## Decision
Option 2 for the station. Option 1 for the Bridge: the base station stays a Pico W on a small carrier because it lives indoors, on mains power, and its requirements are plain.

## Rationale
A weather station's failure modes are mechanical and electrical, not computational. Header connections corrode, hand-soldered carriers vary, and a power path built from modules is what killed battery life on v0. One board, one assembly house, one test procedure. The Bridge does not have those problems, so it does not need that investment.

## Consequences
- Rev A in April, rev B for the May field test, rev C after ([[Skyline v1 Hardware]]).
- The studio needs an assembly partner. Greyfell Assembly was chosen in June ([[2026-06-18-greyfell-production-review]]); that relationship is now the launch's biggest dependency.
- BOM per kit rose by about $9 against the carrier option, offset by fewer connectors and less assembly time.
- Radio choice was left open here. It was settled by [[2026-05-14-switch-to-lora]].
