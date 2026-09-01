// GOLDEN lock for _convergence / _subject_overlap. Pins the [count, activity,
// grounding] tuple and the overlap boolean for hand-derived fixtures — the weight
// bucketing (<=1.5 activity vs >=2.0 grounding) and the >=2-token threshold are
// the parts that silently reorder futures rankings if they drift.
import { describe, it, expect } from 'vitest'
import { convergence, subjectOverlap, type PoolEntry } from './convergence-native'

describe('convergence-native — golden (_convergence / _subject_overlap parity)', () => {
  it('convergence: counts >=2-token hits, buckets by weight, sums activity/grounding', () => {
    const pool: PoolEntry[] = [
      ['工美周边 launch plan', 3.0], // ∩ st = {工美,美周,周边} (3) → grounding += 3.0
      ['random noise words only', 1.0], // ∩ = {} → no hit
      ['工美 something roadmap', 2.0], // ∩ = {工美, roadmap} (2) → grounding += 2.0
      ['工美周边 daily sync', 1.5] // ∩ = {工美,美周,周边} (3) → activity += 1.5
    ]
    expect(convergence('工美周边 roadmap', pool)).toEqual([3, 1.5, 5.0])
  })

  it('convergence: <2 shared tokens does not count', () => {
    // subject shares only "roadmap" (1 token) with the single pool entry → no hit
    expect(convergence('roadmap', [['roadmap alone here', 3.0]])).toEqual([0, 0.0, 0.0])
  })

  it('convergence: empty significant-token subject → zeros', () => {
    expect(convergence('task risk', [['anything at all here', 3.0]])).toEqual([0, 0.0, 0.0]) // both stopwords
    expect(convergence('', [['x', 1.0]])).toEqual([0, 0.0, 0.0])
  })

  it('subjectOverlap: true on shared affects token (CJK bigram)', () => {
    expect(subjectOverlap({ affects: '工美周边' }, { affects: '工美工具' })).toBe(true) // share 工美
  })

  it('subjectOverlap: true on >=2 shared tokens across affects+summary', () => {
    expect(
      subjectOverlap(
        { affects: 'alpha', summary: 'roadmap launch details' },
        { affects: 'beta', summary: 'roadmap launch elsewhere' }
      )
    ).toBe(true) // affects differ, but summaries share {roadmap, launch}
  })

  it('subjectOverlap: false when <2 shared and no affects intersection', () => {
    expect(subjectOverlap({ affects: 'alpha', summary: 'roadmap' }, { affects: 'beta', summary: 'launch' })).toBe(false)
  })
})
