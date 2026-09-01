import { describe, it, expect, beforeEach, vi } from 'vitest'

// autonomy-report had NO test, which is how it kept reporting `ratifyRate` — the single most
// misleading number in the ANS surface. Only DISMISSALS lowered it, so the live
// operator-fact-promotion capability read as a perfect 1.0 while carrying 97 reverts. It is gone;
// `trust` (which folds reverts/(N+reverts)) is what the pane shows instead.

vi.mock('../brain/calibration-scoring', () => ({ scoreResolvedLedger: () => ({ skillScore: null }) }))
vi.mock('../loop-store', () => ({ listLoops: () => [] }))
vi.mock('../loop-controller', () => ({
  effectiveCeilings: () => ({ maxIterations: null, tokenBudget: null, multiplier: 1 })
}))

import { registerCapability, recordFeedback, __resetCapabilityLedger } from './capability-ledger'
import { buildAutonomyState } from './autonomy-report'

beforeEach(() => __resetCapabilityLedger())

const capNamed = (id: string) => buildAutonomyState(null).capabilities.find((c) => c.id === id)!

describe('buildAutonomyState — the breaker surface', () => {
  it('offers a re-arm exactly when a capability sits below its floor', () => {
    registerCapability({ id: 'tripped', title: 'Tripped', rung: 'hold', floorRung: 'reflexive' })
    registerCapability({ id: 'armed', title: 'Armed', rung: 'reflexive', floorRung: 'reflexive' })

    expect(capNamed('tripped').canRearm).toBe(true)
    expect(capNamed('armed').canRearm).toBe(false)
  })

  it('flags a pending trip and names the rung it will drop to', () => {
    registerCapability({ id: 'pending', title: 'Pending', rung: 'reflexive' })
    recordFeedback('pending', 'revert') // unhandled miss → the next pass trips it

    const c = capNamed('pending')
    expect(c.willTrip).toBe(true)
    expect(c.tripsTo).toBe('stage')
  })

  it('reports no pending trip when the miss was already consumed by a trip', () => {
    registerCapability({ id: 'quiet', title: 'Quiet', rung: 'stage' })
    for (let i = 0; i < 5; i++) recordFeedback('quiet', 'ratify')

    const c = capNamed('quiet')
    expect(c.willTrip).toBe(false)
    expect(c.tripsTo).toBeNull()
  })

  // The load-bearing removal. A capability with a spotless ratify record and a pile of reverts used
  // to publish ratifyRate: 1.0 — a green number describing a capability that had missed 97 times.
  it('does not publish ratifyRate at all, and reports reverts plainly', () => {
    registerCapability({ id: 'flattering', title: 'Flattering', rung: 'hold' })
    for (let i = 0; i < 48; i++) recordFeedback('flattering', 'ratify')
    for (let i = 0; i < 97; i++) recordFeedback('flattering', 'revert')

    const c = capNamed('flattering')
    expect(c).not.toHaveProperty('ratifyRate')
    expect(c.reverts).toBe(97)
    // trust IS revert-aware, which is why it is the one kept.
    expect(c.trust).toBeLessThan(1)
  })
})
