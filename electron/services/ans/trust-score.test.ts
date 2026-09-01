import { describe, it, expect } from 'vitest'
import { trustScore, snapshotFor, TRUST_COLD_START_FLOOR, type TrustSnapshot } from './trust-score'

const base = (over: Partial<TrustSnapshot> = {}): TrustSnapshot => ({
  ratifyN: 20,
  ratifyK: 20,
  reverts: 0,
  revertsHandled: 0,
  updatedAt: 0,
  skillScore: 0.4,
  now: 1_000_000_000_000,
  ...over
})

describe('trustScore (item 10)', () => {
  it('cold-start: N < MIN_N → floor 0.1, coldStart true', () => {
    const t = trustScore(base({ ratifyN: 3, ratifyK: 3 }))
    expect(t.score).toBe(TRUST_COLD_START_FLOOR)
    expect(t.coldStart).toBe(true)
  })

  it('a strong record scores high and is monotone in skillScore', () => {
    const hi = trustScore(base({ skillScore: 0.9 }))
    const lo = trustScore(base({ skillScore: 0.1 }))
    expect(hi.score).toBeGreaterThan(0.7)
    expect(hi.score).toBeGreaterThan(lo.score)
    expect(hi.coldStart).toBe(false)
  })

  it('P2 ramp: a thin ledger does NOT bank the old 0.85 cliff; credit ramps in with N', () => {
    // Just past cold-start (N == 5) a clean 5/5 cap with UNMEASURED calibration used to score 0.85
    // (neutral-0.5 calib credit + full revert credit on a thin ledger). The ramp gates those two
    // credits across N ∈ [5, 20], so the same cap now scores 0.5 at N=5 and reaches ~0.85 by N=20.
    const thin = trustScore(base({ ratifyN: 5, ratifyK: 5, skillScore: null }))
    const proven = trustScore(base({ ratifyN: 20, ratifyK: 20, skillScore: null }))
    expect(thin.coldStart).toBe(false)
    expect(thin.score).toBeLessThan(0.85) // no cliff
    expect(thin.score).toBeCloseTo(0.5, 5) // only the earned ratify credit banks at N=5
    expect(proven.score).toBeCloseTo(0.85, 5) // full credit by N=20
    expect(thin.score).toBeLessThan(proven.score) // monotone ramp in evidence
  })

  it('a fresh demotion drops the score; the penalty decays over ~months', () => {
    const now = 1_000_000_000_000
    const fresh = trustScore(base({ now, lastDemoteAt: now }))
    const old = trustScore(base({ now, lastDemoteAt: now - 90 * 24 * 3600_000 }))
    expect(fresh.score).toBeLessThan(old.score)
  })

  it('reverts raise revertRate and lower the score', () => {
    const clean = trustScore(base())
    const reverted = trustScore(base({ reverts: 10 }))
    expect(reverted.score).toBeLessThan(clean.score)
    expect(reverted.components.revertRate).toBeGreaterThan(0)
  })

  it('never emits out-of-range or NaN for any input', () => {
    const inputs: TrustSnapshot[] = [
      base({ ratifyN: 0, ratifyK: 0 }),
      base({ ratifyN: 100, ratifyK: 200 }), // ratifyK > N (bad data)
      base({ reverts: -5 }),
      base({ skillScore: null }),
      base({ skillScore: -3 }),
      base({ skillScore: 50 }),
      base({ ratifyN: 7, ratifyK: 0, reverts: 999 })
    ]
    for (const s of inputs) {
      const t = trustScore(s)
      expect(Number.isFinite(t.score)).toBe(true)
      expect(t.score).toBeGreaterThanOrEqual(0.1)
      expect(t.score).toBeLessThanOrEqual(1)
    }
  })

  it('snapshotFor maps a capability row + skill into a snapshot', () => {
    const snap = snapshotFor({ ratifyN: 8, ratifyK: 6, reverts: 1, revertsHandled: 1, updatedAt: 5 }, 0.3, 42)
    expect(snap).toMatchObject({ ratifyN: 8, ratifyK: 6, reverts: 1, skillScore: 0.3, now: 42 })
  })
})
