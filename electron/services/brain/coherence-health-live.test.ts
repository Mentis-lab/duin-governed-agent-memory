import { describe, it, expect } from 'vitest'
import { freshOverall, NESTED_ROLLUP_MAX_AGE_HOURS } from './coherence-health-live'

// ──────────────────── nested-rollup staleness (Phase 0.4) ────────────────────
//
// Coherence Health is the apex benchmark and it NESTS Brain Health. On 2026-07-30
// Brain Health had not run in 10 days (it fires only after a Construction
// rebuild, and construction had stalled) and the apex score averaged it in as if
// current. A benchmark consuming a stale benchmark manufactures a current-looking
// number from a dead input, which is worse than not running at all.
describe('freshOverall — a stale nested benchmark is not a current signal', () => {
  const NOW = Date.parse('2026-07-30T12:00:00Z')
  const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

  it('passes through a fresh overall', () => {
    expect(freshOverall({ overall: 90, ts: hoursAgo(2) }, NOW, null)).toBe(90)
  })

  it('suppresses the exact live case: a 10-day-old Brain Health score of 90', () => {
    expect(freshOverall({ overall: 90, ts: hoursAgo(240) }, NOW, null)).toBeNull()
  })

  it('holds the boundary in both directions', () => {
    expect(freshOverall({ overall: 50, ts: hoursAgo(71) }, NOW, null)).toBe(50)
    expect(freshOverall({ overall: 50, ts: hoursAgo(73) }, NOW, null)).toBeNull()
  })

  it('falls back to the file mtime when the entry is undated', () => {
    // Undated is not the same as fresh, and treating it as fresh is the bug.
    expect(freshOverall({ overall: 77 }, NOW, NOW - 3_600_000)).toBe(77)
    expect(freshOverall({ overall: 77 }, NOW, NOW - 240 * 3_600_000)).toBeNull()
    expect(freshOverall({ overall: 77 }, NOW, null)).toBeNull()
  })

  it('returns null for a missing or malformed entry', () => {
    expect(freshOverall(null, NOW, NOW)).toBeNull()
    expect(freshOverall({ ts: hoursAgo(1) }, NOW, NOW)).toBeNull()
    expect(freshOverall({ overall: 'ninety', ts: hoursAgo(1) }, NOW, NOW)).toBeNull()
  })

  it('a zero score is a real signal, not a falsy one', () => {
    expect(freshOverall({ overall: 0, ts: hoursAgo(1) }, NOW, null)).toBe(0)
  })

  it('pins the threshold — widening it should be a deliberate change', () => {
    // Generous on purpose: Brain Health is event-driven, so a quiet vault can
    // legitimately go a day or two without a rebuild. 10 days cannot.
    expect(NESTED_ROLLUP_MAX_AGE_HOURS).toBe(72)
  })
})
