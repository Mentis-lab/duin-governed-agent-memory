import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => {
      throw new Error('no electron in test')
    }
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { effectiveCeilings, TRUST_ITER_FLOOR, TRUST_TOKEN_FLOOR } from './loop-controller'
import type { TrustSnapshot } from './ans/trust-score'

const cold: TrustSnapshot = { ratifyN: 0, ratifyK: 0, reverts: 0, revertsHandled: 0, updatedAt: 0, skillScore: null }
const strong: TrustSnapshot = { ratifyN: 20, ratifyK: 20, reverts: 0, revertsHandled: 0, updatedAt: 0, skillScore: 0.9 }

describe('effectiveCeilings (item 19 — reliability-proportional loop ceilings)', () => {
  it('a cold loop is floored (mult 0.1) but still gets a few turns', () => {
    const e = effectiveCeilings({ maxIterations: 25, tokenBudget: 500_000 }, null, cold)
    expect(e.multiplier).toBe(0.1)
    expect(e.maxIterations).toBe(TRUST_ITER_FLOOR)
    expect(e.tokenBudget).toBe(TRUST_TOKEN_FLOOR)
  })
  it('a high-trust loop scales up toward but never past the user cap', () => {
    const e = effectiveCeilings({ maxIterations: 25, tokenBudget: 500_000 }, 0.9, strong)
    expect(e.multiplier).toBeGreaterThan(0.9)
    expect(e.maxIterations).toBeGreaterThan(20)
    expect(e.maxIterations).toBeLessThanOrEqual(25) // never past the user cap
    expect(e.tokenBudget).toBeLessThanOrEqual(500_000)
  })
  it('null caps pass through as null', () => {
    const e = effectiveCeilings({ maxIterations: null, tokenBudget: null }, null, cold)
    expect(e.maxIterations).toBeNull()
    expect(e.tokenBudget).toBeNull()
  })
})
