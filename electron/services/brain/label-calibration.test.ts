import { describe, it, expect } from 'vitest'
import {
  verbalizedCertainty,
  perLabelReliability,
  CERTAINTY_LABELS,
  type LabeledOutcome
} from './label-calibration'

// Measure — per-label verbalized-certainty calibration (Agent-BRACE). Pure.

// A trivial Wilson stand-in for deterministic tests (point estimate ± crude band),
// well-defined at k=0 and k=n (the degenerate case the skill score can't handle).
const wilson = (k: number, n: number): [number | null, number | null] => {
  if (n === 0) return [null, null]
  const p = k / n
  return [Math.max(0, p - 0.2), Math.min(1, p + 0.2)]
}

describe('verbalizedCertainty', () => {
  it('maps probabilities to ordinal labels', () => {
    expect(verbalizedCertainty(0.05)).toBe('remote')
    expect(verbalizedCertainty(0.3)).toBe('unlikely')
    expect(verbalizedCertainty(0.5)).toBe('even')
    expect(verbalizedCertainty(0.8)).toBe('likely')
    expect(verbalizedCertainty(0.95)).toBe('certain')
  })
  it('clamps out-of-range', () => {
    expect(verbalizedCertainty(-1)).toBe('remote')
    expect(verbalizedCertainty(2)).toBe('certain')
  })
})

describe('perLabelReliability', () => {
  it('computes realized rate + wilson bound + calibration gap per label', () => {
    const outcomes: LabeledOutcome[] = [
      { confidence: 0.9, useful: true }, // certain
      { confidence: 0.9, useful: true }, // certain
      { confidence: 0.9, useful: false }, // certain
      { confidence: 0.3, useful: false }, // unlikely
      { confidence: 0.3, useful: false } // unlikely
    ]
    const r = perLabelReliability(outcomes, wilson)
    const certain = r.find((x) => x.label === 'certain')!
    expect(certain).toMatchObject({ n: 3, useful: 2 })
    expect(certain.usefulRate).toBeCloseTo(0.667, 2)
    expect(certain.wilsonLo).not.toBeNull()
    // certain nominal 0.93, realized 0.667 → over-confident (negative gap)
    expect(certain.calibrationGap).toBeLessThan(0)
    const unlikely = r.find((x) => x.label === 'unlikely')!
    expect(unlikely).toMatchObject({ n: 2, useful: 0, usefulRate: 0 })
    expect(unlikely.wilsonLo).toBe(0) // well-defined at k=0 (degenerate — no skill score needed)
  })

  it('excludes unresolved outcomes', () => {
    const r = perLabelReliability([{ confidence: 0.9, useful: null }], wilson)
    expect(r.find((x) => x.label === 'certain')!.n).toBe(0)
  })

  it('an empty label bucket reports null rate, not a crash', () => {
    const r = perLabelReliability([], wilson)
    expect(r.map((x) => x.label)).toEqual(CERTAINTY_LABELS)
    expect(r.every((x) => x.n === 0 && x.usefulRate === null && x.wilsonLo === null)).toBe(true)
  })

  it('is robust to a fully one-sided (degenerate) bucket', () => {
    const outcomes: LabeledOutcome[] = Array.from({ length: 8 }, () => ({ confidence: 0.95, useful: true }))
    const certain = perLabelReliability(outcomes, wilson).find((x) => x.label === 'certain')!
    expect(certain).toMatchObject({ n: 8, useful: 8, usefulRate: 1 })
    expect(certain.wilsonLo).not.toBeNull() // defined even when every outcome is the same
  })
})
