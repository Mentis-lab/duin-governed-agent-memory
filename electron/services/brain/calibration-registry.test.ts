import { describe, expect, it } from 'vitest'

import {
  ACTIVE_RETRIEVAL_CONTEXT,
  CONSTANT_REGISTRY,
  auditConstants,
  type RegisteredConstant
} from './calibration-registry'

const TODAY = '2026-07-28'
const cal = (over: Partial<RegisteredConstant['calibration']> = {}) => ({
  measuredAt: '2026-07-28',
  context: 'ctx-A',
  observed: { min: 0.4, max: 0.7, n: 50 },
  ...over
}) as NonNullable<RegisteredConstant['calibration']>

const one = (c: Partial<RegisteredConstant> = {}): RegisteredConstant => ({
  id: 'mod.C',
  value: 0.5,
  intent: 'threshold',
  signal: 'sig',
  calibration: cal(),
  ...c
})

describe('auditConstants — the unfireable check is the point', () => {
  it('flags a threshold BELOW the whole observed range as unfireable', () => {
    const [f] = auditConstants([one({ value: 0.2 })], { today: TODAY })
    expect(f.kind).toBe('unfireable-low')
    expect(f.severity).toBe('high')
    expect(f.detail).toContain('can never fire')
  })

  it('flags a threshold ABOVE the whole observed range as unconditional', () => {
    const [f] = auditConstants([one({ value: 0.95 })], { today: TODAY })
    expect(f.kind).toBe('unfireable-high')
    expect(f.severity).toBe('high')
  })

  it('accepts a threshold inside the range', () => {
    expect(auditConstants([one({ value: 0.55 })], { today: TODAY })[0].kind).toBe('ok')
  })

  it('does not range-check a WEIGHT — the check is meaningless for a relative weight', () => {
    expect(auditConstants([one({ intent: 'weight', value: 99 })], { today: TODAY })[0].kind).toBe('ok')
  })

  it('does not range-check against an empty measurement', () => {
    const c = one({ value: 0.01, calibration: cal({ observed: { min: 0, max: 0, n: 0 } }) })
    expect(auditConstants([c], { today: TODAY })[0].kind).toBe('ok')
  })
})

describe('auditConstants — provenance checks', () => {
  it('an unmeasured constant is a FINDING, not an omission', () => {
    const [f] = auditConstants([one({ calibration: null })], { today: TODAY })
    expect(f.kind).toBe('never-calibrated')
    expect(f.severity).toBe('medium')
    expect(f.detail).toContain('never been measured')
  })

  it('flags a constant measured in a different context', () => {
    const [f] = auditConstants([one()], { today: TODAY, activeContext: 'ctx-B' })
    expect(f.kind).toBe('context-drift')
    expect(f.severity).toBe('high')
  })

  it('flags a calibration past its freshness budget', () => {
    const [f] = auditConstants([one({ calibration: cal({ measuredAt: '2025-01-01' }) })], {
      today: TODAY,
      maxAgeDays: 180
    })
    expect(f.kind).toBe('stale')
  })

  it('reports unfireable ahead of context drift — unfireability is true in ANY corpus', () => {
    const [f] = auditConstants([one({ value: 0.1 })], { today: TODAY, activeContext: 'ctx-B' })
    expect(f.kind).toBe('unfireable-low')
  })

  it('sorts worst-first so the report reads as a priority list', () => {
    const findings = auditConstants(
      [
        one({ id: 'z.ok', value: 0.5 }),
        one({ id: 'a.never', calibration: null }),
        one({ id: 'm.dead', value: 0.05 })
      ],
      { today: TODAY }
    )
    expect(findings.map((f) => f.kind)).toEqual(['unfireable-low', 'never-calibrated', 'ok'])
  })
})

describe('the live registry — encodes what was measured on 2026-07-28', () => {
  const findings = auditConstants(CONSTANT_REGISTRY, {
    today: TODAY,
    activeContext: ACTIVE_RETRIEVAL_CONTEXT
  })
  const byId = new Map(findings.map((f) => [f.id, f]))

  it('catches THIN_RETRIEVAL_MAX as unfireable — the defect this registry was built from', () => {
    // 0.35 against an observed rawScore range of [0.387, 0.744]: it fires on 0/90 on-corpus and
    // 0/18 off-corpus queries. This assertion is the regression test for the whole idea.
    expect(byId.get('uncertainty-gate.THIN_RETRIEVAL_MAX')!.kind).toBe('unfireable-low')
  })

  it('passes the two thresholds that were actually measured into the band', () => {
    expect(byId.get('evidence-gate.EVIDENCE_FLOOR')!.kind).toBe('ok')
    expect(byId.get('raw-escalation.ESCALATE_MAX_SCORE')!.kind).toBe('ok')
  })

  it('names the never-measured gating constants rather than assuming they are fine', () => {
    expect(byId.get('entity-resolver.TRIPWIRE_HIGH_DEGREE')!.kind).toBe('never-calibrated')
    expect(byId.get('personalization-recall.RECALL_FLOOR')!.kind).toBe('never-calibrated')
  })

  it('catches graph-expand beta as calibrated on the wrong corpus', () => {
    expect(byId.get('graph-expand-retrieve.beta')!.kind).toBe('context-drift')
  })

  it('every registered constant carries a signal — a constant with no comparand cannot be audited', () => {
    for (const c of CONSTANT_REGISTRY) expect(c.signal.length).toBeGreaterThan(0)
  })

  // The registry grew a SECOND domain on 2026-07-30 (learn-native's binding thresholds, measured
  // against the corrections stream). The drift check compares every constant to one activeContext —
  // the retrieval embedder — so those two were reported as `context-drift: high` while being
  // calibrated on exactly the corpus they operate on. Two confident false findings, in the list
  // whose entire purpose is to be true.
  it('does not report drift for a constant that lives against a different corpus', () => {
    expect(byId.get('learn-native.BIND_OVERLAP_MIN')!.kind).not.toBe('context-drift')
    expect(byId.get('learn-native.BIND_JACCARD_MIN')!.kind).not.toBe('context-drift')
  })

  it('still drift-checks the retrieval-domain constants — the exemption is per domain, not blanket', () => {
    expect(byId.get('graph-expand-retrieve.beta')!.kind).toBe('context-drift')
  })

  it('currently reports 4 findings needing attention', () => {
    // Deliberately pinned: when one is FIXED this test fails and must be updated, which is what
    // stops the list quietly growing back.
    expect(findings.filter((f) => f.severity !== 'none')).toHaveLength(4)
  })
})
