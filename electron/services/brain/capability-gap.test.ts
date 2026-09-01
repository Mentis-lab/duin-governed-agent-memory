import { describe, it, expect } from 'vitest'
import { detectGaps, clusterCorrections, gapTokens, type FailedEvent } from './capability-gap'

const fails = (type: string, entity: string, n: number): FailedEvent[] =>
  Array.from({ length: n }, () => ({ type, entityId: entity }))

describe('detectGaps — recurring failures', () => {
  it('surfaces a systematically-failing entity (the 170x case)', () => {
    const gaps = detectGaps({ failedEvents: fails('automation.failed', 'e77ed502', 170) })
    expect(gaps).toHaveLength(1)
    expect(gaps[0].kind).toBe('recurring-failure')
    expect(gaps[0].count).toBe(170)
    expect(gaps[0].title).toContain('e77ed502')
    expect(gaps[0].evidence[0]).toContain('170')
  })

  it('ignores one-off/transient failures below MIN_FAILS', () => {
    const gaps = detectGaps({ failedEvents: fails('model.request.failed', 'flaky', 3) })
    expect(gaps).toHaveLength(0)
  })

  it('groups by (type, entity) — two failing things = two gaps', () => {
    const gaps = detectGaps({
      failedEvents: [...fails('automation.failed', 'a1', 170), ...fails('model.request.failed', 'deepseek-v4-flash', 170)]
    })
    expect(gaps).toHaveLength(2)
    expect(gaps.map((g) => g.count)).toEqual([170, 170])
  })
})

describe('detectGaps — correction clusters', () => {
  it('surfaces a dense recurring correction theme (>=3)', () => {
    const gaps = detectGaps({
      corrections: [
        'always cite the source note when summarizing decisions',
        'you must cite the source note for any decision summary',
        'cite the source note, do not paraphrase a decision without it',
        'unrelated: prefer terse replies'
      ]
    })
    const cc = gaps.filter((g) => g.kind === 'correction-cluster')
    expect(cc).toHaveLength(1)
    expect(cc[0].count).toBe(3)
  })

  it('does not fire on a sparse/singleton correction', () => {
    const gaps = detectGaps({ corrections: ['one lonely correction about xyz', 'a totally different note'] })
    expect(gaps.filter((g) => g.kind === 'correction-cluster')).toHaveLength(0)
  })

  it('clusters CJK corrections too (bigrams)', () => {
    const cl = clusterCorrections([
      '回复北澜渠道问题要先看策划源',
      '北澜渠道的口径要以策划源为准',
      '北澜渠道问题看策划源优先'
    ])
    expect(cl.some((c) => c.members.length >= 3)).toBe(true)
  })
})

describe('detectGaps — calibration', () => {
  it('fires on a low hit-rate over a real sample', () => {
    const gaps = detectGaps({ calibration: [{ kind: 'decision-window', hitRate: 0.3, resolved: 10 }] })
    expect(gaps.filter((g) => g.kind === 'calibration')).toHaveLength(1)
  })
  it('ignores a low hit-rate on a tiny sample (nil signal — the dogfood case)', () => {
    const gaps = detectGaps({ calibration: [{ kind: 'decision-window', hitRate: 0, resolved: 1 }] })
    expect(gaps.filter((g) => g.kind === 'calibration')).toHaveLength(0)
  })
  it('ignores a healthy hit-rate', () => {
    const gaps = detectGaps({ calibration: [{ kind: 'deadline-collision', hitRate: 0.8, resolved: 10 }] })
    expect(gaps).toHaveLength(0)
  })
})

describe('detectGaps — ranking + robustness', () => {
  it('ranks by severity desc; corrections weighted above raw failure counts', () => {
    const gaps = detectGaps({
      failedEvents: fails('automation.failed', 'a1', 6),
      corrections: ['cite the note', 'always cite the note', 'cite the note please']
    })
    // correction cluster (3 × 4 = 12) outranks 6 failures
    expect(gaps[0].kind).toBe('correction-cluster')
  })
  it('empty inputs → empty, never throws', () => {
    expect(detectGaps({})).toEqual([])
  })
})

describe('gapTokens', () => {
  it('drops stopwords/short Latin, keeps CJK bigrams', () => {
    expect(gapTokens('the note')).toEqual(['note'])
    expect(gapTokens('北澜')).toEqual(['北澜'])
  })
})
