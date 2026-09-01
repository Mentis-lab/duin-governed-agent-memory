---
type: decision
created: 2026-03-19
tags: [decision, license, open-source]
status: accepted
owner: Tessa Varga
---
# Decision: open-source licenses for Skyline

**Date:** 2026-03-19 · **Decided by:** [[Tessa Varga]], [[Anouk Ferreira]], [[Ines Halloran]], [[Rafael Nkemdi]] · **Status:** accepted

## Context
Skyline is meant to be open hardware from the first public commit, and the Lodestar Open Hardware Fund requires a recognised open license on the design files ([[2026-04-02-lodestar-grant-call]] confirmed this two weeks later). The team disagreed on how reciprocal the license should be. Tessa wanted the lowest possible barrier to adoption. Anouk worried that a closed clone of the board could undercut the studio's own kits before there was any community to defend it.

## Options
1. **MIT for everything.** Simplest, most permissive. Allows closed derivatives of the hardware.
2. **Strongly reciprocal hardware license, permissive software.** Modifications to the board design must be shared; firmware and app can be reused freely, including in closed products.
3. **Reciprocal everything.** Maximum protection, but makes the app harder to reuse in other projects and is unusual for a companion app.

## Decision
Option 2. Hardware design files under a strongly reciprocal open hardware license (CERN-OHL-S). Firmware and the [[Skyline Companion App]] under Apache-2.0. Documentation under a Creative Commons attribution-share-alike license.

## Rationale
The board is where the studio's differentiation lives and where a clone would hurt. The software is where the studio wants the widest reuse, including by people building their own stations on other hardware. Tessa accepted Anouk's argument on the hardware side; Anouk accepted Tessa's on the software side.

## Consequences
- The repository needs three license files and a clear README section. Anouk owns this for the [[Community Launch]].
- Any contributor who modifies the board must publish their changes. This is a feature, not a cost.
- Reversal would be hard once outside contributions exist. Decide once.

Related reading: [[Open Hardware Business Models]].
