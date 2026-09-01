import { describe, it, expect } from 'vitest'
import { scoreStaleness, templatedStaleFacts, type EvalFact } from './grounding-eval'

describe('scoreStaleness', () => {
  it('counts TP/FP/TN/FN, computes precision/recall/fpRate, captures buried valid preferences', () => {
    const facts: EvalFact[] = [
      { id: 's1', text: 'stale one', label: 'stale' },
      { id: 's2', text: 'stale two', label: 'stale' },
      { id: 'v1', text: 'valid flagged', label: 'valid' }, // a valid fact the signal wrongly flags
      { id: 'v2', text: 'valid clean', label: 'valid' }
    ]
    const match = (t: string) => (/stale|flagged/.test(t) ? { label: 'topicX' } : null)
    const s = scoreStaleness(facts, match)
    expect(s).toMatchObject({ total: 4, stale: 2, valid: 2, tp: 2, fp: 1, tn: 1, fn: 0 })
    expect(s.precision).toBeCloseTo(2 / 3, 5) // 2 genuinely-stale of 3 flagged
    expect(s.recall).toBe(1) // both stale flagged
    expect(s.fpRate).toBe(0.5) // 1 of 2 valid preferences wrongly flagged — the headline risk
    expect(s.flaggedValid).toEqual([{ id: 'v1', text: 'valid flagged', topic: 'topicX' }])
  })

  it('a signal that flags nothing → fpRate 0 (safe), recall 0, precision null', () => {
    const facts: EvalFact[] = [
      { id: 's1', text: 'x', label: 'stale' },
      { id: 'v1', text: 'y', label: 'valid' }
    ]
    const s = scoreStaleness(facts, () => null)
    expect(s).toMatchObject({ tp: 0, fp: 0, tn: 1, fn: 1, fpRate: 0, recall: 0, precision: null })
  })

  it('nulls the ratios when denominators are empty', () => {
    expect(scoreStaleness([], () => null)).toMatchObject({ total: 0, precision: null, recall: null, fpRate: null })
  })
})

describe('templatedStaleFacts', () => {
  it('templates one stale fact per TITLED decision, carrying the title tokens; skips titleless/blank', () => {
    const facts = templatedStaleFacts([
      { id: 'd1', title: '北澜 campaign scope' },
      { id: 'd2' },
      { id: 'd3', title: '   ' }
    ])
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ id: 'stale:d1', label: 'stale' })
    expect(facts[0].text).toContain('北澜 campaign scope')
  })
})
