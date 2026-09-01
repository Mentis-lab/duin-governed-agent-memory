import { describe, it, expect } from 'vitest'
import {
  replaySet,
  backwardRetentionGate,
  type PromotionPredictionRecord
} from './promotion-retention'

// Measure — backward-retention (SIP-Bench). The gate + replay derivation are pure.

const rec = (over: Partial<PromotionPredictionRecord>): PromotionPredictionRecord => ({
  id: 'p1',
  engine: 'recall',
  expected_behavior: 'x',
  verdict: 'passed',
  passed_at_fitness: 0.7,
  created: '2026-07-18',
  ...over
})

describe('replaySet', () => {
  it('keeps only resolved-passed records with a numeric fitness', () => {
    const set = replaySet([
      rec({ id: 'a', verdict: 'passed', passed_at_fitness: 0.7 }),
      rec({ id: 'b', verdict: 'failed', passed_at_fitness: 0.6 }),
      rec({ id: 'c', verdict: 'passed', passed_at_fitness: null }),
      rec({ id: 'd', verdict: '', passed_at_fitness: 0.9 })
    ])
    expect(set.map((r) => r.id)).toEqual(['a'])
  })
})

describe('backwardRetentionGate', () => {
  const replay = [
    { id: 'a', engine: 'recall', passedAtFitness: 0.7 },
    { id: 'b', engine: 'calibration', passedAtFitness: 0.6 }
  ]

  it('retains when every engine holds at/above its validated level', () => {
    const r = backwardRetentionGate(replay, (e) => (e === 'recall' ? 0.72 : 0.61))
    expect(r.retained).toBe(true)
    expect(r.regressions).toEqual([])
    expect(r.retentionRate).toBe(1)
  })

  it('BLOCKS when an engine dropped materially below its validated level', () => {
    const r = backwardRetentionGate(replay, (e) => (e === 'recall' ? 0.5 : 0.61))
    expect(r.retained).toBe(false)
    expect(r.regressions).toEqual([{ id: 'a', engine: 'recall', was: 0.7, now: 0.5 }])
    expect(r.retentionRate).toBe(0.5)
  })

  it('tolerates sub-threshold jitter (0.05 default)', () => {
    const r = backwardRetentionGate(replay, (e) => (e === 'recall' ? 0.67 : 0.6))
    expect(r.retained).toBe(true)
  })

  it('skips an engine whose current score is unknown (fail-safe-open)', () => {
    const r = backwardRetentionGate(replay, (e) => (e === 'recall' ? null : 0.61))
    expect(r.retained).toBe(true)
    expect(r.retentionRate).toBe(1) // only the measurable (calibration) counts, and it held
  })

  it('an empty replay set retains trivially', () => {
    const r = backwardRetentionGate([], () => null)
    expect(r).toEqual({ retained: true, regressions: [], retentionRate: 1 })
  })
})
