import { describe, it, expect } from 'vitest'
import { planCoverBudget } from './index-store'

// COVER's budget policy. The measured failure it serves: a fortnight holds ~138 notes and top-k
// returned 6 (4% coverage), and searchK=30 scored the same 0/18 on aggregation-arms.eval —
// "breadth is not the fix, eligibility is". Cover emits the whole eligible population, so the only
// question left is how to fit it, and the policy is: SHRINK FIDELITY BEFORE DROPPING NOTES.
//
// The two ways this can be wrong are both silent, which is why they are pinned here: emitting a
// snippet so short it says nothing, or dropping notes while claiming to cover a period.

describe('planCoverBudget — the real vault case', () => {
  it('fits ~138 in-window notes without dropping any', () => {
    // 6 ranked hits at ~240 chars, 132 remaining, 24k budget.
    const { snippetChars, room } = planCoverBudget(6 * 240, 132, 24_000)
    expect(room).toBeGreaterThanOrEqual(132) // nothing cut
    expect(snippetChars).toBeGreaterThanOrEqual(60) // still legible
    expect(snippetChars).toBeLessThanOrEqual(240)
    // And it genuinely fits.
    expect(6 * 240 + 132 * snippetChars).toBeLessThanOrEqual(24_000 + snippetChars)
  })
})

describe('planCoverBudget — fidelity shrinks before the population is cut', () => {
  it('uses full fidelity when the population is small', () => {
    expect(planCoverBudget(0, 10, 24_000).snippetChars).toBe(240)
  })

  it('shrinks the snippet as the population grows, rather than dropping notes', () => {
    const small = planCoverBudget(0, 50, 24_000)
    const large = planCoverBudget(0, 300, 24_000)
    expect(large.snippetChars).toBeLessThan(small.snippetChars)
    expect(large.room).toBeGreaterThanOrEqual(300) // still no cut at 300
  })

  it('never goes below the legibility floor', () => {
    // 5,000 notes cannot each get a useful snippet; the floor holds and the cut happens instead.
    const { snippetChars, room } = planCoverBudget(0, 5000, 24_000)
    expect(snippetChars).toBe(60)
    expect(room).toBeLessThan(5000) // → caller reports emitted < eligible
    expect(room).toBe(400) // 24000 / 60
  })
})

describe('planCoverBudget — degenerate inputs stay safe', () => {
  it('handles an empty tail without dividing by zero', () => {
    const r = planCoverBudget(0, 0, 24_000)
    expect(Number.isFinite(r.snippetChars)).toBe(true)
    expect(Number.isFinite(r.room)).toBe(true)
  })

  it('never returns negative room when the ranked head already spent the budget', () => {
    const r = planCoverBudget(50_000, 100, 24_000)
    expect(r.room).toBe(0)
    expect(r.snippetChars).toBe(60)
  })
})
