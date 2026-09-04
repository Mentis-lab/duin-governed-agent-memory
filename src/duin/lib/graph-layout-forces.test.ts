import { describe, expect, it } from 'vitest'
import {
  rampGeo, slidersToForces, linkStrengthFor, reheatAlphaFor, seedAlpha,
  FORCE_RAMPS, VELOCITY_DECAY, REHEAT_ALPHA, COLLISION,
} from './graph-layout-forces'

// The operator's report that started this (2026-09-03): "the link and center forces are not well
// tuned and not smooth". Measured on the live drawn set, the link slider switched models at
// exactly 50 (adaptive there, a constant everywhere else: a 10x jolt one step off the midpoint,
// and a non-monotonic axis) and forceCenter fought the pinned core. These tests pin the shape
// of the fix: one continuous, monotonic model per axis, with 50 still the shipped physics.

const MID = { nodeSpacing: 50, linkLength: 50, linkForce: 50, centerForce: 50 }

describe('rampGeo: 50 is exactly the mid anchor, the ends are one factor away, no step is special', () => {
  it('lands on the anchors', () => {
    expect(rampGeo(50, -30, 4)).toBe(-30)
    expect(rampGeo(0, -30, 4)).toBeCloseTo(-7.5, 6)
    expect(rampGeo(100, -30, 4)).toBeCloseTo(-120, 6)
  })
  it('clamps outside 0..100', () => {
    expect(rampGeo(-20, 30, 3)).toBeCloseTo(10, 6)
    expect(rampGeo(140, 30, 3)).toBeCloseTo(90, 6)
  })
  it('every single step multiplies by the same ratio, so the slider feels even end to end', () => {
    const ratio = Math.pow(4, 1 / 50)
    for (let v = 0; v < 100; v++) expect(rampGeo(v + 1, -30, 4) / rampGeo(v, -30, 4)).toBeCloseTo(ratio, 9)
  })
})

describe('slidersToForces: the shipped physics at 50, and a midpoint that is NOT special', () => {
  it('50 on every slider = the physics the map shipped with', () => {
    expect(slidersToForces(MID)).toEqual({ charge: -30, linkDistance: 30, linkStrengthScale: 1, positional: 0.03, velocityDecay: VELOCITY_DECAY })
  })
  it('one step either side of 50 changes every axis by under 4% (the old link ramp changed it 250x)', () => {
    const at = (v: number) => slidersToForces({ nodeSpacing: v, linkLength: v, linkForce: v, centerForce: v })
    const lo = at(49), mid = at(50), hi = at(51)
    for (const k of ['charge', 'linkDistance', 'linkStrengthScale', 'positional'] as const) {
      expect(Math.abs(lo[k] / mid[k] - 1)).toBeLessThan(0.04)
      expect(Math.abs(hi[k] / mid[k] - 1)).toBeLessThan(0.04)
    }
  })
  it('each axis is monotonic across its whole travel', () => {
    for (const axis of ['nodeSpacing', 'linkLength', 'linkForce', 'centerForce'] as const) {
      const key = ({ nodeSpacing: 'charge', linkLength: 'linkDistance', linkForce: 'linkStrengthScale', centerForce: 'positional' } as const)[axis]
      let prev = slidersToForces({ ...MID, [axis]: 0 })[key]
      for (let v = 1; v <= 100; v++) {
        const cur = slidersToForces({ ...MID, [axis]: v })[key]
        // charge is negative and grows more negative (stronger repulsion) as the slider rises
        if (key === 'charge') expect(cur).toBeLessThan(prev); else expect(cur).toBeGreaterThan(prev)
        prev = cur
      }
    }
  })
  it('the ramps are the documented ones', () => {
    expect(FORCE_RAMPS.charge).toEqual({ atMid: -30, factor: 4 })
    expect(FORCE_RAMPS.linkDistance).toEqual({ atMid: 30, factor: 3 })
    expect(FORCE_RAMPS.linkStrengthScale).toEqual({ atMid: 1, factor: 3 })
    expect(FORCE_RAMPS.positional).toEqual({ atMid: 0.03, factor: 5 })
  })
})

describe('linkStrengthFor: d3\'s adaptive default, scaled by the slider, capped at 1', () => {
  it('scale 1 is exactly 1 / min(degree)', () => {
    expect(linkStrengthFor(1, 3, 2)).toBe(1 / 2)
    expect(linkStrengthFor(1, 2, 5)).toBe(1 / 2)
  })
  it('a hub link stays weak at 3x; a leaf link is already at the cap', () => {
    expect(linkStrengthFor(3, 577, 4)).toBeCloseTo(0.75, 9)
    expect(linkStrengthFor(3, 1, 9)).toBe(1)
    expect(linkStrengthFor(1 / 3, 1, 1)).toBeCloseTo(1 / 3, 9)
  })
  it('a degree of 0 (a rescued isolate) counts as 1, never divides by zero', () => {
    expect(linkStrengthFor(1, 0, 0)).toBe(1)
  })
})

describe('reheatAlphaFor: energy proportional to slider travel, between the floor and d3\'s 0.3', () => {
  it('a nudge is gentle, a half-travel sweep gets the full 0.3, nothing exceeds it', () => {
    expect(reheatAlphaFor(0)).toBe(REHEAT_ALPHA.min)
    expect(reheatAlphaFor(2)).toBeGreaterThan(REHEAT_ALPHA.min)
    expect(reheatAlphaFor(2)).toBeLessThan(0.1)
    expect(reheatAlphaFor(50)).toBeCloseTo(REHEAT_ALPHA.max, 9)
    expect(reheatAlphaFor(500)).toBe(REHEAT_ALPHA.max)
  })
  it('direction does not matter', () => {
    expect(reheatAlphaFor(-10)).toBe(reheatAlphaFor(10))
  })
})

describe('seedAlpha: a placed map re-heats, an unplaced one settles from scratch', () => {
  it('thresholds', () => {
    expect(seedAlpha(0, 100)).toBe(1)
    expect(seedAlpha(40, 100)).toBe(1)
    expect(seedAlpha(60, 100)).toBe(0.6)
    expect(seedAlpha(95, 100)).toBe(0.3)
    expect(seedAlpha(0, 0)).toBe(1)
  })
})

describe('collision and damping constants', () => {
  it('collision is on with a small pad; damping is d3\'s default', () => {
    expect(COLLISION.padding).toBeGreaterThan(0)
    expect(COLLISION.strength).toBeGreaterThan(0)
    expect(COLLISION.strength).toBeLessThanOrEqual(1)
    expect(VELOCITY_DECAY).toBe(0.4)
  })
})
