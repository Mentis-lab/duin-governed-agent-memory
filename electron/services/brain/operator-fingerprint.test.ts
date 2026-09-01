import { describe, it, expect } from 'vitest'
import { computeFingerprint, N_FLOOR, N_GATE, type ForecastConfidenceLike } from './operator-fingerprint'
import type { DecisionRow } from './decisions-native'

const dec = (over: Partial<DecisionRow>): DecisionRow => ({
  id: 'd',
  title: 't',
  date: '2026-01-01',
  status: 'decided',
  oneWay: false,
  reversibility: 'reversible',
  owner: '',
  reviewOn: '',
  links: 0,
  layer: '',
  domain: '',
  ...over
})
const oneWay = (n: number): DecisionRow[] => Array.from({ length: n }, () => dec({ oneWay: true, reversibility: 'one-way' }))
const reversibleExplicit = (n: number): DecisionRow[] => Array.from({ length: n }, () => dec({ oneWay: false, reversibility: 'reversible' }))
const unrecorded = (n: number): DecisionRow[] => Array.from({ length: n }, () => dec({ oneWay: false, reversibility: '—' }))
const fc = (confidence: number | null | undefined): ForecastConfidenceLike => ({ confidence })
const axis = (fp: ReturnType<typeof computeFingerprint>, id: string) => fp.axes.find((a) => a.id === id)!

const NOW = 1_720_000_000_000

describe('computeFingerprint — cold start', () => {
  it('no decisions and no forecasts → axes: [] (nothing to mirror)', () => {
    const fp = computeFingerprint([], [], { now: NOW })
    expect(fp.axes).toEqual([])
    expect(fp.totalDecisions).toBe(0)
    expect(fp.minN).toBe(N_GATE)
    expect(fp.generatedAt).toBe(NOW)
  })
})

describe('computeFingerprint — the two-tier gate (reversibility axis)', () => {
  it('below N_FLOOR → silent: ratio null, ci null, lean null', () => {
    const fp = computeFingerprint([...oneWay(2), ...reversibleExplicit(2)], [], { now: NOW }) // explicitN = 4 < 5
    const a = axis(fp, 'reversibility-lean')
    expect(a.explicitN).toBe(4)
    expect(a.gate).toBe('silent')
    expect(a.ratio).toBeNull()
    expect(a.ci).toEqual([null, null])
    expect(a.lean).toBeNull()
  })

  it('N_FLOOR..N_GATE → observe: shows a smoothed ratio + band but claims NO direction', () => {
    const fp = computeFingerprint([...oneWay(6), ...reversibleExplicit(2)], [], { now: NOW }) // explicitN = 8
    const a = axis(fp, 'reversibility-lean')
    expect(a.gate).toBe('observe')
    expect(a.ratio).not.toBeNull()
    expect(a.ratio).toBeCloseTo((6 + 1) / (8 + 2), 3) // smoothed over the full-n display denom
    expect(a.lean).toBeNull() // no direction claimed mid-tier
  })

  it('at/above N_GATE with a band clearing 0.5 → lean A (one-way)', () => {
    const fp = computeFingerprint(oneWay(20), [], { now: NOW }) // explicitN 20, all one-way
    const a = axis(fp, 'reversibility-lean')
    expect(a.gate).toBe('norm')
    expect(a.lean).toBe('A')
    expect(a.ci[0]!).toBeGreaterThan(0.5)
  })

  it('band straddling 0.5 → balanced (no false confidence on a near-even split)', () => {
    const fp = computeFingerprint([...oneWay(6), ...reversibleExplicit(6)], [], { now: NOW }) // 12 explicit, 6/6
    const a = axis(fp, 'reversibility-lean')
    expect(a.gate).toBe('norm')
    expect(a.lean).toBe('balanced')
    expect(a.ci[0]!).toBeLessThan(0.5)
    expect(a.ci[1]!).toBeGreaterThan(0.5)
  })

  it('mostly-reversible explicit sample → lean B', () => {
    const fp = computeFingerprint([...oneWay(1), ...reversibleExplicit(14)], [], { now: NOW })
    const a = axis(fp, 'reversibility-lean')
    expect(a.gate).toBe('norm')
    expect(a.lean).toBe('B')
    expect(a.ci[1]!).toBeLessThan(0.5)
  })
})

describe('computeFingerprint — explicitN bias guard (the flagship honesty test)', () => {
  it('leans on explicitN, NOT total: 20 one-way + 40 unrecorded → lean A even though full-n ratio looks reversible', () => {
    const decisions = [...oneWay(20), ...unrecorded(40)]
    const fp = computeFingerprint(decisions, [], { now: NOW })
    const a = axis(fp, 'reversibility-lean')
    expect(a.total).toBe(60)
    expect(a.n).toBe(60) // full classifiable
    expect(a.explicitN).toBe(20) // only the recorded ones
    expect(a.countA).toBe(20)
    // full-n shown ratio is diluted by the 40 unrecorded (looks reversible-leaning)...
    expect(a.ratio!).toBeLessThan(0.5)
    // ...but the lean is computed on the explicit-only band → correctly A (one-way)
    expect(a.gate).toBe('norm')
    expect(a.lean).toBe('A')
  })

  it('a pile of unrecorded decisions never manufactures a reversible lean', () => {
    const fp = computeFingerprint(unrecorded(50), [], { now: NOW }) // explicitN = 0
    const a = axis(fp, 'reversibility-lean')
    expect(a.explicitN).toBe(0)
    expect(a.gate).toBe('silent')
    expect(a.lean).toBeNull()
  })
})

describe('computeFingerprint — forecast-optimism axis (calibration bridge)', () => {
  it('buckets high(≥0.85)=confident vs med+low=hedged; untagged excluded from n', () => {
    const forecasts = [
      ...Array.from({ length: 12 }, () => fc(0.9)), // confident
      ...Array.from({ length: 3 }, () => fc(0.6)), // hedged
      fc(undefined), // untagged → excluded
      fc(null) // untagged → excluded
    ]
    const fp = computeFingerprint([], forecasts, { now: NOW })
    const a = axis(fp, 'forecast-optimism')
    expect(a.countA).toBe(12)
    expect(a.countB).toBe(3)
    expect(a.n).toBe(15) // untagged excluded
    expect(a.total).toBe(17)
    expect(a.gate).toBe('norm')
    expect(a.lean).toBe('A') // confidently overconfident
    expect(a.source).toBe('forecast-ledger')
  })

  it('boundary: exactly 0.85 is confident, just under is hedged', () => {
    const fp = computeFingerprint([], [fc(0.85), fc(0.8499)], { now: NOW })
    const a = axis(fp, 'forecast-optimism')
    expect(a.countA).toBe(1)
    expect(a.countB).toBe(1)
  })
})

describe('computeFingerprint — deferred axes shipped honestly', () => {
  it('conviction-reversal + outcome-follow-through present as needs-capture placeholders', () => {
    const fp = computeFingerprint(oneWay(3), [], { now: NOW })
    for (const id of ['conviction-reversal', 'outcome-follow-through']) {
      const a = axis(fp, id)
      expect(a.derivable).toBe('needs-capture')
      expect(a.ratio).toBeNull()
      expect(a.lean).toBeNull()
    }
  })
})

describe('computeFingerprint — options + scope metadata', () => {
  it('records windowDays/domain scope without pre-filtering (P1 headline)', () => {
    const fp = computeFingerprint(oneWay(3), [], { now: NOW, windowDays: 365, domain: 'career' })
    expect(fp.scope).toEqual({ windowDays: 365, domain: 'career' })
  })
  it('respects overridden tiers', () => {
    const fp = computeFingerprint(oneWay(6), [], { now: NOW, nFloor: N_FLOOR, nGate: 6 })
    expect(axis(fp, 'reversibility-lean').gate).toBe('norm') // 6 ≥ nGate override
  })
})
