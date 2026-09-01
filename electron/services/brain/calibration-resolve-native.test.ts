import { describe, it, expect } from 'vitest'
import {
  resolveAndScore,
  resolveCoupling,
  wilson,
  pyRound,
  type LedgerRow
} from './calibration-resolve-native'

describe('resolveAndScore', () => {
  const today = new Date('2026-07-01T00:00:00Z')

  it('resolves a subjects-bearing row: still-open subject → materialized, closed → averted', () => {
    const rows: LedgerRow[] = [
      { id: 'a', kind: 'cascade', verdict: null, subjects: ['t1'], confidence: 0.75, eval_after: { by: '2026-06-01' } },
      { id: 'b', kind: 'cascade', verdict: null, subjects: ['t2'], confidence: 0.75, eval_after: { by: '2026-06-01' } }
    ]
    const r = resolveAndScore(rows, new Set(['t1']), today) // t1 open, t2 closed
    expect(rows[0].verdict).toBe('materialized')
    expect(rows[0].outcome).toBe('hit')
    expect(rows[1].verdict).toBe('averted')
    expect(rows[1].outcome).toBe('useful')
    expect(r.resolved_this_run).toBe(2)
  })

  it('HONEST decision-window grading (P4a): a closed subject is NOT a free on-time credit', () => {
    // The self-graded 0.887 came from "stream closed → averted (on-time)". A stream leaves
    // open_ids for ANY reason, so a close is not proof of an on-time decision.
    const rows: LedgerRow[] = [
      // still open past eval → observably slipped → materialized (a real MISS, counts against)
      { id: 'decide::s1', kind: 'decision-window', verdict: null, subjects: ['s1'], eval_after: { by: '2026-06-01' } },
      // closed, NO operator confirmation → unobserved (EXCLUDED — never a free averted)
      { id: 'decide::s2', kind: 'decision-window', verdict: null, subjects: ['s2'], eval_after: { by: '2026-06-01' } },
      // explicit operator hit → averted (a GENUINE recorded on-time decision, preserved)
      { id: 'decide::s3', kind: 'decision-window', verdict: null, subjects: ['s3'], resolution: 'hit', eval_after: { by: '2026-06-01' } }
    ]
    const { patterns } = resolveAndScore(rows, new Set(['s1']), today) // s1 open; s2,s3 closed
    expect(rows[0].verdict).toBe('materialized') // slipped
    expect(rows[1].verdict).toBe('unobserved') // NOT averted — the free win is gone
    expect(rows[2].verdict).toBe('averted') // confirmed on-time survives
    const dw = patterns['decision-window'] as Record<string, unknown>
    // efficacy = confirmed-on-time / (on-time + slips) = 1 / (1 + 1) = 0.5 (honest), NOT ~1.0
    expect(dw.efficacy_rate).toBe(0.5)
    expect(dw.averted).toBe(1)
    expect(dw.slipped).toBe(1)
    expect(dw.unobserved).toBe(1) // excluded from the rate
  })

  it('honest decision-window: the OLD rule would have inflated the same ledger to 1.0', () => {
    // Contrast probe: under the removed "closed → averted" rule, both closed subjects would
    // have been on-time → efficacy 1.0. The honest rule refuses that inflation.
    const rows: LedgerRow[] = [
      { id: 'decide::a', kind: 'decision-window', verdict: null, subjects: ['a'], eval_after: { by: '2026-06-01' } },
      { id: 'decide::b', kind: 'decision-window', verdict: null, subjects: ['b'], eval_after: { by: '2026-06-01' } }
    ]
    const { patterns } = resolveAndScore(rows, new Set(), today) // both closed
    const dw = patterns['decision-window'] as Record<string, unknown>
    // no confirmed on-time, no observed slip → efficacy null (honest: nothing to grade), NOT 1.0
    expect(dw.efficacy_rate).toBe(null)
    expect(dw.averted).toBe(0)
  })

  it('leaves a not-yet-due row (eval_after in future) OPEN', () => {
    const rows: LedgerRow[] = [{ id: 'c', kind: 'driver', verdict: null, subjects: ['x'], eval_after: { by: '2099-01-01' } }]
    resolveAndScore(rows, new Set(['x']), today)
    expect(rows[0].verdict).toBe(null)
  })

  it('scores forecast tiers (Wilson + gated) and signal efficacy separately', () => {
    const rows: LedgerRow[] = [
      { kind: 'cascade', verdict: 'materialized', confidence: 0.85 },
      { kind: 'cascade', verdict: 'averted', confidence: 0.85 },
      { kind: 'decision-window', verdict: 'averted', confidence: 0.8 } // signal → efficacy, not tier
    ]
    const { patterns, confidence_calibration } = resolveAndScore(rows, new Set(), today)
    expect((patterns['cascade'] as Record<string, unknown>).useful_rate).toBe(1) // 2/2 useful
    expect((patterns['decision-window'] as Record<string, unknown>).mode).toBe('signal')
    expect((patterns['decision-window'] as Record<string, unknown>).efficacy_rate).toBe(1)
    expect(confidence_calibration.high.observed).toBe(2)
    expect(confidence_calibration.high.gated).toBe(true) // 2 < min_n(20)
    expect(confidence_calibration.high.wilson_lo).not.toBe(null)
    // signal row must NOT enter the probabilistic tiers
    expect(confidence_calibration.med.fired).toBe(0)
  })

  it('resolveCoupling — falsifiable co-movement verdicts', () => {
    const S = (...ids: string[]): Set<string> => new Set(ids)
    // all subjects still open → unobserved (no falsifiable movement; the de-inflation)
    expect(resolveCoupling(['a', 'b', 'c'], S('a', 'b', 'c'))).toBe('unobserved')
    // all closed → averted (co-moved to resolution)
    expect(resolveCoupling(['a', 'b', 'c'], S())).toBe('averted')
    // even 2-way split → refuted (subjects diverged → coupling falsified)
    expect(resolveCoupling(['a', 'b'], S('a'))).toBe('refuted')
    // 2-of-4 split → refuted
    expect(resolveCoupling(['a', 'b', 'c', 'd'], S('a', 'b'))).toBe('refuted')
    // 1-of-3 minority (0.333 ≥ 0.33) → refuted
    expect(resolveCoupling(['a', 'b', 'c'], S('a'))).toBe('refuted')
    // 1-of-5 stray, majority closed → averted (noise, not divergence)
    expect(resolveCoupling(['a', 'b', 'c', 'd', 'e'], S('a'))).toBe('averted')
    // 1-of-5 stray, majority open → unobserved (majority still-open is uninformative)
    expect(resolveCoupling(['a', 'b', 'c', 'd', 'e'], S('a', 'b', 'c', 'd'))).toBe('unobserved')
  })

  it('a driver whose stream-ids all stay open is UNOBSERVED, not an inflated hit', () => {
    const rows: LedgerRow[] = [
      { id: 'd', kind: 'driver', verdict: null, subjects: ['s1', 's2', 's3'], confidence: 0.9, eval_after: { by: '2026-06-01' } }
    ]
    const r = resolveAndScore(rows, new Set(['s1', 's2', 's3']), today) // all streams still open
    expect(rows[0].verdict).toBe('unobserved') // was 'materialized' under the old openness rule
    expect(r.resolved_this_run).toBe(1)
    // unobserved is a scoring no-op: it never enters the confidence tiers' observed count
    expect(r.confidence_calibration.high.observed).toBe(0)
    expect((r.patterns['driver'] as Record<string, unknown>).hit_rate).toBe(null)
  })

  it('a driver whose streams DIVERGE resolves to refuted (a miss the old rule could not produce)', () => {
    const rows: LedgerRow[] = [
      { id: 'd', kind: 'driver', verdict: null, subjects: ['s1', 's2'], confidence: 0.9, eval_after: { by: '2026-06-01' } }
    ]
    resolveAndScore(rows, new Set(['s1']), today) // s1 open, s2 closed → diverged
    expect(rows[0].verdict).toBe('refuted')
    expect(rows[0].outcome).toBe('miss')
  })

  it('single-subject subjects-bearing rows keep the legacy persistence rule (parity preserved)', () => {
    const rows: LedgerRow[] = [
      { id: 'a', kind: 'cascade', verdict: null, subjects: ['t1'], eval_after: { by: '2026-06-01' } },
      { id: 'b', kind: 'cascade', verdict: null, subjects: ['t2'], eval_after: { by: '2026-06-01' } }
    ]
    resolveAndScore(rows, new Set(['t1']), today)
    expect(rows[0].verdict).toBe('materialized') // lone open subject → persisted
    expect(rows[1].verdict).toBe('averted')
  })

  it('wilson + pyRound match the Python formulas', () => {
    expect(wilson(3, 3)).toEqual([0.438, 1]) // matches server.py sample (med tier n=3)
    expect(pyRound(0.6667, 3)).toBe(0.667)
    expect(pyRound(2.5, 0)).toBe(2) // round-half-to-even
    expect(pyRound(3.5, 0)).toBe(4)
  })
})
