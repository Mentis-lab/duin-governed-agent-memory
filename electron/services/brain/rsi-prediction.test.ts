import { describe, it, expect } from 'vitest'
import { gradePrediction } from './self-improve-fitness'
import type { EngineFitness } from './self-improve-fitness'

const f = (engine: string, score: number | null, gated = false, n = 30): EngineFitness => ({ engine, score, n, gated } as EngineFitness)

describe('gradePrediction — per-change improvement contract (AHE, SIA activation)', () => {
  it('holds when the target engine rose by >= minDelta', () => {
    expect(gradePrediction([f('promotion', 0.60)], [f('promotion', 0.65)], 'promotion', 0.02)).toBe(true)
  })
  it('FAILS a kept-but-flat change (improvement stricter than no-regression)', () => {
    // delta 0.005 < minDelta 0.02: the keep-gate would pass (no regression) but the prediction fails
    expect(gradePrediction([f('promotion', 0.60)], [f('promotion', 0.605)], 'promotion', 0.02)).toBe(false)
  })
  it('FAILS a regression', () => {
    expect(gradePrediction([f('promotion', 0.60)], [f('promotion', 0.55)], 'promotion', 0.02)).toBe(false)
  })
  it('is null (not gradable) when either window is gated/immature or score-null', () => {
    expect(gradePrediction([f('promotion', 0.60, true)], [f('promotion', 0.65)], 'promotion')).toBeNull()
    expect(gradePrediction([f('promotion', null)], [f('promotion', 0.65)], 'promotion')).toBeNull()
    expect(gradePrediction([f('other', 0.60)], [f('promotion', 0.65)], 'promotion')).toBeNull()
  })
})
