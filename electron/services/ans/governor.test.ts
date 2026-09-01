import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerCapability,
  recordFeedback,
  classify,
  getCapability,
  setRung,
  __resetCapabilityLedger
} from './capability-ledger'
import { demoteRung, governDecision, runGovernorPass, rearmCapability } from './governor'

beforeEach(() => __resetCapabilityLedger())

describe('capability-ledger', () => {
  it('registers with safe defaults (stage rung, reflexive floor)', () => {
    const c = registerCapability({ id: 'autolink.fix', title: 'Auto-link fix' })
    expect(c.rung).toBe('stage')
    expect(c.floorRung).toBe('reflexive')
  })

  it('action-class floor: a matched-CAP-titled capability cannot be seeded below stage', () => {
    // "send an email" → outward-send (CAP) → floor pinned to stage (no silent autonomy).
    expect(registerCapability({ id: 'send', title: 'Send an email to the team' }).floorRung).toBe('stage')
    // benign read → grad → default reflexive floor (may earn full autonomy).
    expect(registerCapability({ id: 'read', title: 'Read the latest notes' }).floorRung).toBe('reflexive')
    // an explicit floor always wins over the classifier.
    expect(registerCapability({ id: 'send2', title: 'Send email', floorRung: 'hold' }).floorRung).toBe('hold')
    // unknown/internal title does NOT tighten (safe-by-construction internals stay reflexive).
    expect(registerCapability({ id: 'consol', title: 'Consolidate a closed topic' }).floorRung).toBe('reflexive')
  })

  it('re-register is idempotent — keeps earned rung + stats, refreshes title', () => {
    registerCapability({ id: 'x', title: 'X' })
    setRung('x', 'reflexive')
    recordFeedback('x', 'ratify')
    const again = registerCapability({ id: 'x', title: 'X v2' })
    expect(again.rung).toBe('reflexive')
    expect(again.title).toBe('X v2')
    expect(again.ratifyK).toBe(1)
  })

  it('records feedback verbs', () => {
    registerCapability({ id: 'c', title: 'C' })
    recordFeedback('c', 'ratify')
    recordFeedback('c', 'dismiss')
    recordFeedback('c', 'revert')
    const c = getCapability('c')!
    expect(c.ratifyN).toBe(2) // ratify + dismiss
    expect(c.ratifyK).toBe(1) // ratify
    expect(c.reverts).toBe(1)
  })

  // 'unknown' is its OWN answer now, not a default to 'stage'. It was 'safe' only for a caller
  // that treats stage as blocking, and the gate on operator-fact auto-promotion blocks solely on
  // 'hold' — so "never heard of it" read as "permitted to act unattended".
  it('classify maps rung → gate; an unregistered id is UNKNOWN, not stage', () => {
    registerCapability({ id: 'r', title: 'R', rung: 'reflexive' })
    registerCapability({ id: 's', title: 'S', rung: 'stage' })
    registerCapability({ id: 'h', title: 'H', rung: 'hold' })
    expect(classify('r')).toBe('run')
    expect(classify('s')).toBe('stage')
    expect(classify('h')).toBe('hold')
    expect(classify('nope')).toBe('unknown')
  })
})

describe('rung ladder', () => {
  // `promoteRung` (one rung toward autonomy, floor-clamped) is gone with the promote arm.
  // `rearmCapability` restores the floor in one step, so nothing needed a per-rung climb —
  // it survived only as production code its own test kept alive.
  it('demoteRung moves toward hold', () => {
    expect(demoteRung('reflexive')).toBe('stage')
    expect(demoteRung('stage')).toBe('hold')
    expect(demoteRung('hold')).toBe('hold') // floor of the ladder
  })
})

describe('governDecision — a breaker, not a grade', () => {
  it('trips on an unhandled miss and holds otherwise', () => {
    expect(governDecision({ newReverts: 1 })).toBe('trip')
    expect(governDecision({ newReverts: 0 })).toBe('hold')
  })

  // The promote arm is GONE, and this is the test that says so. It required >= minSamples
  // decisions at a >= promoteThreshold ratify-rate — a gate that, measured 2026-07-30, four of
  // five live capabilities could never satisfy because they had never recorded a single
  // adjudication, and that the fifth satisfied with a perfect 1.0 while carrying 97 reverts
  // (only DISMISSALS lowered it). No amount of clean record moves a rung on its own now.
  it('never moves a rung toward autonomy on its own, however clean the record', () => {
    registerCapability({ id: 'spotless', title: 'Spotless', rung: 'hold' })
    for (let i = 0; i < 50; i++) recordFeedback('spotless', 'ratify')

    runGovernorPass()

    expect(getCapability('spotless')!.rung).toBe('hold') // only a human re-arms
  })
})

describe('runGovernorPass', () => {
  it('trips the breaker on a miss, applies it immediately, and does not re-fire', () => {
    registerCapability({ id: 'bad', title: 'Bad', rung: 'reflexive' })
    recordFeedback('bad', 'revert')
    registerCapability({ id: 'clean', title: 'Clean', rung: 'stage' })
    for (let i = 0; i < 12; i++) recordFeedback('clean', 'ratify')

    const r = runGovernorPass()

    expect(r.tripped.map((d) => d.id)).toEqual(['bad'])
    expect(getCapability('bad')!.rung).toBe('stage') // reflexive → stage, applied
    expect(getCapability('bad')!.lastDemoteAt).toBeGreaterThan(0)
    expect(getCapability('clean')!.rung).toBe('stage') // untouched — a clean record is not a climb

    // The same miss must not demote twice (revertsHandled consumed it).
    expect(runGovernorPass().tripped.length).toBe(0)
  })

  it('a capability already at hold stays there, and still consumes the miss', () => {
    registerCapability({ id: 'floored', title: 'Floored', rung: 'hold', floorRung: 'hold' })
    recordFeedback('floored', 'revert')

    expect(runGovernorPass().tripped.length).toBe(0) // no rung left to drop
    expect(runGovernorPass().tripped.length).toBe(0) // and it does not re-fire forever
  })
})

describe('rearmCapability — the operator half, and the only way back', () => {
  it('restores the floor rung in ONE step', () => {
    // The live shape of operator-fact-promotion: tripped all the way to hold.
    registerCapability({ id: 'earner', title: 'Earner', rung: 'hold', floorRung: 'reflexive' })

    const res = rearmCapability('earner')

    expect(res.ok).toBe(true)
    expect(res.change).toMatchObject({ id: 'earner', from: 'hold', to: 'reflexive' })
    expect(getCapability('earner')!.rung).toBe('reflexive')
  })

  it('never re-arms past the floor — an outward-send capability stays supervised', () => {
    registerCapability({ id: 'send', title: 'Send an email', rung: 'hold' })
    expect(getCapability('send')!.floorRung).toBe('stage') // action-class floor
    expect(rearmCapability('send').change).toMatchObject({ from: 'hold', to: 'stage' })
    expect(rearmCapability('send')).toEqual({ ok: false, reason: 'already-armed' })
  })

  it('never stamps lastDemoteAt — that belongs to the trip path alone', () => {
    registerCapability({ id: 'clean', title: 'Clean', rung: 'hold' })
    expect(rearmCapability('clean').ok).toBe(true)
    expect(getCapability('clean')!.lastDemoteAt).toBeUndefined()
  })

  it('refuses an unknown capability', () => {
    expect(rearmCapability('nope')).toEqual({ ok: false, reason: 'unknown-capability' })
  })

  // The breaker's actual safety property: re-arming does not forgive a FUTURE miss.
  it('a miss landing after a re-arm trips it straight back', () => {
    registerCapability({ id: 'flappy', title: 'Flappy', rung: 'hold', floorRung: 'reflexive' })
    expect(rearmCapability('flappy').ok).toBe(true)
    expect(getCapability('flappy')!.rung).toBe('reflexive')

    recordFeedback('flappy', 'revert')
    runGovernorPass()

    expect(getCapability('flappy')!.rung).toBe('stage')
  })
})
