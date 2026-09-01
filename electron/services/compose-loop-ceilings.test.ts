import { describe, it, expect, vi } from 'vitest'

// loop-controller (and the bridge that imports it) reach for electron at module load.
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '/tmp/lamprey-test-irrelevant' }
}))

import { composeLoopCeilings } from './goal-automation-loop-bridge'
import { effectiveCeilings } from './loop-controller'

const GLOBAL = { maxIterations: 25, maxWallclockMs: 1_800_000, tokenBudget: 500_000 }

describe('composeLoopCeilings — goal/automation caps may only TIGHTEN global policy', () => {
  it('returns the global policy when no goal/automation caps are supplied', () => {
    expect(composeLoopCeilings(GLOBAL)).toEqual(GLOBAL)
  })

  it('tightens to the goal cap when it is lower than global', () => {
    const r = composeLoopCeilings(GLOBAL, { maxIterations: 5, tokenBudget: 10_000 })
    expect(r.maxIterations).toBe(5)
    expect(r.tokenBudget).toBe(10_000)
    expect(r.maxWallclockMs).toBe(GLOBAL.maxWallclockMs)
  })

  it('takes the tightest across global + goal + automation', () => {
    const r = composeLoopCeilings(
      GLOBAL,
      { maxIterations: 10, tokenBudget: 100_000 },
      { maxIterations: 3, tokenBudget: 200_000 }
    )
    expect(r.maxIterations).toBe(3) // automation is tightest
    expect(r.tokenBudget).toBe(100_000) // goal is tightest
  })

  it('never LOOSENS: a goal/automation cap ABOVE global is ignored', () => {
    const r = composeLoopCeilings(GLOBAL, { maxIterations: 9999 }, { tokenBudget: 9_000_000 })
    expect(r.maxIterations).toBe(GLOBAL.maxIterations)
    expect(r.tokenBudget).toBe(GLOBAL.tokenBudget)
  })

  it('ignores non-positive / non-integer caps', () => {
    const r = composeLoopCeilings(GLOBAL, { maxIterations: 0 }, { tokenBudget: -5 })
    expect(r.maxIterations).toBe(GLOBAL.maxIterations)
    expect(r.tokenBudget).toBe(GLOBAL.tokenBudget)
  })
})

describe('effectiveCeilings — extra caps fold as an ADDITIONAL Math.min term', () => {
  // A full-trust snapshot so the trust-scaled term equals the raw cap; then the
  // extra cap alone decides the fold (isolating the new behavior from trust scaling).
  const fullTrust = { ratifyN: 100, ratifyK: 100, reverts: 0, revertsHandled: 0, updatedAt: 0, skillScore: 1 }

  it('is a no-op when no extra caps are supplied (backward compatible)', () => {
    const r = effectiveCeilings({ maxIterations: 20, tokenBudget: 400_000 }, 1, fullTrust)
    expect(r.maxIterations).toBe(20)
    expect(r.tokenBudget).toBe(400_000)
  })

  it('tightens by the extra cap when it is lower than the trust-scaled ceiling', () => {
    const r = effectiveCeilings({ maxIterations: 20, tokenBudget: 400_000 }, 1, fullTrust, {
      maxIterations: 4,
      tokenBudget: 50_000
    })
    expect(r.maxIterations).toBe(4)
    expect(r.tokenBudget).toBe(50_000)
  })

  it('does not loosen: an extra cap above the scaled ceiling is ignored', () => {
    const r = effectiveCeilings({ maxIterations: 8, tokenBudget: 100_000 }, 1, fullTrust, {
      maxIterations: 9999
    })
    expect(r.maxIterations).toBe(8)
  })

  it('applies the extra cap even when the loop itself is uncapped (null)', () => {
    const r = effectiveCeilings({ maxIterations: null, tokenBudget: null }, 1, fullTrust, {
      maxIterations: 6
    })
    expect(r.maxIterations).toBe(6)
    expect(r.tokenBudget).toBeNull()
  })
})
