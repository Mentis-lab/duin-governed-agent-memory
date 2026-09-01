import { describe, it, expect } from 'vitest'
import {
  centroid,
  meanCoherence,
  shouldConsolidate,
  ConsolidationTracker,
  DEFAULT_CONSOLIDATION_POLICY
} from './consolidation-trigger'

describe('centroid', () => {
  it('averages vectors', () => {
    expect(centroid([[0, 0], [2, 4]])).toEqual([1, 2])
    expect(centroid([])).toEqual([])
  })
})

describe('meanCoherence', () => {
  it('is 1 for a single vector', () => {
    expect(meanCoherence([[1, 0]])).toBe(1)
  })
  it('is high for a coherent batch, low for a scattered one', () => {
    expect(meanCoherence([[1, 0], [0.9, 0.1], [1, 0.05]])).toBeGreaterThan(0.9)
    expect(meanCoherence([[1, 0], [0, 1], [-1, 0]])).toBeLessThan(0.5)
  })
})

describe('shouldConsolidate', () => {
  it('needs a batch size within [min,max]', () => {
    expect(shouldConsolidate([[1, 0]])).toBe(false) // size 1 < minBatch
    expect(shouldConsolidate(Array.from({ length: 16 }, () => [1, 0]))).toBe(false) // > maxBatch
  })
  it('needs coherence', () => {
    expect(shouldConsolidate([[1, 0], [0.95, 0.05]])).toBe(true)
    expect(shouldConsolidate([[1, 0], [-1, 0]])).toBe(false) // opposite → incoherent
  })
})

describe('ConsolidationTracker', () => {
  it('grows a topic on similar turns without closing', () => {
    const t = new ConsolidationTracker()
    expect(t.push([1, 0]).closed).toBe(false)
    const e = t.push([0.95, 0.05])
    expect(e.closed).toBe(false)
    expect(e.batchSize).toBe(2)
  })

  it('closes on a semantic shift and flags consolidate for a coherent batch', () => {
    const t = new ConsolidationTracker()
    t.push([1, 0])
    t.push([0.95, 0.05]) // topic A: 2 coherent turns
    const e = t.push([0, 1]) // shift → close A
    expect(e.closed).toBe(true)
    expect(e.batchSize).toBe(2)
    expect(e.consolidate).toBe(true)
    expect(e.topicId).toMatch(/^topic-/)
    // the shifting turn seeds the NEW topic
    expect(t.push([0.05, 0.95]).closed).toBe(false)
  })

  it('does not consolidate a single-turn topic', () => {
    const t = new ConsolidationTracker()
    t.push([1, 0]) // topic A: 1 turn
    const e = t.push([0, 1]) // shift → close A (size 1)
    expect(e.closed).toBe(true)
    expect(e.batchSize).toBe(1)
    expect(e.consolidate).toBe(false)
  })

  it('force-closes an overflowing topic', () => {
    const t = new ConsolidationTracker({ ...DEFAULT_CONSOLIDATION_POLICY, maxBatch: 3 })
    t.push([1, 0])
    t.push([1, 0])
    t.push([1, 0]) // batch = 3 = maxBatch
    const e = t.push([1, 0]) // overflow → close
    expect(e.closed).toBe(true)
    expect(e.batchSize).toBe(3)
  })

  it('ignores empty vectors', () => {
    const t = new ConsolidationTracker()
    expect(t.push([]).closed).toBe(false)
  })

  // Survival-counter persistence: a new tracker instance models a PROCESS RESTART. The
  // previous ordinal counter reset to 0 used to re-mint `topic-1`, so noteSession() saw a
  // topic id it had already banked and stopped accruing survival. The run-nonce fix makes
  // every tracker's ids distinct across lifetimes while staying stable within one.
  const closeThreeTopics = (t: ConsolidationTracker): string[] => {
    // Alternating orthogonal turns each force a shift → close, yielding 3 distinct topic ids.
    const ids: string[] = []
    const seq = [[1, 0], [0, 1], [1, 0], [0, 1]]
    for (const v of seq) {
      const e = t.push(v)
      if (e.closed) ids.push(e.topicId)
    }
    return ids
  }

  it('mints stable, distinct topic ids WITHIN a process', () => {
    const t = new ConsolidationTracker()
    const ids = closeThreeTopics(t)
    expect(ids.length).toBe(3)
    // distinct within the run
    expect(new Set(ids).size).toBe(3)
    // ordinal is preserved + stable per close (…-1, …-2, …-3 under one nonce)
    expect(ids.every((id) => /^topic-.+-\d+$/.test(id))).toBe(true)
    expect(ids[0].replace(/-\d+$/, '')).toBe(ids[2].replace(/-\d+$/, '')) // same run nonce
  })

  it('does NOT collide topic ids across a simulated restart (the survival fix)', () => {
    const run1 = closeThreeTopics(new ConsolidationTracker()) // process 1
    const run2 = closeThreeTopics(new ConsolidationTracker()) // process 2 (restart)
    // No id from the second run repeats one from the first — so noteSession() keeps accruing
    // survival across restarts instead of dedup-swallowing a re-minted `topic-1`.
    const overlap = run2.filter((id) => run1.includes(id))
    expect(overlap).toEqual([])
    expect(new Set([...run1, ...run2]).size).toBe(6)
  })
})
