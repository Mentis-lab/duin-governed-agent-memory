import { describe, it, expect } from 'vitest'
import { clusterErrors, mineErrorRules, DEFAULT_MINER_POLICY, type ErrorRow } from './error-miner'

const wrong = (track: string, over: Partial<ErrorRow> = {}): ErrorRow => ({
  kind: 'decision-window',
  track,
  verdict: 'materialized',
  outcome: 'slipped',
  confidence: 0.8,
  predicted: `missed a ${track} window`,
  ...over
})
const right = (track: string, over: Partial<ErrorRow> = {}): ErrorRow => ({
  kind: 'decision-window',
  track,
  verdict: 'averted',
  outcome: 'on-time',
  confidence: 0.7,
  ...over
})

describe('clusterErrors', () => {
  it('groups by (kind, track) and scores the error shape', () => {
    const c = clusterErrors([wrong('A'), wrong('A'), right('A'), wrong('B')])
    const a = c.find((x) => x.track === 'A')!
    expect(a.errors).toBe(2)
    expect(a.resolved).toBe(3)
    expect(a.errorRate).toBeCloseTo(0.6667, 3)
    expect(a.meanConfidenceWhenWrong).toBeCloseTo(0.8)
  })

  it('does NOT count unobserved as an error — nobody looked is coverage, not inaccuracy', () => {
    const c = clusterErrors([wrong('A'), { kind: 'decision-window', track: 'A', verdict: 'unobserved' }])
    expect(c[0].resolved).toBe(1)
    expect(c[0].errors).toBe(1)
  })

  it('excludes moot/unresolved rows from the denominator', () => {
    const c = clusterErrors([wrong('A'), { kind: 'decision-window', track: 'A', verdict: 'averted', outcome: 'moot' }])
    expect(c[0].resolved).toBe(1)
  })

  it('orders the worst pattern first', () => {
    const c = clusterErrors([wrong('A'), wrong('A'), wrong('A'), wrong('B'), right('B')])
    expect(c[0].track).toBe('A')
  })

  it('separates kinds — a driver error is not a decision-window error', () => {
    const c = clusterErrors([wrong('A'), wrong('A', { kind: 'driver' })])
    expect(c).toHaveLength(2)
  })
})

describe('mineErrorRules', () => {
  it('emits a candidate only once a pattern clears both thresholds', () => {
    // 2 errors — below minErrors (3), even at a 100% rate.
    expect(mineErrorRules([wrong('A'), wrong('A')])).toEqual([])
    // 3 errors at 100% — a pattern.
    const out = mineErrorRules([wrong('A'), wrong('A'), wrong('A')])
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('sharpen-rule')
    expect(out[0].targetId).toBe('error-cluster:decision-window::A')
  })

  it('does not indict a big domain that is mostly RIGHT', () => {
    const rows = [wrong('A'), wrong('A'), wrong('A'), ...Array.from({ length: 20 }, () => right('A'))]
    expect(mineErrorRules(rows)).toEqual([]) // 3 errors but rate 0.13 < minErrorRate
  })

  it('names confidently-wrong clusters as a model problem, not a sampling problem', () => {
    const out = mineErrorRules([wrong('A', { confidence: 0.9 }), wrong('A', { confidence: 0.9 }), wrong('A', { confidence: 0.9 })])
    expect(out[0].rationale).toMatch(/confidently wrong/i)
    expect(out[0].rationale).toMatch(/0\.9/)
  })

  it('every candidate is reversible and caps at maxCandidates', () => {
    const rows: ErrorRow[] = []
    for (let i = 0; i < DEFAULT_MINER_POLICY.maxCandidates + 5; i++) {
      rows.push(wrong(`t${i}`), wrong(`t${i}`), wrong(`t${i}`))
    }
    const out = mineErrorRules(rows)
    expect(out.length).toBe(DEFAULT_MINER_POLICY.maxCandidates)
    expect(out.every((o) => o.reversible)).toBe(true)
  })

  it('an empty ledger mines nothing rather than inventing a rule', () => {
    expect(mineErrorRules([])).toEqual([])
  })
})
