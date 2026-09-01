import { describe, it, expect } from 'vitest'
import { empiricalRateForKind } from './calibration-weight'

// The single source of truth for "how often was this KIND right", shared by loadKindRates
// (feedback/ranking) and getCalibration (display) so they can't drift (the E1 invariant).
describe('empiricalRateForKind — per-framing rate selection', () => {
  it('signal kinds → efficacy_rate', () => {
    expect(
      empiricalRateForKind('decision-window', { mode: 'signal', efficacy_rate: 0.8, hit_rate: 0.2, useful_rate: 0.9 })
    ).toBe(0.8)
  })

  it('coupling kinds → useful_rate (averted confirms, refuted falsifies; materialized never fires)', () => {
    for (const kind of ['driver', 'convergence', 'cascade']) {
      expect(
        empiricalRateForKind(kind, { mode: 'forecast', hit_rate: 0, useful_rate: 0.6 })
      ).toBe(0.6)
    }
  })

  it('other forecast kinds → hit_rate (risk-materialization framing)', () => {
    expect(
      empiricalRateForKind('operator-risk', { mode: 'forecast', hit_rate: 0.4, useful_rate: 0.9 })
    ).toBe(0.4)
  })

  it('returns null when the selected rate is absent/non-numeric', () => {
    expect(empiricalRateForKind('driver', { mode: 'forecast', hit_rate: 0.5 })).toBeNull() // no useful_rate
    expect(empiricalRateForKind('operator-risk', { mode: 'forecast' })).toBeNull()
  })
})
