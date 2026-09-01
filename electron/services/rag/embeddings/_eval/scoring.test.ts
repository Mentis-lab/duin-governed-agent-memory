import { describe, it, expect } from 'vitest'
import { rankOf, scoreByBucket, multilingualWins, type LabeledQuery, type BucketScore } from './scoring'

describe('rankOf', () => {
  it('1-based rank, 0 when absent', () => {
    expect(rankOf(['a', 'b', 'c'], 'b')).toBe(2)
    expect(rankOf(['a', 'b'], 'z')).toBe(0)
    expect(rankOf(['x'], 'x')).toBe(1)
  })
})

describe('scoreByBucket', () => {
  const labels: LabeledQuery[] = [
    { query: 'q1', expectNote: 'n1', bucket: 'cn-paraphrase' },
    { query: 'q2', expectNote: 'n2', bucket: 'cn-paraphrase' },
    { query: 'q3', expectNote: 'n3', bucket: 'en' }
  ]
  it('computes recall@5 + MRR per bucket', () => {
    const retrieved = new Map<string, string[]>([
      ['q1', ['n1', 'x', 'y']], // hit @1
      ['q2', ['a', 'b', 'c', 'd', 'e', 'n2']], // present but rank 6 → outside top-5
      ['q3', ['z', 'n3']] // hit @2
    ])
    const scores = scoreByBucket(labels, retrieved, 5)
    const cn = scores.find((s) => s.bucket === 'cn-paraphrase')!
    const en = scores.find((s) => s.bucket === 'en')!
    expect(cn.n).toBe(2)
    expect(cn.recallAt5).toBe(0.5) // only q1 in top-5
    expect(cn.mrr).toBeCloseTo((1 / 1 + 1 / 6) / 2, 5) // both present: ranks 1 and 6
    expect(en.recallAt5).toBe(1)
    expect(en.mrr).toBeCloseTo(0.5, 5)
  })
  it('missing query → counted as a miss, not skipped', () => {
    const scores = scoreByBucket(labels, new Map(), 5)
    expect(scores.find((s) => s.bucket === 'cn-paraphrase')!.recallAt5).toBe(0)
  })
})

describe('multilingualWins (the promotion gate)', () => {
  const mk = (cn: number, en: number): BucketScore[] => [
    { bucket: 'cn-paraphrase', n: 10, recallAt5: cn, mrr: cn },
    { bucket: 'en', n: 10, recallAt5: en, mrr: en }
  ]
  it('promotes when CN-paraphrase lifts a real margin AND EN holds', () => {
    expect(multilingualWins(mk(0.4, 0.8), mk(0.7, 0.8))).toBe(true)
  })
  it('rejects a CN lift that REGRESSES English (the moat against a bad swap)', () => {
    expect(multilingualWins(mk(0.4, 0.8), mk(0.7, 0.7))).toBe(false) // EN dropped 0.1 > tol
  })
  it('rejects a negligible CN lift', () => {
    expect(multilingualWins(mk(0.6, 0.8), mk(0.63, 0.8))).toBe(false) // +0.03 < 0.05
  })
  it('the reverted e5 case (no CN win) does not promote', () => {
    expect(multilingualWins(mk(0.5, 0.8), mk(0.5, 0.8))).toBe(false)
  })
})
