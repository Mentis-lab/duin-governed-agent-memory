// The brain map's physics, as numbers: ONE mapping from the four Layout sliders to d3 forces,
// shared by the two engines that lay the graph out, the worker (`graph-layout.worker.ts`) and the
// on-screen react-force-graph fallback configured in `brain-shell.tsx`. They MUST agree: if they
// disagree, whichever settles last visibly undoes the other.
//
// Deliberately side-effect free and dependency free so a worker, the renderer and a node test
// can all import it; the worker module itself installs an `onmessage` handler on `self`, so
// importing a value out of it would run that handler in the renderer.
//
// Retuned 2026-09-03 on the operator's report "the link and center forces are not well tuned and
// not smooth", measured on the live drawn set (2,147 nodes / 6,501 links) before changing anything:
//
//   · link force: the old ramp used d3's adaptive strength (1 / min degree) at EXACTLY 50 and a
//     constant 0.05..1 everywhere else, so one step off the midpoint switched a hub's 500 links
//     from ~0.002 to ~0.5. Measured: a 2-step nudge moved every node 262 world units on average,
//     against 24 for leaving the slider alone (10x), and the axis was not monotonic (r95 1342 →
//     1062 → 1259 → 800 → 719 across 0/25/50/75/100). Now: the adaptive default scaled by a
//     geometric factor, continuous through 50, monotonic (1287 → 959).
//   · center force: `forceCenter` only translates the whole system so its centroid sits on the
//     origin. With the core pinned at the origin it fought the pinned node every tick, and the
//     slider changed a translation gain, not an attraction. Gone; forceX/forceY hold each node
//     in and the slider drives their strength directly.
//   · node spacing: linear to -400 in the upper half meant one step = -7.4 charge; a 2-step
//     nudge moved nodes 134 units (5x idle). Geometric, 4x either way.
//   · damping: velocityDecay 0.3 (under d3's 0.4) rang; 0.4 settles without overshoot.
//   · re-heat: every slider frame re-heated to alpha 0.3, which alone moves an UNCHANGED
//     graph 45 units per node in 60 ticks (measured, collision on or off). The energy is now
//     proportional to how far the slider travelled: a nudge gets 0.09 (14 units), a full
//     sweep the 0.3 it needs (a 50→100 center move reaches r95 610 at 0.3, 688 at 0.1).
//   · collision: nodes may not overlap. forceCollide on each node's drawn radius plus a small
//     pad, one iteration; +4 ms per tick at the drawn set (13 → 17.6 ms), all in the worker.

/** The operator's four Layout sliders, 0..100 with 50 = the shipped look. */
export type LayoutSliders = { nodeSpacing: number; linkLength: number; linkForce: number; centerForce: number }

/** Everything a layout run can be re-tuned on. */
export type ForceParams = {
  /** forceManyBody strength (negative = repulsion). */
  charge: number
  /** forceLink distance, world units. */
  linkDistance: number
  /** Multiplier on d3's adaptive link strength 1 / min(deg(a), deg(b)); 1 = d3's default. */
  linkStrengthScale: number
  /** forceX / forceY strength toward the origin: the per-node inward pull "Center force" means. */
  positional: number
  velocityDecay: number
}

/**
 * A geometric ramp: 50 is EXACTLY `atMid`, 0 is `atMid / factor`, 100 is `atMid × factor`, and
 * every step in between multiplies by the same ratio (factor^(1/50)), so the slider feels even
 * along its whole travel and no step is special. Clamped to 0..100.
 */
export function rampGeo(v: number, atMid: number, factor: number): number {
  const t = Math.max(0, Math.min(100, v))
  return atMid * Math.pow(factor, (t - 50) / 50)
}

/** The ramps, one per slider. Mid values are the physics the map shipped with. */
export const FORCE_RAMPS = {
  charge: { atMid: -30, factor: 4 },            // -7.5 .. -30 .. -120
  linkDistance: { atMid: 30, factor: 3 },       // 10 .. 30 .. 90
  linkStrengthScale: { atMid: 1, factor: 3 },   // 1/3 .. 1 .. 3 × adaptive
  positional: { atMid: 0.03, factor: 5 },       // 0.006 .. 0.03 .. 0.15
} as const

/** d3's default. 0.3 (the previous value) under-damps: the settle rang after a slider change. */
export const VELOCITY_DECAY = 0.4

/** Collision: a node's drawn radius plus this pad (world units), at this strength, one pass. */
export const COLLISION = { padding: 1.5, strength: 0.6 } as const

/** Re-heat energy bounds for a live parameter change (see `reheatAlphaFor`). */
export const REHEAT_ALPHA = { min: 0.08, max: 0.3 } as const

/** Sliders → forces. Both engines call this and nothing else. */
export function slidersToForces(s: LayoutSliders): ForceParams {
  return {
    charge: rampGeo(s.nodeSpacing, FORCE_RAMPS.charge.atMid, FORCE_RAMPS.charge.factor),
    linkDistance: rampGeo(s.linkLength, FORCE_RAMPS.linkDistance.atMid, FORCE_RAMPS.linkDistance.factor),
    linkStrengthScale: rampGeo(s.linkForce, FORCE_RAMPS.linkStrengthScale.atMid, FORCE_RAMPS.linkStrengthScale.factor),
    positional: rampGeo(s.centerForce, FORCE_RAMPS.positional.atMid, FORCE_RAMPS.positional.factor),
    velocityDecay: VELOCITY_DECAY,
  }
}

/**
 * The strength of one link: d3's adaptive default (1 / the smaller endpoint degree, so a hub's
 * hundreds of links stay weak and a leaf's one link holds) times the slider's scale, never above
 * 1. One model across the whole slider range — the discontinuity at 50 lived here.
 */
export function linkStrengthFor(scale: number, degA: number, degB: number): number {
  return Math.min(1, scale / Math.min(degA || 1, degB || 1))
}

/**
 * The energy a FRESH layout run starts with, from how much of it is already placed. A run whose
 * nodes all carry positions (a refresh, or a launch seeded from the remembered layout) needs a
 * re-heat, not d3's alpha-1 scatter; a run with no seeds needs the full settle.
 */
export function seedAlpha(seeded: number, total: number): number {
  if (total <= 0) return 1
  const f = seeded / total
  return f >= 0.9 ? 0.3 : f >= 0.5 ? 0.6 : 1
}

/**
 * How much energy a live parameter change puts back into a settled layout, from how far the
 * slider travelled since the last committed value (in slider steps). d3's own convention for an
 * interactive nudge is 0.3; that is the ceiling, reached at a half-travel sweep. A one-step
 * nudge gets just above the floor, which moves the map a third as far for the same change.
 */
export function reheatAlphaFor(travelSteps: number): number {
  const t = Math.min(1, Math.abs(travelSteps) / 50)
  return REHEAT_ALPHA.min + (REHEAT_ALPHA.max - REHEAT_ALPHA.min) * t
}
