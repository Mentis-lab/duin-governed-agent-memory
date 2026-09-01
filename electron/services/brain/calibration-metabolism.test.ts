import { describe, it, expect } from 'vitest'
import { computeCalibrationMetabolism, CAL_HALF_LIFE_DAYS, gateStaleKinds } from './calibration-metabolism'
import type { KindRate } from './calibration-weight'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 6, 4)
const rate = (r: number | null, observed: number, gated = false): KindRate => ({ rate: r, observed, gated })

describe('calibration-metabolism — gateStaleKinds (FUSE WS2.3)', () => {
  it('gates a stale-evidence kind, leaves fresh, and does not mutate the input', () => {
    const rates = new Map([
      ['recent', rate(0.8, 10)],
      ['old', rate(0.7, 10)]
    ])
    const rows = [
      { kind: 'recent', resolvedMs: NOW - 5 * DAY },
      { kind: 'old', resolvedMs: NOW - 200 * DAY }
    ]
    const meta = computeCalibrationMetabolism(rates, rows, NOW)
    const gated = gateStaleKinds(rates, meta)
    expect(gated.get('old')!.gated).toBe(true) // stale (200d > 90d) → gated
    expect(gated.get('recent')!.gated).toBe(false) // fresh → untouched
    expect(rates.get('old')!.gated).toBe(false) // input map not mutated (copy)
  })
  it('all-fresh evidence gates nothing', () => {
    const rates = new Map([
      ['a', rate(0.8, 10)],
      ['b', rate(0.6, 10)]
    ])
    const rows = [
      { kind: 'a', resolvedMs: NOW - 2 * DAY },
      { kind: 'b', resolvedMs: NOW - 3 * DAY }
    ]
    const gated = gateStaleKinds(rates, computeCalibrationMetabolism(rates, rows, NOW))
    expect([...gated.values()].every((r) => !r.gated)).toBe(true)
  })
})

describe('calibration-metabolism — currency', () => {
  it('a kind with RECENT evidence is fresh (currency≈1), OLD evidence is stale (currency low)', () => {
    const rates = new Map([
      ['recent', rate(0.8, 10)],
      ['old', rate(0.7, 10)]
    ])
    const rows = [
      { kind: 'recent', resolvedMs: NOW - 5 * DAY },
      { kind: 'old', resolvedMs: NOW - 200 * DAY }
    ]
    const m = computeCalibrationMetabolism(rates, rows, NOW)
    const recent = m.kinds.find((k) => k.kind === 'recent')!
    const old = m.kinds.find((k) => k.kind === 'old')!
    expect(recent.currency).toBeGreaterThan(0.9)
    expect(recent.stale).toBe(false)
    expect(old.currency).toBeLessThan(0.3)
    expect(old.stale).toBe(true) // 200d > 90d half-life
    expect(m.fresh).toBe(1)
    expect(m.stale).toBe(1)
  })

  it('a GATED kind is neither fresh nor stale (insufficient data — the prior rules)', () => {
    const m = computeCalibrationMetabolism(new Map([['thin', rate(null, 1, true)]]), [{ kind: 'thin', resolvedMs: NOW - 300 * DAY }], NOW)
    expect(m.kinds[0].gated).toBe(true)
    expect(m.kinds[0].stale).toBe(false)
    expect(m.fresh).toBe(0)
    expect(m.stale).toBe(0)
  })

  it('a kind with NO resolutions has currency 0 and null newestDaysAgo', () => {
    const m = computeCalibrationMetabolism(new Map([['never', rate(0.5, 5)]]), [], NOW)
    expect(m.kinds[0].currency).toBe(0)
    expect(m.kinds[0].newestDaysAgo).toBeNull()
  })

  it('sorts stalest-first (the kinds to distrust surface at the top)', () => {
    const rates = new Map([['a', rate(0.6, 8)], ['b', rate(0.6, 8)]])
    const rows = [
      { kind: 'a', resolvedMs: NOW - 3 * DAY },
      { kind: 'b', resolvedMs: NOW - 120 * DAY }
    ]
    const m = computeCalibrationMetabolism(rates, rows, NOW)
    expect(m.kinds[0].kind).toBe('b') // stalest first
    expect(m.halfLifeDays).toBe(CAL_HALF_LIFE_DAYS)
  })
})
