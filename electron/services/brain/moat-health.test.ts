import { describe, it, expect } from 'vitest'
import { computeMoatHealth, type MoatHealthInputs } from './moat-health'

const base: MoatHealthInputs = { facts: [], capabilities: [], calibration: [], successCount: 0 }

describe('computeMoatHealth', () => {
  it('reads a cold store as cold', () => {
    const h = computeMoatHealth(base)
    expect(h.status).toBe('cold')
    expect(h.facts.total).toBe(0)
    expect(h.calibration.coldStart).toBe(true)
    expect(h.promotion.revertRate).toBe(0)
  })

  it('counts the promotion funnel + survival-ready provisionals', () => {
    const h = computeMoatHealth({
      ...base,
      facts: [
        { status: 'candidate' },
        { status: 'provisional', observedSessions: ['s1', 's2'] }, // survival-ready (≥2)
        { status: 'provisional', observedSessions: ['s1'] }, // not yet
        { status: 'promoted' },
        { status: 'reverted' },
        { status: 'vetoed' }
      ]
    })
    expect(h.facts).toEqual({ candidate: 1, provisional: 2, promoted: 1, vetoed: 1, reverted: 1, total: 6 })
    expect(h.promotion.survivalReady).toBe(1)
    expect(h.promotion.revertRate).toBe(0.5) // 1 reverted / (1 promoted + 1 reverted)
  })

  it('summarizes the capability ladder + avg ratify rate', () => {
    const h = computeMoatHealth({
      ...base,
      capabilities: [
        { rung: 'reflexive', ratifyN: 10, ratifyK: 9 },
        { rung: 'stage', ratifyN: 4, ratifyK: 2 },
        { rung: 'hold', ratifyN: 0, ratifyK: 0 } // no feedback → excluded from avg
      ]
    })
    expect(h.capabilities).toMatchObject({ reflexive: 1, stage: 1, hold: 1, total: 3 })
    expect(h.capabilities.avgRatifyRate).toBe(0.7) // (0.9 + 0.5) / 2
  })

  it('reports calibration earn-out (earned vs gated)', () => {
    const h = computeMoatHealth({
      ...base,
      calibration: [
        { kind: 'driver', observed: 25, gated: false, usefulRate: 0.8 },
        { kind: 'cascade', observed: 5, gated: true, usefulRate: null }
      ]
    })
    expect(h.calibration.earned).toBe(1)
    expect(h.calibration.gated).toBe(1)
    expect(h.calibration.coldStart).toBe(false)
  })

  it('is compounding when calibration earns AND a GOVERNED promotion exists', () => {
    const h = computeMoatHealth({
      ...base,
      // A jury-governed promotion (govern provenance + provisionalAt) — honestly earned.
      facts: [{ status: 'promoted', provisionalAt: 1, govern: { verdict: 'confirm' } }],
      calibration: [{ kind: 'driver', observed: 25, gated: false, usefulRate: 0.8 }]
    })
    expect(h.status).toBe('compounding')
    expect(h.promotion.confirmed).toBe(1)
    expect(h.promotion.governed).toBe(1)
    expect(h.promotion.legacyPromoted).toBe(0)
  })

  it('does NOT read compounding off LEGACY promotions (the honesty fix)', () => {
    // The live shape the value-core audit found: 3 legacy promoted (no govern/provisionalAt)
    // + 1 governed. Only the governed one counts as earned; the legacy 3 are reported
    // separately and must not — alone — flip the verdict to compounding.
    const legacyOnly = computeMoatHealth({
      ...base,
      facts: [
        { status: 'promoted' },
        { status: 'promoted' },
        { status: 'promoted' }
      ],
      calibration: [{ kind: 'driver', observed: 25, gated: false, usefulRate: 0.8 }]
    })
    expect(legacyOnly.promotion.governed).toBe(0)
    expect(legacyOnly.promotion.legacyPromoted).toBe(3)
    expect(legacyOnly.promotion.confirmed).toBe(0)
    expect(legacyOnly.status).toBe('warming') // some learning, but NOT compounding off legacy

    // Add one governed promotion → now honestly compounding, with the split reported.
    const mixed = computeMoatHealth({
      ...base,
      facts: [
        { status: 'promoted' },
        { status: 'promoted' },
        { status: 'promoted' },
        { status: 'promoted', provisionalAt: 1, govern: { verdict: 'confirm' } }
      ],
      calibration: [{ kind: 'driver', observed: 25, gated: false, usefulRate: 0.8 }]
    })
    expect(mixed.promotion.governed).toBe(1)
    expect(mixed.promotion.legacyPromoted).toBe(3)
    expect(mixed.promotion.confirmed).toBe(1)
    expect(mixed.facts.promoted).toBe(4) // raw status tally still counts all 4
    expect(mixed.status).toBe('compounding')
  })

  it('is warming with some learning but nothing earned out yet', () => {
    const h = computeMoatHealth({ ...base, facts: [{ status: 'provisional' }], successCount: 3 })
    expect(h.status).toBe('warming')
  })
})
