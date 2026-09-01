import { describe, it, expect } from 'vitest'
import {
  computeCalibration,
  autoVerdict,
  calibrateConfidence,
  CALIBRATION_MAX_SHIFT,
  CALIBRATION_FLOOR
} from './calibration'
import type { LoggedPrediction, VerdictOutcome } from './types'

function p(id: string, kind: string, outcome: VerdictOutcome, created_at = '2026-01-01'): LoggedPrediction {
  return { id, kind, title: id, due: null, confidence: 0.7, track: null, created_at, outcome }
}

describe('computeCalibration', () => {
  it('computes per-kind hit_rate = (happened + averted) / resolved', () => {
    const r = computeCalibration([
      p('a', 'decision-window', 'happened'),
      p('b', 'decision-window', 'averted'),
      p('c', 'decision-window', 'false_alarm'),
      p('d', 'decision-window', 'unobserved'), // excluded from resolved
      p('e', 'deadline-collision', 'false_alarm')
    ])
    const dw = r.buckets.find((b) => b.kind === 'decision-window')!
    expect(dw.total).toBe(4)
    expect(dw.resolved).toBe(3)
    expect(dw.hit_rate).toBeCloseTo(2 / 3)
    expect(dw.unobserved).toBe(1)

    const dc = r.buckets.find((b) => b.kind === 'deadline-collision')!
    expect(dc.hit_rate).toBe(0)

    expect(r.totals.logged).toBe(5)
    expect(r.totals.resolved).toBe(4)
    expect(r.totals.hit_rate).toBeCloseTo(2 / 4)
  })

  it('returns null hit_rate when nothing is resolved yet', () => {
    const r = computeCalibration([p('a', 'x', 'unobserved')])
    expect(r.buckets[0].hit_rate).toBeNull()
    expect(r.totals.hit_rate).toBeNull()
  })

  it('orders recent predictions newest-first and caps at 20', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      p(`p${i}`, 'x', 'unobserved', `2026-01-${String(i + 1).padStart(2, '0')}`)
    )
    const r = computeCalibration(many)
    expect(r.recent).toHaveLength(20)
    expect(r.recent[0].id).toBe('p24') // 2026-01-25 = newest
  })

  it('handles an empty ledger', () => {
    const r = computeCalibration([])
    expect(r.buckets).toHaveLength(0)
    expect(r.totals).toEqual({ logged: 0, resolved: 0, hit_rate: null })
  })

  it('EXCLUDES expired-unconfirmed from the denominator, dropping the honest rate (P4a)', () => {
    // Same ledger as the first test but the two former free clock-wins are now
    // 'expired-unconfirmed' instead of 'happened'. The honest rate must DROP.
    const dishonest = computeCalibration([
      p('a', 'decision-window', 'happened'), // was a free clock-win
      p('b', 'decision-window', 'happened'), // was a free clock-win
      p('c', 'decision-window', 'averted'), // a genuine recorded decision
      p('d', 'decision-window', 'false_alarm')
    ])
    const honest = computeCalibration([
      p('a', 'decision-window', 'expired-unconfirmed'),
      p('b', 'decision-window', 'expired-unconfirmed'),
      p('c', 'decision-window', 'averted'),
      p('d', 'decision-window', 'false_alarm')
    ])
    const dh = dishonest.buckets[0]
    const hh = honest.buckets[0]
    // before: (2 happened + 1 averted) / 4 resolved = 0.75
    expect(dh.hit_rate).toBeCloseTo(0.75)
    // after: the two expired drop OUT of resolved → (0 + 1 averted) / (1 averted + 1 false_alarm) = 0.5
    expect(hh.expired).toBe(2)
    expect(hh.resolved).toBe(2)
    expect(hh.hit_rate).toBeCloseTo(0.5)
    expect(hh.hit_rate!).toBeLessThan(dh.hit_rate!) // honest grading is LOWER
    expect(hh.total).toBe(4) // still counted as fired
  })
})

describe('calibrateConfidence (P4b — bounded empirical wire)', () => {
  it('returns the prior UNCHANGED when the rate is gated (below min_n) or missing', () => {
    expect(calibrateConfidence(0.8, 0.2, 5)).toBe(0.8) // observed < 20 → gated
    expect(calibrateConfidence(0.8, null, 100)).toBe(0.8) // no rate → prior
  })
  it('nudges the prior TOWARD a healthy empirical rate when non-gated', () => {
    const out = calibrateConfidence(0.65, 0.9, 200)
    expect(out).toBeGreaterThan(0.65)
    expect(out).toBeLessThanOrEqual(0.65 + CALIBRATION_MAX_SHIFT)
  })
  it('CAPS the shift so an extreme rate cannot swing behaviour wildly', () => {
    // rate 0 against a 0.85 prior would pull it to 0 unbounded; the cap holds it.
    const out = calibrateConfidence(0.85, 0.0, 500)
    expect(out).toBeCloseTo(0.85 - CALIBRATION_MAX_SHIFT) // exactly one cap step down
    expect(out).toBeGreaterThanOrEqual(CALIBRATION_FLOOR) // never hard-suppressed to 0
  })
  it('never drops below the floor — the signal informs, it does not silence', () => {
    const out = calibrateConfidence(0.1, 0.0, 500)
    expect(out).toBeGreaterThanOrEqual(CALIBRATION_FLOOR)
  })
})

describe('autoVerdict', () => {
  const today = '2026-06-21'
  it('marks a decision-window AVERTED when the node was decided', () => {
    const v = autoVerdict({ id: 'decide::seed:decision', kind: 'decision-window', due: '2026-07-05' }, new Set(['seed:decision']), today)
    expect(v).toBe('averted')
  })
  it('does NOT credit a passed decide-by with no recorded decision as a success (P4a honest grading)', () => {
    // The free clock-win removed: a lapsed window with no recorded decision is
    // 'expired-unconfirmed' (excluded), never 'happened'/'averted'/a hit.
    const v = autoVerdict({ id: 'decide::n1', kind: 'decision-window', due: '2026-06-10' }, new Set(), today)
    expect(v).toBe('expired-unconfirmed')
    expect(v).not.toBe('happened')
    expect(v).not.toBe('averted')
  })
  it('still resolves a decision-window from a GENUINE recorded decision → averted (P4a preserves real outcomes)', () => {
    const v = autoVerdict({ id: 'decide::n1', kind: 'decision-window', due: '2026-06-10' }, new Set(['n1']), today)
    expect(v).toBe('averted')
  })
  it('leaves a decision-window OPEN (null) when due is future and undecided', () => {
    const v = autoVerdict({ id: 'decide::n1', kind: 'decision-window', due: '2026-07-30' }, new Set(), today)
    expect(v).toBeNull()
  })
  it('does not auto-resolve deadline-collision (no reliable signal)', () => {
    const v = autoVerdict({ id: 'collision::2026-07-01', kind: 'deadline-collision', due: '2026-07-01' }, new Set(), today)
    expect(v).toBeNull()
  })
  it('marks a decision-window UNOBSERVED when the node was a non-substantive call (dismissed/cancelled)', () => {
    // due is past, but the neutral set must win over the happened fallback so a
    // dismissed/cancelled call is excluded from the hit-rate denominator.
    const v = autoVerdict(
      { id: 'decide::n2', kind: 'decision-window', due: '2026-06-10' },
      new Set(),
      today,
      new Set(['n2'])
    )
    expect(v).toBe('unobserved')
  })
  it('treats a node in BOTH decided and neutral as averted (substantive takes precedence)', () => {
    const v = autoVerdict(
      { id: 'decide::n3', kind: 'decision-window', due: '2026-07-30' },
      new Set(['n3']),
      today,
      new Set(['n3'])
    )
    expect(v).toBe('averted')
  })
})
