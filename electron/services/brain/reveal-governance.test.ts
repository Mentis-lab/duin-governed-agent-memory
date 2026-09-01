import { describe, it, expect } from 'vitest'
import { shouldAutoAccept, DEFAULT_AUTO_ACCEPT_POLICY } from './reveal-governance'
import type { RevealTrust } from './reveal-outcomes'

const trust = (over: Partial<RevealTrust>): RevealTrust => ({ rate: 0.9, wilson_lo: 0.85, n: 30, gated: false, ...over })

describe('shouldAutoAccept', () => {
  it('reviews when there is no trust yet (unknown source)', () => {
    expect(shouldAutoAccept(undefined, 0.99)).toBe('review')
  })

  it('reviews while the source is under-sampled (gated), however confident', () => {
    expect(shouldAutoAccept(trust({ gated: true, wilson_lo: 0.95 }), 0.99)).toBe('review')
  })

  it('auto-accepts a confident edge from a calibrated, trusted source', () => {
    expect(shouldAutoAccept(trust({ wilson_lo: 0.85 }), 0.75)).toBe('auto')
  })

  it('reviews a LOW-confidence edge even from a trusted source', () => {
    expect(shouldAutoAccept(trust({ wilson_lo: 0.9 }), 0.5)).toBe('review')
  })

  it('reviews a confident edge from a LOW-trust source', () => {
    expect(shouldAutoAccept(trust({ wilson_lo: 0.6 }), 0.95)).toBe('review')
  })

  it('respects a custom policy', () => {
    const strict = { trustFloor: 0.95, confidenceFloor: 0.9 }
    expect(shouldAutoAccept(trust({ wilson_lo: 0.85 }), 0.95, strict)).toBe('review')
    expect(shouldAutoAccept(trust({ wilson_lo: 0.96 }), 0.95, strict)).toBe('auto')
  })

  it('uses sane defaults (trust 0.8 / confidence 0.6 = the llm prior, so trusted llm edges can mature)', () => {
    expect(DEFAULT_AUTO_ACCEPT_POLICY).toEqual({ trustFloor: 0.8, confidenceFloor: 0.6 })
  })
})
