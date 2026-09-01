import { describe, it, expect } from 'vitest'
import { fitPlatt, recalibrate, fitRecalibration } from './calibration-recalibrate'
import type { ScoredForecast } from './calibration-scoring'

const logLoss = (fc: ScoredForecast[], map: (p: number) => number): number => {
  let s = 0
  for (const r of fc) {
    const p = Math.min(1 - 1e-6, Math.max(1e-6, map(r.confidence)))
    s += -(r.outcome * Math.log(p) + (1 - r.outcome) * Math.log(1 - p))
  }
  return s / fc.length
}

describe('calibration-recalibrate (item 17 Platt/extremization)', () => {
  it('shrinks an over-confident forecaster (a<1) and lowers log-loss', () => {
    // Stated 0.9 but only 50% materialize → over-confident.
    const fc: ScoredForecast[] = [
      ...Array.from({ length: 15 }, () => ({ confidence: 0.9, outcome: 1 as const })),
      ...Array.from({ length: 15 }, () => ({ confidence: 0.9, outcome: 0 as const }))
    ]
    const prm = fitPlatt(fc)
    expect(prm.a).toBeLessThan(1) // shrink toward the base rate
    expect(logLoss(fc, (p) => recalibrate(p, prm))).toBeLessThan(logLoss(fc, (p) => p)) // strictly better
  })

  it('stays monotone + near-identity on a well-calibrated forecaster', () => {
    const fc: ScoredForecast[] = [
      ...Array.from({ length: 18 }, () => ({ confidence: 0.9, outcome: 1 as const })),
      ...Array.from({ length: 2 }, () => ({ confidence: 0.9, outcome: 0 as const })),
      ...Array.from({ length: 2 }, () => ({ confidence: 0.1, outcome: 1 as const })),
      ...Array.from({ length: 18 }, () => ({ confidence: 0.1, outcome: 0 as const }))
    ]
    const prm = fitPlatt(fc)
    expect(recalibrate(0.9, prm)).toBeGreaterThan(0.75)
    expect(recalibrate(0.1, prm)).toBeLessThan(0.25)
    expect(recalibrate(0.9, prm)).toBeGreaterThan(recalibrate(0.1, prm)) // order preserved
  })

  it('gates: identity unless n>=minN AND skill>0', () => {
    const big: ScoredForecast[] = Array.from({ length: 25 }, (_, i) => ({ confidence: 0.7, outcome: (i % 2) as 0 | 1 }))
    expect(fitRecalibration([], 0.5).applied).toBe(false) // too few
    expect(fitRecalibration(big, null).applied).toBe(false) // no skill
    expect(fitRecalibration(big, -0.1).applied).toBe(false) // negative skill
    const ok = fitRecalibration(big, 0.5)
    expect(ok.applied).toBe(true)
    expect(ok.params).not.toBeNull()
  })
})
